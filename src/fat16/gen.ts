import { ATTR_ARCHIVE, ATTR_DIRECTORY, encode83 } from "./dir.js";

export interface GenFile {
  type: "file";
  name: string;
  data: Buffer;
  readOnly?: boolean;
}
export interface GenDir {
  type: "dir";
  name: string;
  children: Array<GenFile | GenDir>;
}
export interface GenRoot {
  children: Array<GenFile | GenDir>;
  volumeLabel?: string;
  deletedRootNames?: string[];
  /** Prepend synthetic VFAT long-name slots before the normal entries. */
  lfnSlots?: number;
}

export const GEOM = {
  bytesPerSector: 512,
  sectorsPerCluster: 1,
  reservedSectors: 1,
  numFats: 2,
  rootEntries: 64,
  media: 0xf8,
  fatSize: 33,
  clusterCount: 4096,
} as const;

export interface BuiltImage {
  buf: Buffer;
  totalSectors: number;
  fatStartSector: number;
  rootStartSector: number;
  rootDirSectors: number;
  firstDataSector: number;
  fatSizeSectors: number;
  fatEntryByteOffset(copy: number, entry: number): number;
  clusterByteOffset(cluster: number): number;
  rootSlotByteOffset(slot: number): number;
}

const CLUSTER_BYTES = GEOM.bytesPerSector * GEOM.sectorsPerCluster;

interface EntryFields {
  name: string;
  attr: number;
  firstCluster: number;
  size: number;
  deleted?: boolean;
  readOnly?: boolean;
}

function writeU16Fill(buf: Buffer, off: number, count: number, value: number): void {
  for (let i = 0; i < count; i++) buf.writeUInt16LE(value & 0xffff, off + i * 2);
}

interface DirPlacement {
  firstCluster: number;
  clusters: number[];
}

/** Build a standards-shaped FAT16 image entirely in memory. */
export function buildImage(root: GenRoot): BuiltImage {
  const g = GEOM;
  const rootDirSectors = Math.ceil((g.rootEntries * 32) / g.bytesPerSector);
  const fatStartSector = g.reservedSectors;
  const rootStartSector = fatStartSector + g.numFats * g.fatSize;
  const firstDataSector = rootStartSector + rootDirSectors;
  const totalSectors = firstDataSector + g.clusterCount * g.sectorsPerCluster;
  const buf = Buffer.alloc(totalSectors * g.bytesPerSector);

  const clusterData = new Map<number, Buffer>();
  const chains = new Map<number, number[]>();
  let nextCluster = 2;

  const allocClusters = (count: number): number[] => {
    const list: number[] = [];
    for (let i = 0; i < count; i++) {
      const c = nextCluster++;
      list.push(c);
      clusterData.set(c, Buffer.alloc(CLUSTER_BYTES));
    }
    return list;
  };

  // Pre-place every sub-directory so dot/dotdot and parents can reference it.
  const placeDirs = (node: GenDir): DirPlacement => {
    const slotCount = node.children.length + 2;
    const clusters = allocClusters(Math.max(1, Math.ceil(slotCount * 32 / CLUSTER_BYTES)));
    const placement: DirPlacement = { firstCluster: clusters[0], clusters };
    (node as GenDir & { _place?: DirPlacement })._place = placement;
    for (const child of node.children) {
      if (child.type === "dir") placeDirs(child);
    }
    return placement;
  };
  for (const child of root.children) if (child.type === "dir") placeDirs(child);

  const placeFile = (file: GenFile): number => {
    const count = file.data.length === 0 ? 0 : Math.ceil(file.data.length / CLUSTER_BYTES);
    const clusters = count > 0 ? allocClusters(count) : [];
    for (let i = 0; i < clusters.length; i++) {
      clusterData.get(clusters[i])!.set(file.data.subarray(i * CLUSTER_BYTES, (i + 1) * CLUSTER_BYTES));
    }
    if (clusters.length) chains.set(clusters[0], clusters);
    return clusters[0] ?? 0;
  };

  const writeEntry = (target: Buffer, off: number, f: EntryFields) => {
    encode83(f.name).copy(target, off);
    target.writeUInt8(f.attr, off + 11);
    target.writeUInt16LE(f.firstCluster & 0xffff, off + 26);
    target.writeUInt32LE(f.size >>> 0, off + 28);
    if (f.readOnly) target.writeUInt8(f.attr | 0x01, off + 11);
    if (f.deleted) target.writeUInt8(0xe5, off);
  };

  const collectFields = (
    node: GenDir | null,
    parentFirst: number,
    selfFirst: number,
  ): EntryFields[] => {
    const fields: EntryFields[] = [];
    if (node) {
      fields.push({ name: ".", attr: ATTR_DIRECTORY, firstCluster: selfFirst, size: 0 });
      fields.push({ name: "..", attr: ATTR_DIRECTORY, firstCluster: parentFirst, size: 0 });
    }
    const children = node ? node.children : root.children;
    for (const child of children) {
      if (child.type === "file") {
        fields.push({
          name: child.name,
          attr: ATTR_ARCHIVE,
          firstCluster: placeFile(child),
          size: child.data.length,
          readOnly: child.readOnly,
        });
      } else {
        const p = (child as GenDir & { _place: DirPlacement })._place;
        fields.push({ name: child.name, attr: ATTR_DIRECTORY, firstCluster: p.firstCluster, size: 0 });
      }
    }
    if (!node && root.volumeLabel) {
      fields.push({ name: root.volumeLabel, attr: 0x08, firstCluster: 0, size: 0 });
    }
    if (!node && root.deletedRootNames) {
      for (const dn of root.deletedRootNames) {
        fields.push({ name: dn, attr: ATTR_ARCHIVE, firstCluster: 0, size: 0, deleted: true });
      }
    }
    return fields;
  };

  // Fixed root directory.
  {
    const fields = collectFields(null, 0, 0);
    const start = rootStartSector * g.bytesPerSector;
    let slot = 0;
    for (let n = 0; n < (root.lfnSlots ?? 0); n++) {
      // Raw 0x0F LFN slot: sequence byte, UTF-16 name fragments, checksum zero.
      const off = start + slot * 32;
      buf.writeUInt8(n === 0 ? 0x41 : 0x42 - n, off); // 0x40+ord with LFN-last bit
      for (let p = 1; p < 11; p++) buf.writeUInt8(0, off + p);
      buf.writeUInt8(0x0f, off + 11);
      buf.writeUInt8(0, off + 12);
      buf.writeUInt8(0, off + 13);
      writeU16Fill(buf, off + 14, 5, 0x0041 + n);
      buf.writeUInt16LE(0x0000, off + 20);
      buf.writeUInt16LE(0x0000, off + 22);
      writeU16Fill(buf, off + 24, 6, 0x0042 + n);
      buf.writeUInt16LE(0x0000, off + 26);
      writeU16Fill(buf, off + 28, 2, 0x0043 + n);
      slot++;
    }
    fields.forEach((f) => {
      writeEntry(buf, start + slot * 32, f);
      slot++;
    });
  }

  // Sub-directories into their cluster buffers, then register chains.
  const serializeDir = (node: GenDir, parentFirst: number) => {
    const place = (node as GenDir & { _place: DirPlacement })._place;
    const fields = collectFields(node, parentFirst, place.firstCluster);
    const perCluster = CLUSTER_BYTES / 32;
    fields.forEach((f, i) => {
      const ci = Math.floor(i / perCluster);
      writeEntry(clusterData.get(place.clusters[ci])!, (i % perCluster) * 32, f);
    });
    chains.set(place.firstCluster, place.clusters);
    for (const child of node.children) {
      if (child.type === "dir") serializeDir(child, place.firstCluster);
    }
  };
  for (const child of root.children) if (child.type === "dir") serializeDir(child, 0);

  // Flush cluster contents.
  for (const [cluster, data] of clusterData) {
    data.copy(buf, (firstDataSector + (cluster - 2) * g.sectorsPerCluster) * g.bytesPerSector);
  }

  // Build and write both FAT copies.
  const fatEntries = g.clusterCount + 2;
  const fat = new Uint16Array(fatEntries);
  fat[0] = 0xff00 | (g.media & 0xff);
  fat[1] = 0xffff;
  for (const cls of chains.values()) {
    for (let i = 0; i < cls.length; i++) fat[cls[i]] = i === cls.length - 1 ? 0xffff : cls[i + 1];
  }
  for (let copy = 0; copy < g.numFats; copy++) {
    const off0 = (fatStartSector + copy * g.fatSize) * g.bytesPerSector;
    for (let i = 0; i < fatEntries; i++) buf.writeUInt16LE(fat[i], off0 + i * 2);
  }

  writeBootSector(buf, totalSectors);

  return {
    buf,
    totalSectors,
    fatStartSector,
    rootStartSector,
    rootDirSectors,
    firstDataSector,
    fatSizeSectors: g.fatSize,
    fatEntryByteOffset(copy, entry) {
      return (fatStartSector + copy * g.fatSize) * g.bytesPerSector + entry * 2;
    },
    clusterByteOffset(cluster) {
      return (firstDataSector + (cluster - 2) * g.sectorsPerCluster) * g.bytesPerSector;
    },
    rootSlotByteOffset(slot) {
      return rootStartSector * g.bytesPerSector + slot * 32;
    },
  };
}

function writeBootSector(buf: Buffer, totalSectors: number) {
  const g = GEOM;
  buf.write("MSDOS5.0", 3, 8, "latin1");
  buf.writeUInt16LE(g.bytesPerSector, 11);
  buf.writeUInt8(g.sectorsPerCluster, 13);
  buf.writeUInt16LE(g.reservedSectors, 14);
  buf.writeUInt8(g.numFats, 16);
  buf.writeUInt16LE(g.rootEntries, 17);
  buf.writeUInt16LE(totalSectors <= 0xffff ? totalSectors : 0, 19);
  buf.writeUInt8(g.media, 21);
  buf.writeUInt16LE(g.fatSize, 22);
  buf.writeUInt16LE(63, 24);
  buf.writeUInt16LE(255, 26);
  buf.writeUInt32LE(0, 28);
  buf.writeUInt32LE(totalSectors > 0xffff ? totalSectors : 0, 32);
  buf.writeUInt8(0x80, 36);
  buf.writeUInt8(0x29, 38);
  buf.writeUInt32LE(0x12345678, 39);
  buf.write("NO NAME    ", 43, 11, "latin1");
  buf.write("FAT16   ", 54, 8, "latin1");
  buf.writeUInt16LE(0xaa55, 510);
}

/** Mutation helpers for constructing corruption fixtures. */
export function setFatEntry(img: BuiltImage, copy: number, entry: number, value: number): void {
  img.buf.writeUInt16LE(value & 0xffff, img.fatEntryByteOffset(copy, entry));
}

export function setRootFirstCluster(img: BuiltImage, slot: number, cluster: number): void {
  img.buf.writeUInt16LE(cluster & 0xffff, img.rootSlotByteOffset(slot) + 26);
}

export function setRootFileSize(img: BuiltImage, slot: number, size: number): void {
  img.buf.writeUInt32LE(size >>> 0, img.rootSlotByteOffset(slot) + 28);
}

export function truncate(img: BuiltImage, bytes: number): Buffer {
  return img.buf.subarray(0, Math.max(0, img.buf.length - bytes));
}
