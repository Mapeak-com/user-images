import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';

import { config } from './config.js';

export type ImageFormat = 'jpg' | 'png' | 'webp';

/**
 * What the camera recorded into the picture, as opposed to what the uploader said about it.
 *
 * Every field is optional because every one of them is optional in EXIF itself, and a picture that
 * has been through an editor or a resizer often arrives with none of them.
 */
export type ImageExif = {
    camera?: string;
    lens?: string;
    software?: string;
    /** The wall clock the camera wrote, with its UTC offset when the camera recorded one */
    takenAt?: string;
    exposureTime?: string;
    fNumber?: number;
    iso?: number;
    focalLength?: number;
    focalLengthIn35mm?: number;
    location?: { lat: number; lng: number };
    altitude?: number;
};

export type ImageMetadata = {
    id: string;
    url: string;
    /** The OSM display name of whoever took the picture, taken from the access token of the upload */
    osmUser: string;
    /** Absent for an imported image whose OSM account no longer exists, see parseAttribution */
    osmUserId?: string;
    location?: { lat: number; lng: number };
    license: string;
    uploadedAt: string;
};

/**
 * The length of an id in hex characters. A sha256 truncated to 128 bits, which is short enough to sit
 * comfortably in an OSM tag and far more than enough to never collide at this scale.
 */
const ID_LENGTH = 32;

export const ID_PATTERN = '[0-9a-f]{32}';

/**
 * The id of a picture is the hash of its bytes, so the same picture uploaded twice gets the same id
 * and the same url, and the bytes behind a url can never change.
 */
export function idOf(content: Buffer): string {
    return createHash('sha256').update(content).digest('hex').slice(0, ID_LENGTH);
}

/**
 * The directory an id belongs to.
 *
 * The url holds the id alone and this is the only place that decides where it sits on disk, so the
 * layout can be re-shaped later - a second level, a different bucket size - without a single url
 * changing. The 256 buckets keep a directory at a few hundred files for a hundred thousand images.
 */
function bucketOf(id: string): string {
    return id.slice(0, 2);
}

export function originalPath(id: string, format: ImageFormat): string {
    return path.resolve(config.storageDir, bucketOf(id), `${id}.${format}`);
}

export function metadataPath(id: string): string {
    return path.resolve(config.storageDir, bucketOf(id), `${id}.json`);
}

/**
 * Generated thumbnails live in a tree of their own, so that they can be thrown away and regenerated
 * without ever putting an original at risk. "thumb" can not collide with a bucket since a bucket is
 * two hex characters.
 */
export function thumbnailPath(id: string, width: number, format: ImageFormat): string {
    return path.resolve(config.storageDir, 'thumb', bucketOf(id), id, `${width}px.${format}`);
}

/**
 * The format a picture is stored in, read back off the url that was built when it was saved.
 *
 * It is not a field of its own because it would be the same thing twice - a picture is addressed by
 * `<id>.<format>` and the url already ends in it.
 */
export function formatOf(metadata: ImageMetadata): ImageFormat {
    return metadata.url.slice(metadata.url.lastIndexOf('.') + 1) as ImageFormat;
}

export function urlOf(id: string, format: ImageFormat): string {
    return `${config.publicBaseUrl}/${id}.${format}`;
}

export async function readMetadata(id: string): Promise<ImageMetadata | null> {
    try {
        return JSON.parse(await fs.readFile(metadataPath(id), 'utf-8')) as ImageMetadata;
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
            return null;
        }
        throw error;
    }
}

/**
 * Writes a file after making sure its directory exists, through a temporary name so that a reader
 * can never observe a half written picture.
 */
export async function writeFileAtomically(filePath: string, content: Buffer | string): Promise<void> {
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    const temporaryPath = `${filePath}.${process.pid}.tmp`;
    await fs.writeFile(temporaryPath, content);
    await fs.rename(temporaryPath, filePath);
}

/**
 * Puts a second name on a file that already exists, through a temporary name so that a reader can
 * never observe a half linked one.
 *
 * The two names are the same bytes rather than a copy of them, which is what lets a thumbnail that
 * would have come out identical to the original cost an inode instead of a second picture.
 */
export async function linkFileAtomically(existingPath: string, filePath: string): Promise<void> {
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    const temporaryPath = `${filePath}.${process.pid}.tmp`;
    await fs.link(existingPath, temporaryPath);
    await fs.rename(temporaryPath, filePath);
}

export async function saveImage(content: Buffer, metadata: ImageMetadata): Promise<void> {
    await writeFileAtomically(originalPath(metadata.id, formatOf(metadata)), content);
    await writeFileAtomically(metadataPath(metadata.id), JSON.stringify(metadata, null, 2));
}

export async function deleteImage(metadata: ImageMetadata): Promise<void> {
    const format = formatOf(metadata);
    await fs.rm(originalPath(metadata.id, format), { force: true });
    await fs.rm(metadataPath(metadata.id), { force: true });
    await fs.rm(path.dirname(thumbnailPath(metadata.id, 0, format)), { recursive: true, force: true });
}

export async function exists(filePath: string): Promise<boolean> {
    try {
        await fs.access(filePath);
        return true;
    } catch {
        return false;
    }
}
