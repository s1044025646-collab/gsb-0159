import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { resolve } from "node:path";
import { startServer } from "../src/api/server.ts";
import { tempProject, writeFixtureSet } from "./helpers.ts";

describe("HTTP API", () => {
  let proj: ReturnType<typeof tempProject>;
  let handle: Awaited<ReturnType<typeof startServer>>;
  let paths: Record<string, string>;

  beforeEach(async () => {
    proj = tempProject();
    paths = writeFixtureSet(proj.root);
    handle = await startServer(resolve(proj.root, "data", "api.db"), 0, proj.root);
  });
  afterEach(async () => {
    await handle.close();
    proj.cleanup();
  });

  async function call(method: string, route: string, body?: unknown): Promise<{
    status: number; json: any;
  }> {
    const res = await fetch(`http://127.0.0.1:${handle.port}${route}`, {
      method,
      headers: { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const json = await res.json();
    return { status: res.status, json };
  }

  test("health binds to localhost only", async () => {
    const r = await call("GET", "/health");
    assert.equal(r.status, 200);
    assert.equal(r.json.bound, "127.0.0.1");
  });

  test("full import/list/chain/export flow and error codes", async () => {
    const rel = "fixtures/normal.img";
    const imp = await call("POST", "/images/import", { path: rel });
    assert.equal(imp.status, 200);
    const id = imp.json.imageId;

    const missing = await call("POST", "/images/import", { path: "fixtures/nope.img" });
    assert.equal(missing.status, 404);
    assert.equal(missing.json.error.code, "IMAGE_NOT_FOUND");

    const badBody = await call("POST", "/images/import", { path: 123 });
    assert.equal(badBody.status, 400);
    assert.equal(badBody.json.error.code, "INVALID_PARAMETER");

    const entries = await call("GET", `/images/${id}/entries?limit=3&offset=0`);
    assert.equal(entries.json.items.length, 3);
    assert.equal(entries.json.limit, 3);

    const badPaging = await call("GET", `/images/${id}/entries?limit=9999`);
    assert.equal(badPaging.status, 400);
    assert.equal(badPaging.json.error.code, "INVALID_PAGINATION");

    const chain = await call("GET", `/images/${id}/chain?path=/DOCS/DEEP/BIG.BIN`);
    assert.equal(chain.status, 200);
    assert.deepEqual(JSON.parse(chain.json.chain_clusters).length, 4);

    const exported = await call("POST", `/images/${id}/export`, {
      path: "/DOCS/DEEP/BIG.BIN",
      output: "out/big.bin",
    });
    assert.equal(exported.status, 200);
    assert.equal(exported.json.bytes, 3 * 512 + 17);

    const escape = await call("POST", `/images/${id}/export`, {
      path: "/DOCS/DEEP/BIG.BIN",
      output: "../escape.bin",
    });
    assert.equal(escape.json.error.code, "PATH_OUTSIDE_PROJECT");

    const issues = await call("GET", `/images/${id}/issues?severity=warning`);
    assert.ok(issues.json.items.every((i: { severity: string }) => i.severity === "warning"));
  });

  test("duplicate import is idempotent via the API", async () => {
    const a = await call("POST", "/images/import", { path: "fixtures/normal.img" });
    const b = await call("POST", "/images/import", { path: "fixtures/normal.img" });
    assert.equal(a.json.imageId, b.json.imageId);
    assert.equal(b.json.reusedImage, true);
  });

  test("unknown routes and invalid JSON are rejected cleanly", async () => {
    const res = await fetch(`http://127.0.0.1:${handle.port}/nope`);
    assert.equal(res.status, 404);
    const res2 = await fetch(`http://127.0.0.1:${handle.port}/images/import`, {
      method: "POST",
      body: "{not json",
      headers: { "content-type": "application/json" },
    });
    const j = await res2.json();
    assert.equal(j.error.code, "INVALID_JSON");
  });
});
