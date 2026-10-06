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
mocking, they exercise the real thing end to end. If something else already holds port 3000, run
this service on another port and point the `@host` in `tests/*.http` at it for the run.

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

**Thumbnail widths are an allow list.** An arbitrary width is a way to fill a disk. An instance sets
the widths its clients actually ask for in `THUMBNAIL_WIDTHS`, and the default in `config.ts` only
changes when most instances would want the new width.

**The uploader comes from the OSM token, never from the request body.** This service issues no
credentials of its own. It is the reason a client has to forward its end user's OSM token, the one
it already holds to edit OSM on their behalf, rather than calling with a service account of its own.

**The spec is enforced, not just documented.** `express-openapi-validator` checks every request
against `user-images.openapi.yml` before it reaches a route, and reads uploads itself, so a field's
type, range or allowed values are changed in the spec rather than in `app.ts`. The routes keep only
what the spec cannot say: who may do what, and that `lat` and `lng` come together. An upload is
authenticated before the validator reads it, so an anonymous one is never held in memory.
The image route is written once per format, because the validator would match `/{id}.json` as an
image in the format `json` if it were a `{format}` parameter.

**Express 5 routes here are regular expressions.** Express 5 dropped inline regex in path strings, and
an id and a width have to be matched exactly - anything looser lets a request walk out of the storage
directory. Numbered captures land in `req.params[0]`, `[1]`, `[2]`.

## Conventions

TypeScript with `NodeNext`, so **imports of local modules end in `.js`** even though the files are
`.ts`. Four spaces, single quotes, `async`/`await` with the handler body wrapped in `try`/`catch` and
errors passed to `next`.

Comments explain why, not what, and live on the function rather than inside it. A comment that is
about one line usually means that line wants to be its own named function.

## Adding an endpoint

1. Describe it in `user-images.openapi.yml` - it is the contract clients are written against, and a
   path that is not in it is answered with a 404 before any route sees it.
2. Add the route to `src/app.ts`, after `authenticate` if it writes anything.
3. Add a block to `tests/images.http` with `??` assertions. A new endpoint without one will not be
   noticed when it breaks.
