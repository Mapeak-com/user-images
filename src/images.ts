import sharp from 'sharp';
import exifReader from 'exif-reader';

import { ImageExif, ImageFormat } from './storage.js';

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
 * Turns the [degrees, minutes, seconds] EXIF holds into a number, signed by its N/S/E/W reference.
 * @returns the coordinate, or undefined when the camera wrote the tag without ever getting a fix
 */
function coordinate(parts: unknown, reference: unknown): number | undefined {
    if (!Array.isArray(parts) || parts.length < 3 || typeof reference !== 'string') {
        return undefined;
    }
    const [degrees, minutes, seconds] = parts.map(Number);
    if (![degrees, minutes, seconds].every(Number.isFinite)) {
        return undefined;
    }
    const value = degrees + minutes / 60 + seconds / 3600;
    if (value === 0) {
        return undefined;
    }
    return 'SW'.includes(reference.toUpperCase()) ? -value : value;
}

/**
 * When the picture was taken, as the camera recorded it.
 *
 * EXIF writes the wall clock with no zone, and exif-reader hands that back as a Date by reading it
 * as if it were UTC - so the instant is wrong but the digits are right, and the digits are what is
 * wanted. A phone that also wrote OffsetTimeOriginal, which EXIF only gained in 2016, turns those
 * digits into a real instant.
 */
function takenAt(photo: Record<string, unknown>): string | undefined {
    const taken = photo.DateTimeOriginal ?? photo.DateTimeDigitized;
    if (!(taken instanceof Date) || Number.isNaN(taken.getTime())) {
        return undefined;
    }
    const wallClock = taken.toISOString().slice(0, 19);
    const offset = photo.OffsetTimeOriginal ?? photo.OffsetTime;
    return typeof offset === 'string' && /^[+-]\d{2}:\d{2}$/.test(offset)
        ? `${wallClock}${offset}`
        : wallClock;
}

/** A shutter speed reads as "1/250" rather than as 0.004 */
function exposureTime(seconds: unknown): string | undefined {
    if (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds <= 0) {
        return undefined;
    }
    return seconds >= 1 ? `${Math.round(seconds * 10) / 10}s` : `1/${Math.round(1 / seconds)}`;
}

function text(value: unknown): string | undefined {
    return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function positive(value: unknown): number | undefined {
    return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined;
}

/**
 * Reads what the camera recorded into the picture.
 *
 * This is kept apart from the metadata the uploader sent, because the two answer different questions
 * - the uploader says what the picture is of and when they say it was taken, the camera says what it
 * actually recorded, and they are free to disagree. Only the fields worth showing are kept; the rest
 * of EXIF is maker notes and thumbnails, and stays in the original where it already lives.
 *
 * @returns what the camera wrote, or undefined when the picture carries no EXIF worth reporting
 */
function readExif(raw: Buffer | undefined): ImageExif | undefined {
    if (!raw) {
        return undefined;
    }
    let parsed;
    try {
        parsed = exifReader(raw) as {
            Image?: Record<string, unknown>;
            Photo?: Record<string, unknown>;
            GPSInfo?: Record<string, unknown>;
        };
    } catch {
        return undefined;
    }

    const image = parsed.Image ?? {};
    const photo = parsed.Photo ?? {};
    const gps = parsed.GPSInfo ?? {};

    const make = text(image.Make);
    const model = text(image.Model);
    const latitude = coordinate(gps.GPSLatitude, gps.GPSLatitudeRef);
    const longitude = coordinate(gps.GPSLongitude, gps.GPSLongitudeRef);

    const exif: ImageExif = {
        // "samsung Galaxy S25" rather than "samsung samsung Galaxy S25", since some makers repeat it
        camera: make && model
            ? (model.toLowerCase().startsWith(make.toLowerCase()) ? model : `${make} ${model}`)
            : make ?? model,
        lens: text(photo.LensModel),
        software: text(image.Software),
        takenAt: takenAt(photo),
        exposureTime: exposureTime(photo.ExposureTime),
        fNumber: positive(photo.FNumber),
        iso: positive(photo.ISOSpeedRatings ?? photo.PhotographicSensitivity),
        focalLength: positive(photo.FocalLength),
        focalLengthIn35mm: positive(photo.FocalLengthIn35mmFilm),
        location: latitude !== undefined && longitude !== undefined
            ? { lat: Number(latitude.toFixed(6)), lng: Number(longitude.toFixed(6)) }
            : undefined,
        altitude: typeof gps.GPSAltitude === 'number' && gps.GPSAltitude !== 0
            ? Math.round(gps.GPSAltitude)
            : undefined
    };

    return Object.values(exif).some(value => value !== undefined) ? exif : undefined;
}

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

export type MeasuredImage = {
    width?: number;
    height?: number;
    exif?: ImageExif;
};

/**
 * Reads the size of a stored picture and what its camera recorded into it.
 *
 * Only the header is read rather than the pixels, so this is cheap enough to do while answering a
 * request. None of it is stored alongside the metadata, because all of it is already in the picture
 * and a second copy could only ever drift from it.
 *
 * @returns what could be read, which is nothing at all when the file is gone or unreadable
 */
export async function measure(filePath: string): Promise<MeasuredImage> {
    try {
        const metadata = await sharp(filePath).metadata();
        return { width: metadata.width, height: metadata.height, exif: readExif(metadata.exif) };
    } catch {
        return {};
    }
}

/**
 * Resizes a picture to a given width, keeping its aspect ratio and its format.
 *
 * The format is read off the picture rather than asked for, so a thumbnail can only ever be the same
 * kind of file as the original - a picture is addressed as `<id>.<format>` and this service never
 * converts between one and another.
 *
 * The orientation of the original is applied rather than carried over, since the EXIF is dropped
 * along with the rest of the metadata - a thumbnail should not be handing out the photographer's
 * camera and GPS position. A picture narrower than the requested width is returned at its own size.
 */
export async function createThumbnail(content: Buffer, width: number): Promise<Buffer> {
    const image = sharp(content);
    const { format } = await image.metadata();
    if (!format || !(format in SUPPORTED_FORMATS)) {
        throw new Error(`Cannot thumbnail a ${format ?? 'file that is not a picture'}`);
    }
    return image
        .rotate()
        .resize({ width, withoutEnlargement: true })
        .toFormat(format, { quality: 85 })
        .toBuffer();
}
