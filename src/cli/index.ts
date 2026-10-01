import { resolve, relative } from "node:path";
import { mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import { InspectorService, ApiError } from "../core/service.ts";
import { buildFat16Image } from "../fsimage/builder.ts";
import { parseImage } from "../fat/parser.ts";

const here = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(here, "..", "..");
const dataDir = resolve(projectRoot, "data");

function usage(): string {
  return [
    "Usage: fat16 <command> [options]",
    "Commands:",
    "  gen-fixtures [outDir=data/fixtures]   Generate deterministic FAT16 fixture images",
    "  import <imagePath>                    Import (idempotent by sha256) and print before/after summary",
    "  ls <imageId> [path] [--run N]         List directory entries (short names, deleted, LFN flagged)",
    "  chain <imageId> <path> [--run N]      Trace a file/directory cluster chain",
    "  export <imageId> <path> <outRel>      Read-only export, output constrained inside the project",
    "  compare <imageId> <runA> <runB>       Diff two check-run versions",
    "  issues <imageId> [--run N] [--sev S]  List problems with concrete offsets/clusters",
  ].join("\n");
}

function makeService(): InspectorService {
  mkdirSync(dataDir, { recursive: true });
  return new InspectorService({ dbPath: resolve(dataDir, "inspector.db"), projectRoot });
}

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

function makeFixtures(outDir: string): Record<string, string> {
  mkdirSync(outDir, { recursive: true });
  const paths: Record<string, string> = {};
  const spc = 1;
  const clusterBytes = spc * 512;

  const normal = buildFat16Image({
    name: "",
    files: [{ name: "README.TXT", content: "hello fat16\n" }],
    dirs: [
      {
        name: "DOCS",
        files: [
          { name: "EMPTY.DAT", content: "" },
          { name: "LONGNAME.TXT", content: "lfn-backed slot demo", lfn: true },
          { name: "GONE.TXT", content: "do not restore me", deleted: true },
        ],
        dirs: [
          {
            name: "DEEP",
            files: [
              { name: "BIG.BIN", content: Buffer.alloc(3 * clusterBytes + 17, 0x58) },
            ],
          },
        ],
      },
    ],
  }, { label: "DEMO", sectorsPerCluster: spc });
  paths.normal = resolve(outDir, "normal.img");
  writeFileSync(paths.normal, normal);

  const parsed = parseImage(normal, { imagePath: paths.normal });
  const big = parsed.chains.find((c) => c.path.endsWith("BIG.BIN"));
  const p = parsed.params;
  const fatSectors = p.fatSize16;
  const fatSet = (img: Buffer, copy: number, cluster: number, value: number): void => {
    img.writeUInt16LE(value, (p.firstFatSector + copy * fatSectors) * 512 + cluster * 2);
  };

  // Duplicate reference: retarget a directory entry to the first cluster of another file,
  // so two directory entries claim the same clusters (cross-linked ownership).
  const dup = Buffer.from(normal);
  const readme = parsed.entries.find((e) => e.path === "/README.TXT");
  const docsEntry = parsed.entries.find((e) => e.path === "/DOCS/EMPTY.DAT");
  if (readme && docsEntry) dup.writeUInt16LE(readme.firstCluster, docsEntry.offset + 26);
  paths.duplicate = resolve(outDir, "duplicate_ref.img");
  writeFileSync(paths.duplicate, dup);

  // Broken chain: change an interior link of the multi-cluster file to free (0).
  const broken = Buffer.from(normal);
  if (big && big.chain.length > 2) fatSet(broken, 0, big.chain[1]!, 0x0000);
  paths.broken = resolve(outDir, "broken_chain.img");
  writeFileSync(paths.broken, broken);

  // FAT copy divergence: alter copy 1 only; copy 0 is untouched and neither is authoritative.
  const conflict = Buffer.from(normal);
  const targetCluster = big?.chain[0] ?? 4;
  fatSet(conflict, 1, targetCluster, 0x1234);
  paths.conflict = resolve(outDir, "fat_conflict.img");
  writeFileSync(paths.conflict, conflict);

  // Truncated image: cut the tail off so a data cluster window is missing.
  paths.truncated = resolve(outDir, "truncated.img");
  writeFileSync(paths.truncated, normal.subarray(0, normal.length - 512));

  // Too small to contain even a boot sector.
  paths.tiny = resolve(outDir, "tiny.img");
  writeFileSync(paths.tiny, normal.subarray(0, 300));

  return paths;
}

function printHeader(title: string): void {
  console.log(`--- ${title} ---`);
}

async function main(argv: string[]): Promise<number> {
  const [cmd, ...rest] = argv;
  if (!cmd || cmd === "help" || cmd === "--help") {
    console.log(usage());
    return 0;
  }

  const service = makeService();
  try {
    if (cmd === "gen-fixtures") {
      const outDir = rest[0] ? resolve(rest[0]) : resolve(dataDir, "fixtures");
      const before = service.repo.listImages(500, 0).total;
      printHeader(`Generating fixtures into ${relative(projectRoot, outDir)}`);
      const paths = makeFixtures(outDir);
      for (const [k, p] of Object.entries(paths)) console.log(`  ${k.padEnd(10)} ${relative(projectRoot, p)}`);
      console.log(`DB images before=${before} after=${service.repo.listImages(500, 0).total} (fixtures are files, not auto-imported)`);
      return 0;
    }

    if (cmd === "import") {
      const imagePath = rest[0];
      if (!imagePath) throw new ApiError("MISSING_ARG", 400, "import requires <imagePath>.");
      printHeader(`Before import: images=${service.repo.listImages(500, 0).total}`);
      const r = service.importImage(resolve(projectRoot, imagePath));
      printHeader("Import result");
      console.log(`  imageId=${r.imageId} runId=${r.runId} reusedImage=${r.reusedImage}`);
      console.log(`  summary=${JSON.stringify(r.summary)}`);
      return 0;
    }

    if (cmd === "ls") {
      const imageId = Number(rest[0]);
      const run = flag(rest, "--run") ? Number(flag(rest, "--run")) : null;
      const page = service.repo.listEntries(imageId, run, 200, 0, null, null);
      printHeader(`Entries of image ${imageId} (${page.total} total)`);
      for (const e of page.items) {
        const tag =
          e.kind === "deleted" ? "DEL" :
          e.lfnUnsupported ? "LFN?" :
          e.kind === "directory" ? "DIR" :
          e.kind === "volume-label" ? "LBL" :
          e.kind === "lfn-unsupported" ? "LFN?" : "FIL";
        console.log(
          `  [${tag}] ${String(e.path).padEnd(32)} size=${String(e.fileSize).padStart(8)} cl=${String(e.firstCluster).padStart(5)} off=${e.offset}`,
        );
      }
      return 0;
    }

    if (cmd === "chain") {
      const imageId = Number(rest[0]);
      const path = rest[1];
      const run = flag(rest, "--run") ? Number(flag(rest, "--run")) : null;
      if (!path) throw new ApiError("MISSING_ARG", 400, "chain requires <path>.");
      const chain = service.repo.getChain(imageId, path, run);
      if (!chain) throw new ApiError("CHAIN_NOT_FOUND", 404, `No chain for ${path}`);
      printHeader(`Chain ${path}`);
      console.log(`  clusters=${chain.chain_clusters} terminated=${chain.terminated} expected=${chain.expected_clusters}`);
      return 0;
    }

    if (cmd === "export") {
      const [imageIdStr, path, outRel] = rest;
      if (!imageIdStr || !path || !outRel) throw new ApiError("MISSING_ARG", 400, "export requires <imageId> <path> <outRel>.");
      const r = service.exportImageFile(Number(imageIdStr), path, outRel, null);
      printHeader(`Exported ${path}`);
      console.log(`  bytes=${r.bytes} sha256=${r.sha256}`);
      console.log(`  output=${relative(projectRoot, r.outputPath)}`);
      return 0;
    }

    if (cmd === "compare") {
      const [imageIdStr, aStr, bStr] = rest;
      const r = service.compareRuns(Number(imageIdStr), Number(aStr), Number(bStr));
      printHeader(`Compare run ${r.runA} -> run ${r.runB}`);
      console.log(`  added=${JSON.stringify(r.added)}`);
      console.log(`  resolved=${JSON.stringify(r.resolved)}`);
      return 0;
    }

    if (cmd === "issues") {
      const imageId = Number(rest[0]);
      const run = flag(rest, "--run") ? Number(flag(rest, "--run")) : null;
      const sev = flag(rest, "--sev") ?? null;
      const page = service.repo.listIssues(imageId, run, 200, 0, sev);
      printHeader(`Issues for image ${imageId} (${page.total})`);
      for (const i of page.items) {
        const loc = i.offset != null ? `off=${i.offset}` : i.cluster != null ? `cluster=${i.cluster}` : i.sector != null ? `sector=${i.sector}` : "-";
        console.log(`  ${String(i.severity).toUpperCase().padEnd(7)} ${String(i.code).padEnd(26)} ${loc.padEnd(12)} ${i.message}`);
      }
      return 0;
    }

    console.error(usage());
    return 2;
  } catch (err) {
    if (err instanceof ApiError) {
      console.error(`ERROR [${err.code}] ${err.message}`);
      return 1;
    }
    throw err;
  } finally {
    service.close();
  }
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (err) => {
    console.error(err);
    process.exit(1);
  },
);
