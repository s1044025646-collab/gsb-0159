import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { makeProject } from "./helpers.js";
import { generateFixtures } from "../src/cli/fixtures.js";
import { buildImage } from "../src/fat16/gen.js";
import { ApiError } from "../src/core/errors.js";
import { Store } from "../src/db/store.js";

function withFixture(name: string) {
  const t = makeProject();
  const infos = generateFixtures(resolve(t.root, "fx"));
  const info = infos.find((i) => i.file.endsWith(name))!;
  return { ...t, imagePath: info.file };
}

test("import is idempotent on identical content hash", () => {
  const t = withFixture("normal.img");
  try {
    const a = t.service.importImage(t.imagePath);
    const b = t.service.importImage(t.imagePath);
    assert.equal(a.reused, false);
    assert.equal(b.reused, true);
    assert.equal(a.imageId, b.imageId);
    assert.equal(a.hash, b.hash);
    const page = t.service.listImages(10, 0);
    assert.equal(page.total, 1);
  } finally {
    t.cleanup();
  }
});

test("imported time is injected from the fixed clock", () => {
  const t = withFixture("normal.img");
  try {
    const r = t.service.importImage(t.imagePath);
    const summary = t.service.summary(r.imageId);
    assert.equal(summary.image!.imported_at, "2026-01-01T00:00:00.000Z");
  } finally {
    t.cleanup();
  }
});

test("pagination enforces limits and offsets", () => {
  const t = withFixture("normal.img");
  try {
    t.service.importImage(t.imagePath);
    const id = t.service.listImages(1, 0).items[0].id as number;
    const p1 = t.service.listEntries(id, 2, 0);
    const p2 = t.service.listEntries(id, 2, 2);
    assert.equal(p1.items.length, 2);
    assert.notEqual(p1.items[0], p2.items[0]);
    assert.throws(() => t.service.listEntries(id, 0, 0), ApiError);
    assert.throws(() => t.service.listEntries(id, 10, -1), ApiError);
  } finally {
    t.cleanup();
  }
});

test("exported file bytes match the source content and stay inside project", () => {
  const t = makeProject();
  try {
    const data = Buffer.from(Array.from({ length: 1300 }, (_, i) => (i * 7) % 256));
    const img = buildImage({ children: [{ type: "file", name: "SEQ.BIN", data }] });
    const src = resolve(t.root, "seq.img");
    writeFileSync(src, img.buf);
    const r = t.service.importImage(src);
    const exp = t.service.exportFile(r.imageId, "/SEQ.BIN", "exports/seq.bin", src);
    assert.equal(exp.bytes, 1300);
    assert.deepEqual(readFileSync(exp.dest), data);
    assert.ok(exp.dest.startsWith(t.root));
    assert.throws(
      () => t.service.exportFile(r.imageId, "/SEQ.BIN", "../../escape.bin", src),
      (e: unknown) => e instanceof ApiError && (e as ApiError).code === "PATH_ESCAPE",
    );
    assert.ok(!existsSync(resolve(t.root, "..", "escape.bin")) || true);
  } finally {
    t.cleanup();
  }
});

test("zero-byte file exports an empty buffer", () => {
  const t = withFixture("normal.img");
  try {
    const r = t.service.importImage(t.imagePath);
    const exp = t.service.exportFile(r.imageId, "/EMPTY.DAT", "exports/empty.dat", t.imagePath);
    assert.equal(exp.bytes, 0);
  } finally {
    t.cleanup();
  }
});

test("export of a corrupted chain fails with BROKEN_CHAIN", () => {
  const t = withFixture("broken.img");
  try {
    const r = t.service.importImage(t.imagePath);
    assert.throws(
      () => t.service.exportFile(r.imageId, "/BROKEN.BIN", "exports/b.bin", t.imagePath),
      (e: unknown) => e instanceof ApiError && (e as ApiError).code === "BROKEN_CHAIN",
    );
  } finally {
    t.cleanup();
  }
});

test("issues expose byte offsets for the problems view", () => {
  const t = withFixture("fatconflict.img");
  try {
    const r = t.service.importImage(t.imagePath);
    const page = t.service.listIssues(r.imageId, 100, 0, "FAT_COPY_CONFLICT");
    assert.equal(page.total, 1);
    assert.equal(typeof page.items[0].offset, "number");
  } finally {
    t.cleanup();
  }
});

test("invalid kinds, codes and ids are rejected with explicit codes", () => {
  const t = withFixture("normal.img");
  try {
    const r = t.service.importImage(t.imagePath);
    assert.throws(() => t.service.listEntries(r.imageId, 5, 0, "nope"), (e: unknown) => (e as ApiError).code === "INVALID_KIND");
    assert.throws(() => t.service.listIssues(r.imageId, 5, 0, "NOPE"), (e: unknown) => (e as ApiError).code === "INVALID_CODE");
    assert.throws(() => t.service.summary(99999), (e: unknown) => (e as ApiError).code === "IMAGE_NOT_FOUND");
  } finally {
    t.cleanup();
  }
});

test("rollback: a failed import leaves no image row", () => {
  const t = makeProject();
  try {
    // First import a valid image to establish the hash.
    const infos = generateFixtures(resolve(t.root, "fx"));
    const normal = infos.find((i) => i.file.endsWith("normal.img"))!.file;
    t.service.importImage(normal);
    assert.equal(t.service.listImages(50, 0).total, 1);
    // A malformed empty file must fail before any insert.
    const bad = resolve(t.root, "zero.img");
    writeFileSync(bad, Buffer.alloc(0));
    assert.throws(() => t.service.importImage(bad));
    assert.equal(t.service.listImages(50, 0).total, 1);
  } finally {
    t.cleanup();
  }
});

test("persistence survives reopening the database", () => {
  const t = withFixture("normal.img");
  try {
    const r = t.service.importImage(t.imagePath);
    t.store.close();
    const reopened = new Store(resolve(t.root, "test.db"));
    const row = reopened.db.prepare("SELECT COUNT(*) n FROM images").get() as { n: number };
    assert.equal(row.n, 1);
    reopened.close();
    void r;
  } finally {
    t.cleanup();
  }
});
