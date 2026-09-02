import { readFile } from 'node:fs/promises';

import express, { Request, Response, NextFunction } from 'express';
import cors from 'cors';
import multer from 'multer';
import swaggerUi from 'swagger-ui-express';

import { config } from './config.js';
import { authenticate } from './auth.js';
import { createThumbnail, probe } from './images.js';
import {
    ID_PATTERN,
    ImageFormat,
    ImageMetadata,
    deleteImage,
    exists,
    idOf,
    originalPath,
    readMetadata,
    saveImage,
    thumbnailPath,
    urlOf,
    writeFileAtomically
} from './storage.js';
import apiDocs from './user-images.openapi.json';

/**
 * The routes are regular expressions rather than express paths, since an id and a width need to be
 * matched exactly - anything else would let a request walk out of the storage directory.
 */
const IMAGE_ROUTE = new RegExp(`^/(${ID_PATTERN})\\.(jpg|png|webp)$`);
const METADATA_ROUTE = new RegExp(`^/(${ID_PATTERN})\\.json$`);
const THUMBNAIL_ROUTE = new RegExp(`^/(${ID_PATTERN})/(\\d{1,5})px\\.(jpg|png|webp)$`);

/** A picture at a given url can never change, so whoever holds it can keep it forever */
const IMMUTABLE_CACHE_CONTROL = 'public, max-age=31536000, immutable';

const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: config.maxUploadBytes, files: 1 }
});

export const app = express();
app.use(cors());
app.use('/api-docs', swaggerUi.serve, swaggerUi.setup(apiDocs));

app.get('/health', (req: Request, res: Response) => {
    res.json({ status: 'ok' });
});

// --- Upload ---

function parseLocation(body: Record<string, string>): { lat: number; lng: number } | undefined | 'invalid' {
    if (body.lat === undefined && body.lng === undefined) {
        return undefined;
    }
    const lat = Number(body.lat);
    const lng = Number(body.lng);
    if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) {
        return 'invalid';
    }
    return { lat, lng };
}

app.post('/api/images', authenticate, upload.single('file'), async (req: Request, res: Response, next: NextFunction) => {
    try {
        if (!req.file) {
            return res.status(400).json({ message: 'A file is required' });
        }
        const probed = await probe(req.file.buffer);
        if (!probed) {
            return res.status(400).json({ message: 'The file is not a jpeg, a png or a webp' });
        }
        const body = req.body as Record<string, string>;
        const location = parseLocation(body);
        if (location === 'invalid') {
            return res.status(400).json({ message: 'lat and lng must both be valid coordinates' });
        }
        if (body.capturedAt && Number.isNaN(Date.parse(body.capturedAt))) {
            return res.status(400).json({ message: 'capturedAt must be an ISO 8601 date' });
        }

        const id = idOf(req.file.buffer);
        const existingMetadata = await readMetadata(id);
        if (existingMetadata) {
            return res.status(200).json(existingMetadata);
        }

        const metadata: ImageMetadata = {
            id,
            format: probed.format,
            url: urlOf(id, probed.format),
            osmUser: req.user!.osmUser,
            osmUserId: req.user!.osmUserId,
            description: body.description || undefined,
            capturedAt: body.capturedAt || undefined,
            location,
            license: body.license || config.defaultLicense,
            uploadedAt: new Date().toISOString(),
            width: probed.width,
            height: probed.height,
            size: req.file.buffer.length
        };
        await saveImage(req.file.buffer, metadata);
        res.status(201).json(metadata);
    } catch (error) {
        next(error);
    }
});

app.delete(new RegExp(`^/api/images/(${ID_PATTERN})$`), authenticate, async (req: Request, res: Response, next: NextFunction) => {
    try {
        const id = req.params[0] as string;
        const metadata = await readMetadata(id);
        if (!metadata) {
            return res.sendStatus(404);
        }
        const user = req.user!;
        if (metadata.osmUserId !== user.osmUserId && !config.adminOsmUserIds.includes(user.osmUserId)) {
            return res.status(403).json({ message: 'Only the uploader can delete an image' });
        }
        await deleteImage(metadata);
        res.sendStatus(204);
    } catch (error) {
        next(error);
    }
});

// --- Serving ---

function sendStoredFile(res: Response, filePath: string, next: NextFunction) {
    res.sendFile(filePath, { headers: { 'Cache-Control': IMMUTABLE_CACHE_CONTROL } }, error => {
        if (!error) {
            return;
        }
        if ((error as NodeJS.ErrnoException & { status?: number }).status === 404) {
            return res.sendStatus(404);
        }
        next(error);
    });
}

app.get(METADATA_ROUTE, async (req: Request, res: Response, next: NextFunction) => {
    try {
        const metadata = await readMetadata(req.params[0] as string);
        if (!metadata) {
            return res.sendStatus(404);
        }
        res.set('Cache-Control', IMMUTABLE_CACHE_CONTROL);
        res.json(metadata);
    } catch (error) {
        next(error);
    }
});

app.get(IMAGE_ROUTE, async (req: Request, res: Response, next: NextFunction) => {
    const id = req.params[0] as string;
    const format = req.params[1] as ImageFormat;
    if (!await exists(originalPath(id, format))) {
        return res.sendStatus(404);
    }
    sendStoredFile(res, originalPath(id, format), next);
});

/**
 * Thumbnails are generated the first time they are asked for and then kept on disk, so a width that
 * nobody uses costs nothing. Requests that arrive together for a thumbnail that does not exist yet
 * share a single generation rather than each doing the same work.
 */
const thumbnailsBeingCreated = new Map<string, Promise<void>>();

async function ensureThumbnail(metadata: ImageMetadata, width: number): Promise<void> {
    const targetPath = thumbnailPath(metadata.id, width, metadata.format);
    if (await exists(targetPath)) {
        return;
    }
    const inFlight = thumbnailsBeingCreated.get(targetPath);
    if (inFlight) {
        return inFlight;
    }
    const creation = (async () => {
        const original = await readFile(originalPath(metadata.id, metadata.format));
        const thumbnail = await createThumbnail(original, width, metadata.format);
        await writeFileAtomically(targetPath, thumbnail);
    })().finally(() => thumbnailsBeingCreated.delete(targetPath));
    thumbnailsBeingCreated.set(targetPath, creation);
    return creation;
}

app.get(THUMBNAIL_ROUTE, async (req: Request, res: Response, next: NextFunction) => {
    try {
        const id = req.params[0] as string;
        const width = Number(req.params[1]);
        const format = req.params[2] as ImageFormat;
        if (!config.thumbnailWidths.includes(width)) {
            return res.status(400).json({
                message: 'Unsupported thumbnail width',
                supportedWidths: config.thumbnailWidths
            });
        }
        const metadata = await readMetadata(id);
        if (!metadata || metadata.format !== format) {
            return res.sendStatus(404);
        }
        await ensureThumbnail(metadata, width);
        sendStoredFile(res, thumbnailPath(id, width, format), next);
    } catch (error) {
        next(error);
    }
});

// --- Error Handling ---

app.use((err: any, req: Request, res: Response, next: NextFunction) => {
    if (err?.code === 'LIMIT_FILE_SIZE') {
        return res.status(413).json({ message: `The image is larger than ${config.maxUploadBytes} bytes` });
    }
    res.status(err.status || 500).json({
        message: err.message,
        errors: err.errors,
    });
    console.log(req.method + ' ' + req.url + ' : ' + err.message);
});
