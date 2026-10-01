import type { CheckIssue, ClusterOccupancy, VolumeParams } from "./types.ts";

export const FAT_FREE = 0x0000;
export const FAT_EOC_MIN = 0xfff8;
export const FAT_EOC_MAX = 0xffff;
export const FAT_BAD = 0xfff7;

export interface FatReadResult {
  copies: Uint16Array[];
  /** copy0 chosen as the navigation view; divergence is always recorded. */
  divergence: CheckIssue[];
}

/** Read every FAT copy as 16-bit entries; nothing here assumes one copy is authoritative. */
export function readFatCopies(buf: Buffer, p: VolumeParams): FatReadResult {
  const entries = p.totalClusters + 2;
  const copies: Uint16Array[] = [];
  for (let c = 0; c < p.numberOfFats; c++) {
    const start = (p.firstFatSector + c * p.fatSize16) * p.bytesPerSector;
    const arr = new Uint16Array(entries);
    for (let i = 0; i < entries; i++) {
      arr[i] = buf.readUInt16LE(start + i * 2) & 0xffff;
    }
    copies.push(arr);
  }

  const divergence: CheckIssue[] = [];
  const primary = copies[0]!;
  for (let c = 1; c < copies.length; c++) {
    const other = copies[c]!;
    for (let i = 0; i < entries; i++) {
      if (primary[i] !== other[i]) {
        divergence.push({
          code: "FAT_COPIES_DIVERGE",
          severity: "error",
          message: `FAT copy 0 and copy ${c} disagree at cluster ${i}: 0x${(primary[i] ?? 0).toString(16)} vs 0x${(other[i] ?? 0).toString(16)}.`,
          cluster: i,
          evidence: {
            cluster: i,
            copy0: primary[i],
            [`copy${c}`]: other[i],
            fatByteOffsetCopy0: p.firstFatSector * p.bytesPerSector + i * 2,
            fatByteOffsetCopyN:
              (p.firstFatSector + c * p.fatSize16) * p.bytesPerSector + i * 2,
          },
        });
      }
    }
  }
  return { copies, divergence };
}

export function isEoc(v: number): boolean {
  return v >= FAT_EOC_MIN && v <= FAT_EOC_MAX;
}

export function buildOccupancy(
  copies: Uint16Array[],
  totalClusters: number,
): ClusterOccupancy[] {
  const primary = copies[0]!;
  const out: ClusterOccupancy[] = [];
  for (let i = 0; i < totalClusters + 2; i++) {
    const values = copies.map((c) => c[i]!);
    const v = primary[i]!;
    let status: ClusterOccupancy["status"];
    if (i < 2) status = "reserved";
    else if (v === FAT_FREE) status = "free";
    else if (v === FAT_BAD) status = "bad";
    else if (isEoc(v)) status = "eoc";
    else status = "allocated";
    out.push({ cluster: i, status, fatValues: values, ownerPath: null });
  }
  return out;
}

export interface WalkResult {
  chain: number[];
  issues: CheckIssue[];
  terminated: boolean;
}

/**
 * Walk a cluster chain starting at `start` (0 means empty).
 * Detects loops, cross-links (a cluster reached twice within this chain),
 * out-of-range references, explicit bad clusters and premature free endings.
 */
export function walkChain(
  fat: Uint16Array,
  totalClusters: number,
  start: number,
  ownerPath: string,
): WalkResult {
  const chain: number[] = [];
  const issues: CheckIssue[] = [];
  if (start === 0) return { chain, issues, terminated: true };
  if (start < 2 || start > totalClusters + 1) {
    issues.push({
      code: "CLUSTER_INDEX_OUT_OF_RANGE",
      severity: "error",
      message: `${ownerPath}: starting cluster ${start} is outside data clusters [2, ${totalClusters + 1}].`,
      cluster: start,
      path: ownerPath,
    });
    return { chain, issues, terminated: false };
  }

  const seen = new Set<number>();
  let cur = start;
  while (true) {
    if (seen.has(cur)) {
      issues.push({
        code: "CHAIN_LOOP",
        severity: "error",
        message: `${ownerPath}: cluster chain loops back to cluster ${cur}.`,
        cluster: cur,
        path: ownerPath,
      });
      return { chain, issues, terminated: false };
    }
    seen.add(cur);
    chain.push(cur);

    if (cur === FAT_BAD) {
      issues.push({
        code: "BAD_CLUSTER_REFERENCED",
        severity: "error",
        message: `${ownerPath}: chain enters explicit bad cluster 0xfff7.`,
        cluster: cur,
        path: ownerPath,
      });
      return { chain, issues, terminated: false };
    }

    const next = fat[cur]! & 0xffff;
    if (next === cur) {
      issues.push({
        code: "CHAIN_LOOP",
        severity: "error",
        message: `${ownerPath}: cluster ${cur} points back to itself.`,
        cluster: cur,
        path: ownerPath,
        evidence: { selfReference: cur },
      });
      return { chain, issues, terminated: false };
    }
    if (isEoc(next)) return { chain, issues, terminated: true };
    if (next === FAT_FREE) {
      issues.push({
        code: "CHAIN_TRUNCATED",
        severity: "error",
        message: `${ownerPath}: cluster ${cur} points to free cluster 0; chain ends without EOC.`,
        cluster: cur,
        path: ownerPath,
      });
      return { chain, issues, terminated: false };
    }
    if (next === FAT_BAD) {
      issues.push({
        code: "BAD_CLUSTER_REFERENCED",
        severity: "error",
        message: `${ownerPath}: cluster ${cur} points to bad cluster 0xfff7.`,
        cluster: cur,
        path: ownerPath,
        evidence: { fromCluster: cur, next },
      });
      return { chain, issues, terminated: false };
    }
    if (next < 2 || next > totalClusters + 1) {
      issues.push({
        code: "CLUSTER_INDEX_OUT_OF_RANGE",
        severity: "error",
        message: `${ownerPath}: cluster ${cur} references out-of-range cluster ${next}.`,
        cluster: next,
        path: ownerPath,
        evidence: { fromCluster: cur, next },
      });
      return { chain, issues, terminated: false };
    }
    cur = next;
  }
}
