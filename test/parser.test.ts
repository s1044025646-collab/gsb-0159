import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parseImage, exportFile, occupancyStats } from "../src/fat/parser.ts";
import { makeService, tempProject, writeFixtureSet } from "./helpers.ts";

describe("FAT16 parser and checker", () => {
  let proj: ReturnType<typeof tempProject>;
  let paths: Record<string, string>;

  beforeEach(() => {
    proj = tempProject();
    paths = writeFixtureSet(proj.root);
  });
  afterEach(() => proj.cleanup());

  test("parses BPB, multi-level dirs and a cross-cluster file", () => {
    const buf = readFileSync(paths.normal!);
    const r = parseImage(buf, { imagePath: paths.normal! });
    assert.equal(r.params.fatType, "FAT16");
    assert.equal(r.params.numberOfFats, 2);
    assert.ok(r.params.totalClusters >= 4085);
    const big = r.entries.find((e) => e.path === "/DOCS/DEEP/BIG.BIN")!;
    assert.equal(big.fileSize, 3 * 512 + 17);
    const chain = r.chains.find((c) => c.path === big.path)!;
    assert.equal(chain.chain.length, 4);
    assert.equal(chain.terminated, true);
    assert.equal(chain.expectedClustersFromSize, 4);
  });

  test("zero byte file has independent semantics and no clusters", () => {
    const r = parseImage(readFileSync(paths.normal!), { imagePath: "x" });
    const empty = r.entries.find((e) => e.path === "/DOCS/EMPTY.DAT")!;
    assert.equal(empty.fileSize, 0);
    assert.equal(empty.firstCluster, 0);
    const { data } = exportFile(readFileSync(paths.normal!), r, empty);
    assert.equal(data.length, 0);
  });

  test("dot entries are parsed as directories but never recursed", () => {
    const r = parseImage(readFileSync(paths.normal!), { imagePath: "x" });
    const dots = r.entries.filter((e) => e.shortName === "." || e.shortName === "..");
    assert.ok(dots.length >= 4);
    assert.ok(dots.every((d) => d.kind === "directory"));
  });

  test("deleted entry has distinct kind and content is never restored", () => {
    const r = parseImage(readFileSync(paths.normal!), { imagePath: "x" });
    const gone = r.entries.find((e) => e.shortName === "ONE.TXT")!;
    assert.equal(gone.kind, "deleted");
    assert.equal(gone.deleted, true);
    assert.ok(!r.chains.some((c) => c.path === gone.path));
  });

  test("LFN slots are flagged unsupported and not read as files", () => {
    const r = parseImage(readFileSync(paths.normal!), { imagePath: "x" });
    const lfnSlots = r.entries.filter((e) => e.kind === "lfn-unsupported");
    assert.ok(lfnSlots.length >= 1);
    assert.ok(lfnSlots.every((s) => s.partOfUnsupportedLfn));
    const file = r.entries.find((e) => e.path === "/DOCS/LONG.TXT");
    assert.equal(file!.partOfUnsupportedLfn, true);
    assert.equal(file!.kind, "file");
    assert.ok(r.issues.some((i) => i.code === "LFN_UNSUPPORTED"));
  });

  test("export reconstructs bytes exactly to the declared file size", () => {
    const buf = readFileSync(paths.normal!);
    const r = parseImage(buf, { imagePath: "x" });
    const big = r.entries.find((e) => e.path === "/DOCS/DEEP/BIG.BIN")!;
    const { data, issues } = exportFile(buf, r, big);
    assert.equal(issues.filter((i) => i.severity === "error").length, 0);
    assert.equal(data.length, 3 * 512 + 17);
    assert.ok(data.subarray(0, 100).every((b) => b === 0x58));
  });

  test("detects truncated chain and orphaned allocated clusters", () => {
    const r = parseImage(readFileSync(paths.broken_chain!), { imagePath: "x" });
    assert.ok(r.issues.some((i) => i.code === "CHAIN_TRUNCATED"));
    assert.ok(r.issues.some((i) => i.code === "ORPHAN_ALLOCATED_CLUSTER"));
  });

  test("detects duplicate (cross-linked) cluster references with both owners", () => {
    const r = parseImage(readFileSync(paths.duplicate_ref!), { imagePath: "x" });
    const cross = r.issues.find((i) => i.code === "CHAIN_CROSS_LINKED");
    assert.ok(cross);
    assert.match(cross!.message, /README\.TXT/);
    assert.match(cross!.message, /EMPTY\.DAT/);
  });

  test("loop in a cluster chain terminates and is reported", () => {
    const r = parseImage(readFileSync(paths.loop!), { imagePath: "x" });
    assert.ok(r.issues.some((i) => i.code === "CHAIN_LOOP"));
  });

  test("out of range and bad cluster references are reported", () => {
    const oob = parseImage(readFileSync(paths.oob!), { imagePath: "x" });
    assert.ok(oob.issues.some((i) => i.code === "CLUSTER_INDEX_OUT_OF_RANGE"));
    const bad = parseImage(readFileSync(paths.bad!), { imagePath: "x" });
    assert.ok(bad.issues.some((i) => i.code === "BAD_CLUSTER_REFERENCED"));
  });

  test("FAT copy divergence retains both values as evidence", () => {
    const r = parseImage(readFileSync(paths.fat_conflict!), { imagePath: "x" });
    const div = r.issues.filter((i) => i.code === "FAT_COPIES_DIVERGE");
    assert.ok(div.length >= 1);
    const ev = div[0]!.evidence as { copy0: number; copy1: number };
    assert.notEqual(ev.copy0, ev.copy1);
  });

  test("truncated image is rejected before data access", () => {
    const r = parseImage(readFileSync(paths.truncated!), { imagePath: "x" });
    assert.ok(r.issues.some((i) => i.code === "IMAGE_TRUNCATED" && i.severity === "error"));
    assert.equal(r.entries.length, 0);
  });

  test("sub-sector image is rejected with a bounds error", () => {
    const r = parseImage(readFileSync(paths.tiny!), { imagePath: "x" });
    assert.ok(r.issues.some((i) => i.code === "IMAGE_TRUNCATED"));
  });

  test("occupancy statistics account for every cluster", () => {
    const r = parseImage(readFileSync(paths.normal!), { imagePath: "x" });
    const stats = occupancyStats(r.clusters);
    const total =
      stats.free! + stats.allocated! + stats.eoc! + stats.bad! + stats.reserved!;
    assert.equal(total, r.params.totalClusters + 2);
    // GONE.TXT is deleted (never restored) yet its cluster remains FAT-allocated:
    // exactly the kind of orphan-allocated cluster the checker must surface.
    assert.ok((stats.orphan ?? 0) >= 1);
  });

  test("service rejects imports and exports escaping the project sandbox", () => {
    const service = makeService(proj.root);
    try {
      assert.throws(
        () => service.importImage("../outside.img"),
        (e: Error & { code?: string }) => e.code === "PATH_OUTSIDE_PROJECT",
      );
    } finally {
      service.close();
    }
  });
});


