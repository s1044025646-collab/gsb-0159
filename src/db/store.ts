import { DatabaseSync } from "node:sqlite";
import { migrate } from "./schema.js";
import type { ScanResult } from "../fat16/types.js";

export interface Page<T> {
  items: T[];
  total: number;
  limit: number;
  offset: number;
}

export interface ImportInput {
  sha256: string;
  fileName: string;
  byteSize: number;
  scannedAt: string;
  scan: ScanResult;
}

export class Store {
  readonly db: DatabaseSync;

  constructor(dbPath: string) {
    this.db = new DatabaseSync(dbPath);
    migrate(this.db);
  }

  close(): void {
    try {
      this.db.close();
    } catch (e) {
      if (!(e instanceof Error) || !e.message.includes("not open")) throw e;
    }
  }

  /** Idempotent import: identical content hash reuses the existing image/scan. */
  importImage(input: ImportInput): { imageId: number; scanId: number; reused: boolean } {
    const existing = this.db
      .prepare("SELECT id FROM images WHERE sha256 = ?")
      .get(input.sha256) as { id: number } | undefined;
    if (existing) {
      const scan = this.db
        .prepare("SELECT id FROM scans WHERE image_id = ? ORDER BY id DESC LIMIT 1")
        .get(existing.id) as { id: number } | undefined;
      return { imageId: existing.id, scanId: scan!.id, reused: true };
    }

    const tx = this.db.prepare("BEGIN");
    try {
      tx.run();
      const imageId = this.#insertImage(input);
      this.#insertVolume(imageId, input.scan);
      const scanId = this.#insertScan(imageId, input);
      this.#insertEntries(imageId, scanId, input.scan);
      this.#insertClusters(imageId, scanId, input.scan);
      this.#insertIssues(imageId, scanId, input.scan);
      this.db.prepare("COMMIT").run();
      return { imageId, scanId, reused: false };
    } catch (err) {
      this.db.prepare("ROLLBACK").run();
      throw err;
    }
  }

  #insertImage(input: ImportInput): number {
    const r = this.db
      .prepare(
        `INSERT INTO images(sha256,file_name,byte_size,imported_at)
         VALUES(?,?,?,?)`,
      )
      .run(input.sha256, input.fileName, input.byteSize, input.scannedAt);
    return Number(r.lastInsertRowid);
  }

  #insertVolume(imageId: number, scan: ScanResult): void {
    const { bpb, layout } = scan;
    this.db
      .prepare(
        `INSERT INTO image_volume(image_id,oem_name,volume_label,bytes_per_sector,sectors_per_cluster,
          reserved_sectors,num_fats,root_entries,fat_size_sectors,total_sectors,cluster_count,
          data_start_sector,fat_start_sector,root_start_sector)
         VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        imageId,
        bpb.oemName.trim(),
        bpb.volumeLabel.trim(),
        bpb.bytesPerSector,
        bpb.sectorsPerCluster,
        bpb.reservedSectors,
        bpb.numFats,
        bpb.rootEntries,
        layout.fatSizeSectors,
        layout.totalSectors,
        layout.clusterCount,
        layout.dataStartSector,
        layout.fatStartSector,
        layout.rootStartSector,
      );
  }

  #insertScan(imageId: number, input: ImportInput): number {
    const errs = input.scan.issues.filter((i) => i.severity === "error").length;
    const warns = input.scan.issues.filter((i) => i.severity === "warning").length;
    const r = this.db
      .prepare(
        `INSERT INTO scans(image_id,scanned_at,allocated_clusters,orphan_count,error_count,warning_count)
         VALUES(?,?,?,?,?,?)`,
      )
      .run(
        imageId,
        input.scannedAt,
        input.scan.allocatedClusters,
        input.scan.orphanClusters.length,
        errs,
        warns,
      );
    return Number(r.lastInsertRowid);
  }

  #insertEntries(imageId: number, scanId: number, scan: ScanResult): void {
    const stmt = this.db.prepare(
      `INSERT INTO dir_entries(image_id,scan_id,path,kind,short_name,attr,first_cluster,
        file_size,offset,parent_cluster,deleted)
       VALUES(?,?,?,?,?,?,?,?,?,?,?)`,
    );
    for (const e of scan.entries) {
      stmt.run(
        imageId,
        scanId,
        e.path,
        e.kind,
        e.shortName,
        e.attr,
        e.firstCluster,
        e.fileSize,
        e.offset,
        e.parentCluster,
        e.deleted ? 1 : 0,
      );
    }
  }

  #insertClusters(imageId: number, scanId: number, scan: ScanResult): void {
    const stmt = this.db.prepare(
      `INSERT INTO cluster_usage(image_id,scan_id,cluster,owner_start,position,orphan)
       VALUES(?,?,?,?,?,?)`,
    );
    const orphans = new Set(scan.orphanClusters);
    for (const [start, chain] of scan.chains) {
      chain.clusters.forEach((c, pos) => {
        stmt.run(imageId, scanId, c, start, pos, orphans.has(c) ? 1 : 0);
      });
    }
    for (const c of scan.orphanClusters) stmt.run(imageId, scanId, c, null, -1, 1);
  }

  #insertIssues(imageId: number, scanId: number, scan: ScanResult): void {
    const stmt = this.db.prepare(
      `INSERT INTO issues(image_id,scan_id,code,severity,message,offset,cluster)
       VALUES(?,?,?,?,?,?,?)`,
    );
    for (const i of scan.issues) {
      stmt.run(imageId, scanId, i.code, i.severity, i.message, i.offset, i.cluster ?? null);
    }
  }

  listImages(limit: number, offset: number): Page<Record<string, unknown>> {
    const total = (this.db.prepare("SELECT COUNT(*) n FROM images").get() as { n: number }).n;
    const items = this.db
      .prepare("SELECT * FROM images ORDER BY id LIMIT ? OFFSET ?")
      .all(limit, offset) as Record<string, unknown>[];
    return { items, total, limit, offset };
  }

  getImage(imageId: number): Record<string, unknown> | undefined {
    return this.db.prepare("SELECT * FROM images WHERE id=?").get(imageId) as
      | Record<string, unknown>
      | undefined;
  }

  getVolume(imageId: number): Record<string, unknown> | undefined {
    return this.db.prepare("SELECT * FROM image_volume WHERE image_id=?").get(imageId) as
      | Record<string, unknown>
      | undefined;
  }

  latestScanId(imageId: number): number | undefined {
    const row = this.db
      .prepare("SELECT id FROM scans WHERE image_id=? ORDER BY id DESC LIMIT 1")
      .get(imageId) as { id: number } | undefined;
    return row?.id;
  }

  listEntries(
    scanId: number,
    limit: number,
    offset: number,
    kind?: string,
  ): Page<Record<string, unknown>> {
    const total = (
      this.db
        .prepare(
          kind
            ? "SELECT COUNT(*) n FROM dir_entries WHERE scan_id=? AND kind=?"
            : "SELECT COUNT(*) n FROM dir_entries WHERE scan_id=?",
        )
        .get(...(kind ? [scanId, kind] : [scanId])) as { n: number }
    ).n;
    const items = this.db
      .prepare(
        kind
          ? "SELECT * FROM dir_entries WHERE scan_id=? AND kind=? ORDER BY id LIMIT ? OFFSET ?"
          : "SELECT * FROM dir_entries WHERE scan_id=? ORDER BY id LIMIT ? OFFSET ?",
      )
      .all(...(kind ? [scanId, kind, limit, offset] : [scanId, limit, offset])) as Record<
      string,
      unknown
    >[];
    return { items, total, limit, offset };
  }

  getChain(scanId: number, startCluster: number): Record<string, unknown>[] {
    return this.db
      .prepare(
        "SELECT cluster,owner_start,position FROM cluster_usage WHERE scan_id=? AND owner_start=? ORDER BY position",
      )
      .all(scanId, startCluster) as Record<string, unknown>[];
  }

  listIssues(
    scanId: number,
    limit: number,
    offset: number,
    code?: string,
  ): Page<Record<string, unknown>> {
    const where = code ? " AND code=?" : "";
    const args = code ? [scanId, code] : [scanId];
    const total = (
      this.db
        .prepare(`SELECT COUNT(*) n FROM issues WHERE scan_id=?${where}`)
        .get(...args) as { n: number }
    ).n;
    const items = this.db
      .prepare(
        `SELECT * FROM issues WHERE scan_id=?${where} ORDER BY id LIMIT ? OFFSET ?`,
      )
      .all(...args, limit, offset) as Record<string, unknown>[];
    return { items, total, limit, offset };
  }

  getScanSummary(scanId: number): Record<string, unknown> | undefined {
    return this.db.prepare("SELECT * FROM scans WHERE id=?").get(scanId) as
      | Record<string, unknown>
      | undefined;
  }

  /** Compare two scans of the same image, returning per-issue-code deltas. */
  compareScans(scanA: number, scanB: number): {
    scanA: number;
    scanB: number;
    byCode: Record<string, { a: number; b: number; delta: number }>;
  } {
    const countBy = (scanId: number) => {
      const rows = this.db
        .prepare("SELECT code, COUNT(*) n FROM issues WHERE scan_id=? GROUP BY code")
        .all(scanId) as { code: string; n: number }[];
      return new Map(rows.map((r) => [r.code, r.n]));
    };
    const a = countBy(scanA);
    const b = countBy(scanB);
    const byCode: Record<string, { a: number; b: number; delta: number }> = {};
    for (const code of new Set([...a.keys(), ...b.keys()])) {
      const na = a.get(code) ?? 0;
      const nb = b.get(code) ?? 0;
      byCode[code] = { a: na, b: nb, delta: nb - na };
    }
    return { scanA, scanB, byCode };
  }
}
