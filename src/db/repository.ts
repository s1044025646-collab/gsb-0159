import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { migrate } from "./migrations.ts";
import type { Page, ParseResult } from "../fat/types.ts";

export interface ImageRecord {
  id: number;
  sha256: string;
  imagePath: string;
  imageSize: number;
  importedAt: number;
  latestRunId: number | null;
}

export interface RunSummary {
  runId: number;
  runIndex: number;
  createdAt: number;
  errorCount: number;
  warningCount: number;
  infoCount: number;
}

export class Repository {
  readonly db: DatabaseSync;

  constructor(dbPath: string) {
    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new DatabaseSync(dbPath);
    migrate(this.db);
  }

  close(): void {
    this.db.close();
  }

  /**
   * Idempotent import: identical content (sha256) returns the existing image.
   * A new parse always creates a fresh check_run version; all writes are transactional.
   */
  importParse(result: ParseResult): { imageId: number; runId: number; reusedImage: boolean } {
    const tx = this.db;
    tx.exec("BEGIN IMMEDIATE");
    try {
      let image = this.db
        .prepare("SELECT id FROM images WHERE sha256 = ?")
        .get(result.sha256) as { id: number } | undefined;
      const reusedImage = image !== undefined;
      if (!image) {
        this.db
          .prepare(
            "INSERT INTO images (sha256, image_path, image_size, imported_at) VALUES (?, ?, ?, ?)",
          )
          .run(result.sha256, result.imagePath, result.imageSize, result.parsedAt);
        image = this.db.prepare("SELECT id FROM images WHERE sha256 = ?").get(result.sha256) as {
          id: number;
        };
        this.upsertVolumeParams(image.id, result);
      }
      const imageId = image.id;
      const row = this.db
        .prepare("SELECT COALESCE(MAX(run_index), 0) AS m FROM check_runs WHERE image_id = ?")
        .get(imageId) as { m: number };
      const runIndex = row.m + 1;
      const counts = {
        error: result.issues.filter((i) => i.severity === "error").length,
        warning: result.issues.filter((i) => i.severity === "warning").length,
        info: result.issues.filter((i) => i.severity === "info").length,
      };
      const runInsert = this.db.prepare(
        `INSERT INTO check_runs (image_id, run_index, created_at, error_count, warning_count, info_count)
         VALUES (?, ?, ?, ?, ?, ?)`,
      );
      runInsert.run(
        imageId,
        runIndex,
        result.parsedAt,
        counts.error,
        counts.warning,
        counts.info,
      );
      const run = this.db
        .prepare("SELECT id FROM check_runs WHERE image_id = ? AND run_index = ?")
        .get(imageId, runIndex) as { id: number };
      this.persistRun(run.id, imageId, result);
      tx.exec("COMMIT");
      return { imageId, runId: run.id, reusedImage };
    } catch (err) {
      tx.exec("ROLLBACK");
      throw err;
    }
  }

  private upsertVolumeParams(imageId: number, r: ParseResult): void {
    const p = r.params;
    this.db
      .prepare(
        `INSERT INTO volume_params (image_id, oem_name, bytes_per_sector, sectors_per_cluster,
          reserved_sectors, number_of_fats, root_entry_count, total_sectors_16, media,
          fat_size_16, root_dir_sectors, first_fat_sector, root_dir_sector,
          first_data_sector, total_clusters)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        imageId, p.oemName, p.bytesPerSector, p.sectorsPerCluster, p.reservedSectors,
        p.numberOfFats, p.rootEntryCount, p.totalSectors16, p.media, p.fatSize16,
        p.rootDirSectors, p.firstFatSector, p.rootDirSector, p.firstDataSector,
        p.totalClusters,
      );
  }

  private persistRun(runId: number, imageId: number, r: ParseResult): void {
    const entryStmt = this.db.prepare(
      `INSERT INTO dir_entries (image_id, run_id, slot_index, offset, kind, short_name,
        attributes, first_cluster, file_size, parent_path, path, deleted, lfn_unsupported)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    );
    for (const e of r.entries) {
      entryStmt.run(
        imageId, runId, e.slotIndex, e.offset, e.kind, e.shortName, e.attributes,
        e.firstCluster, e.fileSize, e.parentPath, e.path, e.deleted ? 1 : 0,
        e.partOfUnsupportedLfn ? 1 : 0,
      );
    }
    const clusterStmt = this.db.prepare(
      `INSERT INTO clusters (image_id, run_id, cluster_no, status, fat_values, owner_path)
       VALUES (?,?,?,?,?,?)`,
    );
    for (const c of r.clusters) {
      clusterStmt.run(
        imageId, runId, c.cluster, c.status, JSON.stringify(c.fatValues), c.ownerPath,
      );
    }
    const chainStmt = this.db.prepare(
      `INSERT INTO chains (image_id, run_id, path, first_cluster, expected_clusters,
        chain_clusters, terminated) VALUES (?,?,?,?,?,?,?)`,
    );
    for (const ch of r.chains) {
      chainStmt.run(
        imageId, runId, ch.path, ch.firstCluster, ch.expectedClustersFromSize,
        JSON.stringify(ch.chain), ch.terminated ? 1 : 0,
      );
    }
    const issueStmt = this.db.prepare(
      `INSERT INTO issues (image_id, run_id, code, severity, message, offset_value,
        sector, cluster, path, evidence) VALUES (?,?,?,?,?,?,?,?,?,?)`,
    );
    for (const i of r.issues) {
      issueStmt.run(
        imageId, runId, i.code, i.severity, i.message, i.offset ?? null,
        i.sector ?? null, i.cluster ?? null, i.path ?? null,
        i.evidence ? JSON.stringify(i.evidence) : null,
      );
    }
  }

  listImages(limit: number, offset: number): Page<ImageRecord> {
    const total = (this.db.prepare("SELECT COUNT(*) AS c FROM images").get() as { c: number }).c;
    const rows = this.db
      .prepare(
        `SELECT i.id, i.sha256, i.image_path AS imagePath, i.image_size AS imageSize,
                i.imported_at AS importedAt,
                (SELECT MAX(id) FROM check_runs cr WHERE cr.image_id = i.id) AS latestRunId
         FROM images i ORDER BY i.id DESC LIMIT ? OFFSET ?`,
      )
      .all(limit, offset) as unknown as ImageRecord[];
    return { items: rows, total, limit, offset };
  }

  getImage(imageId: number): ImageRecord | null {
    const row = this.db
      .prepare(
        `SELECT i.id, i.sha256, i.image_path AS imagePath, i.image_size AS imageSize,
                i.imported_at AS importedAt,
                (SELECT MAX(id) FROM check_runs cr WHERE cr.image_id = i.id) AS latestRunId
         FROM images i WHERE i.id = ?`,
      )
      .get(imageId) as ImageRecord | undefined;
    return row ?? null;
  }

  getImageBySha(sha: string): ImageRecord | null {
    const row = this.db
      .prepare("SELECT id FROM images WHERE sha256 = ?")
      .get(sha) as { id: number } | undefined;
    return row ? this.getImage(row.id) : null;
  }

  getVolumeParams(imageId: number): Record<string, unknown> | null {
    const row = this.db.prepare("SELECT * FROM volume_params WHERE image_id = ?").get(imageId);
    return (row as Record<string, unknown>) ?? null;
  }

  listRuns(imageId: number): RunSummary[] {
    return this.db
      .prepare(
        `SELECT id AS runId, run_index AS runIndex, created_at AS createdAt,
                error_count AS errorCount, warning_count AS warningCount,
                info_count AS infoCount
         FROM check_runs WHERE image_id = ? ORDER BY run_index ASC`,
      )
      .all(imageId) as unknown as RunSummary[];
  }

  resolveRun(imageId: number, runIndex: number | null): number | null {
    if (runIndex === null) {
      const r = this.db
        .prepare("SELECT id FROM check_runs WHERE image_id = ? ORDER BY run_index DESC LIMIT 1")
        .get(imageId) as { id: number } | undefined;
      return r?.id ?? null;
    }
    const r = this.db
      .prepare("SELECT id FROM check_runs WHERE image_id = ? AND run_index = ?")
      .get(imageId, runIndex) as { id: number } | undefined;
    return r?.id ?? null;
  }

  listEntries(
    imageId: number,
    runIndex: number | null,
    limit: number,
    offset: number,
    kind: string | null,
    parentPath: string | null,
  ): Page<Record<string, unknown>> {
    const runId = this.resolveRun(imageId, runIndex);
    if (runId === null) return { items: [], total: 0, limit, offset };
    const where = ["run_id = ?"];
    const params: (string | number)[] = [runId];
    if (kind) { where.push("kind = ?"); params.push(kind); }
    if (parentPath !== null) { where.push("parent_path = ?"); params.push(parentPath); }
    const whereSql = where.join(" AND ");
    const total = (
      this.db.prepare(`SELECT COUNT(*) AS c FROM dir_entries WHERE ${whereSql}`).get(...params) as {
        c: number;
      }
    ).c;
    const items = this.db
      .prepare(
        `SELECT slot_index AS slotIndex, offset, kind, short_name AS shortName, attributes,
                first_cluster AS firstCluster, file_size AS fileSize, parent_path AS parentPath,
                path, deleted, lfn_unsupported AS lfnUnsupported
         FROM dir_entries WHERE ${whereSql} ORDER BY offset ASC LIMIT ? OFFSET ?`,
      )
      .all(...params, limit, offset) as Record<string, unknown>[];
    return { items, total, limit, offset };
  }

  getEntry(imageId: number, path: string, runIndex: number | null): Record<string, unknown> | null {
    const runId = this.resolveRun(imageId, runIndex);
    if (runId === null) return null;
    return (
      (this.db
        .prepare("SELECT * FROM dir_entries WHERE run_id = ? AND path = ?")
        .get(runId, path) as Record<string, unknown>) ?? null
    );
  }

  getChain(imageId: number, path: string, runIndex: number | null): Record<string, unknown> | null {
    const runId = this.resolveRun(imageId, runIndex);
    if (runId === null) return null;
    return (
      (this.db
        .prepare("SELECT * FROM chains WHERE run_id = ? AND path = ?")
        .get(runId, path) as Record<string, unknown>) ?? null
    );
  }

  listClusters(
    imageId: number,
    runIndex: number | null,
    limit: number,
    offset: number,
    status: string | null,
  ): Page<Record<string, unknown>> {
    const runId = this.resolveRun(imageId, runIndex);
    if (runId === null) return { items: [], total: 0, limit, offset };
    const where = ["run_id = ?"];
    const params: (string | number)[] = [runId];
    if (status) { where.push("status = ?"); params.push(status); }
    const total = (
      this.db
        .prepare(`SELECT COUNT(*) AS c FROM clusters WHERE ${where.join(" AND ")}`)
        .get(...params) as { c: number }
    ).c;
    const items = this.db
      .prepare(
        `SELECT cluster_no AS cluster, status, fat_values AS fatValues, owner_path AS ownerPath
         FROM clusters WHERE ${where.join(" AND ")} ORDER BY cluster_no ASC LIMIT ? OFFSET ?`,
      )
      .all(...params, limit, offset) as Record<string, unknown>[];
    return { items, total, limit, offset };
  }

  listIssues(
    imageId: number,
    runIndex: number | null,
    limit: number,
    offset: number,
    severity: string | null,
  ): Page<Record<string, unknown>> {
    const runId = this.resolveRun(imageId, runIndex);
    if (runId === null) return { items: [], total: 0, limit, offset };
    const where = ["run_id = ?"];
    const params: (string | number)[] = [runId];
    if (severity) { where.push("severity = ?"); params.push(severity); }
    const total = (
      this.db
        .prepare(`SELECT COUNT(*) AS c FROM issues WHERE ${where.join(" AND ")}`)
        .get(...params) as { c: number }
    ).c;
    const items = this.db
      .prepare(
        `SELECT code, severity, message, offset_value AS offset, sector, cluster, path, evidence
         FROM issues WHERE ${where.join(" AND ")} ORDER BY id ASC LIMIT ? OFFSET ?`,
      )
      .all(...params, limit, offset) as Record<string, unknown>[];
    return { items, total, limit, offset };
  }
}

