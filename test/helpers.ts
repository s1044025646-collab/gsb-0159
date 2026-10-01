import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { buildFat16Image } from "../src/fsimage/builder.ts";
import { parseImage } from "../src/fat/parser.ts";
import { InspectorService } from "../src/core/service.ts";

export function tempProject(): { root: string; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), "fat16-test-"));
  return {
    root,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

export const FIXED_NOW = 1_700_000_000_000;

export function makeService(root: string): InspectorService {
  return new InspectorService({
    dbPath: resolve(root, "data", "test.db"),
    projectRoot: root,
    now: () => FIXED_NOW,
  });
}

export interface FixtureSet {
  paths: Record<string, string>;
}

export function writeFixtureSet(root: string): Record<string, string> {
  const dir = resolve(root, "fixtures");
  const spc = 1;
  const clusterBytes = spc * 512;
  const normal = buildFat16Image(
    {
      name: "",
      files: [{ name: "README.TXT", content: "hello fat16\n" }],
      dirs: [
        {
          name: "DOCS",
          files: [
            { name: "EMPTY.DAT", content: "" },
            { name: "LONG.TXT", content: "lfn slot demo", lfn: true },
            { name: "GONE.TXT", content: "do not restore", deleted: true },
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
    },
    { label: "DEMO", sectorsPerCluster: spc },
  );

  const paths: Record<string, string> = {};
  const put = (name: string, buf: Buffer): string => {
    const p = resolve(dir, name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(p, buf);
    paths[name.replace(/\.img$/, "")] = p;
    return p;
  };
  put("normal.img", normal);

  const parsed = parseImage(normal, { imagePath: "normal" });
  const p = parsed.params;
  const setFat = (img: Buffer, copy: number, cluster: number, value: number): void => {
    img.writeUInt16LE(
      value,
      (p.firstFatSector + copy * p.fatSize16) * 512 + cluster * 2,
    );
  };

  const dup = Buffer.from(normal);
  const readme = parsed.entries.find((e) => e.path === "/README.TXT")!;
  const empty = parsed.entries.find((e) => e.path === "/DOCS/EMPTY.DAT")!;
  dup.writeUInt16LE(readme.firstCluster, empty.offset + 26);
  put("duplicate_ref.img", dup);

  const broken = Buffer.from(normal);
  const big = parsed.chains.find((c) => c.path.endsWith("BIG.BIN"))!;
  setFat(broken, 0, big.chain[1]!, 0);
  setFat(broken, 1, big.chain[1]!, 0);
  put("broken_chain.img", broken);

  const loop = Buffer.from(normal);
  setFat(loop, 0, big.chain[1]!, big.chain[0]!);
  setFat(loop, 1, big.chain[1]!, big.chain[0]!);
  put("loop.img", loop);

  const oob = Buffer.from(normal);
  setFat(oob, 0, big.chain[0]!, 0xfff0);
  setFat(oob, 1, big.chain[0]!, 0xfff0);
  setFat(oob, 0, 0xfff0, 0xffff);
  setFat(oob, 1, 0xfff0, 0xffff);
  setFat(oob, 0, big.chain[0]!, p.totalClusters + 100);
  setFat(oob, 1, big.chain[0]!, p.totalClusters + 100);
  put("oob.img", oob);

  const bad = Buffer.from(normal);
  setFat(bad, 0, big.chain[0]!, 0xfff7);
  setFat(bad, 1, big.chain[0]!, 0xfff7);
  put("bad.img", bad);

  const conflict = Buffer.from(normal);
  setFat(conflict, 1, big.chain[0]!, 0x1234);
  put("fat_conflict.img", conflict);

  put("truncated.img", normal.subarray(0, normal.length - 512));
  put("tiny.img", normal.subarray(0, 300));

  return paths;
}
