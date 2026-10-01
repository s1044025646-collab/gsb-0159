import { clusterToOffset } from "./bpb.js";
import type { BpbParams, ChainTrace, Issue, VolumeLayout } from "./types.js";

export const FAT_EOC_MIN = 0xfff8;
export const FAT_EOC_MAX = 0xffff;
export const FAT_BAD = 0xfff7;
export const FAT_FREE = 0x0000;

/** Read every FAT copy independently. Conflicts are preserved, never resolved silently. */
export function readFatCopies(
  buf: Buffer,
  bpb: BpbParams,
  layout: VolumeLayout,
): { copies: number[][]; issues: Issue[] } {
  const issues: Issue[] = [];
  const entries = layout.clusterCount + 2;
  const copies: number[][] = [];

  for (let copy = 0; copy < bpb.numFats; copy++) {
    const fatOffset = (layout.fatStartSector + copy * layout.fatSizeSectors) * bpb.bytesPerSector;
    const endOffset = fatOffset + entries * 2;
    if (endOffset > buf.length) {
      issues.push({
        code: "FAT_OUT_OF_BOUNDS",
        severity: "error",
        message: `FAT copy ${copy} table end at byte ${endOffset} exceeds image size ${buf.length}.`,
        offset: Math.min(endOffset, buf.length),
        extra: { copy },
      });
      copies.push(new Array(entries).fill(FAT_FREE));
      continue;
    }
    const table: number[] = new Array(entries);
    for (let i = 0; i < entries; i++) {
      table[i] = buf.readUInt16LE(fatOffset + i * 2);
    }
    copies.push(table);
  }

  // Cross-copy comparison produces evidence at the exact FAT byte offset.
  if (copies.length > 1) {
    const base = copies[0];
    for (let i = 0; i < base.length; i++) {
      for (let copy = 1; copy < copies.length; copy++) {
        if (copies[copy][i] !== base[i]) {
          const fatByte =
            (layout.fatStartSector + copy * layout.fatSizeSectors) * bpb.bytesPerSector + i * 2;
          const values = copies.map((c) => `0x${c[i].toString(16).padStart(4, "0")}`).join(",");
          issues.push({
            code: "FAT_COPY_CONFLICT",
            severity: "error",
            message: `FAT entry ${i} differs across copies: [${values}]. No copy treated as authoritative.`,
            offset: fatByte,
            cluster: i >= 2 ? i : undefined,
            extra: { entry: i, copy },
          });
        }
      }
    }
  }
  return { copies, issues };
}

function isEoc(v: number): boolean {
  return v >= FAT_EOC_MIN && v <= FAT_EOC_MAX;
}

/**
 * Walk one cluster chain using copy 0 values, bounded by the declared cluster
 * count and the real file size. Detects loops, bad clusters and truncation.
 */
export function traceChain(
  startCluster: number,
  fileSize: number,
  bpb: BpbParams,
  layout: VolumeLayout,
  fat: number[],
  isDirectory = false,
): ChainTrace {
  const issues: Issue[] = [];
  const clusters: number[] = [];
  const clusterBytes = bpb.sectorsPerCluster * bpb.bytesPerSector;
  const expectedClusters = fileSize === 0 ? 0 : Math.ceil(fileSize / clusterBytes);

  if (startCluster === 0 || (fileSize === 0 && !isDirectory)) {
    if (fileSize > 0 && startCluster === 0) {
      issues.push({
        code: "CHAIN_TRUNCATED",
        severity: "error",
        message: `File of ${fileSize} bytes has first cluster 0 but needs ${expectedClusters} clusters.`,
        offset: null,
      });
    }
    return { startCluster, expectedClusters, clusters, terminator: null, issues };
  }

  const seen = new Set<number>();
  let current = startCluster;
  let terminator: number | null = null;
  const guard = layout.clusterCount + 2;
  let steps = 0;

  while (true) {
    if (current < 2 || current > layout.clusterCount + 1) {
      issues.push({
        code: "FAT_OUT_OF_BOUNDS",
        severity: "error",
        message: `Chain from ${startCluster} references cluster ${current}, outside 2..${layout.clusterCount + 1}.`,
        offset: null,
        cluster: current,
      });
      break;
    }
    if (seen.has(current)) {
      issues.push({
        code: "CHAIN_LOOP",
        severity: "error",
        message: `Chain from ${startCluster} loops at cluster ${current}.`,
        offset: clusterToOffset(layout, bpb, current),
        cluster: current,
      });
      break;
    }
    seen.add(current);
    clusters.push(current);

    const next = fat[current];
    if (next === FAT_BAD) {
      issues.push({
        code: "BAD_CLUSTER",
        severity: "error",
        message: `Cluster ${current} in chain from ${startCluster} is marked bad (0xfff7).`,
        offset: clusterToOffset(layout, bpb, current),
        cluster: current,
      });
      break;
    }
    if (isEoc(next)) {
      terminator = next;
      break;
    }
    if (next === FAT_FREE) {
      issues.push({
        code: "CHAIN_TRUNCATED",
        severity: "error",
        message: `Cluster ${current} points to a free cluster; chain ended before EOC.`,
        offset: clusterToOffset(layout, bpb, current),
        cluster: current,
      });
      break;
    }
    if (next === 1) {
      issues.push({
        code: "FAT_OUT_OF_BOUNDS",
        severity: "error",
        message: `Cluster ${current} points to reserved cluster 1.`,
        offset: clusterToOffset(layout, bpb, current),
        cluster: current,
      });
      break;
    }
    current = next;
    if (++steps > guard) {
      issues.push({
        code: "CHAIN_LOOP",
        severity: "error",
        message: `Chain from ${startCluster} exceeded ${guard} steps (cycle guard).`,
        offset: null,
      });
      break;
    }
  }

  if (!isDirectory && terminator !== null && clusters.length < expectedClusters) {
    issues.push({
      code: "CHAIN_TRUNCATED",
      severity: "error",
      message: `File needs ${expectedClusters} clusters but chain from ${startCluster} has ${clusters.length}.`,
      offset: clusterToOffset(layout, bpb, startCluster),
      cluster: startCluster,
    });
  }
  return { startCluster, expectedClusters, clusters, terminator, issues };
}
