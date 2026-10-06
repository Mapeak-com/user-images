import path from 'node:path';
import Mustache from 'mustache';
import { readFileSync } from 'node:fs';
import { MeasuredImage } from './images.js';
import { ImageFormat, ImageMetadata } from './storage.js';

/**
 * The licenses a page links to. Anything else is shown as plain text, since a made up SPDX id would
 * otherwise turn into a broken link.
 */
const LICENSE_URLS: Record<string, string> = {
    'CC0-1.0': 'https://creativecommons.org/publicdomain/zero/1.0/',
    'CC-BY-4.0': 'https://creativecommons.org/licenses/by/4.0/',
    'CC-BY-3.0': 'https://creativecommons.org/licenses/by/3.0/'
};

/** Everything on the page comes from whoever uploaded the picture, so none of it can be trusted as markup */
function escapeHtml(value: string): string {
    return value
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

export type SiteSettings = {
    thumbnailWidths: number[];
    faviconUrl: string;
};

/** The pages never change while the service runs, so each template is read once */
function readTemplate(name: string): string {
    return readFileSync(path.join(__dirname, 'templates', name), 'utf8');
}

const IMAGE_TEMPLATE = readTemplate('image.html');
const HOME_TEMPLATE = readTemplate('home.html');

function render(template: string, view: object): string {
    return Mustache.render(template, view, {}, { escape: value => escapeHtml(String(value)) });
}

/**
 * What the camera recorded, or nothing when it recorded none of what the page shows.
 *
 * Every key is present even when it is empty, since a key missing from a section makes mustache look
 * it up on the page around it instead. Each is text rather than a number, because a section hides a 0.
 */
function cameraView(exif: MeasuredImage['exif']) {
    if (!exif) {
        return undefined;
    }
    const exposure = [
        exif.exposureTime,
        exif.fNumber ? `f/${exif.fNumber}` : undefined,
        exif.iso ? `ISO ${exif.iso}` : undefined
    ].filter(Boolean).join(' \u00b7 ');
    const camera = {
        model: exif.camera,
        lens: exif.lens,
        takenAt: exif.takenAt?.replace('T', ' '),
        exposure: exposure || undefined,
        focalLength: exif.focalLength
            ? `${exif.focalLength} mm`
            + (exif.focalLengthIn35mm ? ` (${exif.focalLengthIn35mm} mm equivalent)` : '')
            : undefined,
        position: exif.location,
        altitude: exif.altitude !== undefined ? `${exif.altitude} m` : undefined,
        software: exif.software
    };
    return Object.values(camera).some(Boolean) ? camera : undefined;
}

/**
 * The page a credit under an image links to, the way a wikimedia commons file page is what the credit
 * of an image taken from there links to - it shows the picture together with who took it and the
 * license it may be used under.
 */
export function renderImagePage(
    metadata: ImageMetadata,
    format: ImageFormat,
    measured: MeasuredImage,
    site: SiteSettings
): string {
    const title = `Image by ${metadata.osmUser}`;
    const { thumbnailWidths } = site;
    const largestWidth = thumbnailWidths.length > 0 ? Math.max(...thumbnailWidths) : undefined;
    const previewWidth = thumbnailWidths.find(width => width >= 960) ?? largestWidth;
    const previewUrl = previewWidth ? `${metadata.url}?width=${previewWidth}` : metadata.url;

    // A preview is never enlarged, so it is the original size whenever the picture is the smaller.
    // Without a size there is nothing to tell a browser, and the picture simply lays itself out.
    const width = measured.width && measured.height
        ? Math.min(previewWidth ?? measured.width, measured.width)
        : undefined;
    const height = width && measured.width && measured.height
        ? Math.round(measured.height * (width / measured.width))
        : undefined;

    // The page is the url without the extension, which is the one worth sharing since it carries the
    // credit and the license rather than the bare bytes.
    const pageUrl = metadata.url.replace(new RegExp(`\\.${format}$`), '');

    return render(IMAGE_TEMPLATE, {
        title,
        pageUrl,
        previewUrl,
        url: metadata.url,
        mimeType: `image/${format === 'jpg' ? 'jpeg' : format}`,
        faviconUrl: site.faviconUrl,
        size: width && height ? { width, height } : undefined,
        osmUser: metadata.osmUser,
        // An account that has since been deleted has no page left to link to, so the name is shown on its own
        authorUrl: metadata.osmUserId
            ? `https://www.openstreetmap.org/user/${encodeURIComponent(metadata.osmUser)}`
            : undefined,
        license: metadata.license,
        licenseUrl: LICENSE_URLS[metadata.license],
        location: metadata.location,
        // A date is shown to the day, since the time of day is only ever noise on a page like this
        uploaded: metadata.uploadedAt.slice(0, 10),
        camera: cameraView(measured.exif)
    });
}

/**
 * The page at the root of an instance. Whoever surfs to the bare address - usually by trimming an
 * image url they found in an OSM tag - is told what the service is, who it is for and where its code is.
 */
export function renderHomePage(publicBaseUrl: string, site: SiteSettings): string {
    return render(HOME_TEMPLATE, {
        publicBaseUrl,
        host: new URL(publicBaseUrl).host,
        faviconUrl: site.faviconUrl,
        thumbnailWidth: site.thumbnailWidths.find(width => width >= 250) ?? site.thumbnailWidths[0] ?? 250,
        widths: site.thumbnailWidths.join(', ')
    });
}
