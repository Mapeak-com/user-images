/**
 * Every setting of the service, read once from the environment.
 * See the README for what each of them means and what a production deployment should set.
 */
export const config = {
    port: Number(process.env.PORT ?? 3000),
    /** The directory holding the images, their metadata and the generated thumbnails */
    storageDir: process.env.STORAGE_DIR ?? './data',
    /** The address the images are served from, used to build the url an OSM entity will hold */
    publicBaseUrl: (process.env.PUBLIC_BASE_URL ?? 'http://localhost:3000').replace(/\/+$/, ''),
    /**
     * The thumbnail widths this service is willing to generate.
     * An arbitrary width would let anyone fill the disk with derivatives, so the widths are an allow list.
     */
    thumbnailWidths: (process.env.THUMBNAIL_WIDTHS ?? '100,250,330,500,960,1920')
        .split(',')
        .map(width => Number(width.trim()))
        .filter(width => Number.isInteger(width) && width > 0),
    maxUploadBytes: Number(process.env.MAX_UPLOAD_BYTES ?? 20 * 1024 * 1024),
    /**
     * The icon the image pages show in a browser tab. It points at the site the instance belongs to
     * rather than being served from here, since this service holds users' pictures and nothing of
     * its own. Empty leaves the pages without one.
     */
    faviconUrl: process.env.FAVICON_URL ?? 'https://mapeak.com/content/favicons/favicon.ico',
    /** The license an upload is stored under when it does not state one of its own */
    defaultLicense: process.env.DEFAULT_LICENSE ?? 'CC0-1.0',
    /** OSM user ids that are allowed to delete images they did not upload, for moderation */
    adminOsmUserIds: (process.env.ADMIN_OSM_USER_IDS ?? '')
        .split(',')
        .map(id => id.trim())
        .filter(id => id.length > 0),
    /** Accepts "TEST_TOKEN" as a valid login, so that the http tests can run without an OSM account */
    testMode: process.env.TEST_MODE === 'true'
};

