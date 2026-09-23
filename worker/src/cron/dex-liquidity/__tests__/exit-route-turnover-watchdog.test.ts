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
const RECOVERY_GENERATION = "dex-liquidity-recovery";
const SUSTAINED_GENERATION = "dex-liquidity-sustained";
const AFTER_GENERATION = "dex-liquidity-after";

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

interface SnapshotRoute {
  routeId: string;
  evidenceKind?: DexExitEvidenceKind;
}

interface SnapshotCoin {
  stablecoinId: string;
  routes: SnapshotRoute[];
}

interface SnapshotCandidate {
  stablecoinId: string;
  jaccardDistance: number;
  addedRouteCount: number;
  removedRouteCount: number;
}

function routes(...routeIds: string[]): SnapshotRoute[] {
  return routeIds.map((routeId) => ({ routeId }));
}

function previousSnapshot(
  coins: SnapshotCoin[],
  options: {
    generationId?: string;
    candidates?: SnapshotCandidate[];
  } = {},
): string {
  const generationId = options.generationId ?? PREVIOUS_GENERATION;
  return JSON.stringify({
    schemaVersion: 1,
    generationId,
    coins: coins.map((coin) => ({
      stablecoinId: coin.stablecoinId,
      routes: coin.routes.map((route) => ({
        routeId: route.routeId,
        evidenceKind: route.evidenceKind ?? "reserve-based-amm-simulation",
      })),
    })),
    ...(options.candidates
      ? { candidates: options.candidates.map((candidate) => ({ generationId, ...candidate })) }
      : {}),
  });
}

function watchdogDb(
  currentRows: Record<string, unknown>[],
  previousValue: string | null,
  generationId: string = CURRENT_GENERATION,
  options: { allowUnusedWrite?: boolean } = {},
) {
  return mockD1([
    {
      match: "FROM dex_liquidity_publication_generations",
      rows: [],
      first: { generation_id: generationId, published_at: 2_000 },
    },
    {
      match: "FROM dex_liquidity_run_rows",
      matchBinds: [generationId],
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
      allowUnused: options.allowUnusedWrite === true,
    },
  ], { assertMatchesUsed: true });
}

function lastSnapshotWrite(db: { getHistory: () => Array<{ sql: string; binds: unknown[] }> }): string | null {
  const writes = db.getHistory().filter((entry) => entry.sql.includes("INSERT OR REPLACE INTO cache"));
  const value = writes[writes.length - 1]?.binds[1];
  return typeof value === "string" ? value : null;
}

describe("DEX exit-route turnover watchdog", () => {
  it("stays healthy when the published route set does not turn over", async () => {
    const coinRoutes = routes("route-a", "route-b");
    const result = await runDexExitRouteTurnoverWatchdog(watchdogDb(
      [publishedRow("coin-a", coinRoutes)],
      previousSnapshot([{ stablecoinId: "coin-a", routes: coinRoutes }]),
    ));

    expect(result.status).toBeUndefined();
    expect(JSON.parse(String(result.metadata))).toMatchObject({
      changedCoinCount: 0,
      alertingCoinCount: 0,
      candidateCoinCount: 0,
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
    expect(metadata.candidateCoinCount).toBe(0);
  });

  it("treats a legacy snapshot payload without candidates as no candidate and opens one instead of alerting", async () => {
    const db = watchdogDb(
      [publishedRow("coin-a", routes("route-a", "route-b", "route-e", "route-f"))],
      // Old payload shape: written before the sustain window existed.
      previousSnapshot([{ stablecoinId: "coin-a", routes: routes("route-a", "route-b", "route-c", "route-d") }]),
    );

    const result = await runDexExitRouteTurnoverWatchdog(db);
    const metadata = JSON.parse(String(result.metadata));
    const write = JSON.parse(lastSnapshotWrite(db) ?? "{}");

    expect(result.status).toBeUndefined();
    expect(metadata.baselineCreated).toBe(false);
    expect(metadata.comparedCoinCount).toBe(1);
    expect(metadata.alertingCoinCount).toBe(0);
    expect(metadata.candidateCoinCount).toBe(1);
    expect(metadata.candidates[0]).toMatchObject({
      stablecoinId: "coin-a",
      generationId: CURRENT_GENERATION,
      jaccardDistance: 0.666667,
      addedRouteCount: 2,
      removedRouteCount: 2,
    });
    // The baseline is held at the pre-divergence routes while the candidate is open.
    expect(write.coins[0].routes.map((route: { routeId: string }) => route.routeId))
      .toEqual(["route-a", "route-b", "route-c", "route-d"]);
    expect(write.candidates).toHaveLength(1);
    expect(write.pendingAlert).toBeUndefined();
  });

  it("degrades and names the coin when divergence sustains across two published generations", async () => {
    const db = watchdogDb(
      [publishedRow("coin-a", routes("route-a", "route-b", "route-e", "route-f"))],
      previousSnapshot(
        [{ stablecoinId: "coin-a", routes: routes("route-a", "route-b", "route-c", "route-d") }],
        { candidates: [{ stablecoinId: "coin-a", jaccardDistance: 0.666667, addedRouteCount: 2, removedRouteCount: 2 }] },
      ),
    );

    const result = await runDexExitRouteTurnoverWatchdog(db);
    const metadata = JSON.parse(String(result.metadata));
    const write = JSON.parse(lastSnapshotWrite(db) ?? "{}");

    expect(result.status).toBe("degraded");
    expect(metadata.turnoverAlertThreshold).toBe(DEX_EXIT_ROUTE_TURNOVER_ALERT_THRESHOLD);
    expect(metadata.alertingCoinCount).toBe(1);
    expect(metadata.candidateCoinCount).toBe(0);
    expect(metadata.worstOffenders).toEqual([
      expect.objectContaining({
        stablecoinId: "coin-a",
        jaccardDistance: 0.666667,
        addedRouteCount: 2,
        removedRouteCount: 2,
      }),
    ]);
    // The confirming run advances the baseline and persists the alert.
    expect(write.coins[0].routes.map((route: { routeId: string }) => route.routeId))
      .toEqual(["route-a", "route-b", "route-e", "route-f"]);
    expect(write.candidates).toBeUndefined();
    expect(write.pendingAlert.worstOffenders[0]).toMatchObject({ stablecoinId: "coin-a" });
  });

  it("creates a baseline without alerting on the first-ever run", async () => {
    const db = watchdogDb(
      [publishedRow("coin-a", routes("route-a"))],
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

  it("never alerts on a one-generation lane blip that vanishes and returns", async () => {
    const coinRoutes = routes("route-a", "route-b", "route-c", "route-d");

    const blipDb = watchdogDb(
      [],
      previousSnapshot([{ stablecoinId: "coin-a", routes: coinRoutes }]),
      CURRENT_GENERATION,
    );
    const blip = await runDexExitRouteTurnoverWatchdog(blipDb);
    const blipMetadata = JSON.parse(String(blip.metadata));

    // The blip generation is visible in diagnostics but only opens a candidate.
    expect(blip.status).toBeUndefined();
    expect(blipMetadata).toMatchObject({
      changedCoinCount: 1,
      highestObservedTurnover: 1,
      alertingCoinCount: 0,
      candidateCoinCount: 1,
    });

    const recoveryDb = watchdogDb(
      [publishedRow("coin-a", coinRoutes)],
      lastSnapshotWrite(blipDb),
      RECOVERY_GENERATION,
    );
    const recovery = await runDexExitRouteTurnoverWatchdog(recoveryDb);
    const recoveryMetadata = JSON.parse(String(recovery.metadata));
    const recoveryWrite = JSON.parse(lastSnapshotWrite(recoveryDb) ?? "{}");

    expect(recovery.status).toBeUndefined();
    expect(recoveryMetadata).toMatchObject({
      alertingCoinCount: 0,
      candidateCoinCount: 0,
      clearedCandidateCount: 1,
    });
    expect(recoveryWrite.candidates).toBeUndefined();
    expect(recoveryWrite.pendingAlert).toBeUndefined();
  });

  it("alerts on sustained 3-of-4 route removal and then clears through the pending-alert run", async () => {
    const firstDb = watchdogDb(
      [publishedRow("coin-a", routes("route-a"))],
      previousSnapshot([{ stablecoinId: "coin-a", routes: routes("route-a", "route-b", "route-c", "route-d") }]),
      CURRENT_GENERATION,
    );
    const first = await runDexExitRouteTurnoverWatchdog(firstDb);
    expect(first.status).toBeUndefined();
    expect(JSON.parse(String(first.metadata))).toMatchObject({ candidateCoinCount: 1 });

    const secondDb = watchdogDb(
      [publishedRow("coin-a", routes("route-a"))],
      lastSnapshotWrite(firstDb),
      SUSTAINED_GENERATION,
    );
    const second = await runDexExitRouteTurnoverWatchdog(secondDb);
    const secondMetadata = JSON.parse(String(second.metadata));
    expect(second.status).toBe("degraded");
    expect(secondMetadata.worstOffenders[0]).toMatchObject({
      stablecoinId: "coin-a",
      previousRouteCount: 4,
      currentRouteCount: 1,
      removedRouteCount: 3,
      jaccardDistance: 0.75,
    });

    const thirdDb = watchdogDb(
      [publishedRow("coin-a", routes("route-a"))],
      lastSnapshotWrite(secondDb),
      AFTER_GENERATION,
    );
    const third = await runDexExitRouteTurnoverWatchdog(thirdDb);
    const thirdMetadata = JSON.parse(String(third.metadata));
    expect(third.status).toBe("degraded");
    expect(thirdMetadata).toMatchObject({
      alertingCoinCount: 0,
      pendingAlertCleared: true,
      reason: "dex-route-turnover-pending-alert",
    });
    expect(JSON.parse(lastSnapshotWrite(thirdDb) ?? "{}").pendingAlert).toBeUndefined();
  });

  it("does not alert on single-route flaps of tiny route sets, even a lone route briefly vanishing", async () => {
    const flapDb = watchdogDb(
      [
        publishedRow("coin-a", routes("route-a", "route-b")),
        publishedRow("coin-b", []),
      ],
      previousSnapshot([
        { stablecoinId: "coin-a", routes: routes("route-a") },
        { stablecoinId: "coin-b", routes: routes("route-a") },
      ]),
      CURRENT_GENERATION,
    );
    const flap = await runDexExitRouteTurnoverWatchdog(flapDb);
    const flapMetadata = JSON.parse(String(flap.metadata));

    expect(flap.status).toBeUndefined();
    expect(flapMetadata).toMatchObject({
      changedCoinCount: 2,
      highestObservedTurnover: 1,
      alertingCoinCount: 0,
      candidateCoinCount: 1,
    });

    const backDb = watchdogDb(
      [
        publishedRow("coin-a", routes("route-a")),
        publishedRow("coin-b", routes("route-a")),
      ],
      lastSnapshotWrite(flapDb),
      RECOVERY_GENERATION,
    );
    const back = await runDexExitRouteTurnoverWatchdog(backDb);

    expect(back.status).toBeUndefined();
    expect(JSON.parse(String(back.metadata))).toMatchObject({
      alertingCoinCount: 0,
      candidateCoinCount: 0,
    });
  });

  it("never alerts on sustained pure route additions, including a coin gaining its first routes", async () => {
    // A discovery refresh can revive staged CoinGecko evidence wholesale: the
    // coin's published route set grows (Jaccard distance 1.0 from empty, or
    // past 0.5 on top of existing routes) without a single route being
    // removed. Coverage gains are not exit-route turnover and must not
    // degrade the sentinel even when sustained.
    const firstDb = watchdogDb(
      [
        publishedRow("coin-a", routes("route-a", "route-b", "route-c")),
        publishedRow("coin-b", routes("route-x", "route-y")),
      ],
      previousSnapshot([
        { stablecoinId: "coin-a", routes: routes("route-a") },
        { stablecoinId: "coin-b", routes: [] },
      ]),
      CURRENT_GENERATION,
    );
    const first = await runDexExitRouteTurnoverWatchdog(firstDb);
    const firstWrite = JSON.parse(lastSnapshotWrite(firstDb) ?? "{}");

    expect(first.status).toBeUndefined();
    expect(JSON.parse(String(first.metadata))).toMatchObject({
      alertingCoinCount: 0,
      candidateCoinCount: 0,
      highestObservedTurnover: 1,
    });
    expect(firstWrite.candidates).toBeUndefined();
    // No candidate holds the baseline, so it advances to the grown route set.
    expect(firstWrite.coins).toEqual(expect.arrayContaining([
      expect.objectContaining({
        stablecoinId: "coin-a",
        routes: ["route-a", "route-b", "route-c"].map((routeId) =>
          expect.objectContaining({ routeId })),
      }),
    ]));

    const secondDb = watchdogDb(
      [
        publishedRow("coin-a", routes("route-a", "route-b", "route-c")),
        publishedRow("coin-b", routes("route-x", "route-y")),
      ],
      lastSnapshotWrite(firstDb),
      SUSTAINED_GENERATION,
    );
    const second = await runDexExitRouteTurnoverWatchdog(secondDb);

    expect(second.status).toBeUndefined();
    expect(JSON.parse(String(second.metadata))).toMatchObject({
      alertingCoinCount: 0,
      candidateCoinCount: 0,
    });
    expect(JSON.parse(lastSnapshotWrite(secondDb) ?? "{}").pendingAlert).toBeUndefined();
  });

  it("never alerts on a sustained one-for-one route swap of a single-route coin", async () => {
    // A lane substitution replaces a coin's only route with an equivalent one
    // (Jaccard distance 1.0, one removed and one added). Exit capacity
    // exists either way, so the swap stays metadata-only even when the
    // replacement persists.
    const firstDb = watchdogDb(
      [publishedRow("coin-a", routes("route-new"))],
      previousSnapshot([{ stablecoinId: "coin-a", routes: routes("route-old") }]),
      CURRENT_GENERATION,
    );
    const first = await runDexExitRouteTurnoverWatchdog(firstDb);

    expect(first.status).toBeUndefined();
    expect(JSON.parse(String(first.metadata))).toMatchObject({
      alertingCoinCount: 0,
      candidateCoinCount: 0,
      highestObservedTurnover: 1,
    });
    expect(JSON.parse(lastSnapshotWrite(firstDb) ?? "{}").candidates).toBeUndefined();

    const secondDb = watchdogDb(
      [publishedRow("coin-a", routes("route-new"))],
      lastSnapshotWrite(firstDb),
      SUSTAINED_GENERATION,
    );
    const second = await runDexExitRouteTurnoverWatchdog(secondDb);

    expect(second.status).toBeUndefined();
    expect(JSON.parse(String(second.metadata))).toMatchObject({
      alertingCoinCount: 0,
      candidateCoinCount: 0,
    });
  });

  it.each([[["route-a"]], [["route-a", "route-b"]]])("treats a coin losing all %j routes as complete turnover only when sustained", async (lost) => {
    const firstDb = watchdogDb(
      [],
      previousSnapshot([{ stablecoinId: "coin-a", routes: routes(...lost) }]),
      CURRENT_GENERATION,
    );
    const first = await runDexExitRouteTurnoverWatchdog(firstDb);
    expect(first.status).toBeUndefined();
    expect(JSON.parse(String(first.metadata))).toMatchObject({ candidateCoinCount: 1 });

    const secondDb = watchdogDb(
      [],
      lastSnapshotWrite(firstDb),
      SUSTAINED_GENERATION,
    );
    const second = await runDexExitRouteTurnoverWatchdog(secondDb);
    const metadata = JSON.parse(String(second.metadata));

    expect(second.status).toBe("degraded");
    expect(metadata.worstOffenders[0]).toMatchObject({
      stablecoinId: "coin-a",
      previousRouteCount: lost.length,
      currentRouteCount: 0,
      jaccardDistance: 1,
      removedRouteCount: lost.length,
    });
  });

  it("skips a rerun against the same published generation without touching state", async () => {
    const db = watchdogDb(
      [publishedRow("coin-a", routes("route-a", "route-b", "route-e", "route-f"))],
      previousSnapshot(
        [{ stablecoinId: "coin-a", routes: routes("route-a", "route-b", "route-c", "route-d") }],
        { generationId: CURRENT_GENERATION },
      ),
      CURRENT_GENERATION,
      { allowUnusedWrite: true },
    );

    const result = await runDexExitRouteTurnoverWatchdog(db);

    expect(result.status).toBe("skipped_neutral");
    expect(JSON.parse(String(result.metadata))).toMatchObject({
      reason: "no-new-published-dex-generation",
    });
    expect(db.getHistory().some((entry) => entry.sql.includes("INSERT OR REPLACE INTO cache"))).toBe(false);
  });
});
