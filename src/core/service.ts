import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { scanImage } from "../fat16/scanner.js";
import { readFileBytes, safeJoinPath, sha256, ExportError } from "../fat16/export.js";
import { Store, type Page } from "../db/store.js";
import { ApiError, paging } from "./errors.js";

export interface Clock {
  now(): Date;
}
export const systemClock: Clock = { now: () => new Date() };

export class FatService {
  constructor(
    private readonly store: Store,
    private readonly projectRoot: string,
    private readonly clock: Clock = systemClock,
  ) {}

  /** Read-only import. The source file is never opened for writing. */
  importImage(filePath: string, fileName?: string) {
    let buf: Buffer;
    try {
      buf = readFileSync(filePath);
    } catch {
      throw new ApiError("IMAGE_UNREADABLE", `Cannot read image file: ${filePath}`, 400);
    }
    if (buf.length === 0) throw new ApiError("EMPTY_IMAGE", "Image file is empty", 400);
    const hash = sha256(buf);
    const scan = scanImage(buf);
    const result = this.store.importImage({
      sha256: hash,
      fileName: fileName ?? filePath.split(/[\\/]/).pop() ?? "image.img",
      byteSize: buf.length,
      scannedAt: this.clock.now().toISOString(),
      scan,
    });
    return { ...result, hash, issueCount: scan.issues.length };
  }

  listImages(limit: number, offset: number): Page<Record<string, unknown>> {
    void paging({ limit, offset });
    return this.store.listImages(limit, offset);
  }

  summary(imageId: number) {
    const image = this.store.getImage(imageId);
    if (!image) throw new ApiError("IMAGE_NOT_FOUND", `Image ${imageId} not found`, 404);
    const volume = this.store.getVolume(imageId);
    const scanId = this.store.latestScanId(imageId);
    const scan = scanId ? this.store.getScanSummary(scanId) : undefined;
    return { image, volume, latestScan: scan };
  }

  listEntries(imageId: number, limit: number, offset: number, kind?: string) {
    this.#assertImage(imageId);
    void paging({ limit, offset });
    const scanId = this.#requireScan(imageId);
    if (kind && !this.#validKinds.has(kind)) {
      throw new ApiError("INVALID_KIND", `Unknown entry kind: ${kind}`, 400);
    }
    return this.store.listEntries(scanId, limit, offset, kind);
  }

  traceChain(imageId: number, startCluster: number) {
    this.#assertImage(imageId);
    const scanId = this.#requireScan(imageId);
    if (!Number.isInteger(startCluster) || startCluster < 2) {
      throw new ApiError("INVALID_CLUSTER", "start cluster must be an integer >= 2", 400);
    }
    const rows = this.store.getChain(scanId, startCluster);
    if (rows.length === 0) {
      throw new ApiError("CHAIN_NOT_FOUND", `No chain starts at cluster ${startCluster}`, 404);
    }
    const issues = this.store
      .listIssues(scanId, 500, 0)
      .items.filter((i) => Number(i.cluster) === startCluster);
    return { startCluster, clusters: rows.map((r) => r.cluster), issues };
  }

  listIssues(imageId: number, limit: number, offset: number, code?: string) {
    this.#assertImage(imageId);
    void paging({ limit, offset });
    const scanId = this.#requireScan(imageId);
    if (code && !this.#validCodes.has(code)) {
      throw new ApiError("INVALID_CODE", `Unknown issue code: ${code}`, 400);
    }
    return this.store.listIssues(scanId, limit, offset, code);
  }

  compareScans(imageId: number, scanA: number, scanB: number) {
    this.#assertImage(imageId);
    for (const id of [scanA, scanB]) {
      if (!this.store.getScanSummary(id)) {
        throw new ApiError("SCAN_NOT_FOUND", `Scan ${id} not found`, 404);
      }
    }
    return this.store.compareScans(scanA, scanB);
  }

  /** Export a live file into the project's export directory only. */
  exportFile(imageId: number, logicalPath: string, destRelative: string, imageSourcePath?: string) {
    this.#assertImage(imageId);
    const scanId = this.#requireScan(imageId);
    let dest: string;
    try {
      dest = safeJoinPath(this.projectRoot, destRelative);
    } catch (e) {
      if (e instanceof ExportError) throw new ApiError(e.code, e.message, 400);
      throw e;
    }

    // Rebuild from the original bytes. The stored hash proves identity.
    if (!imageSourcePath) {
      throw new ApiError("SOURCE_REQUIRED", "Original image path is required for export", 400);
    }
    const buf = readFileSync(imageSourcePath);
    const scan = scanImage(buf);
    let bytes: Buffer;
    try {
      bytes = readFileBytes(buf, scan, logicalPath);
    } catch (e) {
      if (e instanceof ExportError) throw new ApiError(e.code, e.message, 409);
      throw e;
    }
    mkdirSync(dirname(dest), { recursive: true });
    writeFileSync(dest, bytes);
    return {
      scanId,
      path: logicalPath,
      dest: resolve(dest),
      bytes: bytes.length,
      sha256: sha256(bytes),
    };
  }

  #validKinds = new Set([
    "file",
    "directory",
    "volume-label",
    "lfn-slot",
    "deleted",
    "dot",
    "dotdot",
  ]);

  #validCodes = new Set([
    "IMAGE_TRUNCATED",
    "INVALID_BPB",
    "LAYOUT_OUT_OF_BOUNDS",
    "FAT_COPY_CONFLICT",
    "FAT_OUT_OF_BOUNDS",
    "BAD_CLUSTER",
    "CHAIN_LOOP",
    "CROSS_LINKED",
    "CHAIN_TRUNCATED",
    "ORPHAN_CLUSTER",
    "ROOT_SLOT_OVERFLOW",
  ]);

  #assertImage(imageId: number): void {
    if (!this.store.getImage(imageId)) {
      throw new ApiError("IMAGE_NOT_FOUND", `Image ${imageId} not found`, 404);
    }
  }

  #requireScan(imageId: number): number {
    const scanId = this.store.latestScanId(imageId);
    if (!scanId) throw new ApiError("SCAN_NOT_FOUND", `No scan for image ${imageId}`, 404);
    return scanId;
  }
}
