import { describe, expect, it } from "vitest";
import { mockD1 } from "../../../test-helpers/__shared/mock-d1";
import {
  D1_CAPACITY_CACHE_KEY,
  loadCachedD1CapacityAssessment,
  refreshD1CapacityAssessment,
} from "../d1-capacity-store";

const NOW = 1_783_661_028;

describe("D1 capacity observation store", () => {
  it("records an hourly observation, prunes retention, and publishes the assessment cache", async () => {
    const db = mockD1([
      { match: "INSERT INTO d1_capacity_observations", rows: [] },
      { match: "DELETE FROM d1_capacity_observations", rows: [] },
      {
        match: "SELECT observed_at, database_size_bytes",
        rows: [
          { observed_at: NOW - 23 * 3600, database_size_bytes: 3_977_000_000 },
          { observed_at: NOW - 12 * 3600, database_size_bytes: 3_988_000_000 },
          { observed_at: NOW, database_size_bytes: 4_000_000_000 },
        ],
      },
      { match: "INSERT INTO cache", rows: [], runMeta: { changes: 1 } },
    ], { requireMatch: true });

    const assessment = await refreshD1CapacityAssessment(db, 4_000_000_000, NOW);

    expect(assessment.utilizationPercent).toBe(40);
    expect(assessment.forecastBasis).toBe("linear-window");
    expect(assessment.conservativeWindow).toBe("24h");
    expect(assessment.growthBytesPerDay).toBe(24_000_000);
    expect(db.getHistory().some((entry) => entry.binds[0] === D1_CAPACITY_CACHE_KEY)).toBe(true);
    expect(() => db.assertAllMatchesUsed()).not.toThrow();
  });

  it("loads only fresh, structurally valid cache envelopes", async () => {
    const assessment = {
      observedAt: NOW,
      databaseSizeBytes: 6_000_000_000,
      maximumSizeBytes: 10_000_000_000,
      utilizationRatio: 0.6,
      utilizationPercent: 60,
      thresholdState: "watch",
      crossedThresholdPercent: 60,
      nextThresholdPercent: 75,
      sampleCount: 3,
      forecastBasis: "linear-30d",
      forecastSpanHours: 48,
      growthBytesPerDay: 100_000_000,
      nextThresholdAt: NOW + 15 * 86_400,
      exhaustionAt: NOW + 40 * 86_400,
      daysUntilExhaustion: 40,
    };
    const db = mockD1([{
      match: "SELECT value, updated_at FROM cache WHERE key = ?",
      matchBinds: [D1_CAPACITY_CACHE_KEY],
      rows: [{
        key: D1_CAPACITY_CACHE_KEY,
        value: JSON.stringify({ version: 1, assessment }),
        updated_at: NOW,
      }],
    }], { requireMatch: true });

    await expect(loadCachedD1CapacityAssessment(db, NOW + 60)).resolves.toEqual(assessment);
  });
});
