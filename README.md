# user-images

A microservice that stores the images users attach to points of interest, and serves them at a stable
url that an OSM entity can hold in its `image` tag.

It exists so that a site whose users contribute pictures to OSM does not have to depend on someone
else's image host for them.

## How an image is addressed

The id of an image is the hash of its bytes, truncated to 32 hexadecimal characters:

```
https://images.mapeak.com/3a7f9c2e1b4d0a95f60c2d3e4f501b6c.jpg
```

- **The same picture uploaded twice gets the same id**, so uploading it again returns the existing
  image rather than storing a second copy.
- **The bytes behind a url never change**, so everything is served `immutable` and can be cached
  forever, by browsers and by apps.

Every size of a picture is the same url with `?width=` appended, so whoever holds `<id>.jpg` never has
to build a second kind of url.

## Endpoints

| | |
|---|---|
| `GET /` | A page telling whoever surfs to the bare address what this is and where its code is |
| `POST /api/images` | Upload. Needs an OSM access token, the uploader is taken from it |
| `DELETE /api/images/:id` | Delete, for the uploader or a moderator |
| `GET /:id.jpg` | The original, byte for byte as it was uploaded (also `.png` and `.webp`) |
| `GET /:id.jpg?width=250` | A thumbnail, at one of the widths in `THUMBNAIL_WIDTHS` |
| `GET /:id.json` | The metadata, including who should be credited |
| `GET /:id` | The page of the image: the picture, who took it, its license and what its camera recorded. This is what a credit should link to |
| `GET /favicon.ico` | Redirects to `FAVICON_URL` |
| `GET /health` | Liveness |
| `GET /api-docs` | Swagger UI, the full description of every request and response |

Every request is validated against the API description, and a malformed one is refused with a 400
that says which field is wrong.

### Who an image is credited to

The uploader is always taken from the OSM access token and never from a field in the request, so an
image cannot be attributed to someone who did not send it. **The caller must forward the end user's
OSM token**, which is the token the site already holds in order to edit OSM on their behalf.

A moderator - an account listed in `ADMIN_OSM_USER_IDS` - is the one exception, and may send
`osmUser`, `osmUserId` and `uploadedAt` along with the file. That exists so an archive that already
lives somewhere else can be moved here with the people who actually took the pictures still on them.
What a moderator states is not verified. Anyone else sending those fields gets a 403.

## Licenses

An upload may only be stored under `CC0-1.0`, `CC-BY-4.0` or `CC-BY-3.0`, and anything else is
refused with a 400. An upload that does not state one is stored under `DEFAULT_LICENSE`.

The list is closed and holds permissive licenses alone, because a picture is only worth holding in an
OSM tag if whoever reads it there is free to show it. Share alike and non commercial licenses put
conditions on whatever shows the picture, and a picture already in a tag cannot be taken back quietly.

## Configuration

Everything is set through environment variables, and every one of them is optional.

| Variable | Default | Meaning |
|---|---|---|
| `PORT` | `3000` | The port the service listens on |
| `STORAGE_DIR` | `./data`, `/data/images` in the Docker image | Where images, metadata and thumbnails are kept. This directory is the whole state of the service |
| `PUBLIC_BASE_URL` | `http://localhost:3000` | The address the images are served from, used to build the url an OSM entity will hold. Set it to the public address in production, without a trailing slash |
| `THUMBNAIL_WIDTHS` | `100,250,330,500,960,1920` | The widths, in pixels and separated by commas, that `?width=` may ask for. Any other width is refused, so that nobody can fill the disk with sizes no one uses |
| `MAX_UPLOAD_BYTES` | `20971520` (20 MB) | The largest file an upload may be. A larger one is refused with a 413 |
| `DEFAULT_LICENSE` | `CC0-1.0` | The license an upload is stored under when it does not state one. One of `CC0-1.0`, `CC-BY-4.0` or `CC-BY-3.0`, the [licenses](#licenses) an upload may state |
| `FAVICON_URL` | `https://mapeak.com/content/favicons/favicon.ico` | The icon a browser tab shows for the pages and pictures of this instance. Empty for none |
| `ADMIN_OSM_USER_IDS` | empty | OSM user ids, separated by commas, of the moderators. A moderator may delete any image and state who an uploaded image belongs to |
| `TEST_MODE` | `false` | `true` accepts `TEST_TOKEN` and `TEST_ADMIN_TOKEN` as logins, for the http tests. **Never set it in production**, it lets anyone upload and delete |

## Running it

With Docker:

    docker build . -t mapeak/user-images
    docker run --rm -it -p 3000:3000 -v user-images:/data/images -e PUBLIC_BASE_URL=http://localhost:3000 mapeak/user-images

Or without:

    npm install
    npm run build
    npm start

If the port is already taken the service says so and exits, set `PORT` to another one.

## In production

nginx serves the originals and the already generated thumbnails straight from disk, and only reaches
the service for uploads, pages and a thumbnail that does not exist yet. The read path therefore has no
application in it at all.

```nginx
server {
    listen 80;
    server_name images.mapeak.com;
    root /srv/user-images;
    client_max_body_size 20m;

    # A picture, its metadata or an already generated thumbnail is served from disk, and anything
    # missing is handed to the service, which generates a thumbnail the first time it is asked for.
    location ~ "^/(?<bucket>[0-9a-f]{2})(?<rest>[0-9a-f]{30})\.(?<ext>jpg|png|webp|json)$" {
        expires max;
        add_header Cache-Control "public, immutable";

        set $stored /$bucket/$bucket$rest.$ext;
        if ($arg_width) {
            set $stored /thumb/$bucket/$bucket$rest/${arg_width}px.$ext;
        }
        try_files $stored @service;
    }

    location / {
        proxy_pass http://user-images:3000;
    }

    location @service {
        proxy_pass http://user-images:3000;
    }
}
```

`root` must point at the same directory the service has as `STORAGE_DIR`, and `client_max_body_size`
should be at least `MAX_UPLOAD_BYTES`.

### Backups

The service does not make any. `STORAGE_DIR` is its whole state, and backing it up as a directory is
enough. Its `thumb` directory can be left out: everything in it can be deleted at any time and is
generated again when it is next asked for.
