import { describe, expect, it } from "vitest";
import { buildBackfillRows } from "../yield-history-backfill";

describe("buildBackfillRows", () => {
  it("converts DL chart data to yield_history rows", () => {
    const dlData = [
      { timestamp: "2025-06-01T23:00:00.000Z", tvlUsd: 100_000_000, apy: 3.5, apyBase: 3.5, apyReward: null, il7d: null, apyBase7d: null },
      { timestamp: "2025-06-02T23:00:00.000Z", tvlUsd: 101_000_000, apy: 3.6, apyBase: 3.6, apyReward: null, il7d: null, apyBase7d: null },
    ];
    const rows = buildBackfillRows("usde-ethena", "66985a81-pool-uuid", dlData);
    expect(rows.length).toBe(2);
    expect(rows[0]).toEqual(expect.objectContaining({
      stablecoin_id: "usde-ethena",
      source_key: "66985a81-pool-uuid",
      apy: 3.5,
      apy_base: 3.5,
      source_tvl_usd: 100_000_000,
      data_source: "defillama-backfill",
    }));
  });

  it("filters to last 365 days", () => {
    const twoYearsAgo = new Date(Date.now() - 730 * 86400 * 1000).toISOString();
    const yesterday = new Date(Date.now() - 86400 * 1000).toISOString();
    const dlData = [
      { timestamp: twoYearsAgo, tvlUsd: 50_000_000, apy: 2.0, apyBase: 2.0, apyReward: null, il7d: null, apyBase7d: null },
      { timestamp: yesterday, tvlUsd: 100_000_000, apy: 3.5, apyBase: 3.5, apyReward: null, il7d: null, apyBase7d: null },
    ];
    const rows = buildBackfillRows("test-coin", "pool-uuid", dlData);
    expect(rows.length).toBe(1);
  });
});
