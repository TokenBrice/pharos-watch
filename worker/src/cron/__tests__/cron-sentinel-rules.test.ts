import { describe, expect, it } from "vitest";
import { CRON_SENTINEL_RULES } from "../cron-sentinel-rules";

describe("CRON_SENTINEL_RULES", () => {
  it("has one unique declarative row for every legacy watchdog condition", () => {
    const ids = CRON_SENTINEL_RULES.map((rule) => rule.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toEqual(expect.arrayContaining([
      "producer-stale",
      "detail-write-failure",
      "daily-row",
      "daily-telegram",
      "daily-twitter",
      "weekly-row",
      "weekly-telegram",
      "weekly-twitter",
      "map-producer-lag",
      "duration-average",
      "duration-cap-hits",
      "duration-budget-truncations",
      "slot-abandonment",
      "dex-route-turnover",
      "reserve-collateral-drift",
      "reserve-curated-fallback",
      "reserve-persistent-stale-warning",
      "reserve-drift-cache-age",
      "reserve-persistent-stale",
      "mint-burn-row-growth",
      "repair-debt-due",
      "repair-debt-stale-claim",
    ]));
    for (const rule of CRON_SENTINEL_RULES) {
      expect(rule.condition.length).toBeGreaterThan(0);
      expect(rule.cooldownSec).toBeGreaterThanOrEqual(0);
      expect(rule.sustainedSec).toBeGreaterThanOrEqual(0);
    }
  });
});
