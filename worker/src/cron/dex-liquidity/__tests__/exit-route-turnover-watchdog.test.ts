import { describe, expect, it } from "vitest";

import type { DexExitEvidenceKind } from "@shared/types/market";
import { mockD1 } from "@shared/test-utils/mock-d1";
import {
  DEX_EXIT_ROUTE_TURNOVER_ALERT_THRESHOLD,
  DEX_EXIT_ROUTE_TURNOVER_SNAPSHOT_CACHE_KEY,
  runDexExitRouteTurnoverWatchdog,
} from "../../dex-exit-route-turnover-watchdog";

const CURRENT_GENERATION = "dex-liquidity-current";
const PREVIOUS_GENERATION = "dex-liquidity-previous";

function observation(routeId: string, evidenceKind: DexExitEvidenceKind = "reserve-based-amm-simulation") {
  return {
    routeId,
    routeFamily: "dex-amm",
    scope: {
      kind: "chain-contract",
      chain: "Ethereum",
      contractOrPoolId: routeId,
      protocol: "test-dex",
    },
    requestedNotionalUsd: 25_000_000,
    settlementHorizonSec: 300,
    maxCostBps: 200,
    executableUsd: 1_000_000,
    completionRatio: 0.04,
    output: {
      kind: "tracked-stablecoin",
      trackedAssetIds: ["usdc-circle"],
    },
    evidenceKind,
    confidence: "high",
    scoreEligible: true,
    observedAt: 1_000,
    freshnessSeconds: 300,
    commonModeKeys: [],
  };
}

function publishedRow(
  stablecoinId: string,
  routes: Array<{ routeId: string; evidenceKind?: DexExitEvidenceKind }>,
) {
  return {
    stablecoin_id: stablecoinId,
    score_components_json: JSON.stringify({
      exitRouteObservations: routes.map((route) => observation(route.routeId, route.evidenceKind)),
    }),
  };
}

function previousSnapshot(
  coins: Array<{
    stablecoinId: string;
    routes: Array<{ routeId: string; evidenceKind?: DexExitEvidenceKind }>;
  }>,
): string {
  return JSON.stringify({
    schemaVersion: 1,
    generationId: PREVIOUS_GENERATION,
    coins: coins.map((coin) => ({
      stablecoinId: coin.stablecoinId,
      routes: coin.routes.map((route) => ({
        routeId: route.routeId,
        evidenceKind: route.evidenceKind ?? "reserve-based-amm-simulation",
      })),
    })),
  });
}

function watchdogDb(currentRows: Record<string, unknown>[], previousValue: string | null) {
  return mockD1([
    {
      match: "FROM dex_liquidity_publication_generations",
      rows: [],
      first: { generation_id: CURRENT_GENERATION, published_at: 2_000 },
    },
    {
      match: "FROM dex_liquidity_run_rows",
      matchBinds: [CURRENT_GENERATION],
      rows: currentRows,
    },
    {
      match: "SELECT value, updated_at FROM cache WHERE key = ?",
      matchBinds: [DEX_EXIT_ROUTE_TURNOVER_SNAPSHOT_CACHE_KEY],
      rows: [],
      first: previousValue === null ? null : { value: previousValue, updated_at: 1_000 },
    },
    {
      match: "INSERT OR REPLACE INTO cache",
      rows: [],
      runMeta: { changes: 1 },
    },
  ]);
}

describe("DEX exit-route turnover watchdog", () => {
  it("stays healthy when the published route set does not turn over", async () => {
    const routes = [{ routeId: "route-a" }, { routeId: "route-b" }];
    const result = await runDexExitRouteTurnoverWatchdog(watchdogDb(
      [publishedRow("coin-a", routes)],
      previousSnapshot([{ stablecoinId: "coin-a", routes }]),
    ));

    expect(result.status).toBeUndefined();
    expect(JSON.parse(String(result.metadata))).toMatchObject({
      changedCoinCount: 0,
      alertingCoinCount: 0,
      highestObservedTurnover: 0,
      worstOffenders: [],
    });
  });

  it("reports partial turnover and evidence-kind changes below the alert threshold", async () => {
    const result = await runDexExitRouteTurnoverWatchdog(watchdogDb(
      [publishedRow("coin-a", [
        { routeId: "route-a" },
        { routeId: "route-b" },
        { routeId: "route-c", evidenceKind: "measured-executable-depth" },
        { routeId: "route-e" },
      ])],
      previousSnapshot([{ stablecoinId: "coin-a", routes: [
        { routeId: "route-a" },
        { routeId: "route-b" },
        { routeId: "route-c" },
        { routeId: "route-d" },
      ] }]),
    ));

    const metadata = JSON.parse(String(result.metadata));
    expect(result.status).toBeUndefined();
    expect(metadata.highestObservedTurnover).toBe(0.4);
    expect(metadata.changedCoinCount).toBe(1);
    expect(metadata.evidenceKindChangedRouteCount).toBe(1);
    expect(metadata.alertingCoinCount).toBe(0);
  });

  it("degrades and names the coin when turnover exceeds the alert threshold", async () => {
    const result = await runDexExitRouteTurnoverWatchdog(watchdogDb(
      [publishedRow("coin-a", [
        { routeId: "route-a" },
        { routeId: "route-b" },
        { routeId: "route-e" },
        { routeId: "route-f" },
      ])],
      previousSnapshot([{ stablecoinId: "coin-a", routes: [
        { routeId: "route-a" },
        { routeId: "route-b" },
        { routeId: "route-c" },
        { routeId: "route-d" },
      ] }]),
    ));

    const metadata = JSON.parse(String(result.metadata));
    expect(result.status).toBe("degraded");
    expect(metadata.turnoverAlertThreshold).toBe(DEX_EXIT_ROUTE_TURNOVER_ALERT_THRESHOLD);
    expect(metadata.worstOffenders).toEqual([
      expect.objectContaining({
        stablecoinId: "coin-a",
        jaccardDistance: 0.666667,
        addedRouteCount: 2,
        removedRouteCount: 2,
      }),
    ]);
  });

  it("creates a baseline without alerting on the first-ever run", async () => {
    const db = watchdogDb(
      [publishedRow("coin-a", [{ routeId: "route-a" }])],
      null,
    );

    const result = await runDexExitRouteTurnoverWatchdog(db);
    const metadata = JSON.parse(String(result.metadata));
    const write = db.getHistory().find((entry) => entry.sql.includes("INSERT OR REPLACE INTO cache"));

    expect(result.status).toBeUndefined();
    expect(metadata).toMatchObject({
      baselineCreated: true,
      previousGenerationId: null,
      alertingCoinCount: 0,
    });
    expect(String(write?.binds[1])).toContain('"routeId":"route-a"');
    expect(String(write?.binds[1])).not.toContain("requestedNotionalUsd");
  });

  it("treats a coin disappearing entirely as complete turnover", async () => {
    const result = await runDexExitRouteTurnoverWatchdog(watchdogDb(
      [],
      previousSnapshot([{ stablecoinId: "coin-a", routes: [
        { routeId: "route-a" },
        { routeId: "route-b" },
      ] }]),
    ));

    const metadata = JSON.parse(String(result.metadata));
    expect(result.status).toBe("degraded");
    expect(metadata.worstOffenders[0]).toMatchObject({
      stablecoinId: "coin-a",
      previousRouteCount: 2,
      currentRouteCount: 0,
      jaccardDistance: 1,
      removedRouteCount: 2,
    });
  });
});
