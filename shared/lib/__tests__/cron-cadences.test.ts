import { describe, expect, it } from "vitest";

import {
  CRON_SCHEDULE_CADENCES,
  DEX_LIQUIDITY_EVIDENCE_MAX_AGE_SEC,
  V9_EVIDENCE_PRODUCER_INTERVAL_SEC,
  isDailyDexShadowTargetPublicationSlot,
  isDexLiquidityPublicationSlot,
  isHourlyDexPriceSlot,
} from "../cron-cadences";
import { CRON_INTERVALS, CRON_JOB_DEFINITIONS, CRON_SCHEDULES } from "../cron-jobs";

describe("cron cadence split", () => {
  it("keeps a cadence entry for every schedule key the job table uses", () => {
    for (const key of Object.keys(CRON_SCHEDULES)) {
      expect(CRON_SCHEDULE_CADENCES).toHaveProperty(key);
    }
    expect(Object.keys(CRON_SCHEDULE_CADENCES).sort()).toEqual(Object.keys(CRON_SCHEDULES).sort());
  });

  it("binds every job to a cadence with a positive interval", () => {
    for (const definition of CRON_JOB_DEFINITIONS) {
      expect(CRON_SCHEDULE_CADENCES[definition.scheduleKey].intervalSec).toBeGreaterThan(0);
      expect(definition.intervalSec).toBeGreaterThan(0);
    }
  });

  it("preserves reviewed DEX freshness while other evidence producers follow their cron cadence", () => {
    for (const [job, intervalSec] of Object.entries(V9_EVIDENCE_PRODUCER_INTERVAL_SEC)) {
      if (job === "sync-dex-liquidity") {
        expect(intervalSec).toBe(7200);
        expect(DEX_LIQUIDITY_EVIDENCE_MAX_AGE_SEC).toBe(14_400);
        expect(CRON_INTERVALS[job]).toBe(3600);
        continue;
      }
      expect(CRON_INTERVALS[job], `producer cadence drifted for ${job}`).toBe(intervalSec);
    }
  });

  it("runs DEX sources, prices and full scoring hourly, and shadow targets daily", () => {
    const sec = (iso: string) => Date.parse(iso) / 1_000;

    expect(CRON_SCHEDULE_CADENCES.halfHourlyOffset).toEqual({ intervalSec: 3600, offsetSec: 10 * 60 });
    expect(isHourlyDexPriceSlot(sec("2026-08-10T06:16:00Z"))).toBe(true);
    expect(isHourlyDexPriceSlot(sec("2026-08-10T06:46:00Z"))).toBe(false);
    expect(isDexLiquidityPublicationSlot(sec("2026-08-10T06:16:00Z"))).toBe(true);
    expect(isDexLiquidityPublicationSlot(sec("2026-08-10T07:16:00Z"))).toBe(true);
    expect(isDexLiquidityPublicationSlot(sec("2026-08-10T07:46:00Z"))).toBe(false);
    expect(isDailyDexShadowTargetPublicationSlot(sec("2026-08-10T06:16:00Z"))).toBe(true);
    expect(isDailyDexShadowTargetPublicationSlot(sec("2026-08-10T08:16:00Z"))).toBe(false);
  });
});
