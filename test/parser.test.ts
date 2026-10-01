import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { scanImage } from "../src/fat16/scanner.js";
import { buildImage, setFatEntry } from "../src/fat16/gen.js";
import { readFileBytes } from "../src/fat16/export.js";
import { validate83 } from "../src/fat16/dir.js";
import { codes } from "./helpers.js";

const here = dirname(fileURLToPath(import.meta.url));
const fx = (n: string) => resolve(here, "..", "fixtures", n);
const load = (n: string) => scanImage(readFileSync(fx(n)));

test("normal image: multi-level tree, zero-byte, label, deleted and dot semantics", () => {
  const s = load("normal.img");
  assert.equal(codes(s).length, 0, `unexpected issues: ${JSON.stringify(codes(s))}`);
  const kinds = new Map(s.entries.map((e) => [e.path, e.kind]));
  assert.equal(kinds.get("/README.TXT"), "file");
  assert.equal(kinds.get("/EMPTY.DAT"), "file");
  assert.equal(kinds.get("/SUBDIR"), "directory");
  assert.equal(kinds.get("/SUBDIR/A.TXT"), "file");
  assert.equal(kinds.get("/SUBDIR/DEEP/B.LOG"), "file");
  assert.ok([...kinds.values()].includes("volume-label"));
  assert.ok([...kinds.values()].includes("deleted"));
  assert.ok([...kinds.values()].includes("dot"));
  assert.ok([...kinds.values()].includes("dotdot"));

  const empty = s.entries.find((e) => e.path === "/EMPTY.DAT")!;
  assert.equal(empty.fileSize, 0);
  assert.equal(empty.firstCluster, 0);
  const deleted = s.entries.find((e) => e.kind === "deleted")!;
  assert.equal(deleted.deleted, true);
  assert.equal(deleted.shortName, null);
});

test("cross-cluster file spans exactly ceil(size/cluster) clusters", () => {
  const s = load("crosscluster.img");
  const chain = s.chains.get(2)!;
  assert.equal(chain.clusters.length, 3);
  assert.equal(chain.expectedClusters, 3);
  assert.ok(chain.terminator !== null && chain.terminator >= 0xfff8);
});

test("export rebuilds bytes truncated to the real file size and matches source", () => {
  const data = Buffer.from(Array.from({ length: 1300 }, (_, i) => i % 251));
  const img = buildImage({ children: [{ type: "file", name: "DAT.BIN", data }] });
  const s = scanImage(img.buf);
  const bytes = readFileBytes(img.buf, s, "/DAT.BIN");
  assert.equal(bytes.length, 1300);
  assert.deepEqual(bytes, data);
  const small = readFileBytes(img.buf, s, "/DAT.BIN").subarray(0, 17);
  assert.equal(small.length, 17);
});

test("cross-linked fixture reports CROSS_LINKED with both owners", () => {
  const s = load("crosslink.img");
  assert.ok(codes(s).includes("CROSS_LINKED"));
  const issue = s.issues.find((i) => i.code === "CROSS_LINKED")!;
  assert.equal(issue.extra!.firstOwner, issue.extra!.secondOwner);
});

test("broken chain reports CHAIN_TRUNCATED with an offset", () => {
  const s = load("broken.img");
  const issue = s.issues.find((i) => i.code === "CHAIN_TRUNCATED")!;
  assert.ok(issue);
  assert.equal(typeof issue.offset, "number");
});

test("FAT copy conflict is reported and keeps both values as evidence", () => {
  const s = load("fatconflict.img");
  const issue = s.issues.find((i) => i.code === "FAT_COPY_CONFLICT")!;
  assert.ok(/0xffff.*0x1234|0x1234.*0xffff/.test(issue.message));
  assert.equal(typeof issue.offset, "number");
});

test("loop chain terminates and reports CHAIN_LOOP", () => {
  const s = load("loop.img");
  assert.ok(codes(s).includes("CHAIN_LOOP"));
  const chain = s.chains.get(2)!;
  assert.ok(chain.clusters.length < 10, "loop walk must terminate");
});

test("bad cluster marker is detected", () => {
  const s = load("badcluster.img");
  assert.ok(codes(s).includes("BAD_CLUSTER"));
});

test("orphan allocated cluster is flagged", () => {
  const s = load("orphan.img");
  assert.ok(codes(s).includes("ORPHAN_CLUSTER"));
  assert.ok(s.orphanClusters.includes(100));
});

test("truncated image is rejected before data access", () => {
  const s = load("truncated.img");
  assert.ok(codes(s).includes("IMAGE_TRUNCATED"));
});

test("out-of-range FAT reference is rejected", () => {
  const img = buildImage({ children: [{ type: "file", name: "X.TXT", data: Buffer.from("abc") }] });
  setFatEntry(img, 0, 2, 0xfff0 - 0); // not EOC, reserved
  const s = scanImage(img.buf);
  assert.ok(s.issues.some((i) => i.code === "FAT_COPY_CONFLICT" || i.code === "FAT_OUT_OF_BOUNDS"));
});

test("8.3 validator rejects long names and illegal characters", () => {
  assert.throws(() => validate83("TOOLONGFI.TXT"));
  assert.throws(() => validate83("BAD/NAME.TXT"));
  assert.doesNotThrow(() => validate83("OK.TXT"));
});

test("LFN slots are marked unsupported and never become files", () => {
  const s = load("lfn.img");
  const lfn = s.entries.filter((e) => e.kind === "lfn-slot");
  assert.equal(lfn.length, 2);
  for (const e of lfn) {
    assert.equal(e.attr, 0x0f);
    assert.equal(e.shortName, null);
  }
  const files = s.entries.filter((e) => e.kind === "file");
  assert.equal(files.length, 1);
  assert.equal(files[0].path, "/SHORT.TXT");
});
