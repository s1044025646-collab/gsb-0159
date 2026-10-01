# FAT16 Inspector

A Windows-local, read-only **FAT16 image directory parser and cluster-chain
consistency checker** backend. It ships only an HTTP API, a CLI, synthetic
filesystem image generation and automated tests. There is **no web UI**, no
image mounting, and **no physical-disk access**. Inputs are limited to project
files that begin with a FAT16 volume boot sector.

The parser reads little-endian BPB fields, all FAT copies, the fixed root
directory and sub-directories, rebuilds cluster chains from each entry's real
file size, and exports files without modifying the image.

## Requirements

- Node.js **>= 22.5** (developed on Node 25). Uses the built-in `node:sqlite`
  module and native TypeScript type stripping — there are **no runtime
  dependencies**; `typescript`/`tsx`/`@types/node` are dev-only.
- Windows, PowerShell. All data stays inside this project directory.

## Install

```powershell
npm install
```

## Test

```powershell
npm test          # node:test + tsx, 26 tests (parser, service/store, HTTP API)
npm run typecheck # strict TypeScript check, no emit
npm run cli gen-fixtures   # (re)create fixtures/*.img
```

Tests inject a fixed clock, use per-test temporary databases/directories, and
cover: the multi-level tree, cross-cluster files, duplicate (cross-linked)
references, broken chains, FAT-copy conflicts, loops, bad clusters, orphans,
truncated images, boundary rejection, occupancy statistics, loop termination,
export hash verification, idempotent/repeated imports, transaction rollback and
persistence after reopening the database.

## Start / stop the API

The server binds **only** to `127.0.0.1` and uses an automatic ephemeral port
(`PORT=xxxx` overrides it).

```powershell
npm run server    # writes data/server.pid and data/server.port, prints the URL
npm run stop      # stops only the pid previously recorded by this project
```

Both scripts manage only processes this project started.

## Repeatable end-to-end demo

```powershell
npm run demo
```

Generates fixtures, starts an isolated loopback server (`data/demo.db`),
imports images (showing idempotent re-import), pages entries, traces a chain,
exports a file and prints the FAT-conflict evidence offset, then shuts down.

## CLI

```powershell
npm run cli gen-fixtures
npm run cli import <image>
npm run cli images [limit] [offset]
npm run cli summary <imageId>
npm run cli ls <imageId> [kind]
npm run cli chain <imageId> <startCluster>
npm run cli issues <imageId> [code]
npm run cli export <imageId> <logicalPath> <destRelative> <sourceImage>
npm run cli compare <imageId> <scanA> <scanB>
```

`import`, `export` and the server print key before/after state. `destRelative`
must remain inside the project (e.g. `exports/x.bin`); `..` and drive-absolute
escapes are rejected with `PATH_ESCAPE`.

Examples:

```powershell
npm run cli import fixtures/normal.img
npm run cli ls 1
npm run cli chain 2 2
npm run cli export 2 /BIG.BIN exports/big.bin fixtures/crosscluster.img
npm run cli issues 3 FAT_COPY_CONFLICT
```

## HTTP API

All responses are JSON. Errors are `{ "error": { "code", "message" } }` with an
appropriate 4xx/5xx status. List endpoints accept `limit` (1..500, default 50)
and `offset` (>= 0).

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/health` | Liveness |
| POST | `/images/import` | Body `{ "path": "...", "name"?: "..." }`; idempotent by SHA-256 |
| GET | `/images?limit&offset` | Paged image list |
| GET | `/images/:id` | Image summary + volume parameters + latest scan |
| GET | `/images/:id/entries?limit&offset&kind` | Paged directory entries |
| GET | `/images/:id/chains/:start` | Cluster chain for a start cluster |
| GET | `/images/:id/issues?limit&offset&code` | Paged check issues with offsets |
| GET | `/images/:id/compare?scanA&scanB` | Per-issue-code counts and deltas |
| POST | `/export` | `{ imageId, path, dest, source }` -> read-only export into project |

Entry `kind` values: `file`, `directory`, `volume-label`, `lfn-slot`,
`deleted`, `dot`, `dotdot`. LFN slots are explicitly recorded as unsupported
and never misread as ordinary files. Deleted entries are reported as deleted
slots only; the scanner never recovers or guesses their contents.

## Consistency checks

Validation order: parse BPB → validate every derived sector boundary → read
FAT copies → walk directories → trace chains → compute occupancy. No data
region is read until the layout bounds pass.

Issue codes:

- `INVALID_BPB`, `IMAGE_TRUNCATED`, `LAYOUT_OUT_OF_BOUNDS`,
  `ROOT_SLOT_OVERFLOW`
- `FAT_COPY_CONFLICT` (each divergent entry keeps every copy's value and the
  exact byte offset; no copy is silently chosen as authoritative)
- `FAT_OUT_OF_BOUNDS`, `BAD_CLUSTER`, `CHAIN_LOOP`, `CROSS_LINKED`,
  `CHAIN_TRUNCATED`
- `ORPHAN_CLUSTER` (allocated in the FAT with no directory owner)

Chains are rebuilt to the directory entry's declared file size; zero-byte
files need no clusters, and exports are truncated to the declared size.
Directory chains are followed to EOC independently of their zero size field.

## Storage

SQLite database at `data/fat16.db` (demo uses `data/demo.db`). Schema migration
runs on every open and is idempotent (`CREATE TABLE IF NOT EXISTS`). Imports are
transactional: an identical SHA-256 reuses the existing image (`reused: true`),
and any failure rolls back so no partial image/scan rows remain.

## Layout

```
src/fat16/   BPB/FAT/directory parsing, scanner, exporter, image generator
src/db/      SQLite schema migration + query store
src/core/    service orchestration, validation and error codes
src/api/     loopback HTTP server
src/cli/     CLI commands and fixture definitions
scripts/     demo, server start/stop, smoke and migration checks
test/        automated tests
fixtures/    generated synthetic images
exports/     read-only export destination (project confined)
data/        SQLite database, pid/port files (local only)
```
