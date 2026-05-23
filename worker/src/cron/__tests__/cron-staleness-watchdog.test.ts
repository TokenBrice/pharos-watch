import { describe, expect, it } from "vitest";
import { evaluateCronStaleness } from "../cron-staleness-watchdog";

describe("cron staleness watchdog", () => {
  it("flags watched freshness lanes beyond twice their producer interval", () => {
    const stale = evaluateCronStaleness({
      stablecoins: { ageSeconds: 1_801 },
      "fx-rates": { ageSeconds: 1_799 },
      "dex-liquidity": { ageSeconds: 3_601 },
      "yield-data": { ageSeconds: 7_200 },
      dews: { ageSeconds: 1_000 },
    });

    expect(stale.map((entry) => entry.cacheKey)).toEqual([
      "stablecoins",
      "dex-liquidity",
    ]);
  });

  it("treats missing watched cache freshness as stale", () => {
    const stale = evaluateCronStaleness({
      stablecoins: { ageSeconds: 0 },
      "fx-rates": { ageSeconds: 0 },
      "dex-liquidity": { ageSeconds: 0 },
      dews: { ageSeconds: 0 },
    });

    expect(stale).toEqual([
      expect.objectContaining({
        cacheKey: "yield-data",
        ageSeconds: null,
      }),
    ]);
  });
});
