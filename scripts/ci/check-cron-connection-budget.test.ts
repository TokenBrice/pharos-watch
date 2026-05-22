import { describe, expect, it } from "vitest";
import { CRON_CONNECTION_BUDGET_ENTRIES } from "../../shared/lib/cron-jobs";
import { evaluateCronConnectionBudget } from "./check-cron-connection-budget";

describe("check-cron-connection-budget", () => {
  it("models sync-stablecoins at the bounded provider fanout peak", () => {
    const report = evaluateCronConnectionBudget();
    const quarterHourly = report.triggerReports.find((trigger) => trigger.scheduleKey === "quarterHourly");
    const syncStablecoins = CRON_CONNECTION_BUDGET_ENTRIES.find((entry) => entry.job === "sync-stablecoins");

    expect(syncStablecoins?.maxConnections).toBe(4);
    expect(quarterHourly?.groups.get("quarter-hourly-chain")?.peak).toBe(4);
    expect(quarterHourly?.totalConnections).toBe(4);
    expect(report.failed).toBe(false);
  });
});
