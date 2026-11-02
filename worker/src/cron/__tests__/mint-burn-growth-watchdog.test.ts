import { describe, it, expect } from "vitest";
import { mockD1 } from "@shared/test-utils/mock-d1";
import { WORKER_ACTIVE_IDS } from "@shared/lib/stablecoins/worker-runtime-registry";
import {
  MINT_BURN_EVENTS_ROW_ALERT_THRESHOLD,
  MINT_BURN_ACTIVITY_MIN_BASELINE_EVENTS,
  runMintBurnGrowthWatchdog,
} from "../mint-burn-growth-watchdog";
import { MINT_BURN_CONFIGS } from "../../lib/mint-burn-contracts";
import { mintBurnConfigKey } from "../../lib/mint-burn-pipeline/sync-state";

const activeConfig = MINT_BURN_CONFIGS.find(
  (config) => config.enabled !== false && WORKER_ACTIVE_IDS.has(config.stablecoinId),
)!;
// YUSD is carried by two stablecoins, so the env switch alone disables neither;
// only the durable keys retained by the producer keep a quarantined leg paused.
const ambiguousSymbolConfig = MINT_BURN_CONFIGS.find(
  (config) => config.enabled !== false
    && WORKER_ACTIVE_IDS.has(config.stablecoinId)
    && config.symbol.toUpperCase() === "YUSD",
)!;

function rowCountTable(rowCount: number | null) {
  return {
    match: "SELECT COUNT(*) AS rowCount FROM mint_burn_events",
    rows: [],
    first: rowCount == null ? null : { rowCount },
  };
}

function activityTable(rows: Record<string, unknown>[] = []) {
  return {
    match: "pharos:mint-burn-activity-collapse",
    rows,
  };
}

describe("runMintBurnGrowthWatchdog", () => {
  it("counts current retained events below the threshold", async () => {
    const db = mockD1(
      [rowCountTable(1_430_000), activityTable()],
      { strictSql: false },
    );

    const result = await runMintBurnGrowthWatchdog(db);

    expect(result.status).toBeUndefined();
    expect(result.itemCount).toBe(1_430_000);
    expect(JSON.parse(String(result.metadata))).toMatchObject({
      rowCount: 1_430_000,
      activityCollapse: [],
      firedRuleIds: [],
    });
    expect(db.getHistory()[0]?.sql).toContain("COUNT(*)");
    expect(db.getHistory()[0]?.sql).toContain("mint_burn_events");
  });

  it("reports capacity findings without failing completed work", async () => {
    const db = mockD1(
      [rowCountTable(MINT_BURN_EVENTS_ROW_ALERT_THRESHOLD + 1), activityTable()],
      { strictSql: false },
    );

    const result = await runMintBurnGrowthWatchdog(db);

    expect(result.status).toBe("ok");
    expect(result.itemCount).toBe(MINT_BURN_EVENTS_ROW_ALERT_THRESHOLD + 1);
    expect(JSON.parse(String(result.metadata))).toEqual({
      rowCount: MINT_BURN_EVENTS_ROW_ALERT_THRESHOLD + 1,
      thresholdRows: MINT_BURN_EVENTS_ROW_ALERT_THRESHOLD,
      activityCollapse: [],
      rowCountThresholdExceeded: true,
      quality: { reason: "row-count-threshold" },
      firedRuleIds: ["mint-burn-row-growth"],
    });
  });

  it("reports an enabled leg whose 30-day baseline records no events for a week", async () => {
    const db = mockD1(
      [
        rowCountTable(100_000),
        activityTable([{
          stablecoin_id: activeConfig.stablecoinId,
          chain_id: activeConfig.chain.chainId,
          recent_events: 0,
          baseline_events: MINT_BURN_ACTIVITY_MIN_BASELINE_EVENTS,
        }]),
      ],
      { strictSql: false },
    );

    const result = await runMintBurnGrowthWatchdog(db);

    expect(result.status).toBe("ok");
    expect(JSON.parse(String(result.metadata))).toMatchObject({
      activityCollapse: [{
        stablecoinId: activeConfig.stablecoinId,
        chainId: activeConfig.chain.chainId,
        baselineEvents: MINT_BURN_ACTIVITY_MIN_BASELINE_EVENTS,
      }],
      quality: {
        reason: "mint-burn-activity-collapse",
        coinCount: 1,
        coins: [{
          stablecoinId: activeConfig.stablecoinId,
          chainId: activeConfig.chain.chainId,
          baselineEvents: MINT_BURN_ACTIVITY_MIN_BASELINE_EVENTS,
        }],
      },
      firedRuleIds: ["mint-burn-activity-collapse"],
    });
  });

  it("does not report a runtime-disabled leg as collapsed", async () => {
    const db = mockD1(
      [
        rowCountTable(100_000),
        activityTable([{
          stablecoin_id: activeConfig.stablecoinId,
          chain_id: activeConfig.chain.chainId,
          recent_events: 0,
          baseline_events: MINT_BURN_ACTIVITY_MIN_BASELINE_EVENTS,
        }]),
      ],
      { strictSql: false },
    );

    const result = await runMintBurnGrowthWatchdog(db, undefined, {
      disabledIds: [activeConfig.stablecoinId],
    });

    expect(result.status).toBeUndefined();
    expect(JSON.parse(String(result.metadata))).toMatchObject({
      activityCollapse: [],
      firedRuleIds: [],
    });
  });

  it("honors a retained durable disable for an ambiguous symbol", async () => {
    const yusdKey = mintBurnConfigKey(ambiguousSymbolConfig);
    const db = mockD1(
      [
        rowCountTable(100_000),
        {
          match: "mint_burn_publication_policy",
          rows: [{ disabled_keys: JSON.stringify([yusdKey]), paused_keys: "[]" }],
        },
        activityTable([{
          stablecoin_id: ambiguousSymbolConfig.stablecoinId,
          chain_id: ambiguousSymbolConfig.chain.chainId,
          recent_events: 0,
          baseline_events: MINT_BURN_ACTIVITY_MIN_BASELINE_EVENTS,
        }]),
      ],
      { strictSql: false },
    );

    const result = await runMintBurnGrowthWatchdog(db, undefined, {
      disabledSymbols: ["YUSD"],
    });

    expect(result.status).toBeUndefined();
    expect(JSON.parse(String(result.metadata))).toMatchObject({
      activityCollapse: [],
      firedRuleIds: [],
    });
  });

  it("names the disabled-policy read as the unavailable input, not the activity baseline", async () => {
    const db = mockD1(
      [
        rowCountTable(100_000),
        {
          match: "mint_burn_publication_policy",
          throwError: new Error("D1 unavailable"),
          rows: [],
        },
      ],
      { strictSql: false },
    );

    const result = await runMintBurnGrowthWatchdog(db, undefined, {
      disabledSymbols: ["YUSD"],
    });

    expect(result.status).toBe("degraded");
    expect(result.itemCount).toBe(100_000);
    const metadata = JSON.parse(String(result.metadata));
    expect(metadata).toMatchObject({
      reason: "mint-burn-disabled-policy-unavailable",
      rowCount: 100_000,
      disabledPolicyUnavailable: true,
    });
    expect(metadata).not.toHaveProperty("activityBaselineUnavailable");
    expect(db.getHistory().some(({ sql }) => sql.includes("pharos:mint-burn-activity-collapse")))
      .toBe(false);
  });

  it("degrades instead of reporting healthy when the activity baseline read fails", async () => {
    const db = mockD1(
      [
        rowCountTable(100_000),
        {
          match: "pharos:mint-burn-activity-collapse",
          throwError: new Error("D1 unavailable"),
          rows: [],
        },
      ],
      { strictSql: false },
    );

    const result = await runMintBurnGrowthWatchdog(db);

    expect(result.status).toBe("degraded");
    expect(result.itemCount).toBe(100_000);
    expect(JSON.parse(String(result.metadata))).toMatchObject({
      reason: "mint-burn-activity-baseline-unavailable",
      rowCount: 100_000,
      activityBaselineUnavailable: true,
    });
  });

  it("fails closed when the current table count is unavailable", async () => {
    const db = mockD1(
      [rowCountTable(null), activityTable()],
      { strictSql: false },
    );
    await expect(runMintBurnGrowthWatchdog(db)).rejects.toThrow("row count unavailable");
  });

  it("throws before D1 work when the cron signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort(new Error("growth watchdog aborted"));

    await expect(runMintBurnGrowthWatchdog(mockD1(), controller.signal)).rejects.toThrow(
      "growth watchdog aborted",
    );
  });
});
