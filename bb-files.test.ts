import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { BbFileStore, type BbFileStorage } from "./lib/bb-files.js";

/** Stands in for `bb.storage`: a real SQLite file plus bb's migration helper. */
function testStorage(): { storage: BbFileStorage; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), "diffui-bb-files-"));
  const db = new Database(join(root, "data.db"));
  const storage: BbFileStorage = {
    database: () => db,
    migrate: (handle, statements) => {
      handle.exec(`CREATE TABLE IF NOT EXISTS _bb_migrations (id INTEGER PRIMARY KEY)`);
      const applied = new Set(
        (handle.prepare(`SELECT id FROM _bb_migrations`).all() as Array<{ id: number }>).map((row) => row.id),
      );
      handle.transaction(() => {
        statements.forEach((statement, index) => {
          if (applied.has(index)) return;
          handle.exec(statement);
          handle.prepare(`INSERT INTO _bb_migrations (id) VALUES (?)`).run(index);
        });
      })();
    },
  };
  return {
    storage,
    cleanup: () => {
      db.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

describe("BbFileStore", () => {
  let storage: BbFileStorage;
  let cleanup: () => void;
  let store: BbFileStore;

  beforeEach(() => {
    ({ storage, cleanup } = testStorage());
    store = new BbFileStore(storage);
  });
  afterEach(() => cleanup());

  test("a fresh install owns no files, so the sidebar lists none", () => {
    expect(store.list()).toEqual([]);
    expect(store.trackedIds().size).toBe(0);
    expect(store.has("anything")).toBe(false);
  });

  test("tracking is idempotent and records how the file arrived", () => {
    store.track("canvas-1", { source: "created", title: "Checkout" });
    store.track("canvas-1", { source: "created", title: "Checkout" });
    expect(store.list()).toEqual([
      expect.objectContaining({ projectId: "canvas-1", title: "Checkout", source: "created" }),
    ]);
    expect(store.has("canvas-1")).toBe(true);
  });

  test("opening a file that was created here does not downgrade its source", () => {
    store.track("canvas-1", { source: "created", title: "Checkout" });
    store.track("canvas-1", { source: "opened" });
    expect(store.list()[0]!.source).toBe("created");
  });

  test("a later open never blanks a title it has no better value for", () => {
    store.track("canvas-1", { source: "opened", title: "Checkout" });
    store.track("canvas-1", { source: "opened" });
    expect(store.list()[0]!.title).toBe("Checkout");
  });

  test("renames follow the file, and a blank rename is ignored", () => {
    store.track("canvas-1", { source: "created" });
    expect(store.list()[0]!.title).toBe("");
    store.rename("canvas-1", "Coffee subscription");
    expect(store.list()[0]!.title).toBe("Coffee subscription");
    store.rename("canvas-1", "   ");
    expect(store.list()[0]!.title).toBe("Coffee subscription");
  });

  test("forgetting removes only that file", () => {
    store.track("canvas-1", { source: "created" });
    store.track("canvas-2", { source: "opened" });
    store.forget("canvas-1");
    expect(store.trackedIds()).toEqual(new Set(["canvas-2"]));
  });

  test("the registry survives a plugin reload against the same database", () => {
    store.track("canvas-1", { source: "created", title: "Checkout" });
    const reloaded = new BbFileStore(storage);
    expect(reloaded.list()).toEqual([
      expect.objectContaining({ projectId: "canvas-1", title: "Checkout", source: "created" }),
    ]);
  });

  test("blank ids are not files", () => {
    store.track("   ", { source: "created" });
    expect(store.list()).toEqual([]);
  });
});
