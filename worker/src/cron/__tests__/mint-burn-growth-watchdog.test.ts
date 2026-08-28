import { describe, it, expect } from "vitest";
import { mockD1 } from "@shared/test-utils/mock-d1";
import {
  MINT_BURN_EVENTS_ROW_ALERT_THRESHOLD,
  runMintBurnGrowthWatchdog,
} from "../mint-burn-growth-watchdog";

describe("runMintBurnGrowthWatchdog", () => {
  it("returns ok below the threshold", async () => {
    const db = mockD1([
      {
        match: "mint_burn_events",
        rows: [],
        first: { row_count: 1_430_000 },
      },
    ]);

    const result = await runMintBurnGrowthWatchdog(db);

    expect(result.status).toBeUndefined();
    expect(result.itemCount).toBe(1_430_000);
  });

  it("degrades when the growth budget is exceeded", async () => {
    const db = mockD1([
      {
        match: "mint_burn_events",
        rows: [],
        first: { row_count: MINT_BURN_EVENTS_ROW_ALERT_THRESHOLD + 1 },
      },
    ]);

    const result = await runMintBurnGrowthWatchdog(db);

    expect(result.status).toBe("degraded");
    expect(result.itemCount).toBe(MINT_BURN_EVENTS_ROW_ALERT_THRESHOLD + 1);
    expect(JSON.parse(String(result.metadata))).toEqual({
      rowCount: MINT_BURN_EVENTS_ROW_ALERT_THRESHOLD + 1,
      thresholdRows: MINT_BURN_EVENTS_ROW_ALERT_THRESHOLD,
    });
  });

  it("throws before D1 work when the cron signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort(new Error("growth watchdog aborted"));

    await expect(runMintBurnGrowthWatchdog(mockD1(), controller.signal)).rejects.toThrow(
      "growth watchdog aborted",
    );
  });
});
