import { beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";

import type { DexExitEvidenceKind, ExitRouteObservationCoverage } from "@shared/types/exit-route";
import { createLatestSchemaSqlite } from "@shared/test-utils/latest-schema-sqlite";
import { OPERATOR_ALERT_RECEIPT_KEYS } from "../../../lib/status/operator-alert-health";
import { mockD1 } from "@shared/test-utils/mock-d1";
import {
  DEX_EXIT_ROUTE_TURNOVER_ALERT_STATE_CACHE_KEY as ALERT_STATE_KEY,
  DEX_EXIT_ROUTE_TURNOVER_ALERT_THRESHOLD,
  DEX_EXIT_ROUTE_TURNOVER_SNAPSHOT_CACHE_KEY as SNAPSHOT_KEY,
  runDexExitRouteTurnoverWatchdog,
} from "../../dex-exit-route-turnover-watchdog";

const sendToChatMock = vi.hoisted(() => vi.fn(async (..._args: unknown[]) => ({ ok: true })));
vi.mock("../../../telegram/delivery/telegram", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../telegram/delivery/telegram")>()),
  sendToChat: sendToChatMock,
}));

const CURRENT = "dex-liquidity-current";
const PREVIOUS = "dex-liquidity-previous";
const RECOVERY = "dex-liquidity-recovery";
const SUSTAINED = "dex-liquidity-sustained";
const AFTER = "dex-liquidity-after";
const LEGACY_SNAPSHOT_KEY = "dex-exit-route-turnover-watchdog:snapshot:v1";
const OUTPUT_ASSET_KEY = "ethereum:0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48";

function canonicalRouteId(poolId: string) {
  return JSON.stringify([`ethereum:${poolId}`, [OUTPUT_ASSET_KEY]]);
}

function observation(routeId: string, evidenceKind: DexExitEvidenceKind = "reserve-based-amm-simulation", poolId = routeId) {
  return {
    routeId,
    routeFamily: "dex-amm",
    scope: {
      kind: "chain-contract",
      chain: "Ethereum",
      contractOrPoolId: poolId,
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
      assetKeys: [OUTPUT_ASSET_KEY],
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
  routes: Array<{ routeId: string; evidenceKind?: DexExitEvidenceKind; poolId?: string }>,
  coverageStatus: ExitRouteObservationCoverage["status"] = "populated",
  coverageOverrides: Partial<ExitRouteObservationCoverage> = {},
) {
  return {
    stablecoin_id: stablecoinId,
    score_components_json: JSON.stringify({
      exitRouteObservations: routes.map((route) => observation(route.routeId, route.evidenceKind, route.poolId)),
      exitRouteObservationCoverage: {
        status: coverageStatus,
        capabilityMatrixVersion: "test",
        retainedPoolCount: routes.length,
        observationCount: routes.length,
        scoreEligibleObservationCount: routes.length,
        unsupportedPoolCount: 0,
        evidenceCounts: {},
        unsupportedReasons: {},
        ...coverageOverrides,
      },
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
  const generationId = options.generationId ?? PREVIOUS;
  return JSON.stringify({
    schemaVersion: 1,
    generationId,
    coins: coins.map((coin) => ({
      stablecoinId: coin.stablecoinId,
      routes: coin.routes.map((route) => ({
        routeId: canonicalRouteId(route.routeId),
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
  generationId: string = CURRENT,
  options: { alertStateValue?: string | null; legacyValue?: string } = {},
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
      matchBinds: [SNAPSHOT_KEY],
      rows: [],
      first: previousValue === null ? null : { value: previousValue, updated_at: 1_000 },
    },
    {
      match: "SELECT value, updated_at FROM cache WHERE key = ?",
      matchBinds: [LEGACY_SNAPSHOT_KEY],
      rows: [],
      first: options.legacyValue === undefined ? null : { value: options.legacyValue, updated_at: 1_000 },
    },
    {
      match: "SELECT value, updated_at FROM cache WHERE key = ?",
      matchBinds: [ALERT_STATE_KEY],
      rows: [],
      first: options.alertStateValue == null ? null : { value: options.alertStateValue, updated_at: 1_000 },
    },
    {
      match: "SELECT value, updated_at FROM cache WHERE key = ?",
      matchBinds: [OPERATOR_ALERT_RECEIPT_KEYS.turnover],
      rows: [],
    },
    {
      match: "INSERT INTO cache",
      rows: [],
      runMeta: { changes: 1 },
    },
  ], { assertMatchesUsed: true });
}

function lastSnapshotWrite(db: { getHistory: () => Array<{ sql: string; binds: unknown[] }> }): string | null {
  const writes = db.getHistory().filter((entry) => entry.sql.includes("INSERT INTO cache")
    && entry.binds[0] === SNAPSHOT_KEY);
  const value = writes[writes.length - 1]?.binds[1];
  return typeof value === "string" ? value : null;
}

function snapshotOf(db: Parameters<typeof lastSnapshotWrite>[0]) {
  return JSON.parse(lastSnapshotWrite(db) ?? "{}");
}
function metadataOf(result: { metadata?: string }) {
  return JSON.parse(String(result.metadata));
}

function lossDb(previousValue = previousSnapshot([
  { stablecoinId: "coin-a", routes: routes("route-a", "route-b", "route-c", "route-d") },
]), generationId = CURRENT) {
  return watchdogDb([publishedRow("coin-a", routes("route-a"))], previousValue, generationId);
}

function sqliteWatchdogReplay() {
  const { db, sqlite } = createLatestSchemaSqlite();
  onTestFinished(() => { sqlite.close(); vi.restoreAllMocks(); });
  const read = (key: string) => JSON.parse(String(sqlite.prepare("SELECT value FROM cache WHERE key = ?").get(key)?.value ?? "null"));
  const write = (key: string, value: unknown) =>
    sqlite.prepare("INSERT OR REPLACE INTO cache (key, value, updated_at) VALUES (?, ?, 1)").run(key, JSON.stringify(value));
  const publish = (id: string, remaining: string[]) => {
    sqlite.exec("UPDATE dex_liquidity_publication_generations SET state = 'staged'");
    sqlite.prepare(`INSERT INTO dex_liquidity_publication_generations
      (generation_id, started_at, state, expected_row_count, created_at, published_at)
      VALUES (?, 1, 'published', 1, 1, 1)`).run(id);
    sqlite.prepare(`INSERT INTO dex_liquidity_run_rows
      (generation_id, stablecoin_id, symbol, updated_at, score_components_json)
      VALUES (?, 'coin-a', 'A', 1, ?)`).run(id, publishedRow("coin-a", routes(...remaining)).score_components_json);
  };
  const run = (configured = true) => runDexExitRouteTurnoverWatchdog(db, undefined, {
    operatorTelegramCreds: configured ? { botToken: "bot-token", chatId: "ops-chat" } : null,
  });
  const legacyPendingOnRollback = () => read(ALERT_STATE_KEY)?.active ? undefined : read(LEGACY_SNAPSHOT_KEY)?.pendingAlert;
  return { sqlite, read, write, publish, run, legacyPendingOnRollback };
}

const legacyBaseline = {
  schemaVersion: 1, generationId: PREVIOUS,
  coins: [{ stablecoinId: "coin-a", routes: [{ routeId: "old-source-id", evidenceKind: "reserve-based-amm-simulation" }] }],
};

describe("DEX exit-route turnover watchdog", () => {
  beforeEach(() => {
    sendToChatMock.mockClear();
    sendToChatMock.mockResolvedValue({ ok: true });
  });
  it("stays healthy when the published route set does not turn over", async () => {
    const coinRoutes = routes("route-a", "route-b");
    const result = await runDexExitRouteTurnoverWatchdog(watchdogDb(
      [publishedRow("coin-a", coinRoutes)],
      previousSnapshot([{ stablecoinId: "coin-a", routes: coinRoutes }]),
    ));

    expect(result.status).toBe("ok");
    expect(metadataOf(result)).toMatchObject({
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

    const metadata = metadataOf(result);
    expect(result.status).toBe("ok");
    expect(metadata.highestObservedTurnover).toBe(0.4);
    expect(metadata.changedCoinCount).toBe(1);
    expect(metadata.evidenceKindChangedRouteCount).toBe(1);
    expect(metadata.alertingCoinCount).toBe(0);
    expect(metadata.candidateCoinCount).toBe(0);
  });

  it("opens a candidate instead of alerting when the snapshot has none", async () => {
    const db = watchdogDb(
      [publishedRow("coin-a", routes("route-a", "route-b", "route-e", "route-f"))],
      previousSnapshot([{ stablecoinId: "coin-a", routes: routes("route-a", "route-b", "route-c", "route-d") }]),
    );

    const result = await runDexExitRouteTurnoverWatchdog(db);
    const metadata = metadataOf(result);
    const write = snapshotOf(db);

    expect(result.status).toBe("ok");
    expect(metadata.baselineCreated).toBe(false);
    expect(metadata.comparedCoinCount).toBe(1);
    expect(metadata.alertingCoinCount).toBe(0);
    expect(metadata.candidateCoinCount).toBe(1);
    expect(metadata.candidates[0]).toMatchObject({
      stablecoinId: "coin-a",
      generationId: CURRENT,
      jaccardDistance: 0.666667,
      addedRouteCount: 2,
      removedRouteCount: 2,
    });
    expect(write.coins[0].routes.map((route: { routeId: string }) => route.routeId))
      .toEqual(["route-a", "route-b", "route-c", "route-d"].map(canonicalRouteId));
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
    const metadata = metadataOf(result);
    const write = snapshotOf(db);

    expect(result.status).toBe("ok");
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
    expect(write.coins[0].routes.map((route: { routeId: string }) => route.routeId))
      .toEqual(["route-a", "route-b", "route-e", "route-f"].map(canonicalRouteId));
    expect(write.candidates).toBeUndefined();
    expect(write.pendingAlert.worstOffenders[0]).toMatchObject({ stablecoinId: "coin-a" });
  });

  it("creates a baseline without alerting on the first-ever run", async () => {
    const db = watchdogDb(
      [publishedRow("coin-a", routes("route-a"))],
      null,
    );

    const result = await runDexExitRouteTurnoverWatchdog(db);
    const metadata = metadataOf(result);
    const write = db.getHistory().find((entry) => entry.sql.includes("INSERT INTO cache"));

    expect(result.status).toBe("ok");
    expect(metadata).toMatchObject({
      baselineCreated: true,
      previousGenerationId: null,
      alertingCoinCount: 0,
    });
    expect(JSON.parse(String(write?.binds[1])).coins[0].routes[0].routeId).toBe(canonicalRouteId("route-a"));
    expect(String(write?.binds[1])).not.toContain("requestedNotionalUsd");
  });

  it("re-baselines legacy route IDs without discarding an undelivered historical alert", async () => {
    const pendingAlert = { generationId: PREVIOUS, threshold: 0.5, worstOffenders: [{ stablecoinId: "coin-a", jaccardDistance: 1 }] };
    const legacyValue = JSON.stringify({
      schemaVersion: 1, generationId: PREVIOUS, pendingAlert,
      coins: [{ stablecoinId: "coin-a", routes: [{ routeId: "old-source-id", evidenceKind: "reserve-based-amm-simulation" }] }],
    });
    const db = watchdogDb([publishedRow("coin-a", routes("route-a"))], null, CURRENT, { legacyValue });
    const result = await runDexExitRouteTurnoverWatchdog(db);
    expect(metadataOf(result)).toMatchObject({ rebasedLegacySnapshot: true, comparedCoinCount: 0, candidateCoinCount: 0 });
    expect(snapshotOf(db)).toMatchObject({
      coins: [{ stablecoinId: "coin-a", routes: [{ routeId: canonicalRouteId("route-a") }] }],
      pendingAlert,
    });
  });

  it("treats two provider replacements as the same physical pool and output", async () => {
    const previous = previousSnapshot([{ stablecoinId: "coin-a", routes: routes("route-a", "route-b", "route-c") }]);
    const current = publishedRow("coin-a", [
      { routeId: "provider-two-a", poolId: "Ethereum:ROUTE-A", evidenceKind: "measured-executable-depth" },
      { routeId: "provider-two-b", poolId: "route-b" },
      { routeId: "route-c" },
    ]);
    const db = watchdogDb([current], previous);
    const first = await runDexExitRouteTurnoverWatchdog(db);
    expect(metadataOf(first)).toMatchObject({
      comparedCoinCount: 1, candidateCoinCount: 0, highestObservedTurnover: 0, evidenceKindChangedRouteCount: 1,
    });
    const second = await runDexExitRouteTurnoverWatchdog(watchdogDb([current], lastSnapshotWrite(db), SUSTAINED));
    expect(metadataOf(second)).toMatchObject({ alertingCoinCount: 0 });
  });

  it.each(["unknown", "unsupported"] as const)("retains the baseline without confirming loss through %s coverage", async (status) => {
    const baseline = previousSnapshot([{ stablecoinId: "coin-a", routes: routes("route-a") }]);
    const candidateDb = watchdogDb([publishedRow("coin-a", [])], baseline, CURRENT);
    expect(metadataOf(await runDexExitRouteTurnoverWatchdog(candidateDb)).candidateCoinCount).toBe(1);
    let previous = lastSnapshotWrite(candidateDb);
    for (const generation of [SUSTAINED, AFTER]) {
      const gapDb = watchdogDb([publishedRow("coin-a", [], status)], previous, generation);
      const gap = await runDexExitRouteTurnoverWatchdog(gapDb);
      expect(metadataOf(gap)).toMatchObject({
        comparedCoinCount: 0, candidateCoinCount: 0, alertingCoinCount: 0,
        coverageGapCoinCount: 1, coverageGapReasons: { [`coverage-${status}`]: 1 },
      });
      expect(snapshotOf(gapDb).coins).toEqual(JSON.parse(baseline).coins);
      previous = lastSnapshotWrite(gapDb);
    }
    const recoveryDb = watchdogDb([publishedRow("coin-a", [])], previous, RECOVERY);
    expect(metadataOf(await runDexExitRouteTurnoverWatchdog(recoveryDb))).toMatchObject({
      comparedCoinCount: 1, candidateCoinCount: 1, alertingCoinCount: 0,
    });
  });

  it.each([
    "executionCapabilityGate:measured-execution:quote-failed",
    "executionCapabilityGate:measured-execution:target-unresolved",
    "executionCapabilityGate:measured-execution:quote-missing",
    "executionCapabilityGate:measured-execution:budget-deferred",
    "executionCapabilityGate:measured-execution:generation-mismatch",
    "executionCapabilityGate:measured-execution:stale-observation",
    "executionCapabilityGate:curve-stableswap:transport-unavailable",
  ])("does not count two partial outages as sustained turnover (%s)", async (reason) => {
    const baseline = previousSnapshot([{ stablecoinId: "coin-a", routes: routes("route-a", "route-b", "route-c") }]);
    const partial = publishedRow("coin-a", routes("route-a"), "populated", {
      retainedPoolCount: 3, unsupportedPoolCount: 2, unsupportedReasons: { [reason]: 2 },
    });
    let previous: string | null = baseline;
    for (const generation of [CURRENT, SUSTAINED]) {
      const db = watchdogDb([partial], previous, generation);
      expect(metadataOf(await runDexExitRouteTurnoverWatchdog(db))).toMatchObject({
        comparedCoinCount: 0, candidateCoinCount: 0, alertingCoinCount: 0,
        coverageGapCoinCount: 1, coverageGapReasons: { [reason]: 1 },
      });
      expect(snapshotOf(db).coins).toEqual(JSON.parse(baseline).coins);
      expect(snapshotOf(db).pendingAlert).toBeUndefined();
      previous = lastSnapshotWrite(db);
    }

    const certifiedEmpty = publishedRow("coin-a", [], "populated", {
      unsupportedReasons: { deploymentCensusUnsupportedMethod: 1 },
    });
    const nextDb = watchdogDb([certifiedEmpty], previous, AFTER);
    expect(metadataOf(await runDexExitRouteTurnoverWatchdog(nextDb))).toMatchObject({
      comparedCoinCount: 1, candidateCoinCount: 1, alertingCoinCount: 0,
    });
  });

  it("never alerts on a one-generation lane blip that vanishes and returns", async () => {
    const coinRoutes = routes("route-a", "route-b", "route-c", "route-d");

    const blipDb = watchdogDb(
      [publishedRow("coin-a", [])],
      previousSnapshot([{ stablecoinId: "coin-a", routes: coinRoutes }]),
      CURRENT,
    );
    const blip = await runDexExitRouteTurnoverWatchdog(blipDb);
    const blipMetadata = metadataOf(blip);

    expect(blip.status).toBe("ok");
    expect(blipMetadata).toMatchObject({
      changedCoinCount: 1,
      highestObservedTurnover: 1,
      alertingCoinCount: 0,
      candidateCoinCount: 1,
    });

    const recoveryDb = watchdogDb(
      [publishedRow("coin-a", coinRoutes)],
      lastSnapshotWrite(blipDb),
      RECOVERY,
    );
    const recovery = await runDexExitRouteTurnoverWatchdog(recoveryDb);
    const recoveryMetadata = metadataOf(recovery);
    const recoveryWrite = snapshotOf(recoveryDb);

    expect(recovery.status).toBe("ok");
    expect(recoveryMetadata).toMatchObject({
      alertingCoinCount: 0,
      candidateCoinCount: 0,
      clearedCandidateCount: 1,
    });
    expect(recoveryWrite.candidates).toBeUndefined();
    expect(recoveryWrite.pendingAlert).toBeUndefined();
  });

  it("retains sustained 3-of-4 route removal without credentials after comparison advances", async () => {
    const firstDb = lossDb();
    const first = await runDexExitRouteTurnoverWatchdog(firstDb);
    expect(first.status).toBe("ok");
    expect(metadataOf(first)).toMatchObject({ candidateCoinCount: 1 });

    const secondDb = lossDb(lastSnapshotWrite(firstDb)!, SUSTAINED);
    const second = await runDexExitRouteTurnoverWatchdog(secondDb);
    const secondMetadata = metadataOf(second);
    expect(second.status).toBe("ok");
    expect(secondMetadata.worstOffenders[0]).toMatchObject({
      stablecoinId: "coin-a",
      previousRouteCount: 4,
      currentRouteCount: 1,
      removedRouteCount: 3,
      jaccardDistance: 0.75,
    });

    const thirdDb = lossDb(lastSnapshotWrite(secondDb)!, AFTER);
    const third = await runDexExitRouteTurnoverWatchdog(thirdDb);
    const thirdMetadata = metadataOf(third);
    expect(third.status).toBe("ok");
    expect(thirdMetadata).toMatchObject({
      alertingCoinCount: 0,
      pendingAlertCleared: false,
    });
    expect(thirdMetadata.reason).toBeUndefined();
    expect(thirdMetadata.quality).toBeUndefined();
    expect(secondMetadata.quality).toEqual({ reason: "dex-route-turnover-threshold" });
    expect(snapshotOf(thirdDb).pendingAlert)
      .toEqual(snapshotOf(secondDb).pendingAlert);
  });

  it("pages the operator once per sustained turnover episode", async () => {
    const creds = { botToken: "bot-token", chatId: "ops-chat" };
    const firstDb = lossDb();
    await runDexExitRouteTurnoverWatchdog(firstDb, undefined, { operatorTelegramCreds: creds });
    expect(sendToChatMock).not.toHaveBeenCalled();

    const secondDb = lossDb(lastSnapshotWrite(firstDb)!, SUSTAINED);
    const second = await runDexExitRouteTurnoverWatchdog(secondDb, undefined, { operatorTelegramCreds: creds });
    expect(sendToChatMock).toHaveBeenCalledTimes(1);
    expect(String(sendToChatMock.mock.calls[0]?.[1])).toContain("sync-dex-liquidity");
    expect(String(sendToChatMock.mock.calls[0]?.[1])).toContain(SUSTAINED);
    expect(metadataOf(second).operatorAlert).toEqual({
      episodeActive: true, sent: true, deliveryFailed: false,
    });

    const acknowledged = {
      alertStateValue: JSON.stringify({ active: true, generationId: SUSTAINED, sentAtSec: 2_000 }),
    };
    const thirdDb = watchdogDb(
      [publishedRow("coin-a", [])],
      lastSnapshotWrite(secondDb),
      AFTER,
      acknowledged,
    );
    const third = await runDexExitRouteTurnoverWatchdog(thirdDb, undefined, { operatorTelegramCreds: creds });
    expect(sendToChatMock).toHaveBeenCalledTimes(1);
    expect(metadataOf(third)).toMatchObject({
      alertingCoinCount: 0,
      operatorAlert: { episodeActive: false, sent: false },
    });

    const pendingSnapshot = String(secondDb.getHistory().find((entry) => entry.sql.includes("INSERT") && entry.binds[0] === SNAPSHOT_KEY)?.binds[1]);
    const rerunDb = watchdogDb(
      [publishedRow("coin-a", routes("route-a"))],
      pendingSnapshot,
      SUSTAINED,
      acknowledged,
    );
    const rerun = await runDexExitRouteTurnoverWatchdog(rerunDb, undefined, { operatorTelegramCreds: creds });
    expect(rerun.status).toBe("skipped_neutral");
    expect(snapshotOf(rerunDb).pendingAlert).toBeUndefined();
    expect(sendToChatMock).toHaveBeenCalledTimes(1);

    const laterDb = watchdogDb(
      [publishedRow("coin-a", [])],
      lastSnapshotWrite(thirdDb),
      "dex-liquidity-later",
    );
    const later = await runDexExitRouteTurnoverWatchdog(laterDb, undefined, { operatorTelegramCreds: creds });
    expect(sendToChatMock).toHaveBeenCalledTimes(2);
    expect(metadataOf(later).operatorAlert).toMatchObject({
      episodeActive: true,
      sent: true,
    });
  });

  it.each([false, true])("replays original failed delivery through newer, duplicate, absent and recovered observations (recover=%s)", async (recover) => {
    const { sqlite, read, publish, run } = sqliteWatchdogReplay();
    const clock = vi.spyOn(Date, "now").mockReturnValue(1_800_000_000_000);
    const snapshot = () => read(SNAPSHOT_KEY);
    const receipt = () => read(OPERATOR_ALERT_RECEIPT_KEYS.turnover);
    for (const [id, remaining] of [
      [PREVIOUS, ["a", "b", "c", "d"]], [CURRENT, ["a"]],
    ] as const) {
      publish(id, [...remaining]);
      await run(false);
      expect(receipt()).toMatchObject({ version: 1, producer: "turnover", pendingSince: null, operatorConfigured: false });
    }
    publish(SUSTAINED, ["a"]);
    sendToChatMock.mockImplementation(async () => {
      expect(snapshot().pendingAlert.generationId).toBe(SUSTAINED);
      expect(read(LEGACY_SNAPSHOT_KEY).pendingAlert).toEqual(snapshot().pendingAlert);
      expect(receipt().pendingSince).toBe(1_800_000_000);
      return { ok: false };
    });
    const failed = await run();
    expect(failed.status).toBe("degraded");
    expect(metadataOf(failed)).toMatchObject({
      reason: "operator-alert-delivery-failed",
      operatorAlert: { episodeActive: true, sent: false, deliveryFailed: true, deliveryErrorClass: "unknown" },
    });
    const original = snapshot().pendingAlert;
    const pendingReceipt = receipt();
    const update = sqlite.prepare("UPDATE cache SET value = ? WHERE key = ?");
    for (const key of [SNAPSHOT_KEY, LEGACY_SNAPSHOT_KEY, ALERT_STATE_KEY]) {
      const stored = sqlite.prepare("SELECT value FROM cache WHERE key = ?").get(key);
      sqlite.prepare("INSERT OR REPLACE INTO cache (key, value, updated_at) VALUES (?, ?, 1)").run(key, "{");
      await expect(run()).rejects.toThrow("Invalid DEX exit-route turnover");
      expect(receipt()).toEqual(pendingReceipt);
      expect(sqlite.prepare("SELECT value FROM cache WHERE key = ?").get(key)?.value).toBe("{");
      if (stored) update.run(stored.value, key);
      else sqlite.prepare("DELETE FROM cache WHERE key = ?").run(key);
    }
    expect(sendToChatMock).toHaveBeenCalledTimes(1);
    for (const id of [AFTER, null, RECOVERY]) {
      clock.mockReturnValue(Date.now() + 60_000);
      if (id) publish(id, recover ? ["a", "b", "c", "d"] : []);
      else sqlite.exec("UPDATE dex_liquidity_publication_generations SET state = 'staged'");
      let calls = sendToChatMock.mock.calls.length;
      for (const [index, configured] of [true, false, true].entries()) {
        const result = await run(configured);
        if (configured) calls++;
        expect(sendToChatMock).toHaveBeenCalledTimes(calls);
        expect(snapshot().pendingAlert).toEqual(original);
        expect(receipt()).toMatchObject({
          pendingSince: 1_800_000_000, lastDeliveredAt: null,
          reason: configured ? "operator-alert-delivery-failed" : "operator-alert-credentials-missing",
        });
        if (id === RECOVERY && !recover && index === 0) {
          expect(metadataOf(result).alertingCoinCount).toBe(1);
        }
      }
      if (id) expect(snapshot().generationId).toBe(id);
    }
    sendToChatMock.mockResolvedValue({ ok: true });
    const callsBeforeAcceptance = sendToChatMock.mock.calls.length;
    const accepted = await run();
    expect(read(ALERT_STATE_KEY)).toEqual({ active: true, generationId: SUSTAINED, sentAtSec: Date.now() / 1000 });
    expect(sendToChatMock).toHaveBeenCalledTimes(callsBeforeAcceptance + 1);
    expect(metadataOf(accepted).operatorAlert).toEqual({
      episodeActive: true, sent: true, deliveryFailed: false,
    });
    expect(sendToChatMock.mock.calls.every((call) => String(call[1]).includes(SUSTAINED)
      && String(call[1]).includes("Historical published event"))).toBe(true);
    expect(snapshot().pendingAlert).toBeUndefined();
    expect(receipt()).toMatchObject({ pendingSince: null, lastDeliveredAt: Date.now() / 1000 });
    const calls = sendToChatMock.mock.calls.length;
    await run();
    expect(sendToChatMock).toHaveBeenCalledTimes(calls);
    publish("quiet", recover ? ["a", "b", "c", "d"] : []);
    await run();
    expect(sendToChatMock).toHaveBeenCalledTimes(calls);
  });

  it("clears a delivered v1 alert before episode reset so rollback cannot resend it", async () => {
    const { sqlite, read, write, publish, run, legacyPendingOnRollback } = sqliteWatchdogReplay();
    const pendingAlert = { generationId: PREVIOUS, threshold: 0.5, worstOffenders: [{ stablecoinId: "coin-a", jaccardDistance: 1 }] };
    write(LEGACY_SNAPSHOT_KEY, { ...legacyBaseline, pendingAlert });
    sqlite.exec(`CREATE TRIGGER reject_turnover_reset_with_pending BEFORE UPDATE ON cache
      WHEN NEW.key = '${ALERT_STATE_KEY}' AND json_extract(NEW.value, '$.active') = 0
        AND EXISTS (SELECT 1 FROM cache WHERE key IN ('${SNAPSHOT_KEY}', '${LEGACY_SNAPSHOT_KEY}')
          AND json_type(value, '$.pendingAlert') IS NOT NULL)
      BEGIN SELECT RAISE(ABORT, 'turnover reset with pending alert'); END`);

    publish(CURRENT, ["a"]);
    await run();
    expect(sendToChatMock).toHaveBeenCalledTimes(1);
    expect(read(ALERT_STATE_KEY).active).toBe(true);
    expect(read(LEGACY_SNAPSHOT_KEY)).toEqual(legacyBaseline);
    expect(read(SNAPSHOT_KEY).pendingAlert).toBeUndefined();
    publish(RECOVERY, ["a"]);
    await run();
    expect(read(ALERT_STATE_KEY).active).toBe(false);
    expect(legacyPendingOnRollback()).toBeUndefined();
    expect(sendToChatMock).toHaveBeenCalledTimes(1);
  });

  it("makes an undelivered v2 alert readable on rollback and honors acknowledgement by v1", async () => {
    const { read, write, publish, run, legacyPendingOnRollback } = sqliteWatchdogReplay();
    write(LEGACY_SNAPSHOT_KEY, legacyBaseline);
    for (const [id, remaining] of [[PREVIOUS, ["a", "b", "c"]], [CURRENT, ["a"]], [SUSTAINED, ["a"]]] as const) {
      publish(id, [...remaining]);
      await run(false);
    }
    const pending = read(SNAPSHOT_KEY).pendingAlert;
    expect(pending.generationId).toBe(SUSTAINED);
    expect(legacyPendingOnRollback()).toEqual(pending);
    expect(read(LEGACY_SNAPSHOT_KEY)).toEqual({ ...legacyBaseline, pendingAlert: pending });

    write(LEGACY_SNAPSHOT_KEY, legacyBaseline);
    write(ALERT_STATE_KEY, { active: false, generationId: null, sentAtSec: null });
    await run();
    expect(read(SNAPSHOT_KEY).pendingAlert).toBeUndefined();
    expect(sendToChatMock).not.toHaveBeenCalled();
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
      CURRENT,
    );
    const flap = await runDexExitRouteTurnoverWatchdog(flapDb);
    const flapMetadata = metadataOf(flap);

    expect(flap.status).toBe("ok");
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
      RECOVERY,
    );
    const back = await runDexExitRouteTurnoverWatchdog(backDb);

    expect(back.status).toBe("ok");
    expect(metadataOf(back)).toMatchObject({
      alertingCoinCount: 0,
      candidateCoinCount: 0,
    });
  });

  it("never alerts on sustained pure route additions, including a coin gaining its first routes", async () => {
    const firstDb = watchdogDb(
      [
        publishedRow("coin-a", routes("route-a", "route-b", "route-c")),
        publishedRow("coin-b", routes("route-x", "route-y")),
      ],
      previousSnapshot([
        { stablecoinId: "coin-a", routes: routes("route-a") },
        { stablecoinId: "coin-b", routes: [] },
      ]),
      CURRENT,
    );
    const first = await runDexExitRouteTurnoverWatchdog(firstDb);
    const firstWrite = snapshotOf(firstDb);

    expect(first.status).toBe("ok");
    expect(metadataOf(first)).toMatchObject({
      alertingCoinCount: 0,
      candidateCoinCount: 0,
      highestObservedTurnover: 1,
    });
    expect(firstWrite.candidates).toBeUndefined();
    expect(firstWrite.coins).toEqual(expect.arrayContaining([
      expect.objectContaining({
        stablecoinId: "coin-a",
        routes: ["route-a", "route-b", "route-c"].map((poolId) =>
          expect.objectContaining({ routeId: canonicalRouteId(poolId) })),
      }),
    ]));

    const secondDb = watchdogDb(
      [
        publishedRow("coin-a", routes("route-a", "route-b", "route-c")),
        publishedRow("coin-b", routes("route-x", "route-y")),
      ],
      lastSnapshotWrite(firstDb),
      SUSTAINED,
    );
    const second = await runDexExitRouteTurnoverWatchdog(secondDb);

    expect(second.status).toBe("ok");
    expect(metadataOf(second)).toMatchObject({
      alertingCoinCount: 0,
      candidateCoinCount: 0,
    });
    expect(snapshotOf(secondDb).pendingAlert).toBeUndefined();
  });

  it("never alerts on a sustained one-for-one route swap of a single-route coin", async () => {
    const firstDb = watchdogDb(
      [publishedRow("coin-a", routes("route-new"))],
      previousSnapshot([{ stablecoinId: "coin-a", routes: routes("route-old") }]),
      CURRENT,
    );
    const first = await runDexExitRouteTurnoverWatchdog(firstDb);

    expect(first.status).toBe("ok");
    expect(metadataOf(first)).toMatchObject({
      alertingCoinCount: 0,
      candidateCoinCount: 0,
      highestObservedTurnover: 1,
    });
    expect(snapshotOf(firstDb).candidates).toBeUndefined();

    const secondDb = watchdogDb(
      [publishedRow("coin-a", routes("route-new"))],
      lastSnapshotWrite(firstDb),
      SUSTAINED,
    );
    const second = await runDexExitRouteTurnoverWatchdog(secondDb);

    expect(second.status).toBe("ok");
    expect(metadataOf(second)).toMatchObject({
      alertingCoinCount: 0,
      candidateCoinCount: 0,
    });
  });

  it.each([[["route-a"]], [["route-a", "route-b"]]])("treats a coin losing all %j routes as complete turnover only when sustained", async (lost) => {
    const firstDb = watchdogDb(
      [publishedRow("coin-a", [])],
      previousSnapshot([{ stablecoinId: "coin-a", routes: routes(...lost) }]),
      CURRENT,
    );
    const first = await runDexExitRouteTurnoverWatchdog(firstDb);
    expect(first.status).toBe("ok");
    expect(metadataOf(first)).toMatchObject({ candidateCoinCount: 1 });

    const secondDb = watchdogDb(
      [publishedRow("coin-a", [])],
      lastSnapshotWrite(firstDb),
      SUSTAINED,
    );
    const second = await runDexExitRouteTurnoverWatchdog(secondDb);
    const metadata = metadataOf(second);

    expect(second.status).toBe("ok");
    expect(metadata.worstOffenders[0]).toMatchObject({
      stablecoinId: "coin-a",
      previousRouteCount: lost.length,
      currentRouteCount: 0,
      jaccardDistance: 1,
      removedRouteCount: lost.length,
    });
  });

  it("keeps the baseline and does not alert when a tracked coin leaves the active roster", async () => {
    const previous = previousSnapshot([
      { stablecoinId: "coin-a", routes: routes("route-a1", "route-a2") },
      { stablecoinId: "coin-x", routes: routes("route-x1", "route-x2", "route-x3") },
    ]);
    const rosterRows = [publishedRow("coin-a", routes("route-a1", "route-a2"))];

    const firstDb = watchdogDb(rosterRows, previous, CURRENT);
    const first = await runDexExitRouteTurnoverWatchdog(firstDb);
    const firstMetadata = metadataOf(first);

    expect(firstMetadata).toMatchObject({
      comparedCoinCount: 1,
      changedCoinCount: 0,
      alertingCoinCount: 0,
      candidateCoinCount: 0,
      worstOffenders: [],
    });
    const firstWrite = snapshotOf(firstDb);
    expect(firstWrite.coins.find((coin: { stablecoinId: string }) => coin.stablecoinId === "coin-x").routes)
      .toEqual([
        { routeId: canonicalRouteId("route-x1"), evidenceKind: "reserve-based-amm-simulation" },
        { routeId: canonicalRouteId("route-x2"), evidenceKind: "reserve-based-amm-simulation" },
        { routeId: canonicalRouteId("route-x3"), evidenceKind: "reserve-based-amm-simulation" },
      ]);

    const secondDb = watchdogDb(rosterRows, lastSnapshotWrite(firstDb), RECOVERY);
    const second = await runDexExitRouteTurnoverWatchdog(secondDb);
    const secondMetadata = metadataOf(second);

    expect(secondMetadata).toMatchObject({ alertingCoinCount: 0, worstOffenders: [] });
    expect(snapshotOf(secondDb).pendingAlert).toBeUndefined();
  });

  it("skips a rerun against the same published generation without changing comparison state", async () => {
    const db = watchdogDb(
      [publishedRow("coin-a", routes("route-a", "route-b", "route-e", "route-f"))],
      previousSnapshot(
        [{ stablecoinId: "coin-a", routes: routes("route-a", "route-b", "route-c", "route-d") }],
        { generationId: CURRENT },
      ),
      CURRENT,
    );

    const result = await runDexExitRouteTurnoverWatchdog(db);

    expect(result.status).toBe("skipped_neutral");
    expect(metadataOf(result)).toMatchObject({
      reason: "no-new-published-dex-generation",
    });
    expect(lastSnapshotWrite(db)).toBeNull();
    expect(db.getHistory().some((entry) => entry.binds[0] === OPERATOR_ALERT_RECEIPT_KEYS.turnover
      && entry.sql.includes("INSERT INTO cache"))).toBe(true);
  });
});
