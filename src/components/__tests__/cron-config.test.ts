import { describe, expect, it } from "vitest";
import { getStatusCronDisplay } from "@/lib/status/cron-config";
import { CRON_GROUPS, CRON_JOB_DEFINITIONS } from "@shared/lib/cron-jobs";

describe("status cron config", () => {
  it("maps the split DEX pipeline onto separate cron slots", () => {
    expect(getStatusCronDisplay("sync-dex-discovery")).toEqual({
      group: "multi-hourly",
      label: "DEX pool discovery",
      schedule: "6 */2 * * *",
      triggerMode: "isolated",
    });
    expect(getStatusCronDisplay("sync-dex-liquidity-stage")).toEqual({
      group: "hourly",
      label: "DEX liquidity source stage",
      schedule: "10 * * * *",
      triggerMode: "isolated",
    });
    expect(getStatusCronDisplay("sync-dex-liquidity")).toEqual({
      group: "multi-hourly",
      label: "DEX liquidity scoring",
      schedule: "16,46 * * * *",
      triggerMode: "shared",
    });
  });

  it("maps stablecoin charts to the shared half-hourly charts slot", () => {
    expect(getStatusCronDisplay("sync-stablecoin-charts")).toEqual({
      group: "half-hourly",
      label: "Stablecoin charts",
      schedule: "16,46 * * * *",
      triggerMode: "shared",
    });
  });

  it("maps DEWS and PSI to the decoupled DB-only half-hourly slot", () => {
    expect(getStatusCronDisplay("compute-dews")).toEqual({
      group: "half-hourly",
      label: "DEWS compute",
      schedule: "26,56 * * * *",
      triggerMode: "shared",
    });
    expect(getStatusCronDisplay("stability-index")).toEqual({
      group: "half-hourly",
      label: "PSI compute",
      schedule: "26,56 * * * *",
      triggerMode: "shared",
    });
  });

  it("maps live reserve sync to the dedicated 4-hourly slot", () => {
    expect(getStatusCronDisplay("sync-live-reserves")).toEqual({
      group: "multi-hourly",
      label: "Live reserve sync",
      schedule: "11 */4 * * *",
      triggerMode: "shared",
    });
  });

  it("maps core and supplemental yield jobs onto their dedicated post-DEX lanes", () => {
    expect(getStatusCronDisplay("sync-yield-data")).toEqual({
      group: "hourly",
      label: "Yield sync",
      schedule: "55 * * * *",
      triggerMode: "isolated",
    });
    expect(getStatusCronDisplay("sync-yield-supplemental")).toEqual({
      group: "multi-hourly",
      label: "Yield supplemental sync",
      schedule: "25 */4 * * *",
      triggerMode: "isolated",
    });
  });

  it("maps telegram alerts to the dedicated 5-minute slot", () => {
    expect(getStatusCronDisplay("dispatch-telegram-alerts")).toEqual({
      group: "five-minute",
      label: "Telegram alerts",
      schedule: "2,7,12,17,22,27,32,37,42,47,52,57 * * * *",
      triggerMode: "isolated",
    });
  });

  it("keeps daily chained jobs in the daily group across both triggers", () => {
    expect(getStatusCronDisplay("weekly-recap")).toEqual({
      group: "daily",
      label: "Weekly recap",
      schedule: "10 8 * * *",
      triggerMode: "shared",
    });
  });

  it("keeps cron group copy aligned with mixed trigger cadences", () => {
    expect(CRON_GROUPS.find((group) => group.key === "half-hourly")?.description).toContain(
      "mint/burn critical and extended triggers",
    );
    expect(CRON_GROUPS.find((group) => group.key === "hourly")?.description).toContain(
      "core yield publication lane",
    );
    const multiHourly = CRON_GROUPS.find((group) => group.key === "multi-hourly");
    expect(multiHourly?.badge).toBe("2-6h");
    expect(multiHourly?.description).toContain("6-hour critical blacklist sync");
    const daily = CRON_GROUPS.find((group) => group.key === "daily");
    expect(daily?.badge).toBe("daily");
    expect(daily?.description).toContain("03:00 retention pruning");
  });

  it("pins reduced-frequency cron intervals used by status", () => {
    const intervals = Object.fromEntries(CRON_JOB_DEFINITIONS.map((cron) => [cron.job, cron.intervalSec]));
    expect(intervals["sync-blacklist"]).toBe(6 * 3600);
    expect(intervals["sync-dex-discovery"]).toBe(2 * 3600);
    expect(intervals["sync-dex-liquidity-stage"]).toBe(3600);
    expect(intervals["sync-dex-liquidity"]).toBe(2 * 3600);
    expect(intervals["sync-cl-exit-depth"]).toBe(1800);
    expect(intervals["sync-live-reserves"]).toBe(4 * 3600);
    expect(intervals["sync-redemption-backstops"]).toBe(4 * 3600);
    expect(intervals["sync-kinesis-supply"]).toBe(4 * 3600);
    expect(intervals["sync-yield-data"]).toBe(3600);
    expect(intervals["sync-yield-supplemental"]).toBe(4 * 3600);
    expect(intervals["prune-status-probe-runs"]).toBe(86400);
    expect(intervals["prune-cron-history"]).toBe(86400);
  });

  it("provides display metadata for every known cron job", () => {
    for (const cron of CRON_JOB_DEFINITIONS) {
      expect(getStatusCronDisplay(cron.job)).toEqual({
        group: cron.group,
        label: cron.label,
        schedule: cron.schedule,
        triggerMode: cron.triggerMode,
      });
    }
  });
});
