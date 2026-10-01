/**
 * Repeatable end-to-end demo:
 * 1. generate synthetic fixtures into fixtures/
 * 2. start the loopback API on an automatic port
 * 3. import, list, trace, export and compare over HTTP
 * 4. print before/after state and shut down (this project's process only)
 */
import { rmSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { startServer } from "../src/api/server.js";
import { generateFixtures } from "../src/cli/fixtures.js";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");
const dbPath = resolve(root, "data", "demo.db");

async function call(base: string, path: string, init?: RequestInit) {
  const r = await fetch(`${base}${path}`, {
    headers: { "content-type": "application/json" },
    ...init,
  });
  const body = await r.json();
  if (!r.ok) throw new Error(`${r.status} ${JSON.stringify(body)}`);
  return body as Record<string, unknown>;
}

for (const p of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) {
  rmSync(p, { force: true });
}

console.log("== generating fixtures ==");
const fixtures = generateFixtures();
console.log(`generated ${fixtures.length} images into fixtures/`);

const server = await startServer({ dbPath, projectRoot: root, port: 0 });
console.log(`== API ready on http://127.0.0.1:${server.port} ==`);
const base = `http://127.0.0.1:${server.port}`;

try {
  const normal = fixtures.find((f) => f.file.endsWith("normal.img"))!.file;
  const cross = fixtures.find((f) => f.file.endsWith("crosscluster.img"))!.file;
  const conflict = fixtures.find((f) => f.file.endsWith("fatconflict.img"))!.file;

  console.log("\n-- import normal (first submission) --");
  const a = (await call(base, "/images/import", { method: "POST", body: JSON.stringify({ path: normal }) })) as {
    imageId: number;
    reused: boolean;
    issueCount: number;
  };
  console.log(a);

  console.log("\n-- import normal again (must be idempotent) --");
  const a2 = await call(base, "/images/import", { method: "POST", body: JSON.stringify({ path: normal }) });
  console.log({ imageId: a2.imageId, reused: a2.reused });

  console.log("\n-- list directory entries (paged, 5 at a time) --");
  const page = await call(base, `/images/${a.imageId}/entries?limit=5&offset=0`);
  console.log(`total=${page.total} returned=${(page.items as unknown[]).length}`);

  console.log("\n-- import cross-cluster file and trace its chain --");
  const x = (await call(base, "/images/import", { method: "POST", body: JSON.stringify({ path: cross }) })) as {
    imageId: number;
  };
  const chain = await call(base, `/images/${x.imageId}/chains/2`);
  console.log("clusters:", chain.clusters);

  console.log("\n-- export the 1300-byte file, verify length --");
  const exp = await call(base, "/export", {
    method: "POST",
    body: JSON.stringify({
      imageId: x.imageId,
      path: "/BIG.BIN",
      dest: "exports/demo-big.bin",
      source: cross,
    }),
  });
  console.log({ bytes: exp.bytes, sha256: exp.sha256 });

  console.log("\n-- import FAT-conflict image and inspect the conflict offset --");
  const c = (await call(base, "/images/import", { method: "POST", body: JSON.stringify({ path: conflict }) })) as {
    imageId: number;
  };
  const issues = await call(base, `/images/${c.imageId}/issues?code=FAT_COPY_CONFLICT`);
  console.log((issues.items as Record<string, unknown>[])[0]);

  console.log("\nDEMO OK");
} finally {
  server.close();
}
