import type { DatabaseSync } from "node:sqlite";

/** Idempotent migration: safe to run on every startup. */
export function migrate(db: DatabaseSync): void {
  db.exec("PRAGMA journal_mode=WAL;");
  db.exec("PRAGMA foreign_keys=ON;");
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS images (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      sha256 TEXT NOT NULL UNIQUE,
      file_name TEXT NOT NULL,
      byte_size INTEGER NOT NULL,
      imported_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS image_volume (
      image_id INTEGER PRIMARY KEY REFERENCES images(id) ON DELETE CASCADE,
      oem_name TEXT NOT NULL,
      volume_label TEXT NOT NULL,
      bytes_per_sector INTEGER NOT NULL,
      sectors_per_cluster INTEGER NOT NULL,
      reserved_sectors INTEGER NOT NULL,
      num_fats INTEGER NOT NULL,
      root_entries INTEGER NOT NULL,
      fat_size_sectors INTEGER NOT NULL,
      total_sectors INTEGER NOT NULL,
      cluster_count INTEGER NOT NULL,
      data_start_sector INTEGER NOT NULL,
      fat_start_sector INTEGER NOT NULL,
      root_start_sector INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS scans (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      image_id INTEGER NOT NULL REFERENCES images(id) ON DELETE CASCADE,
      scanned_at TEXT NOT NULL,
      allocated_clusters INTEGER NOT NULL,
      orphan_count INTEGER NOT NULL,
      error_count INTEGER NOT NULL,
      warning_count INTEGER NOT NULL,
      UNIQUE(image_id, id)
    );
    CREATE TABLE IF NOT EXISTS dir_entries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      image_id INTEGER NOT NULL REFERENCES images(id) ON DELETE CASCADE,
      scan_id INTEGER NOT NULL REFERENCES scans(id) ON DELETE CASCADE,
      path TEXT NOT NULL,
      kind TEXT NOT NULL,
      short_name TEXT,
      attr INTEGER NOT NULL,
      first_cluster INTEGER NOT NULL,
      file_size INTEGER NOT NULL,
      offset INTEGER NOT NULL,
      parent_cluster INTEGER NOT NULL,
      deleted INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS cluster_usage (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      image_id INTEGER NOT NULL REFERENCES images(id) ON DELETE CASCADE,
      scan_id INTEGER NOT NULL REFERENCES scans(id) ON DELETE CASCADE,
      cluster INTEGER NOT NULL,
      owner_start INTEGER,
      position INTEGER NOT NULL,
      orphan INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS issues (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      image_id INTEGER NOT NULL REFERENCES images(id) ON DELETE CASCADE,
      scan_id INTEGER NOT NULL REFERENCES scans(id) ON DELETE CASCADE,
      code TEXT NOT NULL,
      severity TEXT NOT NULL,
      message TEXT NOT NULL,
      offset INTEGER,
      cluster INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_entries_scan ON dir_entries(scan_id, path);
    CREATE INDEX IF NOT EXISTS idx_issues_scan ON issues(scan_id, code);
    CREATE INDEX IF NOT EXISTS idx_clusters_scan ON cluster_usage(scan_id, cluster);
  `);
  db.prepare(
    `INSERT INTO schema_meta(key,value) VALUES('version','1')
     ON CONFLICT(key) DO NOTHING`,
  ).run();
}
