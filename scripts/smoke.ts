import { readFileSync, readdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { scanImage } from "../src/fat16/scanner.js";

const here = dirname(fileURLToPath(import.meta.url));
const dir = resolve(here, "..", "fixtures");
for (const f of readdirSync(dir).filter((x) => x.endsWith(".img"))) {
  const buf = readFileSync(resolve(dir, f));
  const s = scanImage(buf);
  const codes = [...new Set(s.issues.map((i) => i.code))];
  console.log(
    f.padEnd(18),
    "entries=",
    String(s.entries.length).padStart(2),
    "alloc=",
    String(s.allocatedClusters).padStart(3),
    "orphans=",
    s.orphanClusters.length,
    "issues=",
    JSON.stringify(codes),
  );
  for (const e of s.entries.filter((e) => e.kind === "file")) {
    console.log("    ", e.path, e.fileSize, "cluster", e.firstCluster);
  }
}
