import { readFile } from 'node:fs/promises';

import express, { Request, Response, NextFunction } from 'express';
import cors from 'cors';
import multer from 'multer';
import swaggerUi from 'swagger-ui-express';

import { config } from './config.js';
import { AuthenticatedUser, authenticate } from './auth.js';
import { createThumbnail, probe } from './images.js';
import { renderImagePage } from './page.js';
import {
    ID_PATTERN,
    ImageFormat,
    ImageMetadata,
    deleteImage,
    exists,
    idOf,
    originalPath,
    readMetadata,
    linkFileAtomically,
    saveImage,
    thumbnailPath,
    urlOf,
    writeFileAtomically
} from './storage.js';
import apiDocs from './user-images.openapi.json';

/**
 * The routes are regular expressions rather than express paths, since an id has to be matched
 * exactly - anything else would let a request walk out of the storage directory.
 */
const IMAGE_ROUTE = new RegExp(`^/(${ID_PATTERN})\\.(jpg|png|webp)$`);
const METADATA_ROUTE = new RegExp(`^/(${ID_PATTERN})\\.json$`);
const PAGE_ROUTE = new RegExp(`^/(${ID_PATTERN})$`);

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

type Attribution = {
    osmUser: string;
    osmUserId?: string;
    uploadedAt: string;
};

/**
 * Who an image is credited to and when it was contributed.
 *
 * Both are taken from the access token and the clock, so an image can not be attributed to someone
 * who did not send it. A moderator is the one exception, and only so that an archive that already
 * exists somewhere else can be brought in with the people who actually took the pictures still on
 * them - which is the whole point of moving it. What a moderator states is not verified.
 *
 * `osmUserId` may be left out there, and only there, because an account that has since been deleted
 * has no id left to give - the name is still who took the picture and still who to credit. No token
 * can match an image with no id on it, so only a moderator can ever remove one.
 *
 * `osmUser` may be left out too, and then the moderator is credited as usual. An archive holds
 * pictures whose author it never recorded, and the date is still worth keeping even though there is
 * nobody but the importer to put on them.
 */
function parseAttribution(body: Record<string, string>, user: AuthenticatedUser): Attribution | 'invalid' | 'forbidden' {
    const stated = body.osmUser || body.osmUserId || body.uploadedAt;
    if (!stated) {
        return { osmUser: user.osmUser, osmUserId: user.osmUserId, uploadedAt: new Date().toISOString() };
    }
    if (!config.adminOsmUserIds.includes(user.osmUserId)) {
        return 'forbidden';
    }
    if (body.osmUserId && !body.osmUser) {
        return 'invalid';
    }
    if (body.uploadedAt && Number.isNaN(Date.parse(body.uploadedAt))) {
        return 'invalid';
    }
    return {
        osmUser: body.osmUser || user.osmUser,
        osmUserId: body.osmUser ? (body.osmUserId || undefined) : user.osmUserId,
        uploadedAt: body.uploadedAt || new Date().toISOString()
    };
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
        const attribution = parseAttribution(body, req.user!);
        if (attribution === 'forbidden') {
            return res.status(403).json({ message: 'Only a moderator can state who an image belongs to' });
        }
        if (attribution === 'invalid') {
            return res.status(400).json({
                message: 'osmUserId needs the osmUser it belongs to, and uploadedAt must be an ISO 8601 date'
            });
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
            osmUser: attribution.osmUser,
            osmUserId: attribution.osmUserId,
            description: body.description || undefined,
            capturedAt: body.capturedAt || undefined,
            location,
            license: body.license || config.defaultLicense,
            uploadedAt: attribution.uploadedAt,
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
        const sourcePath = originalPath(metadata.id, metadata.format);
        // A thumbnail at least as wide as the picture is the picture - resizing would only re-encode
        // it into a second copy of the same thing. It gets a name under `thumb` all the same, so the
        // front end keeps serving every size straight from disk, but the bytes are stored once.
        if (width >= metadata.width) {
            return linkFileAtomically(sourcePath, targetPath);
        }
        const original = await readFile(sourcePath);
        const thumbnail = await createThumbnail(original, width, metadata.format);
        await writeFileAtomically(targetPath, thumbnail);
    })().finally(() => thumbnailsBeingCreated.delete(targetPath));
    thumbnailsBeingCreated.set(targetPath, creation);
    return creation;
}

/**
 * Serves a picture, at its own size or at one of the widths this instance generates.
 *
 * The width is a query parameter rather than a path of its own, so that every size of a picture is
 * the same url with one thing varied - whoever holds `<id>.jpg` asks for a smaller one by appending
 * `?width=`, without having to know how to spell a second kind of url. Only the widths the instance
 * allows are generated, since an arbitrary width would let anyone fill the disk with derivatives.
 */
/**
 * The page a credit under an image links to, so that whoever follows it sees the picture together
 * with who took it and the license it may be used under.
 */
app.get(PAGE_ROUTE, async (req: Request, res: Response, next: NextFunction) => {
    try {
        const metadata = await readMetadata(req.params[0] as string);
        if (!metadata) {
            return res.sendStatus(404);
        }
        res.type('html').send(renderImagePage(metadata, config.thumbnailWidths));
    } catch (error) {
        next(error);
    }
});

app.get(IMAGE_ROUTE, async (req: Request, res: Response, next: NextFunction) => {
    try {
        const id = req.params[0] as string;
        const format = req.params[1] as ImageFormat;
        const requestedWidth = req.query.width;

        if (requestedWidth === undefined) {
            if (!await exists(originalPath(id, format))) {
                return res.sendStatus(404);
            }
            return sendStoredFile(res, originalPath(id, format), next);
        }

        const width = Number(requestedWidth);
        if (!config.thumbnailWidths.includes(width)) {
            return res.status(400).json({
                message: 'Unsupported width',
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
