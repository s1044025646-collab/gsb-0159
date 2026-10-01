import { computeLayout, parseBpb } from "./bpb.js";
import { readRootEntries, readSubdirEntries } from "./dir.js";
import { readFatCopies, traceChain } from "./fat.js";
import type {
  BpbParams,
  DirectoryEntry,
  Issue,
  ScanResult,
  VolumeLayout,
} from "./types.js";

/**
 * Parse a whole FAT16 volume image read-only. No byte of the buffer is ever
 * mutated; deleted slots are reported but never guessed at or recovered.
 */
export function scanImage(buf: Buffer): ScanResult {
  const { bpb, issues: bpbIssues } = parseBpb(buf);
  const empty: ScanResult = {
    bpb: bpb ?? emptyBpb(),
    layout: emptyLayout(buf),
    entries: [],
    chains: new Map(),
    issues: bpbIssues,
    allocatedClusters: 0,
    orphanClusters: [],
    fatCopies: [],
    ownerByCluster: new Map(),
  };
  if (!bpb || bpbIssues.some((i) => i.severity === "error")) return empty;

  const { layout, issues: layoutIssues } = computeLayout(buf, bpb);
  if (!layout) return { ...empty, issues: [...bpbIssues, ...layoutIssues] };

  const { copies, issues: fatIssues } = readFatCopies(buf, bpb, layout);
  const fat = copies[0];
  const issues: Issue[] = [...layoutIssues, ...fatIssues];

  const entries: DirectoryEntry[] = [];
  const chains = new Map<number, ReturnType<typeof traceChain>>();
  const ownerByCluster = new Map<number, number>();

  const noteOwners = (start: number, clusters: number[]) => {
    for (const c of clusters) {
      if (ownerByCluster.has(c)) {
        const first = ownerByCluster.get(c)!;
        issues.push({
          code: "CROSS_LINKED",
          severity: "error",
          message: `Cluster ${c} is claimed by chains starting at ${first} and ${start}.`,
          offset: null,
          cluster: c,
          extra: { firstOwner: first, secondOwner: start },
        });
      } else {
        ownerByCluster.set(c, start);
      }
    }
  };

  const { entries: rootEntries, overflow } = readRootEntries(buf, bpb, layout);
  if (overflow) {
    issues.push({
      code: "ROOT_SLOT_OVERFLOW",
      severity: "error",
      message: "Fixed root directory region extends past the end of the image.",
      offset: layout.rootStartSector * bpb.bytesPerSector,
    });
  }

  interface Pending { entry: DirectoryEntry; parentPath: string }
  const queue: Pending[] = rootEntries.map((e) => ({ entry: e, parentPath: "" }));

  while (queue.length > 0) {
    const { entry, parentPath } = queue.shift()!;
    const name = entry.shortName ?? "<unavailable>";
    const baseName = parentPath === "" ? "" : parentPath;
    const path = entry.kind === "volume-label" || entry.kind === "deleted" || entry.kind === "lfn-slot"
      ? `/${name}`
      : `${baseName}/${name}`;
    const resolved: DirectoryEntry = { ...entry, path };
    entries.push(resolved);

    if (entry.kind === "lfn-slot" || entry.kind === "deleted" || entry.kind === "volume-label") {
      continue;
    }
    if (entry.kind === "dot" || entry.kind === "dotdot") continue;
    const isDir = entry.kind === "directory";
    if (entry.firstCluster === 0 || (!isDir && entry.fileSize === 0)) continue;

    if (!chains.has(entry.firstCluster)) {
      const chain = traceChain(entry.firstCluster, entry.fileSize, bpb, layout, fat, isDir);
      chains.set(entry.firstCluster, chain);
      issues.push(...chain.issues);
    }
    // Attribute ownership for every directory entry, even when two entries
    // alias the identical start cluster (that is itself a cross-link).
    noteOwners(entry.firstCluster, chains.get(entry.firstCluster)!.clusters);

    if (isDir) {
      const chain = chains.get(entry.firstCluster)!;
      const { entries: subEntries, truncated } = readSubdirEntries(
        buf,
        bpb,
        layout,
        chain.clusters,
        entry.firstCluster,
      );
      if (truncated) {
        issues.push({
          code: "IMAGE_TRUNCATED",
          severity: "error",
          message: `Subdirectory ${path} cluster data runs past the image end.`,
          offset: null,
          cluster: entry.firstCluster,
        });
      }
      for (const se of subEntries) queue.push({ entry: se, parentPath: path });
    }
  }

  const orphanClusters: number[] = [];
  // A data cluster is allocated when either some FAT entry points at it, or
  // its own slot is non-free (a continuation, a run start carrying EOC, or a
  // bad marker). Chains reached from directories populate ownerByCluster;
  // everything else allocated-but-unreached is an orphan.
  const pointed = new Set<number>();
  for (let i = 2; i <= layout.clusterCount + 1; i++) {
    const v = fat[i] & 0xffff;
    if (v >= 2 && v <= layout.clusterCount + 1) pointed.add(v);
  }
  for (let c = 2; c <= layout.clusterCount + 1; c++) {
    const v = fat[c];
    const allocated = pointed.has(c) || (v !== 0x0000 && v !== 1);
    if (allocated && !ownerByCluster.has(c)) {
      orphanClusters.push(c);
    }
  }
  for (const c of orphanClusters) {
    issues.push({
      code: "ORPHAN_CLUSTER",
      severity: "warning",
      message: `Cluster ${c} is marked allocated in the FAT but no directory entry reaches it.`,
      offset: null,
      cluster: c,
    });
  }

  return {
    bpb,
    layout,
    entries,
    chains,
    issues,
    allocatedClusters: ownerByCluster.size,
    orphanClusters,
    fatCopies: copies,
    ownerByCluster,
  };
}

function emptyBpb(): BpbParams {
  return {
    bytesPerSector: 0,
    sectorsPerCluster: 0,
    reservedSectors: 0,
    numFats: 0,
    rootEntries: 0,
    totalSectors16: 0,
    media: 0,
    fatSize16: 0,
    totalSectors32: 0,
    oemName: "",
    volumeLabel: "",
  };
}

function emptyLayout(buf: Buffer): VolumeLayout {
  return {
    imageSize: buf.length,
    totalSectors: 0,
    fatStartSector: 0,
    fatSizeSectors: 0,
    rootStartSector: 0,
    rootDirSectors: 0,
    dataStartSector: 0,
    clusterCount: 0,
    firstDataSector: 0,
    totalDataSectors: 0,
  };
}
