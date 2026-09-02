import { ImageMetadata } from './storage.js';

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
export function renderImagePage(metadata: ImageMetadata, thumbnailWidths: number[]): string {
    const title = metadata.description || `Image by ${metadata.osmUser}`;
    const largestWidth = thumbnailWidths.length > 0 ? Math.max(...thumbnailWidths) : undefined;
    const previewWidth = thumbnailWidths.find(width => width >= 960) ?? largestWidth;
    const previewUrl = previewWidth ? `${metadata.url}?width=${previewWidth}` : metadata.url;
    const capturedAt = metadata.capturedAt
        ? `<dt>Taken</dt><dd>${escapeHtml(new Date(metadata.capturedAt).toISOString().slice(0, 10))}</dd>`
        : '';
    const location = metadata.location
        ? `<dt>Location</dt><dd><a href="https://www.openstreetmap.org/?mlat=${metadata.location.lat}&amp;mlon=${metadata.location.lng}#map=17/${metadata.location.lat}/${metadata.location.lng}">${metadata.location.lat}, ${metadata.location.lng}</a></dd>`
        : '';

    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>
:root { color-scheme: light dark; }
body { margin: 0; padding: 1.5rem; font: 16px/1.5 system-ui, sans-serif; max-width: 60rem; margin-inline: auto; }
img { max-width: 100%; height: auto; display: block; margin-bottom: 1rem; }
h1 { font-size: 1.25rem; font-weight: 600; }
dl { display: grid; grid-template-columns: max-content 1fr; gap: 0.25rem 1rem; }
dt { font-weight: 600; }
dd { margin: 0; }
</style>
</head>
<body>
<a href="${escapeHtml(metadata.url)}"><img src="${escapeHtml(previewUrl)}" alt="${escapeHtml(title)}" width="${metadata.width}" height="${metadata.height}"></a>
<h1>${escapeHtml(title)}</h1>
<dl>
<dt>Author</dt><dd>${authorHtml(metadata.osmUser, metadata.osmUserId)}</dd>
<dt>License</dt><dd>${licenseHtml(metadata.license)}</dd>
${capturedAt}
${location}
<dt>Uploaded</dt><dd>${escapeHtml(metadata.uploadedAt.slice(0, 10))}</dd>
<dt>File</dt><dd><a href="${escapeHtml(metadata.url)}">${metadata.width}&times;${metadata.height}, ${Math.round(metadata.size / 1024)} KB</a></dd>
</dl>
</body>
</html>
`;
}
