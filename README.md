# FAT16 Inspector

Windows-local, read-only **FAT16 image directory parser and cluster-chain consistency checker**.

- Parses little-endian BPB, all FAT copies, the fixed root directory and subdirectories.
- Rebuilds cluster chains from the **real directory file size** and exports files read-only.
- Validates sector layout, cluster counts and every offset boundary **before** touching data.
- Detects loops, cross-linked/duplicate references, premature endings, bad clusters,
  out-of-range references and allocated clusters with no directory owner.
- FAT copy disagreements are kept as **conflict evidence** (both values); no copy is silently authoritative.
- 8.3 short names are supported; long-file-name slots are explicitly flagged `LFN_UNSUPPORTED`
  and are never mistaken for ordinary files.
- Zero-byte files, `.` / `..` entries and deleted entries have distinct semantics.
  Deleted content is never guessed or "recovered", and images are never modified.

There is **no web UI, no mounting, and no physical-disk access**. Inputs are only
project-local files beginning at a FAT16 volume boot sector; exports are confined to the project.

## Requirements

- Node.js >= 22.5 (developed/tested on Node 25 on Windows).
- Only dev dependencies (`typescript`, `@types/node`). Runtime uses built-in
  `node:sqlite`; there is nothing to compile or install beyond `npm install`.

```powershell
npm install
```

## Layout

```
src/
  fat/        BPB, FAT copies, directory scan, chain walker, parser/types
  fsimage/    deterministic synthetic FAT16 image builder (fixtures only)
  db/         SQLite migrations + repository (idempotent, transactional)
  core/       service layer (import, export sandbox, run comparison)
  api/        HTTP API, bound to 127.0.0.1 with an automatic port
  cli/        command line interface
test/         node:test automated tests
scripts/      repeatable demo and project-scoped cleanup
data/         all databases, fixtures, exports and temporary artifacts
```

## Automated tests

```powershell
npm test
npm run typecheck
```

Tests cover the normal multi-level tree, cross-cluster files, duplicate references,
broken chains, loops, bad/out-of-range clusters, FAT divergence, truncated images,
boundary rejection, occupancy accounting, loop termination, idempotent re-import,
transactional persistence across a restart, pagination validation and export sandboxing.
Time is injected (`FIXED_NOW`) and fixture content is deterministic, so runs are repeatable.

## Repeatable end-to-end demo

```powershell
npm run demo
```

The demo generates nine fixtures, imports them, shows before/after counts, traces a
four-cluster chain, exports and verifies a digest, prints problem offsets, compares check
versions, then reopens the SQLite database to show persisted state.

## CLI

```powershell
npm run cli -- gen-fixtures [outDir]
npm run cli -- import <imagePath>
npm run cli -- ls <imageId> [--run N]
npm run cli -- chain <imageId> <path> [--run N]
npm run cli -- export <imageId> <path> <outRel>
npm run cli -- compare <imageId> <runA> <runB>
npm run cli -- issues <imageId> [--run N] [--sev error|warning|info]
```

`import` prints image/run counts before and after. `export` only accepts a path relative to
the project; absolute or `..` escapes are rejected with `PATH_OUTSIDE_PROJECT`.
`issues` shows concrete byte offsets, sectors and clusters for every finding.

## HTTP API

```powershell
npm run serve
```

The server listens **only on `127.0.0.1`** on an OS-assigned port printed at startup
(set `PORT` to request a specific local port).

| Method | Route | Purpose |
| --- | --- | --- |
| `GET` | `/health` | liveness / bind check |
| `POST` | `/images/import` | body `{ "path": "..." }`, idempotent by SHA-256 |
| `GET` | `/images?limit=&offset=` | paged images |
| `GET` | `/images/:id` | summary, volume params, check runs |
| `GET` | `/images/:id/entries?limit=&offset=&run=&kind=&parent=` | paged directory entries |
| `GET` | `/images/:id/clusters?limit=&offset=&run=&status=` | paged occupancy |
| `GET` | `/images/:id/chain?path=&run=` | cluster chain trace |
| `GET` | `/images/:id/issues?limit=&offset=&run=&severity=` | paged findings with offsets |
| `GET` | `/images/:id/compare?a=&b=` | added/resolved findings between runs |
| `POST` | `/images/:id/export` | body `{ "path", "output", "run?" }`, project-sandboxed |

Errors use a stable shape `{ "error": { "code", "message" } }` with codes such as
`IMAGE_NOT_FOUND`, `IMAGE_TRUNCATED`, `NOT_FAT16`, `INVALID_PAGINATION`,
`INVALID_PARAMETER`, `PATH_OUTSIDE_PROJECT`, `EXPORT_INCOMPLETE`, `RUN_NOT_FOUND`.

## Data isolation and cleanup

Everything is written under `data/`. To stop only node processes started from this project
and remove local data:

```powershell
npm run clean
```

Migrations use `IF NOT EXISTS` and are safe to re-run. Re-importing identical bytes is
idempotent: the image row is reused by SHA-256 and a new versioned check run is recorded.
