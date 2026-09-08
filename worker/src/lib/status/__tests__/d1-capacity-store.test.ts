import { afterEach, describe, expect, it } from "vitest";
import { createLatestSchemaFixtureTracker } from "@shared/test-utils/latest-schema-sqlite";
import {
  D1_CAPACITY_CACHE_KEY,
  loadCachedD1CapacityAssessment,
  refreshD1CapacityAssessment,
} from "../d1-capacity-store";

const NOW = 1_783_661_028;
const fixtures = createLatestSchemaFixtureTracker();
afterEach(fixtures.closeAll);

describe("D1 capacity observation store", () => {
  it("replaces hourly observations, fences older samples and prunes only expired history", async () => {
    const { db, sqlite } = fixtures.open();
    const cutoff = NOW - 180 * 86400;
    const insert = sqlite.prepare("INSERT INTO d1_capacity_observations (observed_hour, observed_at, database_size_bytes, maximum_size_bytes, created_at) VALUES (?, ?, ?, ?, ?)");
    for (const [at, size] of [[cutoff - 1, 1_000_000_000], [cutoff, 1_000_000_000], [NOW - 23 * 3600, 3_977_000_000], [NOW - 12 * 3600, 3_988_000_000]] as const) {
      insert.run(at, at, size, 10_000_000_000, at);
    }
    const assessment = await refreshD1CapacityAssessment(db, 4_000_000_000, NOW);
    expect(assessment).toMatchObject({ utilizationPercent: 40, forecastBasis: "linear-window", conservativeWindow: "24h", growthBytesPerDay: 24_000_000 });
    expect(sqlite.prepare("SELECT observed_at FROM d1_capacity_observations ORDER BY observed_at").all()).toEqual(
      [cutoff, NOW - 23 * 3600, NOW - 12 * 3600, NOW].map((observed_at) => ({ observed_at })),
    );
    await refreshD1CapacityAssessment(db, 4_001_000_000, NOW + 1);
    await refreshD1CapacityAssessment(db, 1, NOW);
    expect(sqlite.prepare("SELECT observed_at, database_size_bytes FROM d1_capacity_observations WHERE observed_hour = ?").get(Math.floor(NOW / 3600) * 3600)).toEqual({ observed_at: NOW + 1, database_size_bytes: 4_001_000_000 });
    await expect(loadCachedD1CapacityAssessment(db, NOW + 1)).resolves.toMatchObject({ observedAt: NOW + 1, databaseSizeBytes: 4_001_000_000 });
  });

  it("accepts the exact freshness boundary and rejects expired or invalid envelopes", async () => {
    const { db, sqlite } = fixtures.open();
    const assessment = await refreshD1CapacityAssessment(db, 6_000_000_000, NOW);
    await expect(loadCachedD1CapacityAssessment(db, NOW + 60, 60)).resolves.toEqual(assessment);
    await expect(loadCachedD1CapacityAssessment(db, NOW + 61, 60)).resolves.toBeNull();
    for (const value of ["{", JSON.stringify({ version: 2, assessment }), JSON.stringify({ version: 1, assessment: { ...assessment, databaseSizeBytes: "invalid" } })]) {
      sqlite.prepare("UPDATE cache SET value = ? WHERE key = ?").run(value, D1_CAPACITY_CACHE_KEY);
      await expect(loadCachedD1CapacityAssessment(db, NOW, 60)).resolves.toBeNull();
    }
  });
});
