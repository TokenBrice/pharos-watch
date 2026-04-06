import { describe, expect, it } from "vitest";
import { getStatusCronDisplay } from "@/lib/status/cron-config";
import { CRON_GROUPS, CRON_JOB_DEFINITIONS } from "@shared/lib/cron-jobs";

describe("status cron config", () => {
  it("maps the split DEX pipeline onto separate cron groups", () => {
    expect(getStatusCronDisplay("sync-dex-discovery")).toEqual({
      group: "half-hourly",
      label: "DEX pool discovery",
      schedule: "6,36 * * * *",
      triggerMode: "isolated",
    });
    expect(getStatusCronDisplay("sync-dex-liquidity")).toEqual({
      group: "half-hourly",
      label: "DEX liquidity scoring",
      schedule: "10,40 * * * *",
      triggerMode: "shared",
    });
  });

  it("maps stablecoin charts to the shared half-hourly offset slot", () => {
    expect(getStatusCronDisplay("sync-stablecoin-charts")).toEqual({
      group: "half-hourly",
      label: "Stablecoin charts",
      schedule: "10,40 * * * *",
      triggerMode: "shared",
    });
  });

  it("maps live reserve sync to the dedicated hourly slot", () => {
    expect(getStatusCronDisplay("sync-live-reserves")).toEqual({
      group: "hourly",
      label: "Live reserve sync",
      schedule: "11 * * * *",
      triggerMode: "shared",
    });
  });

  it("maps core and supplemental yield jobs onto their dedicated post-DEX lanes", () => {
    expect(getStatusCronDisplay("sync-yield-data")).toEqual({
      group: "hourly",
      label: "Yield sync",
      schedule: "20 * * * *",
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

  it("keeps daily chained jobs in the daily group on the consolidated trigger", () => {
    expect(getStatusCronDisplay("discovery-scan")).toEqual({
      group: "daily",
      label: "Coverage discovery",
      schedule: "0 8 * * *",
      triggerMode: "shared",
    });
  });

  it("keeps the 20-minute slot description aligned with isolated on-chain triggers", () => {
    expect(CRON_GROUPS.find((group) => group.key === "twenty-minute")?.description).toContain(
      "isolated trigger",
    );
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
