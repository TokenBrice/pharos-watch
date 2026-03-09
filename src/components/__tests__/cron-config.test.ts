import { describe, expect, it } from "vitest";
import { getStatusCronDisplay, STATUS_CRON_GROUPS } from "@/components/status/cron-config";

describe("status cron config", () => {
  it("maps the split DEX pipeline onto separate cron groups", () => {
    expect(getStatusCronDisplay("sync-dex-discovery")).toEqual({
      group: "twenty-minute",
      label: "DEX pool discovery",
    });
    expect(getStatusCronDisplay("sync-dex-liquidity")).toEqual({
      group: "half-hourly",
      label: "DEX liquidity scoring",
    });
  });

  it("maps stablecoin charts to the half-hourly group after cadence reduction", () => {
    expect(getStatusCronDisplay("sync-stablecoin-charts")).toEqual({
      group: "half-hourly",
      label: "Stablecoin charts",
    });
  });

  it("keeps the 20-minute slot description aligned with isolated on-chain triggers", () => {
    expect(STATUS_CRON_GROUPS.find((group) => group.key === "twenty-minute")?.description).toContain(
      "On-chain intake",
    );
  });
});
