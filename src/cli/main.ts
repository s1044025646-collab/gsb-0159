import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdirSync } from "node:fs";
import { Store } from "../db/store.js";
import { FatService } from "../core/service.js";
import { ApiError } from "../core/errors.js";
import { generateFixtures, FIXTURE_DIR, PROJECT_ROOT } from "./fixtures.js";

const here = dirname(fileURLToPath(import.meta.url));
void here;
mkdirSync(resolve(PROJECT_ROOT, "data"), { recursive: true });
mkdirSync(resolve(PROJECT_ROOT, "exports"), { recursive: true });
const dbPath = resolve(PROJECT_ROOT, "data", "fat16.db");

function makeService(): { service: FatService; store: Store } {
  const store = new Store(dbPath);
  return { service: new FatService(store, PROJECT_ROOT), store };
}

function table(rows: Record<string, unknown>[], cols: string[]): string {
  if (rows.length === 0) return "(no rows)";
  const widths = cols.map((c) => Math.max(c.length, ...rows.map((r) => String(r[c] ?? "").length)));
  const line = (vals: string[]) => vals.map((v, i) => v.padEnd(widths[i])).join("  ");
  return [line(cols), ...rows.map((r) => cols.map((c) => String(r[c] ?? "")).map((v, i) => v.padEnd(widths[i])).join("  "))].join("\n");
}

const args = process.argv.slice(2);
const cmd = args.shift();

async function main(): Promise<void> {
  switch (cmd) {
    case "gen-fixtures": {
      const infos = generateFixtures();
      console.log(`Before: fixture dir ${FIXTURE_DIR}`);
      for (const i of infos) console.log(`  wrote ${i.file}\n    - ${i.description}`);
      console.log(`After: ${infos.length} synthetic images generated`);
      return;
    }
    case "import": {
      const file = resolve(required(args[0], "usage: import <image>"));
      const { service, store } = makeService();
      console.log(`Before: importing ${file}`);
      try {
        const r = service.importImage(file);
        console.log(
          `After: imageId=${r.imageId} scanId=${r.scanId} reused=${r.reused} sha256=${r.hash} issues=${r.issueCount}`,
        );
      } finally {
        store.close();
      }
      return;
    }
    case "images": {
      const { service, store } = makeService();
      try {
        const page = service.listImages(num(args[0], 50), num(args[1], 0));
        console.log(table(page.items as Record<string, unknown>[], ["id", "file_name", "byte_size", "imported_at"]));
        console.log(`total=${page.total}`);
      } finally {
        store.close();
      }
      return;
    }
    case "ls": {
      const imageId = num(args[0], NaN, "usage: ls <imageId> [kind]");
      const kind = args[1];
      const { service, store } = makeService();
      try {
        const page = service.listEntries(imageId, 200, 0, kind);
        console.log(
          table(
            page.items.map((r) => r as Record<string, unknown>),
            ["kind", "path", "first_cluster", "file_size", "deleted"],
          ),
        );
        console.log(`total=${page.total}`);
      } finally {
        store.close();
      }
      return;
    }
    case "chain": {
      const imageId = num(args[0], NaN, "usage: chain <imageId> <startCluster>");
      const cluster = num(args[1], NaN, "usage: chain <imageId> <startCluster>");
      const { service, store } = makeService();
      try {
        const r = service.traceChain(imageId, cluster);
        console.log(`chain ${cluster}: ${r.clusters.join(" -> ") || "(empty)"}`);
        for (const i of r.issues as unknown as Record<string, unknown>[]) console.log(`  issue: ${JSON.stringify(i)}`);
      } finally {
        store.close();
      }
      return;
    }
    case "issues": {
      const imageId = num(args[0], NaN, "usage: issues <imageId> [code]");
      const code = args[1];
      const { service, store } = makeService();
      try {
        const page = service.listIssues(imageId, 500, 0, code);
        console.log(
          table(
            page.items.map((r) => r as Record<string, unknown>),
            ["code", "severity", "cluster", "offset", "message"],
          ),
        );
        console.log(`total=${page.total}`);
      } finally {
        store.close();
      }
      return;
    }
    case "export": {
      const imageId = num(args[0], NaN, "usage: export <imageId> <logicalPath> <destRelative> <sourceImage>");
      const logical = required(args[1], "missing logical path");
      const dest = required(args[2], "missing destination (must stay inside project)");
      const source = required(args[3], "missing source image path");
      const { service, store } = makeService();
      try {
        console.log(`Before: exporting ${logical} -> ${dest}`);
        const r = service.exportFile(imageId, logical, dest, resolve(source));
        console.log(`After: ${r.bytes} bytes sha256=${r.sha256} at ${r.dest}`);
      } finally {
        store.close();
      }
      return;
    }
    case "compare": {
      const imageId = num(args[0], NaN, "usage: compare <imageId> <scanA> <scanB>");
      const a = num(args[1], NaN);
      const b = num(args[2], NaN);
      const { service, store } = makeService();
      try {
        const r = service.compareScans(imageId, a, b);
        console.log(JSON.stringify(r.byCode, null, 2));
      } finally {
        store.close();
      }
      return;
    }
    case "summary": {
      const imageId = num(args[0], NaN, "usage: summary <imageId>");
      const { service, store } = makeService();
      try {
        console.log(JSON.stringify(service.summary(imageId), null, 2));
      } finally {
        store.close();
      }
      return;
    }
    default:
      console.log(
        [
          "usage: fat16 <command> [args]",
          "commands:",
          "  gen-fixtures",
          "  import <image>",
          "  images [limit] [offset]",
          "  ls <imageId> [kind]",
          "  chain <imageId> <startCluster>",
          "  issues <imageId> [code]",
          "  export <imageId> <logicalPath> <destRelative> <sourceImage>",
          "  compare <imageId> <scanA> <scanB>",
          "  summary <imageId>",
        ].join("\n"),
      );
  }
}

function required(v: string | undefined, msg: string): string {
  if (!v) throw new ApiError("USAGE", msg, 400);
  return v;
}

function num(v: string | undefined, fallback: number, msg?: string): number {
  if (v === undefined) {
    if (Number.isNaN(fallback)) throw new ApiError("USAGE", msg ?? "missing number", 400);
    return fallback;
  }
  const n = Number(v);
  if (!Number.isInteger(n)) throw new ApiError("USAGE", msg ?? `not an integer: ${v}`, 400);
  return n;
}

main().catch((e) => {
  if (e instanceof ApiError) {
    console.error(`error[${e.code}]: ${e.message}`);
  } else {
    console.error(e instanceof Error ? e.message : String(e));
  }
  process.exitCode = 1;
});
