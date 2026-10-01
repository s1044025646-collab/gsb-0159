import type { DatabaseSync } from "node:sqlite";

/**
 * Idempotent migrations. Every statement uses IF NOT EXISTS so a migration
 * can be re-run on an already-current database without error or data loss.
 */
export function migrate(db: DatabaseSync): void {
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA foreign_keys = ON;");

  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at INTEGER NOT NULL
    );
  `);

  const applied = new Set<number>(
    (db.prepare("SELECT version FROM schema_migrations").all() as Array<{ version: number }>).map(
      (r) => r.version,
    ),
  );

  const steps: Array<{ version: number; name: string; sql: string }> = [
    {
      version: 1,
      name: "initial",
      sql: `
        CREATE TABLE IF NOT EXISTS images (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          sha256 TEXT NOT NULL UNIQUE,
          image_path TEXT NOT NULL,
          image_size INTEGER NOT NULL,
          imported_at INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS check_runs (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          image_id INTEGER NOT NULL REFERENCES images(id) ON DELETE CASCADE,
          run_index INTEGER NOT NULL,
          created_at INTEGER NOT NULL,
          error_count INTEGER NOT NULL,
          warning_count INTEGER NOT NULL,
          info_count INTEGER NOT NULL,
          UNIQUE(image_id, run_index)
        );
        CREATE TABLE IF NOT EXISTS volume_params (
          image_id INTEGER PRIMARY KEY REFERENCES images(id) ON DELETE CASCADE,
          oem_name TEXT NOT NULL,
          bytes_per_sector INTEGER NOT NULL,
          sectors_per_cluster INTEGER NOT NULL,
          reserved_sectors INTEGER NOT NULL,
          number_of_fats INTEGER NOT NULL,
          root_entry_count INTEGER NOT NULL,
          total_sectors_16 INTEGER NOT NULL,
          media INTEGER NOT NULL,
          fat_size_16 INTEGER NOT NULL,
          root_dir_sectors INTEGER NOT NULL,
          first_fat_sector INTEGER NOT NULL,
          root_dir_sector INTEGER NOT NULL,
          first_data_sector INTEGER NOT NULL,
          total_clusters INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS dir_entries (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          image_id INTEGER NOT NULL REFERENCES images(id) ON DELETE CASCADE,
          run_id INTEGER NOT NULL REFERENCES check_runs(id) ON DELETE CASCADE,
          slot_index INTEGER NOT NULL,
          offset INTEGER NOT NULL,
          kind TEXT NOT NULL,
          short_name TEXT NOT NULL,
          attributes INTEGER NOT NULL,
          first_cluster INTEGER NOT NULL,
          file_size INTEGER NOT NULL,
          parent_path TEXT NOT NULL,
          path TEXT NOT NULL,
          deleted INTEGER NOT NULL,
          lfn_unsupported INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_dir_entries_run ON dir_entries(run_id);
        CREATE INDEX IF NOT EXISTS idx_dir_entries_path ON dir_entries(image_id, path);
        CREATE TABLE IF NOT EXISTS clusters (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          image_id INTEGER NOT NULL REFERENCES images(id) ON DELETE CASCADE,
          run_id INTEGER NOT NULL REFERENCES check_runs(id) ON DELETE CASCADE,
          cluster_no INTEGER NOT NULL,
          status TEXT NOT NULL,
          fat_values TEXT NOT NULL,
          owner_path TEXT,
          UNIQUE(run_id, cluster_no)
        );
        CREATE INDEX IF NOT EXISTS idx_clusters_run ON clusters(run_id);
        CREATE TABLE IF NOT EXISTS chains (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          image_id INTEGER NOT NULL REFERENCES images(id) ON DELETE CASCADE,
          run_id INTEGER NOT NULL REFERENCES check_runs(id) ON DELETE CASCADE,
          path TEXT NOT NULL,
          first_cluster INTEGER NOT NULL,
          expected_clusters INTEGER NOT NULL,
          chain_clusters TEXT NOT NULL,
          terminated INTEGER NOT NULL,
          UNIQUE(run_id, path)
        );
        CREATE TABLE IF NOT EXISTS issues (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          image_id INTEGER NOT NULL REFERENCES images(id) ON DELETE CASCADE,
          run_id INTEGER NOT NULL REFERENCES check_runs(id) ON DELETE CASCADE,
          code TEXT NOT NULL,
          severity TEXT NOT NULL,
          message TEXT NOT NULL,
          offset_value INTEGER,
          sector INTEGER,
          cluster INTEGER,
          path TEXT,
          evidence TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_issues_run ON issues(run_id);
        CREATE INDEX IF NOT EXISTS idx_issues_image ON issues(image_id, severity);
      `,
    },
  ];

  const insertMigration = db.prepare(
    "INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)",
  );
  for (const step of steps) {
    if (applied.has(step.version)) continue;
    db.exec("BEGIN IMMEDIATE");
    try {
      db.exec(step.sql);
      insertMigration.run(step.version, step.name, Date.now());
      db.exec("COMMIT");
    } catch (err) {
      db.exec("ROLLBACK");
      throw err;
    }
  }
}
