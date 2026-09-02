# Contributing

This is a small service on purpose. Before adding anything, it is worth knowing what it deliberately
does not do and why.

## Getting set up

```bash
npm install
npm run build          # generates the openapi json, then compiles
TEST_MODE=true npm start
npm run test:http      # in another shell
```

`npm run test:http` generates its fixtures first, then runs every `.http` file through
[httpyac](https://httpyac.github.io/). The tests talk to a running service on port 3000 - there is no
mocking, they exercise the real thing end to end. If the Site's docker compose is up, `user-data`
already holds port 3000, so run this service on another port and point the `@host` in `tests/*.http`
at it for the run.

## Where things live

| | |
|---|---|
| `src/index.ts` | Starts the server, creates the storage directory |
| `src/app.ts` | Every route, and the error handler |
| `src/auth.ts` | Turns an OSM access token into a user, with an LRU cache |
| `src/config.ts` | Everything read from the environment, in one place |
| `src/storage.ts` | Ids, paths on disk, reading and writing |
| `src/images.ts` | The only module that knows about `sharp` |
| `user-images.openapi.yml` | The API description, compiled to json at build for Swagger UI |
| `tests/*.http` | The whole test suite |

## Decisions worth not re-litigating

**The id is the hash of the bytes.** It gives deduplication for free, makes every url immutable and
cacheable forever, and makes an upload idempotent so a retry cannot create a second copy. It is also
why originals are never re-encoded: the file on disk has to be the file that was hashed.

**There is no database.** The metadata lives in a `.json` next to its image. Everything the service
needs to answer is reachable from an id, and an id is in the url. Adding a database would buy a
listing endpoint and nothing else. If a listing is ever needed, index into Elasticsearch alongside
the files rather than making the filesystem stop being the source of truth.

**The fan out is derived from the id, never stored in the url.** `storage.ts` and the nginx config in
the README are the only two places that know an image lives in `<first two characters>/`. That is
what makes it possible to move to a deeper tree later with a `mv` script and one changed line,
instead of rewriting OSM tags.

**Thumbnail widths are an allow list.** An arbitrary width is a way to fill a disk. Add widths to the
default in `config.ts` when the app needs them; the app currently asks for 250, 330, 960 and 1920,
and the Site's own thumbnail cache uses 100.

**The uploader comes from the OSM token, never from the request body.** This service issues no
credentials of its own. It is the reason the caller has to forward the end user's token rather than
using a service account - see "Wiring the site to it" below.

**Uploads use `multer` directly rather than `express-openapi-validator`.** The validator handles
multipart, but combining it with file uploads and `removeAdditional` is more machinery than four
fields deserve. The spec is still the documentation, it just is not enforcing the upload route.

**Express 5 routes here are regular expressions.** Express 5 dropped inline regex in path strings, and
an id and a width have to be matched exactly - anything looser lets a request walk out of the storage
directory. Numbered captures land in `req.params[0]`, `[1]`, `[2]`.

## Conventions

Same as the `user-data` repo: TypeScript with `NodeNext`, so **imports of local modules end in `.js`**
even though the files are `.ts`. Four spaces, single quotes, `async`/`await` with the handler body
wrapped in `try`/`catch` and errors passed to `next`.

Comments explain why, not what, and live on the function rather than inside it. A comment that is
about one line usually means that line wants to be its own named function.

## Adding an endpoint

1. Describe it in `user-images.openapi.yml` - that file is what the Site generates its types from.
2. Add the route to `src/app.ts`, after `authenticate` if it writes anything.
3. Add a block to `tests/images.http` with `??` assertions. A new endpoint without one will not be
   noticed when it breaks.

## Wiring the site to it

The Site talks to this service through `IImageUploadGateway`, the same interface behind its Wikimedia
Commons and Panoramax gateways, so switching hosts is a one line change in `RegisterDataAccess`. A
`MapeakImagesGateway` posts to `POST /api/images` and returns `UploadedImage(null, url)`, and the url
goes into the OSM `image` tag exactly as the Commons url does today.

Two things still open on that side:

- **The gateway needs the user's OSM token.** `UploadImage` does not currently take one, and the
  provider has it - `PointsOfInterestProvider` builds its `IAuthClient` from the logged in user. Until
  it is threaded through, uploads cannot be attributed to the right person.
- **Israel Hiking Map has the same seam.** Its own `IWikimediaCommonGateway` has an identical
  signature and one call site, so the same gateway works there and both sites end up on this service
  without either of them proxying to the other.

## Known work not done yet

- **Migrating the images that are on Wikimedia Commons.** Roughly 8,300 files across
  `Category:Israel Hiking Map` and `Category:Mapeak`. The Commons description holds the OSM display
  name of the uploader, which is what should land in `osmUser`. Then the OSM `image` tags need
  rewriting, which is a mass edit and needs a community discussion first.
- **A listing or search endpoint.** Deliberately absent, see above.
- **Serving `webp` derivatives of a `jpg` original.** Thumbnails currently keep the format of the
  original.
- **Backups.** The service does not do any. The storage directory is the whole state, and it should be
  backed up as a directory.
