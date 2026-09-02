import sharp from 'sharp';

import { ImageFormat } from './storage.js';

const SUPPORTED_FORMATS: Record<string, ImageFormat> = {
    jpeg: 'jpg',
    png: 'png',
    webp: 'webp'
};

export type ProbedImage = {
    format: ImageFormat;
    width: number;
    height: number;
};

/**
 * Reads the format and the dimensions of an upload, which doubles as the check that the bytes really
 * are a picture and not something that was given a picture's name.
 * @returns the details of the picture, or null when it is not one this service accepts
 */
export async function probe(content: Buffer): Promise<ProbedImage | null> {
    try {
        const metadata = await sharp(content).metadata();
        const format = SUPPORTED_FORMATS[metadata.format ?? ''];
        if (!format || !metadata.width || !metadata.height) {
            return null;
        }
        return { format, width: metadata.width, height: metadata.height };
    } catch {
        return null;
    }
}

/**
 * Resizes a picture to a given width, keeping its aspect ratio and its format.
 *
 * The orientation of the original is applied rather than carried over, since the EXIF is dropped
 * along with the rest of the metadata - a thumbnail should not be handing out the photographer's
 * camera and GPS position. A picture narrower than the requested width is returned at its own size.
 */
export async function createThumbnail(content: Buffer, width: number, format: ImageFormat): Promise<Buffer> {
    const pipeline = sharp(content)
        .rotate()
        .resize({ width, withoutEnlargement: true });
    switch (format) {
        case 'jpg':
            return pipeline.jpeg({ quality: 85 }).toBuffer();
        case 'png':
            return pipeline.png().toBuffer();
        case 'webp':
            return pipeline.webp().toBuffer();
    }
}
