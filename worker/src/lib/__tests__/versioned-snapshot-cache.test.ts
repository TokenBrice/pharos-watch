import { describe, expect, it } from "vitest";
import { loadVersionedSnapshotCache, type VersionedSnapshotCacheOptions } from "../versioned-snapshot-cache";
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
});
