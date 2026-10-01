/**
 * Deterministic synthetic FAT16 image builder used purely for test/demo fixtures.
 * Produces a volume-boot-sector-led image: reserved sectors + FAT copies +
 * fixed root directory + data clusters. Never touches a physical disk.
 */

export interface FixtureFile {
  name: string;
  /** Content; when a string is given it is encoded as UTF-8. */
  content: Buffer | string;
  deleted?: boolean;
  lfn?: boolean;
}

export interface FixtureDir {
  name: string;
  files?: FixtureFile[];
  dirs?: FixtureDir[];
}

export interface BuildOptions {
  label?: string;
  sectorsPerCluster?: number;
  fatCopies?: number;
  rootEntries?: number;
  /** Deterministic clock (ms); stamps are fixed, no randomness by default. */
  now?: number;
}

interface AllocNode {
  type: "file" | "dir";
  name: string;
  content?: Buffer;
  children?: AllocNode[];
  deleted?: boolean;
  lfn?: boolean;
  cluster?: number;
  sizeClusters?: number;
}

const SEC = 512;

export function buildFat16Image(tree: FixtureDir, opts: BuildOptions = {}): Buffer {
  const spc = opts.sectorsPerCluster ?? 1;
  const fatCopies = opts.fatCopies ?? 2;
  const rootEntries = opts.rootEntries ?? 512;
  const rootDirSectors = Math.ceil((rootEntries * 32) / SEC);

  const alloc = materialize(tree);
  countDirClusters(alloc, spc);
  let cursor = 2;
  assignClusters(alloc, () => cursor++);

  const usedClusters = cursor - 2;
  // FAT16 volumes must report at least 4085 data clusters. Unused tail clusters
  // stay marked free in the FAT, exactly like real slack space on a fresh volume.
  const minClusters = 4085;
  const totalClusters = Math.max(usedClusters, minClusters + 4);
  const fatEntries = totalClusters + 2;
  const fatSectors = Math.ceil((fatEntries * 2) / SEC);
  const reserved = 1;
  const totalSectors =
    reserved + fatCopies * fatSectors + rootDirSectors + totalClusters * spc;

  const image = Buffer.alloc(totalSectors * SEC, 0);
  const firstFat = reserved;
  const rootStartSector = reserved + fatCopies * fatSectors;
  const firstDataSector = rootStartSector + rootDirSectors;

  writeBootSector(image, {
    spc, reserved, fatCopies, rootEntries, fatSectors, totalSectors,
  });

  const fat0 = new Uint16Array(fatEntries).fill(0);
  fat0[0] = 0xfff8;
  fat0[1] = 0xffff;
  for (const node of walkNodes(alloc)) {
    if (node.sizeClusters === 0 || node.cluster === undefined) continue;
    for (let i = 0; i < node.sizeClusters!; i++) {
      const c = node.cluster! + i;
      fat0[c] = i === node.sizeClusters! - 1 ? 0xffff : c + 1;
    }
  }
  for (let copy = 0; copy < fatCopies; copy++) {
    for (let i = 0; i < fatEntries; i++) {
      image.writeUInt16LE(fat0[i]!, (firstFat + copy * fatSectors) * SEC + i * 2);
    }
  }

  for (const node of walkNodes(alloc)) {
    if (node.type !== "file" || !node.content || node.cluster === undefined) continue;
    node.content.copy(image, clusterOffset(firstDataSector, spc, node.cluster));
  }

  writeRoot(image, rootStartSector * SEC, rootEntries, alloc, opts.label ?? "");
  for (const node of walkNodes(alloc)) {
    if (node.type !== "dir" || node.cluster === undefined) continue;
    writeSubdir(image, clusterOffset(firstDataSector, spc, node.cluster), node, spc);
  }

  return image;
}

function clusterOffset(firstDataSector: number, spc: number, cluster: number): number {
  return (firstDataSector + (cluster - 2) * spc) * SEC;
}

interface BpbInputs {
  spc: number; reserved: number; fatCopies: number; rootEntries: number;
  fatSectors: number; totalSectors: number;
}

function writeBootSector(image: Buffer, b: BpbInputs): void {
  image.writeUInt8(0xeb, 0);
  image.writeUInt8(0x3c, 1);
  image.writeUInt8(0x90, 2);
  image.write("MSWIN4.1", 3, "latin1");
  image.writeUInt16LE(SEC, 11);
  image.writeUInt8(b.spc, 13);
  image.writeUInt16LE(b.reserved, 14);
  image.writeUInt8(b.fatCopies, 16);
  image.writeUInt16LE(b.rootEntries, 17);
  image.writeUInt16LE(b.totalSectors, 19);
  image.writeUInt8(0xf8, 21);
  image.writeUInt16LE(b.fatSectors, 22);
  image.writeUInt16LE(63, 24);
  image.writeUInt16LE(255, 26);
  image.writeUInt32LE(0, 28);
  image.writeUInt32LE(0, 32);
  image.writeUInt8(0x80, 36);
  image.writeUInt8(0x29, 38);
  image.writeUInt32LE(0x12345678, 39);
  image.write("NO NAME    ", 43, "latin1");
  image.write("FAT16   ", 54, "latin1");
  image.writeUInt16LE(0xaa55, 510);
}

function materialize(tree: FixtureDir): AllocNode {
  const node: AllocNode = { type: "dir", name: tree.name, children: [] };
  for (const f of tree.files ?? []) {
    node.children!.push({
      type: "file",
      name: f.name,
      content: Buffer.isBuffer(f.content) ? f.content : Buffer.from(f.content, "utf8"),
      deleted: f.deleted,
      lfn: f.lfn,
    });
  }
  for (const d of tree.dirs ?? []) node.children!.push(materialize(d));
  return node;
}

function countDirClusters(root: AllocNode, spc: number): void {
  for (const c of root.children ?? []) {
    if (c.type === "dir") {
      countDirClusters(c, spc);
      let entries = 2; // "." and ".."
      for (const ch of c.children ?? []) entries += ch.type === "file" && ch.lfn ? 2 : 1;
      const sectors = Math.max(1, Math.ceil((entries * 32) / SEC));
      c.sizeClusters = Math.ceil(sectors / spc);
    } else {
      c.sizeClusters = c.content!.length === 0 ? 0 : Math.ceil(c.content!.length / (spc * SEC));
    }
  }
}

function assignClusters(root: AllocNode, next: () => number): void {
  for (const d of root.children ?? []) {
    if (d.type === "dir") {
      d.cluster = next();
      for (let i = 1; i < d.sizeClusters!; i++) next();
      assignClusters(d, next);
    }
  }
  for (const f of root.children ?? []) {
    if (f.type === "file" && f.sizeClusters! > 0) {
      f.cluster = next();
      for (let i = 1; i < f.sizeClusters!; i++) next();
    }
  }
}

function* walkNodes(n: AllocNode): Generator<AllocNode> {
  for (const c of n.children ?? []) {
    if (c.type === "dir") {
      yield* walkNodes(c);
      yield c;
    }
  }
  for (const c of n.children ?? []) if (c.type === "file") yield c;
}

function encode83(name: string): Buffer {
  const upper = name.toUpperCase();
  const dot = upper.indexOf(".");
  const base = dot === -1 ? upper : upper.slice(0, dot);
  const ext = dot === -1 ? "" : upper.slice(dot + 1);
  const b = Buffer.alloc(11, 0x20);
  Buffer.from(base.slice(0, 8), "latin1").copy(b, 0);
  if (ext) Buffer.from(ext.slice(0, 3), "latin1").copy(b, 8);
  return b;
}

function writeEntry(buf: Buffer, off: number, n: AllocNode): void {
  const rec = Buffer.alloc(32, 0);
  const name = encode83(n.name);
  if (n.deleted) name[0] = 0xe5;
  name.copy(rec, 0);
  rec[11] = n.type === "dir" ? 0x10 : 0x20;
  rec.writeUInt16LE(0x8000, 22);
  rec.writeUInt16LE(0x5a21, 24);
  const first = n.type === "file" && n.content!.length === 0 ? 0 : n.cluster ?? 0;
  rec.writeUInt16LE(first, 26);
  rec.writeUInt32LE(n.type === "file" ? n.content!.length : 0, 28);
  rec.copy(buf, off);
}

function writeLfnSlot(buf: Buffer, off: number, checksum: number, final: boolean): void {
  const rec = Buffer.alloc(32, 0xff);
  rec[0] = (final ? 0x40 : 0) | 1;
  rec[11] = 0x0f;
  rec[13] = checksum;
  rec.writeUInt16LE(0, 26);
  rec.copy(buf, off);
}

function shortChecksum(short: Buffer): number {
  let sum = 0;
  for (let i = 0; i < 11; i++) sum = ((sum & 1) << 7) + (sum >> 1) + short[i]!;
  return sum & 0xff;
}

function writeRoot(
  image: Buffer, off: number, rootEntries: number, root: AllocNode, label: string,
): void {
  let slot = 0;
  if (label) {
    const rec = Buffer.alloc(32, 0x20);
    Buffer.from(label.toUpperCase().padEnd(11, " ").slice(0, 11), "latin1").copy(rec, 0);
    rec[11] = 0x08;
    rec.copy(image, off + slot * 32);
    slot++;
  }
  for (const n of root.children ?? []) {
    if (slot >= rootEntries) throw new Error("Root directory region exhausted");
    if (n.type === "file" && n.lfn) {
      writeLfnSlot(image, off + slot * 32, shortChecksum(encode83(n.name)), true);
      slot++;
    }
    writeEntry(image, off + slot * 32, n);
    slot++;
  }
}

function writeSubdir(image: Buffer, off: number, dir: AllocNode, spc: number): void {
  const capacity = (spc * SEC) / 32;
  let slot = 0;
  writeDotEntry(image, off + slot * 32, dir.cluster!, ".");
  slot++;
  writeDotEntry(image, off + slot * 32, 0, "..");
  slot++;
  for (const n of dir.children ?? []) {
    if (slot >= capacity) throw new Error(`Subdirectory ${dir.name} exceeds its cluster region`);
    if (n.type === "file" && n.lfn) {
      writeLfnSlot(image, off + slot * 32, shortChecksum(encode83(n.name)), true);
      slot++;
    }
    writeEntry(image, off + slot * 32, n);
    slot++;
  }
}

function writeDotEntry(image: Buffer, off: number, cluster: number, dot: string): void {
  const rec = Buffer.alloc(32, 0);
  const name = Buffer.alloc(11, 0x20);
  name.write(dot === "." ? "." : "..", 0, "latin1");
  name.copy(rec, 0);
  rec[11] = 0x10;
  rec.writeUInt16LE(cluster, 26);
  rec.copy(image, off);
}

/** Deterministic corruption helpers for fixtures. */
export const corrupt = {
  truncate(image: Buffer, bytes: number): Buffer {
    return image.subarray(0, Math.max(0, image.length - bytes));
  },
  setFat(image: Buffer, firstFatSector: number, copy: number, fatSectors: number, cluster: number, value: number): void {
    const off = (firstFatSector + copy * fatSectors) * SEC + cluster * 2;
    image.writeUInt16LE(value, off);
  },
  /** Build a FAT16-sized image deliberately under the 4085-cluster FAT16 floor. */
};
