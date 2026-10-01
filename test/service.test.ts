import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { makeService, tempProject, writeFixtureSet, FIXED_NOW } from "./helpers.ts";
import { validatePagination, ApiError } from "../src/core/service.ts";

describe("service, persistence, pagination and transactions", () => {
  let proj: ReturnType<typeof tempProject>;
  let paths: Record<string, string>;

  beforeEach(() => {
    proj = tempProject();
    paths = writeFixtureSet(proj.root);
  });
  afterEach(() => proj.cleanup());

  test("import is idempotent on content and adds versioned check runs", () => {
    const service = makeService(proj.root);
    const first = service.importImage(paths.normal!);
    assert.equal(first.reusedImage, false);
    const again = service.importImage(paths.normal!);
    assert.equal(again.reusedImage, true);
    assert.equal(again.imageId, first.imageId);
    const runs = service.repo.listRuns(first.imageId);
    assert.equal(runs.length, 2);
    assert.equal(runs[0]!.createdAt, FIXED_NOW);
    service.close();
  });

  test("state survives a process/restart simulation (new repository, same db)", () => {
    const service1 = makeService(proj.root);
    const imported = service1.importImage(paths.normal!);
    service1.close();
    const service2 = makeService(proj.root);
    const image = service2.repo.getImage(imported.imageId);
    assert.ok(image);
    const entries = service2.repo.listEntries(imported.imageId, null, 100, 0, null, null);
    assert.ok(entries.total >= 10);
    service2.close();
  });

  test("migrations are repeatable without error", () => {
    const a = makeService(proj.root);
    a.close();
    const b = makeService(proj.root);
    b.importImage(paths.normal!);
    b.close();
    const c = makeService(proj.root);
    assert.equal(c.repo.listImages(100, 0).total, 1);
    c.close();
  });

  test("pagination limit/offset works and invalid values are rejected", () => {
    const service = makeService(proj.root);
    const { imageId } = service.importImage(paths.normal!);
    const page1 = service.repo.listEntries(imageId, null, 5, 0, null, null);
    assert.equal(page1.items.length, 5);
    assert.ok(page1.total > 5);
    const page2 = service.repo.listEntries(imageId, null, 5, 5, null, null);
    assert.notDeepEqual(page1.items[0], page2.items[0]);
    assert.throws(() => validatePagination({ limit: 0 }), ApiError);
    assert.throws(() => validatePagination({ limit: 5000 }), ApiError);
    assert.throws(() => validatePagination({ limit: 10, offset: -2 }), ApiError);
    service.close();
  });

  test("check versions can be compared (added/resolved)", () => {
    const service = makeService(proj.root);
    const normal = service.importImage(paths.normal!);
    const secondImport = service.importImage(paths.normal!);
    assert.equal(secondImport.imageId, normal.imageId);
    const comparison = service.compareRuns(normal.imageId, 1, 2);
    assert.deepEqual(comparison.added, []);
    assert.deepEqual(comparison.resolved, []);
    service.close();
  });

  test("export is constrained inside the project and matches source bytes", () => {
    const service = makeService(proj.root);
    const { imageId } = service.importImage(paths.normal!);
    const out = service.exportImageFile(
      imageId,
      "/DOCS/DEEP/BIG.BIN",
      "out/big.bin",
      null,
    );
    assert.equal(out.bytes, 3 * 512 + 17);
    const onDisk = readFileSync(resolve(proj.root, "out/big.bin"));
    assert.equal(onDisk.length, out.bytes);
    assert.throws(
      () => service.exportImageFile(imageId, "/DOCS/DEEP/BIG.BIN", "../evil.bin", null),
      (e: Error & { code?: string }) => e.code === "PATH_OUTSIDE_PROJECT",
    );
    assert.equal(existsSync(resolve(proj.root, "..", "evil.bin")), false);
    service.close();
  });

  test("broken image import still records failure issues and remains queryable", () => {
    const service = makeService(proj.root);
    const { imageId } = service.importImage(paths.broken_chain!);
    const issues = service.repo.listIssues(imageId, null, 100, 0, "error");
    assert.ok(issues.total >= 2);
    service.close();
  });
});
