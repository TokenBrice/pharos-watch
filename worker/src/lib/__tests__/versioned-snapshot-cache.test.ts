import { afterEach, describe, expect, it } from "vitest";
import { loadVersionedSnapshotCache, writeVersionedSnapshotCache, type VersionedSnapshotCacheOptions } from "../versioned-snapshot-cache";
import { createLatestSchemaFixtureTracker } from "@shared/test-utils/latest-schema-sqlite";

const fixtures = createLatestSchemaFixtureTracker();
afterEach(fixtures.closeAll);
import { makeNoopD1 } from "../../test-helpers/noop-d1";

type Reason = "missing" | "parse" | "payload" | "envelope" | "generation" | "methodology";
interface Payload { computedAt: number }

const options: VersionedSnapshotCacheOptions<Payload, Reason> = {
  cacheKey: "snapshot:test",
  retention: {
    storage: "d1-kv",
    schemaId: "snapshot:test:v1",
    ttlSec: null,
    maxEntries: 1,
    stale: "accept",
    invalid: "retain",
  },
  label: "test",
  generation: 2,
  methodologyVersion: "v1",
  schema: {
    safeParse: (value): { success: true; data: Payload } | { success: false; error: { message: string } } => (
      value != null && typeof value === "object" && typeof (value as Payload).computedAt === "number"
        ? { success: true, data: value as Payload }
        : { success: false, error: { message: "invalid payload" } }
    ),
  },
  reasons: {
    missingCache: "missing",
    jsonParseFailed: "parse",
    invalidPayload: "payload",
    invalidEnvelope: "envelope",
    generationMismatch: "generation",
    methodologyMismatch: "methodology",
  },
  getUpdatedAt: (payload) => payload.computedAt,
};

function cacheDb(value: unknown, updatedAt = 1): D1Database {
  return makeNoopD1({
    prepare: () => ({
      bind: () => ({
        first: async () => ({ value: JSON.stringify(value), updated_at: updatedAt }),
      }),
    }),
  });
}

describe("versioned snapshot cache policy", () => {
  it("keeps identity-versioned snapshots valid without imposing a wall-clock TTL", async () => {
    const result = await loadVersionedSnapshotCache(cacheDb({
      generation: 2,
      methodologyVersion: "v1",
      payload: { computedAt: 500 },
    }), options);

    expect(result).toEqual({ kind: "ok", payload: { computedAt: 500 }, updatedAt: 500 });
  });

  it("preserves generation mismatch invalidation under the consolidated policy", async () => {
    const result = await loadVersionedSnapshotCache(cacheDb({
      generation: 1,
      methodologyVersion: "v1",
      payload: { computedAt: 500 },
    }), options);

    expect(result).toEqual({ kind: "error", reason: "generation", updatedAt: 1 });
  });

  it("preserves cache timestamps for each invalid representation and prioritizes envelope validation", async () => {
    const { db, sqlite } = fixtures.open();
    await expect(loadVersionedSnapshotCache(db, options)).resolves.toEqual({ kind: "error", reason: "missing", updatedAt: null });
    const valid = { generation: 2, methodologyVersion: "v1", payload: { computedAt: 500 } };
    for (const [value, reason] of [
      ["{", "parse"],
      [JSON.stringify({}), "envelope"],
      [JSON.stringify({ ...valid, payload: null }), "payload"],
      [JSON.stringify({ ...valid, methodologyVersion: "v2" }), "methodology"],
    ] as const) {
      sqlite.prepare("INSERT OR REPLACE INTO cache VALUES (?, ?, ?)").run(options.cacheKey, value, 123);
      await expect(loadVersionedSnapshotCache(db, options)).resolves.toEqual({ kind: "error", reason, updatedAt: 123 });
    }
    sqlite.prepare("UPDATE cache SET value = ?").run(JSON.stringify(valid));
    await expect(loadVersionedSnapshotCache(db, {
      ...options,
      validateEnvelope: () => "envelope",
      validatePayload: () => ({ reason: "payload" }),
    })).resolves.toEqual({ kind: "error", reason: "envelope", updatedAt: 123 });
    await expect(loadVersionedSnapshotCache(db, {
      ...options, validatePayload: () => ({ reason: "payload" }),
    })).resolves.toEqual({ kind: "error", reason: "payload", updatedAt: 123 });
  });

  it("leaves the accepted cache untouched when schema or payload validation rejects a write", async () => {
    const { db, sqlite } = fixtures.open();
    sqlite.prepare("INSERT INTO cache VALUES (?, ?, ?)").run(options.cacheKey, "accepted", 123);
    await expect(writeVersionedSnapshotCache(db, { computedAt: "invalid" } as never, options)).rejects.toThrow();
    await expect(writeVersionedSnapshotCache(db, { computedAt: 500 }, {
      ...options, validatePayload: () => ({ reason: "payload" }),
    })).rejects.toThrow();
    expect(sqlite.prepare("SELECT value, updated_at FROM cache").all()).toEqual([{ value: "accepted", updated_at: 123 }]);
  });
});
