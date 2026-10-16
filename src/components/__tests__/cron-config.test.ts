import { describe, expect, it } from "vitest";
import { CRON_JOB_DEFINITIONS } from "@shared/lib/cron-jobs";

describe("status cron config", () => {
  it("pins reduced-frequency cron intervals used by status", () => {
    const intervals = Object.fromEntries(CRON_JOB_DEFINITIONS.map((cron) => [cron.job, cron.intervalSec]));
    expect(intervals["sync-blacklist"]).toBe(6 * 3600);
    expect(intervals["sync-dex-discovery"]).toBe(2 * 3600);
    expect(intervals["sync-dex-liquidity-stage"]).toBe(3600);
    expect(intervals["sync-dex-liquidity"]).toBe(3600);
    expect(intervals["sync-cl-exit-depth"]).toBe(1800);
    expect(intervals["sync-live-reserves"]).toBe(4 * 3600);
    expect(intervals["sync-redemption-backstops"]).toBe(4 * 3600);
    expect(intervals["sync-kinesis-supply"]).toBe(4 * 3600);
    expect(intervals["sync-yield-data"]).toBe(3600);
    expect(intervals["sync-yield-supplemental"]).toBe(4 * 3600);
    expect(intervals["prune-status-probe-runs"]).toBe(86400);
    expect(intervals["prune-cron-history"]).toBe(86400);
  });
});
