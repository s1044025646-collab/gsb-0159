import { createHash } from "node:crypto";
import { readBpb } from "./bpb.ts";
import { buildOccupancy, readFatCopies, walkChain } from "./fat.ts";
import { scanDirectories } from "./dir.ts";
import type {
  ChainTrace,
  CheckIssue,
  ClusterOccupancy,
  ParseResult,
  ParsedDirEntry,
} from "./types.ts";

export interface ParseOptions {
  imagePath: string;
  now?: number;
}

/**
 * Read-only, order-validated FAT16 parse. Layout/BPB checks run before any
 * data region is touched; every cluster/offset is bounds-checked first.
 */
export function parseImage(buf: Buffer, opts: ParseOptions): ParseResult {
  const parsedAt = opts.now ?? Date.now();
  const sha256 = createHash("sha256").update(buf).digest("hex");
  const { params, issues: bpbIssues } = readBpb(buf);
  if (!params) {
    return {
      imagePath: opts.imagePath,
      imageSize: buf.length,
      sha256,
      params: {
        oemName: "", bytesPerSector: 512, sectorsPerCluster: 1, reservedSectors: 1,
        numberOfFats: 1, rootEntryCount: 0, totalSectors16: 0, media: 0, fatSize16: 0,
        sectorsPerTrack: 0, numberOfHeads: 0, hiddenSectors: 0, totalSectors32: 0,
        rootDirSectors: 0, firstFatSector: 0, rootDirSector: 0, firstDataSector: 0,
        totalClusters: 0, fatType: "FAT16",
      },
      fatCopies: [],
      entries: [],
      clusters: [],
      chains: [],
      issues: bpbIssues,
      parsedAt,
    };
  }

  const { copies, divergence } = readFatCopies(buf, params);
  const fat = copies[0]!;
  const dirScan = scanDirectories(buf, params, fat);
  const clusters = buildOccupancy(copies, params.totalClusters);

  const chains: ChainTrace[] = [];
  const issues: CheckIssue[] = [...bpbIssues, ...divergence, ...dirScan.issues];

  const contentOwners = new Map<number, string>();

  for (const entry of dirScan.entries) {
    if (entry.kind !== "file" && entry.kind !== "directory") continue;
    if (entry.shortName === "." || entry.shortName === "..") continue;
    const walk = walkChain(fat, params.totalClusters, entry.firstCluster, entry.path);
    const clusterBytes = params.sectorsPerCluster * params.bytesPerSector;
    const expected =
      entry.kind === "file"
        ? entry.fileSize === 0
          ? 0
          : Math.ceil(entry.fileSize / clusterBytes)
        : walk.chain.length;

    for (const c of walk.chain) {
      const prior = contentOwners.get(c);
      if (prior !== undefined) {
        issues.push({
          code: "CHAIN_CROSS_LINKED",
          severity: "error",
          message: `Cluster ${c} is referenced by both "${prior}" and "${entry.path}".`,
          cluster: c,
          path: entry.path,
          evidence: { cluster: c, firstOwner: prior, secondOwner: entry.path },
        });
      } else {
        contentOwners.set(c, entry.path);
      }
    }

    if (entry.kind === "file") {
      if (entry.fileSize === 0 && entry.firstCluster !== 0) {
        issues.push({
          code: "SIZE_CLUSTER_MISMATCH",
          severity: "error",
          message: `${entry.path}: zero-byte file must start at cluster 0, found ${entry.firstCluster}.`,
          cluster: entry.firstCluster,
          path: entry.path,
        });
      }
      if (entry.fileSize > 0 && walk.chain.length < expected) {
        issues.push({
          code: "CHAIN_TRUNCATED",
          severity: "error",
          message: `${entry.path}: size ${entry.fileSize} needs ${expected} cluster(s) but chain yields ${walk.chain.length}.`,
          path: entry.path,
        });
      }
      if (walk.terminated && walk.chain.length > expected) {
        issues.push({
          code: "SIZE_CLUSTER_MISMATCH",
          severity: "warning",
          message: `${entry.path}: chain has ${walk.chain.length} cluster(s) but size requires ${expected}; trailing bytes are ignored.`,
          path: entry.path,
        });
      }
    }

    chains.push({
      path: entry.path,
      firstCluster: entry.firstCluster,
      expectedClustersFromSize: expected,
      chain: walk.chain,
      terminated: walk.terminated,
      issues: walk.issues,
    });
    issues.push(...walk.issues);
  }

  for (const occ of clusters) {
    if (occ.cluster < 2) continue;
    const owner = contentOwners.get(occ.cluster) ?? null;
    occ.ownerPath = owner;
    if (occ.status === "bad") {
      issues.push({
        code: "BAD_CLUSTER_REFERENCED",
        severity: "info",
        message: `Cluster ${occ.cluster} is marked bad (0xfff7) in the FAT.`,
        cluster: occ.cluster,
      });
    }
    if (occ.status === "allocated" || occ.status === "eoc") {
      if (owner === null) {
        issues.push({
          code: "ORPHAN_ALLOCATED_CLUSTER",
          severity: "warning",
          message: `Cluster ${occ.cluster} is marked allocated (fat value 0x${(fat[occ.cluster] ?? 0).toString(16)}) but no file or directory reaches it.`,
          cluster: occ.cluster,
        });
      }
    }
  }

  return {
    imagePath: opts.imagePath,
    imageSize: buf.length,
    sha256,
    params,
    fatCopies: copies,
    entries: dirScan.entries,
    clusters,
    chains,
    issues,
    parsedAt,
  };
}

/** Export a file's bytes following the FAT chain, truncated to the real directory size. */
export function exportFile(
  buf: Buffer,
  result: ParseResult,
  entry: ParsedDirEntry,
): { data: Buffer; issues: CheckIssue[] } {
  const p = result.params;
  const chain = result.chains.find((c) => c.path === entry.path);
  const issues: CheckIssue[] = [];
  if (entry.kind !== "file") {
    return { data: Buffer.alloc(0), issues: [{
      code: "LAYOUT_INVALID", severity: "error",
      message: `${entry.path} is not a regular file and cannot be exported.`, path: entry.path,
    }] };
  }
  if (entry.fileSize === 0) return { data: Buffer.alloc(0), issues };
  if (!chain) {
    return { data: Buffer.alloc(0), issues: [{
      code: "CHAIN_TRUNCATED", severity: "error",
      message: `No cluster chain recorded for ${entry.path}.`, path: entry.path,
    }] };
  }
  const clusterBytes = p.sectorsPerCluster * p.bytesPerSector;
  const out = Buffer.alloc(Math.min(entry.fileSize, chain.chain.length * clusterBytes));
  let written = 0;
  for (const cluster of chain.chain) {
    const start =
      (p.firstDataSector + (cluster - 2) * p.sectorsPerCluster) * p.bytesPerSector;
    if (start < 0 || start + clusterBytes > buf.length) {
      issues.push({
        code: "OFFSET_OUT_OF_BOUNDS", severity: "error",
        message: `Cluster ${cluster} data window [${start}, ${start + clusterBytes}) exceeds image size ${buf.length}.`,
        cluster, offset: start, path: entry.path,
      });
      break;
    }
    const take = Math.min(clusterBytes, entry.fileSize - written);
    if (take <= 0) break;
    buf.copy(out, written, start, start + take);
    written += take;
  }
  if (written < entry.fileSize) {
    issues.push({
      code: "CHAIN_TRUNCATED", severity: "error",
      message: `${entry.path}: exported ${written} of ${entry.fileSize} declared bytes.`,
      path: entry.path,
    });
  }
  return { data: out.subarray(0, written), issues };
}

export interface OccupancyStats {
  free: number;
  allocated: number;
  eoc: number;
  bad: number;
  reserved: number;
  orphan: number;
}

export function occupancyStats(clusters: ClusterOccupancy[]): OccupancyStats {
  const stats = { free: 0, allocated: 0, eoc: 0, bad: 0, reserved: 0, orphan: 0 };
  for (const c of clusters) {
    if (c.cluster < 2) { stats.reserved++; continue; }
    stats[c.status === "free" ? "free" : c.status === "bad" ? "bad" : c.status === "eoc" ? "eoc" : "allocated"]++;
    if ((c.status === "allocated" || c.status === "eoc") && c.ownerPath === null) stats.orphan++;
  }
  return stats;
}
