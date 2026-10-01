/**
 * Repeatable end-to-end demo:
 * generates fixtures, imports each image through the service layer,
 * prints before/after state, traces chains, exports a file and verifies
 * the exported digest, and restarts the repository to prove persistence.
 */
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import { readFileSync } from "node:fs";
import { InspectorService } from "../src/core/service.ts";
import { writeFixtureSet, FIXED_NOW } from "../test/helpers.ts";
import { createHash } from "node:crypto";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const dataDir = resolve(root, "data", "demo");

function line(s: string): void {
  console.log(s);
}

const service = new InspectorService({
  dbPath: resolve(dataDir, "demo.db"),
  projectRoot: root,
  now: () => FIXED_NOW,
});

line("== 1. generate synthetic fixtures ==");
const paths = writeFixtureSet(dataDir);
for (const [name, p] of Object.entries(paths)) line(`  ${name.padEnd(14)} ${p}`);

line("\n== 2. import images (before/after image count) ==");
line(`  images before: ${service.repo.listImages(100, 0).total}`);
const imported: Record<string, { imageId: number; runId: number }> = {};
for (const [name, p] of Object.entries(paths)) {
  const rel = p.replace(root + "\\", "").replace(root + "/", "").replaceAll("\\", "/");
  const r = service.importImage(rel);
  imported[name] = { imageId: r.imageId, runId: r.runId };
  line(`  imported ${name.padEnd(14)} imageId=${r.imageId} errors=${r.summary.error} warnings=${r.summary.warning}`);
}
line(`  images after:  ${service.repo.listImages(100, 0).total}`);

line("\n== 3. idempotent re-import ==");
const again = service.importImage("data/demo/fixtures/normal.img");
line(`  reusedImage=${again.reusedImage} imageId=${again.imageId} newRunId=${again.runId}`);

line("\n== 4. trace the multi-cluster chain ==");
const chain = service.repo.getChain(imported.normal!.imageId, "/DOCS/DEEP/BIG.BIN", null)!;
line(`  ${chain.path} clusters=${chain.chain_clusters} terminated=${chain.terminated}`);

line("\n== 5. read-only export and digest check ==");
const exported = service.exportImageFile(
  imported.normal!.imageId,
  "/DOCS/DEEP/BIG.BIN",
  "data/demo/exported-big.bin",
  null,
);
const fileEntry = service.repo
  .getEntry(imported.normal!.imageId, "/DOCS/DEEP/BIG.BIN", null) as { file_size: number };
line(`  exported bytes=${exported.bytes} declaredSize=${fileEntry.file_size} match=${exported.bytes === fileEntry.file_size}`);
const diskDigest = createHash("sha256")
  .update(readFileSync(exported.outputPath))
  .digest("hex");
line(`  digest matches file on disk: ${diskDigest === exported.sha256}`);

line("\n== 6. concrete problem offsets (broken chain image) ==");
const issues = service.repo.listIssues(imported.broken_chain!.imageId, null, 10, 0, "error");
for (const i of issues.items) {
  line(`  ${String(i.code).padEnd(26)} cluster=${i.cluster ?? "-"} ${i.message}`);
}

line("\n== 7. compare check versions ==");
const cmp = service.compareRuns(imported.normal!.imageId, 1, 2);
const added = cmp.added as unknown[];
const resolved = cmp.resolved as unknown[];
line(`  run 1 -> 2 added=${added.length} resolved=${resolved.length} (identical content)`);

line("\n== 8. restart persistence ==");
service.close();
const reopened = new InspectorService({
  dbPath: resolve(dataDir, "demo.db"),
  projectRoot: root,
  now: () => FIXED_NOW,
});
const images = reopened.repo.listImages(100, 0);
line(`  images visible after reopening db: ${images.total}`);
reopened.close();
line("\nDemo complete. All artifacts stay under data/demo/.");
