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

import { createLatestSchemaFixtureTracker, createLatestSchemaSqlite } from "../latest-schema-sqlite";

afterEach(() => {
  vi.restoreAllMocks();
  for (const sqlite of state.connections.splice(0)) {
    if (sqlite.isOpen) sqlite.close();
  }
  state.migration = "CREATE TABLE items (id INTEGER)";
});

it.each(["direct", "tracked"])("closes a %s connection when migrations fail", (mode) => {
  state.migration = "INVALID SQL";
  const tracker = createLatestSchemaFixtureTracker();
  expect(() => mode === "direct" ? createLatestSchemaSqlite() : tracker.open()).toThrow();
  expect(state.connections[0].isOpen).toBe(false);
  expect(() => tracker.closeAll()).not.toThrow();
});

it("closes remaining registered connections even when one close fails", () => {
  const tracker = createLatestSchemaFixtureTracker();
  const first = tracker.open();
  const second = tracker.open();
  vi.spyOn(first.sqlite, "close").mockImplementationOnce(() => { throw new Error("close failed"); });
  expect(() => tracker.closeAll()).toThrow();
  expect(second.sqlite.isOpen).toBe(false);
  expect(() => tracker.closeAll()).not.toThrow();
});

it("keeps tracked fixtures independent and closes all handles", () => {
  const tracker = createLatestSchemaFixtureTracker();
  const first = tracker.open();
  const second = tracker.open();
  first.sqlite.exec("INSERT INTO items VALUES (1)");
  expect(second.sqlite.prepare("SELECT * FROM items").all()).toEqual([]);
  tracker.closeAll();
  expect(first.sqlite.isOpen).toBe(false);
  expect(second.sqlite.isOpen).toBe(false);
});
