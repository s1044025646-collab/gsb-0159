import { createHash } from "node:crypto";
import { resolve, relative, isAbsolute } from "node:path";
import type { BpbParams, ScanResult, VolumeLayout } from "./types.js";

export class ExportError extends Error {
  constructor(
    public code: "NOT_A_FILE" | "BROKEN_CHAIN" | "NOT_FOUND" | "PATH_ESCAPE",
    message: string,
  ) {
    super(message);
    this.name = "ExportError";
  }
}

/**
 * Rebuild a file's bytes from its cluster chain, truncated to the directory
 * entry's declared size. Reads only; the image buffer is never modified.
 */
export function readFileBytes(image: Buffer, scan: ScanResult, path: string): Buffer {
  const entry = scan.entries.find((e) => e.path === path && e.kind === "file");
  if (!entry) throw new ExportError("NOT_FOUND", `No live file entry at ${path}`);
  if (entry.fileSize === 0) return Buffer.alloc(0);

  const chain = scan.chains.get(entry.firstCluster);
  if (!chain || chain.clusters.length === 0) {
    throw new ExportError("BROKEN_CHAIN", `File ${path} has no readable cluster chain`);
  }
  if (chain.issues.some((i) => i.severity === "error")) {
    throw new ExportError(
      "BROKEN_CHAIN",
      `File ${path} chain is corrupt: ${chain.issues[0].message}`,
    );
  }

  const { bpb, layout } = scan;
  const clusterBytes = bpb.sectorsPerCluster * bpb.bytesPerSector;
  const out = Buffer.alloc(chain.clusters.length * clusterBytes);
  for (let i = 0; i < chain.clusters.length; i++) {
    const off = clusterOffset(layout, bpb, chain.clusters[i]);
    const slice = image.subarray(off, off + clusterBytes);
    slice.copy(out, i * clusterBytes);
  }
  return out.subarray(0, entry.fileSize);
}

function clusterOffset(layout: VolumeLayout, bpb: BpbParams, cluster: number): number {
  return (layout.firstDataSector + (cluster - 2) * bpb.sectorsPerCluster) * bpb.bytesPerSector;
}

export function sha256(buf: Buffer): string {
  return createHash("sha256").update(buf).digest("hex");
}

/** Ensure the destination stays inside the project root (no .. or drive escapes). */
export function safeJoinPath(projectRoot: string, requested: string): string {
  const root = resolve(projectRoot);
  const target = resolve(root, requested);
  const rel = relative(root, target);
  if (isAbsolute(rel) || rel.startsWith("..") ) {
    throw new ExportError("PATH_ESCAPE", `Export path ${requested} escapes the project root`);
  }
  return target;
}
