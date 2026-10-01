import { writeFileSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { buildImage, setFatEntry, truncate, type BuiltImage } from "../fat16/gen.js";
import { encode83 } from "../fat16/dir.js";

const here = dirname(fileURLToPath(import.meta.url));
export const PROJECT_ROOT = resolve(here, "..", "..");
export const FIXTURE_DIR = resolve(PROJECT_ROOT, "fixtures");

function pattern(byte: number, length: number, seed: number): Buffer {
  const b = Buffer.alloc(length);
  for (let i = 0; i < length; i++) b[i] = (byte + i + seed) & 0xff;
  return b;
}

export interface FixtureInfo {
  file: string;
  description: string;
  /** Clusters known to belong to specific named objects, for test assertions. */
  hints?: Record<string, unknown>;
}

/** Generate every synthetic image used by the demo and the test suite. */
export function generateFixtures(dir = FIXTURE_DIR): FixtureInfo[] {
  mkdirSync(dir, { recursive: true });
  const out: FixtureInfo[] = [];
  const save = (name: string, buf: Buffer, description: string, hints?: Record<string, unknown>) => {
    const file = resolve(dir, name);
    writeFileSync(file, buf);
    out.push({ file, description, hints });
  };

  // 1. Normal multi-level tree, includes zero-byte file.
  {
    const img = buildImage({
      volumeLabel: "DRIVE",
      deletedRootNames: ["GONE.TXT"],
      children: [
        { type: "file", name: "README.TXT", data: Buffer.from("hello fat16 root\n") },
        { type: "file", name: "EMPTY.DAT", data: Buffer.alloc(0) },
        {
          type: "dir",
          name: "SUBDIR",
          children: [
            { type: "file", name: "A.TXT", data: pattern(1, 300, 0) },
            {
              type: "dir",
              name: "DEEP",
              children: [{ type: "file", name: "B.LOG", data: pattern(9, 700, 3) }],
            },
          ],
        },
      ],
    });
    save("normal.img", img.buf, "Multi-level directories, zero-byte file, volume label and deleted slot");
  }

  // 2. Cross-cluster file (1300 bytes -> 3 clusters of 512).
  // 2b. Long-file-name slots must be flagged unsupported, never read as files.
  {
    const img = buildImage({
      lfnSlots: 2,
      children: [{ type: "file", name: "SHORT.TXT", data: Buffer.from("lfn present") }],
    });
    save("lfn.img", img.buf, "VFAT long-name slots preceding a normal 8.3 file");
  }

  {
    const img = buildImage({
      children: [{ type: "file", name: "BIG.BIN", data: pattern(0x20, 1300, 7) }],
    });
    save("crosscluster.img", img.buf, "Single file spanning three clusters", { size: 1300 });
  }

  // 3. Duplicate reference: two directory entries point at the same first cluster.
  {
    const img = buildImage({
      children: [
        { type: "file", name: "ORIG.DAT", data: pattern(0x40, 600, 1) },
      ],
    });
    const orig = rootFirst(img, 0);
    // Append a second 600-byte entry that aliases ORIG's first cluster. The
    // generator already advanced FAT allocation past ORIG, so only root slot 1
    // is rewritten; its size stays 600.
    const slotOff = img.rootSlotByteOffset(1);
    encode83("DUP.DAT").copy(img.buf, slotOff);
    img.buf.writeUInt8(0x20, slotOff + 11);
    img.buf.writeUInt32LE(600, slotOff + 28);
    writeRootFirst(img, 1, orig);
    save("crosslink.img", img.buf, "Two files share one cluster chain (cross-linked)", {
      sharedStart: orig,
    });
  }

  // 4. Broken/early-ending chain: middle FAT entry changed to EOC.
  {
    const img = buildImage({
      children: [{ type: "file", name: "BROKEN.BIN", data: pattern(0x60, 1300, 2) }],
    });
    const start = rootFirst(img, 0);
    setFatEntry(img, 0, start, 0xffff);
    setFatEntry(img, 1, start, 0xffff);
    save("broken.img", img.buf, "Chain ends after one cluster while file needs three");
  }

  // 5. FAT copy conflict: copy 1 diverges from copy 0.
  {
    const img = buildImage({
      children: [{ type: "file", name: "CONFLIC.TXT", data: Buffer.from("conflict me") }],
    });
    const start = rootFirst(img, 0);
    setFatEntry(img, 1, start, 0x1234);
    save("fatconflict.img", img.buf, "Second FAT copy disagrees with the first");
  }

  // 6. Loop in a chain.
  {
    const img = buildImage({
      children: [{ type: "file", name: "LOOP.BIN", data: pattern(0x70, 1300, 5) }],
    });
    const start = rootFirst(img, 0);
    setFatEntry(img, 0, start + 1, start);
    setFatEntry(img, 1, start + 1, start);
    save("loop.img", img.buf, "Cluster chain loops back to its start");
  }

  // 7. Bad cluster marker inside a chain.
  {
    const img = buildImage({
      children: [{ type: "file", name: "BAD.BIN", data: pattern(0x10, 1300, 9) }],
    });
    const start = rootFirst(img, 0);
    setFatEntry(img, 0, start, 0xfff7);
    setFatEntry(img, 1, start, 0xfff7);
    save("badcluster.img", img.buf, "Chain references a cluster marked bad");
  }

  // 8. Orphan allocated cluster (allocated in FAT, not referenced).
  {
    const img = buildImage({
      children: [{ type: "file", name: "SMALL.TXT", data: Buffer.from("tiny") }],
    });
    // Mark a high, otherwise-unused cluster allocated by giving it an EOC value.
    const orphan = 100;
    setFatEntry(img, 0, orphan, 0xffff);
    setFatEntry(img, 1, orphan, 0xffff);
    save("orphan.img", img.buf, "An allocated cluster has no directory owner", { orphan });
  }

  // 9. Truncated image (cut the tail off a valid image).
  {
    const img = buildImage({
      children: [
        {
          type: "dir",
          name: "DIR",
          children: [{ type: "file", name: "TAIL.BIN", data: pattern(0x30, 400, 4) }],
        },
      ],
    });
    const cut = truncate(img, img.buf.length / 2);
    save("truncated.img", cut, "Image cut in half so declared sectors exceed the file");
  }

  return out;
}

function rootFirst(img: BuiltImage, slot: number): number {
  return img.buf.readUInt16LE(img.rootSlotByteOffset(slot) + 26);
}

function writeRootFirst(img: BuiltImage, slot: number, cluster: number): void {
  img.buf.writeUInt16LE(cluster & 0xffff, img.rootSlotByteOffset(slot) + 26);
}
