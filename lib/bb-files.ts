// Which Diffui files belong to bb.
//
// bb's sidebar lists THREADS — work that lives here. A Diffui account can hold
// hundreds of canvases that have nothing to do with this machine, so listing all
// of them would bury bb's own rows in someone else's design history. The sidebar
// therefore shows only the files bb knows about:
//
// - created in bb (the panel's New canvas button, or the diffui_create_canvas
//   agent tool), or
// - explicitly opened into bb (picking one out of the browse grid, or following
//   a canvas link into the panel).
//
// The registry is the plugin's OWN SQLite database (`bb.storage.database()`,
// <dataDir>/plugins/diffui-bb/data.db) — the same place bb keeps plugin state.
// Diffui's schema is untouched: nothing here needs a migration over there, and a
// file that is not in this table is simply not a bb thread.
//
// Titles are cached alongside so a row can paint before the network answers, and
// are refreshed from Diffui whenever a file renames itself (a canvas names itself
// after its first designs), which is what makes a thread row follow a rename.

import type BetterSqlite3 from "better-sqlite3";

/** How a file came to be a bb thread. */
export type BbFileSource = "created" | "opened";

export interface BbFileRow {
  projectId: string;
  /** Last title seen from Diffui — the thread row's name. */
  title: string;
  source: BbFileSource;
  /** ms since epoch. */
  addedAt: number;
}

/** The slice of `bb.storage` this store needs, so tests can pass a bare db. */
export interface BbFileStorage {
  database(): BetterSqlite3.Database;
  migrate(db: BetterSqlite3.Database, statements: string[]): void;
}

/**
 * Append-only. The statement index IS the migration id in bb's `_bb_migrations`
 * table, so an existing statement may never be edited or reordered.
 */
const MIGRATIONS: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS bb_files (
     project_id TEXT PRIMARY KEY,
     title      TEXT NOT NULL DEFAULT '',
     source     TEXT NOT NULL DEFAULT 'opened',
     added_at   INTEGER NOT NULL
   )`,
];

interface BbFileRecord {
  project_id: string;
  title: string;
  source: string;
  added_at: number;
}

function normalizeSource(value: string): BbFileSource {
  return value === "created" ? "created" : "opened";
}

export class BbFileStore {
  private readonly db: BetterSqlite3.Database;

  constructor(storage: BbFileStorage) {
    this.db = storage.database();
    storage.migrate(this.db, [...MIGRATIONS]);
  }

  /**
   * Records a file as belonging to bb. Idempotent, and it never downgrades a
   * file that was created here into a merely-opened one — nor does it move an
   * existing row's position in the list by rewriting `added_at`.
   */
  track(projectId: string, options: { source: BbFileSource; title?: string }): void {
    const id = projectId.trim();
    if (id === "") return;
    const title = (options.title ?? "").trim();
    this.db
      .prepare(
        `INSERT INTO bb_files (project_id, title, source, added_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(project_id) DO UPDATE SET
           title  = CASE WHEN excluded.title <> '' THEN excluded.title ELSE bb_files.title END,
           source = CASE WHEN bb_files.source = 'created' THEN 'created' ELSE excluded.source END`,
      )
      .run(id, title, options.source, Date.now());
  }

  /** Follows a rename. A blank title is ignored: it would blank a good row. */
  rename(projectId: string, title: string): void {
    const next = title.trim();
    if (projectId.trim() === "" || next === "") return;
    this.db
      .prepare(`UPDATE bb_files SET title = ? WHERE project_id = ? AND title <> ?`)
      .run(next, projectId.trim(), next);
  }

  /** Drops a file from bb without touching it in Diffui. */
  forget(projectId: string): void {
    this.db.prepare(`DELETE FROM bb_files WHERE project_id = ?`).run(projectId.trim());
  }

  has(projectId: string): boolean {
    const row = this.db
      .prepare(`SELECT 1 AS present FROM bb_files WHERE project_id = ?`)
      .get(projectId.trim()) as { present?: number } | undefined;
    return row !== undefined;
  }

  /** Every bb file, newest addition first. */
  list(): BbFileRow[] {
    const rows = this.db
      .prepare(`SELECT project_id, title, source, added_at FROM bb_files ORDER BY added_at DESC`)
      .all() as BbFileRecord[];
    return rows.map((row) => ({
      projectId: row.project_id,
      title: row.title,
      source: normalizeSource(row.source),
      addedAt: Number(row.added_at) || 0,
    }));
  }

  /** Just the ids, for filtering a Diffui listing down to bb's own files. */
  trackedIds(): Set<string> {
    return new Set(this.list().map((row) => row.projectId));
  }
}
