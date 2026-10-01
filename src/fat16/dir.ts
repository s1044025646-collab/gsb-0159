import type { BpbParams, DirectoryEntry, VolumeLayout } from "./types.js";

export const ATTR_READ_ONLY = 0x01;
export const ATTR_HIDDEN = 0x02;
export const ATTR_SYSTEM = 0x04;
export const ATTR_VOLUME_ID = 0x08;
export const ATTR_DIRECTORY = 0x10;
export const ATTR_ARCHIVE = 0x20;
export const ATTR_LFN = 0x0f;
const DELETED = 0xe5;
const FREE = 0x00;

function decodeShortName(raw: Buffer): string {
  const base = raw.toString("latin1", 0, 8).replace(/ +$/g, "");
  const ext = raw.toString("latin1", 8, 11).replace(/ +$/g, "");
  return ext ? `${base}.${ext}` : base;
}

function parseOne(
  buf: Buffer,
  offset: number,
  parentCluster: number,
): DirectoryEntry {
  const first = buf.readUInt8(offset);
  const rawNameBytes = buf.subarray(offset, offset + 11);
  const attr = buf.readUInt8(offset + 11);
  const firstCluster = buf.readUInt16LE(offset + 26);
  const fileSize = buf.readUInt32LE(offset + 28);
  const createTime = buf.readUInt16LE(offset + 14);
  const modifyDate = buf.readUInt16LE(offset + 24);

  const base: DirectoryEntry = {
    kind: "free",
    shortName: null,
    rawName: null,
    attr,
    isReadOnly: (attr & ATTR_READ_ONLY) !== 0,
    isHidden: (attr & ATTR_HIDDEN) !== 0,
    isSystem: (attr & ATTR_SYSTEM) !== 0,
    isArchive: (attr & ATTR_ARCHIVE) !== 0,
    firstCluster,
    fileSize,
    offset,
    parentCluster,
    path: "",
    deleted: false,
    lfnSequence: null,
    createTime,
    modifyDate,
  };

  if (first === FREE) return { ...base, kind: "free" };
  if (first === DELETED) {
    return {
      ...base,
      kind: "deleted",
      deleted: true,
      rawName: rawNameBytes.toString("latin1"),
      shortName: null,
    };
  }

  if (attr === ATTR_LFN) {
    return {
      ...base,
      kind: "lfn-slot",
      lfnSequence: buf.readUInt8(offset + 0),
      rawName: rawNameBytes.toString("latin1"),
    };
  }

  const rawName = rawNameBytes.toString("latin1");
  let shortName = decodeShortName(rawNameBytes);

  if (rawName[0] === "\x05") {
    // 0x05 leading byte stands in for 0xE5 (Kanji lead) - not a deletion.
    const fixed = Buffer.from(rawNameBytes);
    fixed[0] = 0xe5;
    shortName = decodeShortName(fixed);
  }

  let kind: DirectoryEntry["kind"];
  const dot0 = rawNameBytes[0] === 0x2e;
  const dot1 = rawNameBytes[1] === 0x2e;
  const blank1 = rawNameBytes[1] === 0x20;
  if (dot0 && dot1) {
    kind = "dotdot";
  } else if (dot0 && blank1) {
    kind = "dot";
  } else if (attr & ATTR_VOLUME_ID) {
    kind = "volume-label";
  } else if (attr & ATTR_DIRECTORY) {
    kind = "directory";
  } else {
    kind = "file";
  }

  return { ...base, kind, shortName, rawName };
}

/** Read the fixed root directory region (FAT12/16), stopping at a free slot. */
export function readRootEntries(
  buf: Buffer,
  bpb: BpbParams,
  layout: VolumeLayout,
): { entries: DirectoryEntry[]; overflow: boolean } {
  const start = layout.rootStartSector * bpb.bytesPerSector;
  const byteLen = layout.rootDirSectors * bpb.bytesPerSector;
  const entries: DirectoryEntry[] = [];
  let overflow = false;
  for (let i = 0; i < bpb.rootEntries; i++) {
    const offset = start + i * 32;
    if (offset + 32 > buf.length) {
      overflow = true;
      break;
    }
    const e = parseOne(buf, offset, 0);
    if (e.kind === "free") break;
    entries.push(e);
  }
  if (start + byteLen > buf.length) overflow = true;
  return { entries, overflow };
}

/** Read a sub-directory cluster chain as a flat sequence of 32-byte slots. */
export function readSubdirEntries(
  buf: Buffer,
  bpb: BpbParams,
  layout: VolumeLayout,
  clusters: number[],
  parentCluster: number,
): { entries: DirectoryEntry[]; truncated: boolean } {
  const entries: DirectoryEntry[] = [];
  let truncated = false;
  const clusterBytes = bpb.sectorsPerCluster * bpb.bytesPerSector;
  for (const cluster of clusters) {
    const sector = layout.firstDataSector + (cluster - 2) * bpb.sectorsPerCluster;
    const start = sector * bpb.bytesPerSector;
    if (start + clusterBytes > buf.length) {
      truncated = true;
      continue;
    }
    const slots = clusterBytes / 32;
    for (let s = 0; s < slots; s++) {
      const e = parseOne(buf, start + s * 32, parentCluster);
      if (e.kind === "free") return { entries, truncated };
      entries.push(e);
    }
  }
  return { entries, truncated };
}

/** Validate an 8.3 name for the synthetic image generator. */
export function validate83(name: string): void {
  if (name === "." || name === "..") return;
  const m = /^([^.]{1,8})(?:\.([^.]{1,3}))?$/;
  if (!m.test(name)) {
    throw new Error(`"${name}" is not a valid 8.3 short file name`);
  }
  if (/[\\/:*?"<>|\x00-\x1f]/.test(name)) {
    throw new Error(`"${name}" contains characters forbidden in 8.3 names`);
  }
}

export function encode83(name: string): Buffer {
  const out = Buffer.alloc(11, 0x20);
  if (name === ".") {
    out[0] = 0x2e;
    return out;
  }
  if (name === "..") {
    out[0] = 0x2e;
    out[1] = 0x2e;
    return out;
  }
  const [base, ext = ""] = name.split(".");
  out.write(base.toUpperCase().padEnd(8, " "), 0, "latin1");
  if (ext) out.write(ext.toUpperCase().padEnd(3, " "), 8, "latin1");
  return out;
}
