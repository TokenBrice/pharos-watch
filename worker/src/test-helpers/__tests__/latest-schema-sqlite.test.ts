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

import { createLatestSchemaFixtureTracker, createLatestSchemaSqliteUncached } from "@shared/test-utils/latest-schema-sqlite";

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
