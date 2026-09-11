import type * as Sqlite from "node:sqlite";
import { afterEach, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ connections: [] as Sqlite.DatabaseSync[], migration: "CREATE TABLE items (id INTEGER)" }));
vi.mock("node:sqlite", async (importOriginal) => {
  const actual = await importOriginal<typeof Sqlite>();
  return {
    ...actual,
    DatabaseSync: class extends actual.DatabaseSync {
      constructor(location: string) {
        super(location);
        state.connections.push(this);
      }
    },
  };
});
vi.mock("node:fs", () => ({
  readdirSync: () => ["0001_test.sql"],
  readFileSync: () => state.migration,
}));

import { createLatestSchemaFixtureTracker, createLatestSchemaSqlite, createLatestSchemaSqliteUncached } from "@shared/test-utils/latest-schema-sqlite";

afterEach(() => {
  vi.restoreAllMocks();
  for (const sqlite of state.connections.splice(0)) {
    if (sqlite.isOpen) sqlite.close();
  }
  state.migration = "CREATE TABLE items (id INTEGER)";
});

it.each(["direct", "tracked"])("closes a %s connection when migrations fail", (mode) => {
  state.migration = "INVALID SQL";
  const tracker = createLatestSchemaFixtureTracker({ uncached: true });
  expect(() => mode === "direct" ? createLatestSchemaSqliteUncached() : tracker.open()).toThrow();
  expect(state.connections[0].isOpen).toBe(false);
  expect(() => tracker.closeAll()).not.toThrow();
});

it("closes remaining registered connections even when one close fails", () => {
  const tracker = createLatestSchemaFixtureTracker({ uncached: true });
  const first = tracker.open();
  const second = tracker.open();
  vi.spyOn(first.sqlite, "close").mockImplementationOnce(() => { throw new Error("close failed"); });
  expect(() => tracker.closeAll()).toThrow();
  expect(second.sqlite.isOpen).toBe(false);
  expect(() => tracker.closeAll()).not.toThrow();
});

it("keeps tracked fixtures independent and closes all handles", () => {
  const tracker = createLatestSchemaFixtureTracker({ uncached: true });
  const first = tracker.open();
  const second = tracker.open();
  first.sqlite.exec("INSERT INTO items VALUES (1)");
  expect(second.sqlite.prepare("SELECT * FROM items").all()).toEqual([]);
  tracker.closeAll();
  expect(first.sqlite.isOpen).toBe(false);
  expect(second.sqlite.isOpen).toBe(false);
});

it("keeps databases opened from the cached inventory independent", () => {
  const first = createLatestSchemaSqlite();
  const second = createLatestSchemaSqlite();
  first.sqlite.exec("INSERT INTO items VALUES (1)");
  expect(second.sqlite.prepare("SELECT * FROM items").all()).toEqual([]);
  state.migration = "CREATE TABLE other (id INTEGER)";
  const third = createLatestSchemaSqlite();
  third.sqlite.exec("INSERT INTO items VALUES (2)");
  expect(first.sqlite.prepare("SELECT * FROM items").all()).toEqual([{ id: 1 }]);
  expect(second.sqlite.prepare("SELECT * FROM items").all()).toEqual([]);
});

it("does not reuse a schema build that failed", async () => {
  // A fresh module registry so this exercises a cold per-process cache: the
  // statically imported instance above is already warm from earlier tests.
  vi.resetModules();
  const helper = await import("@shared/test-utils/latest-schema-sqlite");
  state.migration = "INVALID SQL";
  expect(() => helper.createLatestSchemaSqlite()).toThrow();

  state.migration = "CREATE TABLE recovered (id INTEGER)";
  const recovered = helper.createLatestSchemaSqlite();

  expect(
    recovered.sqlite.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all(),
  ).toEqual([{ name: "recovered" }]);
});

it("re-reads the migration inventory on the uncached path", () => {
  state.migration = "CREATE TABLE replacement (id INTEGER)";
  const uncached = createLatestSchemaSqliteUncached();
  expect(
    uncached.sqlite.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all(),
  ).toEqual([{ name: "replacement" }]);
});
