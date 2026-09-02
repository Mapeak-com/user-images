import { MeasuredImage } from './images.js';
import { ImageFormat, ImageMetadata } from './storage.js';

/**
 * The licenses a page links to. Anything else is shown as plain text, since a made up SPDX id would
 * otherwise turn into a broken link.
 */
const LICENSE_URLS: Record<string, string> = {
    'CC0-1.0': 'https://creativecommons.org/publicdomain/zero/1.0/',
    'CC-BY-4.0': 'https://creativecommons.org/licenses/by/4.0/',
    'CC-BY-SA-4.0': 'https://creativecommons.org/licenses/by-sa/4.0/'
};

/** Everything on the page comes from whoever uploaded the picture, so none of it can be trusted as markup */
function escapeHtml(value: string): string {
    return value
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

/**
 * Links the author to their OSM page, unless the picture was imported for an account that is no longer
 * there, in which case there is nothing to link to and the name is shown on its own.
 */
function authorHtml(osmUser: string, osmUserId?: string): string {
    return osmUserId
        ? `<a href="https://www.openstreetmap.org/user/${encodeURIComponent(osmUser)}">${escapeHtml(osmUser)}</a>`
        : escapeHtml(osmUser);
}

function rowHtml(label: string, value?: string): string {
    return value ? `<dt>${escapeHtml(label)}</dt><dd>${value}</dd>` : '';
}

function coordinatesHtml(location: { lat: number; lng: number }): string {
    const { lat, lng } = location;
    return `<a href="https://mapeak.com/map/15/${lat}/${lng}"> ${lat}, ${lng} </a>`;
}

/** A date is shown to the day, since the time of day is only ever noise on a page like this */
function day(value: string): string {
    return escapeHtml(value.slice(0, 10));
}

/**
 * What the camera recorded, kept in a section of its own.
 *
 * The point of separating it is that everything above it is what the uploader said, and this is what
 * the picture itself says - so a date or a position that disagrees is visible rather than hidden.
 */
function exifHtml(exif: MeasuredImage['exif']): string {
    if (!exif) {
        return '';
    }
    const exposure = [
        exif.exposureTime,
        exif.fNumber ? `f/${exif.fNumber}` : undefined,
        exif.iso ? `ISO ${exif.iso}` : undefined
    ].filter(Boolean).join(' &middot; ');
    const focalLength = exif.focalLength
        ? `${exif.focalLength} mm`
        + (exif.focalLengthIn35mm ? ` (${exif.focalLengthIn35mm} mm equivalent)` : '')
        : undefined;

    const rows = [
        rowHtml('Camera', exif.camera && escapeHtml(exif.camera)),
        rowHtml('Lens', exif.lens && escapeHtml(exif.lens)),
        rowHtml('Taken', exif.takenAt && escapeHtml(exif.takenAt.replace('T', ' '))),
        rowHtml('Exposure', exposure || undefined),
        rowHtml('Focal length', focalLength),
        rowHtml('Position', exif.location && coordinatesHtml(exif.location)),
        rowHtml('Altitude', exif.altitude !== undefined ? `${exif.altitude} m` : undefined),
        rowHtml('Software', exif.software && escapeHtml(exif.software))
    ].filter(Boolean);

    return rows.length === 0 ? '' : `
<h2>From the camera (exif data)</h2>
<dl>
${rows.join('\n')}
</dl>`;
}

function licenseHtml(license: string): string {
    const url = LICENSE_URLS[license];
    return url
        ? `<a href="${escapeHtml(url)}" rel="license">${escapeHtml(license)}</a>`
        : escapeHtml(license);
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
    thumbnailWidths: number[]
): string {
    const title = `Image by ${metadata.osmUser}`;
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
    const sizeAttributes = width && height ? ` width="${width}" height="${height}"` : '';

    // The page is the url without the extension, which is the one worth sharing since it carries the
    // credit and the license rather than the bare bytes.
    const pageUrl = metadata.url.replace(new RegExp(`\\.${format}$`), '');
    const description = `A picture by ${metadata.osmUser}, ${metadata.license}`;

    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(title)}</title>
<meta name="description" content="${escapeHtml(description)}">
<link rel="canonical" href="${escapeHtml(pageUrl)}">
<meta property="og:type" content="article">
<meta property="og:title" content="${escapeHtml(title)}">
<meta property="og:description" content="${escapeHtml(description)}">
<meta property="og:url" content="${escapeHtml(pageUrl)}">
<meta property="og:image" content="${escapeHtml(previewUrl)}">
<meta property="og:image:type" content="image/${format === 'jpg' ? 'jpeg' : format}">${width && height ? `
<meta property="og:image:width" content="${width}">
<meta property="og:image:height" content="${height}">` : ''}
<meta property="og:image:alt" content="${escapeHtml(title)}">
<meta name="twitter:card" content="summary_large_image">
<style>
:root { color-scheme: light dark; }
body { margin: 0; padding: 1.5rem; font: 16px/1.5 system-ui, sans-serif; max-width: 60rem; margin-inline: auto; }
img { max-width: 100%; height: auto; display: block; margin-bottom: 1rem; }
h1 { font-size: 1.25rem; font-weight: 600; }
h2 { font-size: 1rem; font-weight: 600; margin-bottom: 0.25rem; }
dl { display: grid; grid-template-columns: max-content 1fr; gap: 0.25rem 1rem; }
dt { font-weight: 600; }
dd { margin: 0; }
.note { margin: 0 0 0.75rem; opacity: 0.7; font-size: 0.875rem; }
</style>
</head>
<body>
<a href="${escapeHtml(metadata.url)}"><img src="${escapeHtml(previewUrl)}" alt="${escapeHtml(title)}"${sizeAttributes}></a>
<h1>${escapeHtml(title)}</h1>
<dl>
${[
            rowHtml('Author', authorHtml(metadata.osmUser, metadata.osmUserId)),
            rowHtml('License', licenseHtml(metadata.license)),
            rowHtml('Location', metadata.location && coordinatesHtml(metadata.location)),
            rowHtml('Uploaded', day(metadata.uploadedAt))
        ].filter(Boolean).join('\n')}
</dl>${exifHtml(measured.exif)}
</body>
</html>
`;
}
