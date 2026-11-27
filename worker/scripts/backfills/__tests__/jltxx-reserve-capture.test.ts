import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createLatestSchemaFixtureTracker } from "@shared/test-utils/latest-schema-sqlite";
import { WORKER_TRACKED_META_BY_ID } from "@shared/lib/stablecoins/worker-runtime-registry";
import { computeLiveReserveConfigFingerprint } from "@shared/lib/live-reserve-adapters";
import { JLTXX_ETHEREUM_CONTRACT, JLTXX_SOLANA_MINT, JLTXX_SOLANA_TOKEN_PROGRAM } from "@shared/types/reserve-nav-supply";

const { issuer, shares } = vi.hoisted(() => ({ issuer: vi.fn(), shares: vi.fn() }));
vi.mock("../../../src/cron/reserve-adapters/jpmorgan-nav", () => ({ fetchJpmorganNavReserves: issuer }));
vi.mock("../../../src/cron/sync-stablecoins/supplemental-assets/onchain-supply", () => ({ fetchPinnedNativeShares: shares }));

import { bootstrapJltxxReserves } from "../jltxx-reserve-capture";
import { CONFIGURED_COINS } from "../../../src/cron/sync-live-reserves-shared";
import { finalizeReserveSyncRun } from "../../../src/cron/sync-live-reserves-finalize";
import { resolveLiveReserveSyncBudgetConfig } from "../../../src/cron/sync-live-reserves-config";
import { createAdapterLatencyCollector } from "../../../src/cron/sync-live-reserves-core";

const ID = "jltxx-jpmorgan";
const nowSec = () => Math.floor(Date.now() / 1000);
const runBootstrap = (db: D1Database) => bootstrapJltxxReserves(db, new Map(), new AbortController().signal);
const fixtures = createLatestSchemaFixtureTracker();

afterEach(() => { fixtures.closeAll(); vi.useRealTimers(); });
beforeEach(() => {
  vi.clearAllMocks();
  const now = nowSec();
  const midnight = Math.floor(now / 86400) * 86400;
  issuer.mockResolvedValue({
    slices: [{ name: "JLTXX government fund shares", pct: 100, risk: "low" }],
    metadata: {
      navPerToken: 1, sourceTimestamp: midnight, freshnessMode: "verified",
      details: {
        cusip: "46655R119", shareClassNumber: "4397", ticker: "JLTXX", classAssetsUsd: 600_000_000,
        dealingDate: new Date(midnight * 1000).toISOString().slice(0, 10),
        supplyAdmissionReview: {
          maxNavSupplySkewSec: 432000, reviewedAt: "2026-11-27",
          evidenceRef: "https://am.jpmorgan.com/FundsMarketingHandler/slim/product.md?cusip=46655r119&country=us&role=adv&language=en",
          perimeterRef: "https://www.sec.gov/Archives/edgar/data/1659326/000119312526410014/d172947d497.htm",
        },
      },
    },
  });
  shares.mockResolvedValue({
    rawShares: "60000000000", decimals: 2, observedAt: now - 900,
    legs: [{ chain: "ethereum", contractAddress: JLTXX_ETHEREUM_CONTRACT, rawShares: "60000000000", decimals: 2, blockNumber: 100, blockHash: `0x${"a".repeat(64)}`, observedAt: now - 900 }],
  });
});

function runFinalize(db: D1Database, runStartedAt: number) {
  const telemetry = createAdapterLatencyCollector();
  return finalizeReserveSyncRun({
    db, total: CONFIGURED_COINS.length, runStartedAt, runStartedMs: Date.now(),
    counts: { synced: 0, failed: 0, persistenceFailed: 0, skipped: 0, circuitSkipped: 0, deferredSkipped: 0, deferredCoins: 0, attemptedCoins: 0 },
    warningMessages: [], coinsWithErrors: [], coinsWithWarnings: [],
    breaker: { breakerKeys: new Set(), breakerOutcomes: new Map() },
    deferredTail: { nextCursorStablecoinId: null, cursorTailState: null, cursorRecordedAt: null, cursorTailCompletedAt: null, cursorTailFailedAt: null, cursorTailError: null, runBudgetTruncationCount: 0 },
    checkpointOwned: false, attemptFailureSummaries: [], budgetConfig: resolveLiveReserveSyncBudgetConfig(),
    phaseTimings: { setup: 0, queue: 0, adapter: 0, d1CoinPersistence: 0 },
    adapterLatency: telemetry.finalize(), adapterTelemetryProgress: telemetry.progress(),
  });
}

describe("active JLTXX canonical reserve writer", () => {
  it("writes a matched active attempt without creating an accepted generation", async () => {
    const { db, sqlite } = fixtures.open();
    expect(await runBootstrap(db)).toMatchObject({ evidenceCaptured: true, admissionAllowed: false, runtimePriceMarketcapPass: false, scopePassed: true, reason: "explicit-admission-review-and-runtime-price-marketcap-pass-required" });
    const current = sqlite.prepare("SELECT c.source, c.attempt_id, c.config_fingerprint, c.fetched_at, s.last_success_at, s.last_success_attempt_id, s.config_fingerprint AS state_fingerprint FROM reserve_composition c JOIN reserve_sync_state s USING (stablecoin_id) WHERE c.stablecoin_id = ?").get(ID) as Record<string, unknown>;
    const fp = computeLiveReserveConfigFingerprint(WORKER_TRACKED_META_BY_ID.get(ID)!.liveReservesConfig!);
    expect(current).toMatchObject({ config_fingerprint: fp, state_fingerprint: fp, attempt_id: current.last_success_attempt_id, fetched_at: current.last_success_at });
    expect(CONFIGURED_COINS.some((c) => c.id === ID)).toBe(true);
    expect(sqlite.prepare("SELECT COUNT(*) AS n FROM reserve_composition_history WHERE stablecoin_id = ?").get(ID)).toEqual({ n: 1 });
  });

  it("retains active JLTXX evidence through ordinary finalization but deletes retired adapter rows", async () => {
    const { db, sqlite } = fixtures.open();
    expect((await runBootstrap(db)).evidenceCaptured).toBe(true);
    const getRow = (table: string, id = ID) => sqlite.prepare(`SELECT * FROM ${table} WHERE stablecoin_id = ?`).get(id);
    const countRow = (table: string) => sqlite.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE stablecoin_id = ?`).get(ID);
    const compositionBefore = getRow("reserve_composition");
    const stateBefore = getRow("reserve_sync_state");
    const retired = [
      { id: "stbt-matrixdock", adapter: "matrixdock-stbt" },
      { id: "usdv-solomon", adapter: "solomon" },
      { id: "usdh-hubble", adapter: "hubble" },
    ];
    const now = nowSec();
    for (const { id, adapter } of retired) {
      expect(WORKER_TRACKED_META_BY_ID.has(id)).toBe(true);
      expect(CONFIGURED_COINS.some((c) => c.id === id)).toBe(false);
      sqlite.prepare("INSERT INTO reserve_composition (stablecoin_id, slices, fetched_at, source) VALUES (?, '[]', ?, ?)").run(id, now, adapter);
      sqlite.prepare("INSERT INTO reserve_sync_state (stablecoin_id, adapter_key, breaker_key, last_status) VALUES (?, ?, ?, 'ok')").run(id, adapter, `live-reserves:${adapter}`);
    }

    vi.useFakeTimers();
    for (const elapsedSec of [4 * 3600, 31 * 86400]) {
      vi.setSystemTime((now + elapsedSec) * 1000);
      const result = await runFinalize(db, now + elapsedSec);
      const deleted = elapsedSec === 4 * 3600 ? retired.length : 0;
      expect(JSON.parse(result.metadata!)).toMatchObject({
        artifactCleanupSkipped: false, artifactCleanupWarningCount: 0, historyPruneSkipped: false,
        artifactCleanup: { syncStateDeleted: deleted, compositionDeleted: deleted },
      });
      expect(getRow("reserve_composition")).toEqual(compositionBefore);
      expect(getRow("reserve_sync_state")).toEqual(stateBefore);
      expect(countRow("reserve_composition_history")).toEqual({ n: 1 });
      expect(countRow("reserve_sync_attempt_history")).toEqual({ n: 1 });
    }
    for (const { id } of retired) {
      expect(getRow("reserve_composition", id)).toBeUndefined();
      expect(getRow("reserve_sync_state", id)).toBeUndefined();
    }
    expect(WORKER_TRACKED_META_BY_ID.get(ID)?.status).toBe("active");
    expect(CONFIGURED_COINS.some((c) => c.id === ID)).toBe(true);
    expect(sqlite.prepare("SELECT key FROM cache WHERE key = 'live-reserves:accepted-generation:v1'").get()).toBeUndefined();
  });

  it("does not claim current evidence when an adapter attempt fails", async () => {
    issuer.mockRejectedValue(new Error("issuer source unavailable"));
    const { db, sqlite } = fixtures.open();
    expect(await runBootstrap(db)).toMatchObject({ evidenceCaptured: false, admissionAllowed: false });
    expect(sqlite.prepare("SELECT last_status FROM reserve_sync_state WHERE stablecoin_id = ?").get(ID)).toEqual({ last_status: "error" });
    expect(sqlite.prepare("SELECT COUNT(*) AS n FROM reserve_composition WHERE stablecoin_id = ?").get(ID)).toEqual({ n: 0 });
  });

  it("persists and re-validates a 2-leg observation", async () => {
    const now = nowSec();
    shares.mockResolvedValue({
      rawShares: "60000000000", decimals: 2, observedAt: now - 900,
      legs: [
        { chain: "ethereum", contractAddress: JLTXX_ETHEREUM_CONTRACT, rawShares: "5000000000", decimals: 2, blockNumber: 100, blockHash: `0x${"a".repeat(64)}`, observedAt: now - 600 },
        { chain: "solana", contractAddress: JLTXX_SOLANA_MINT, rawShares: "55000000000", decimals: 2, slot: 460_000_000, programOwner: JLTXX_SOLANA_TOKEN_PROGRAM, observedAt: now - 900 },
      ],
    });
    const packet = await runBootstrap(fixtures.open().db);
    expect(packet).toMatchObject({ evidenceCaptured: true, admissionAllowed: false, scopePassed: true, reason: "explicit-admission-review-and-runtime-price-marketcap-pass-required", nativeShares: { rawShares: "60000000000", observedAt: now - 900 } });
    expect(packet.nativeShares?.legs).toHaveLength(2);
  });
});
