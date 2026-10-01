import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startServer } from "../src/api/server.js";
import { generateFixtures } from "../src/cli/fixtures.js";
import { buildImage } from "../src/fat16/gen.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const j = async (r: Response): Promise<any> => r.json();

async function harness() {
  const root = mkdtempSync(join(tmpdir(), "fat16-api-"));
  const infos = generateFixtures(resolve(root, "fx"));
  const dbPath = resolve(root, "api.db");
  const { port, close } = await startServer({ dbPath, projectRoot: root, port: 0 });
  const base = `http://127.0.0.1:${port}`;
  return {
    root,
    base,
    image: (n: string) => infos.find((i) => i.file.endsWith(n))!.file,
    stop: () =>
      new Promise<void>((res) => {
        close();
        setTimeout(() => {
          for (let i = 0; i < 5; i++) {
            try {
              rmSync(root, { recursive: true, force: true });
              break;
            } catch {
              const end = Date.now() + 100;
              while (Date.now() < end) {}
            }
          }
          res();
        }, 50);
      }),
  };
}

test("health, import, list, chain, issues and export over HTTP", async () => {
  const h = await harness();
  try {
    const health = await j(await fetch(`${h.base}/health`));
    assert.equal(health.status, "ok");

    const imp = await j(
      await fetch(`${h.base}/images/import`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ path: h.image("crosscluster.img") }),
      }),
    );
    assert.equal(imp.issueCount, 0);
    const imageId = imp.imageId;

    const entries = await j(await fetch(`${h.base}/images/${imageId}/entries?limit=1&offset=0`));
    assert.equal(entries.limit, 1);
    assert.equal(entries.items.length, 1);

    const chain = await j(await fetch(`${h.base}/images/${imageId}/chains/2`));
    assert.deepEqual(chain.clusters, [2, 3, 4]);

    const exp = await j(
      await fetch(`${h.base}/export`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          imageId,
          path: "/BIG.BIN",
          dest: "exports/big.bin",
          source: h.image("crosscluster.img"),
        }),
      }),
    );
    assert.equal(exp.bytes, 1300);
  } finally {
    await h.stop();
  }
});

test("error codes and HTTP statuses are explicit", async () => {
  const h = await harness();
  try {
    const missing = await fetch(`${h.base}/images/9999`);
    assert.equal(missing.status, 404);
    assert.equal((await j(missing)).error.code, "IMAGE_NOT_FOUND");

    const badLimit = await fetch(`${h.base}/images?limit=99999`);
    assert.equal(badLimit.status, 400);
    assert.equal((await j(badLimit)).error.code, "INVALID_LIMIT");

    const badJson = await fetch(`${h.base}/images/import`, { method: "POST", body: "{not json" });
    assert.equal(badJson.status, 400);
    assert.equal((await j(badJson)).error.code, "INVALID_JSON");

    const notFoundRoute = await fetch(`${h.base}/nope`);
    assert.equal(notFoundRoute.status, 404);
  } finally {
    await h.stop();
  }
});

test("FAT conflict image surfaces conflict issue via API", async () => {
  const h = await harness();
  try {
    const imp = await j(
      await fetch(`${h.base}/images/import`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ path: h.image("fatconflict.img") }),
      }),
    );
    const issues = await j(await fetch(`${h.base}/images/${imp.imageId}/issues?code=FAT_COPY_CONFLICT`));
    assert.equal(issues.total, 1);
    assert.equal(typeof issues.items[0].offset, "number");
  } finally {
    await h.stop();
  }
});

test("server binds loopback and chooses an automatic ephemeral port", async () => {
  const root = mkdtempSync(join(tmpdir(), "fat16-bind-"));
  const dbPath = resolve(root, "b.db");
  const { port, close } = await startServer({ dbPath, projectRoot: root, port: 0 });
  assert.ok(port > 0 && port < 65536);
  const img = buildImage({ children: [] });
  writeFileSync(resolve(root, "e.img"), img.buf);
  close();
  for (let i = 0; i < 5; i++) {
    try {
      rmSync(root, { recursive: true, force: true });
      break;
    } catch {
      const end = Date.now() + 100;
      while (Date.now() < end) {}
    }
  }
});
