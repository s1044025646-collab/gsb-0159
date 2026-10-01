import type { CheckIssue, ParsedDirEntry, VolumeParams } from "./types.ts";
import { walkChain } from "./fat.ts";

const ATTR_READ_ONLY = 0x01;
const ATTR_HIDDEN = 0x02;
const ATTR_SYSTEM = 0x04;
const ATTR_VOLUME_ID = 0x08;
const ATTR_DIRECTORY = 0x10;
const ATTR_ARCHIVE = 0x20;
const ATTR_LFN = 0x0f;
const DELETED = 0xe5;
const DELETED_ESC = 0x05;

function decodeShortName(raw: Buffer): { name: string; deleted: boolean } {
  const bytes = Buffer.from(raw);
  let deleted = false;
  if (bytes[0] === DELETED) deleted = true;
  if (bytes[0] === DELETED_ESC) bytes[0] = DELETED;
  const baseBytes = bytes.subarray(0, 8);
  const extBytes = bytes.subarray(8, 11);
  const base = decode83Part(baseBytes);
  const ext = decode83Part(extBytes);
  return { name: ext === "" ? base : `${base}.${ext}`, deleted };
}

function decode83Part(part: Buffer): string {
  let end = part.length;
  while (end > 0 && part[end - 1] === 0x20) end--;
  let out = "";
  for (let i = 0; i < end; i++) {
    const ch = part[i]!;
    if (ch >= 0x21 && ch <= 0x7e) out += String.fromCharCode(ch);
  }
  return out;
}

export interface Region {
  start: number;
  length: number;
  parentPath: string;
  isRoot: boolean;
  firstCluster: number;
}

export interface DirScanResult {
  entries: ParsedDirEntry[];
  regions: Region[];
  issues: CheckIssue[];
}

/**
 * Scan the fixed root and all reachable subdirectory regions.
 * BFS with explicit seen-region guard prevents infinite recursion on directory loops.
 */
export function scanDirectories(
  buf: Buffer,
  p: VolumeParams,
  fat: Uint16Array,
): DirScanResult {
  const entries: ParsedDirEntry[] = [];
  const issues: CheckIssue[] = [];
  const rootStart = p.rootDirSector * p.bytesPerSector;
  const rootLength = p.rootDirSectors * p.bytesPerSector;
  const queue: Region[] = [
    { start: rootStart, length: rootLength, parentPath: "", isRoot: true, firstCluster: 0 },
  ];
  const visitedClusters = new Set<number>();

  while (queue.length > 0) {
    const region = queue.shift()!;
    if (!region.isRoot) {
      const walk = walkChain(fat, p.totalClusters, region.firstCluster, region.parentPath);
      if (walk.chain.some((c) => visitedClusters.has(c))) {
        issues.push({
          code: "CHAIN_LOOP",
          severity: "error",
          message: `Directory ${region.parentPath} reuses a cluster already visited by another directory.`,
          path: region.parentPath,
        });
      }
      walk.chain.forEach((c) => visitedClusters.add(c));
      issues.push(...walk.issues);
    }

    const end = region.start + region.length;
    if (end > buf.length) {
      issues.push({
        code: "OFFSET_OUT_OF_BOUNDS",
        severity: "error",
        message: `Directory region for ${region.parentPath || "<root>"} ends at offset ${end}, beyond image size ${buf.length}.`,
        offset: end,
        path: region.parentPath,
      });
      continue;
    }

    let lfnPending = false;
    for (let slot = 0; slot * 32 + 32 <= region.length; slot++) {
      const off = region.start + slot * 32;
      const rec = buf.subarray(off, off + 32);
      const first = rec[0]!;
      if (first === 0x00) break; // free slot and all following slots are free
      const attr = rec[11]!;

      if (attr === ATTR_LFN) {
        lfnPending = true;
        const entry = baseEntry(rec, slot, off, region.parentPath, true);
        entry.kind = "lfn-unsupported";
        entry.partOfUnsupportedLfn = true;
        entry.path = joinPath(region.parentPath, "<lfn-unsupported>");
        entries.push(entry);
        issues.push({
          code: "LFN_UNSUPPORTED",
          severity: "warning",
          message: `Long file name slot at offset ${off} is not supported; the slot is never interpreted as an 8.3 file.`,
          offset: off,
          path: region.parentPath,
        });
        continue;
      }

      const entry = baseEntry(rec, slot, off, region.parentPath, false);
      const { name, deleted } = decodeShortName(rec.subarray(0, 11));
      entry.shortName = name;
      entry.deleted = deleted;

      if (deleted) {
        entry.kind = "deleted";
        entry.path = joinPath(region.parentPath, name);
        entries.push(entry);
        issues.push({
          code: "DELETED_ENTRY_PRESENT",
          severity: "info",
          message: `Deleted directory entry "${name}" at offset ${off}; no recovery is attempted.`,
          offset: off,
          path: region.parentPath,
        });
        lfnPending = false;
        continue;
      }

      const followsLfn = lfnPending;
      lfnPending = false;

      if ((attr & ATTR_VOLUME_ID) !== 0 && !region.isRoot) {
        entry.kind = "invalid";
      } else if ((attr & ATTR_VOLUME_ID) !== 0) {
        entry.kind = "volume-label";
      } else if ((attr & ATTR_DIRECTORY) !== 0) {
        entry.kind = "directory";
      } else {
        entry.kind = "file";
      }

      if (followsLfn) entry.partOfUnsupportedLfn = true;
      entry.path = joinPath(region.parentPath, name);
      entries.push(entry);

      const isDotEntry = entry.kind === "directory" && (name === "." || name === "..");
      if (entry.kind === "directory" && entry.firstCluster >= 2 && !isDotEntry) {
        const clusterBytes = p.sectorsPerCluster * p.bytesPerSector;
        const dataStart =
          (p.firstDataSector +
            (entry.firstCluster - 2) * p.sectorsPerCluster) *
          p.bytesPerSector;
        queue.push({
          start: dataStart,
          length: clusterBytes,
          parentPath: entry.path,
          isRoot: false,
          firstCluster: entry.firstCluster,
        });
      }
    }
  }

  return { entries, regions: [], issues };
}

function baseEntry(
  rec: Buffer,
  slotIndex: number,
  offset: number,
  parentPath: string,
  isLfn: boolean,
): ParsedDirEntry {
  const attr = isLfn ? rec[11]! : rec[11]!;
  return {
    slotIndex,
    offset,
    kind: "invalid",
    shortName: "",
    rawName: rec.subarray(0, 11).toString("latin1"),
    attributes: attr,
    isReadOnly: (attr & ATTR_READ_ONLY) !== 0,
    isHidden: (attr & ATTR_HIDDEN) !== 0,
    isSystem: (attr & ATTR_SYSTEM) !== 0,
    isArchive: (attr & ATTR_ARCHIVE) !== 0,
    createTime: isLfn ? null : rec.readUInt16LE(14),
    createDate: isLfn ? null : rec.readUInt16LE(16),
    modifyTime: isLfn ? null : rec.readUInt16LE(22),
    modifyDate: isLfn ? null : rec.readUInt16LE(24),
    accessDate: isLfn ? null : rec.readUInt16LE(18),
    firstCluster: isLfn ? 0 : rec.readUInt16LE(26),
    fileSize: isLfn ? 0 : rec.readUInt32LE(28),
    parentPath,
    path: "",
    partOfUnsupportedLfn: false,
    deleted: false,
  };
}

function joinPath(parent: string, name: string): string {
  if (parent === "") return `/${name}`;
  return `${parent}/${name}`;
}
