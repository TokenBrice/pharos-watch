import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createLatestSchemaFixtureTracker } from "@shared/test-utils/latest-schema-sqlite";
import { WORKER_TRACKED_META_BY_ID } from "@shared/lib/stablecoins/worker-runtime-registry";
import { computeLiveReserveConfigFingerprint } from "@shared/lib/live-reserve-adapters";
const { issuer, shares } = vi.hoisted(() => ({ issuer: vi.fn(), shares: vi.fn() }));
vi.mock("../reserve-adapters/jpmorgan-nav", () => ({ fetchJpmorganNavReserves: issuer }));
vi.mock("../sync-stablecoins/supplemental-assets/onchain-supply", () => ({ fetchPinnedNativeShares: shares }));
import { bootstrapJltxxReserves } from "../bootstrap-jltxx-reserves";
import { CONFIGURED_COINS } from "../sync-live-reserves-shared";
import { finalizeReserveSyncRun } from "../sync-live-reserves-finalize";
import { resolveLiveReserveSyncBudgetConfig } from "../sync-live-reserves-config";
import { createAdapterLatencyCollector } from "../sync-live-reserves-core";
const fixtures = createLatestSchemaFixtureTracker();
afterEach(() => {
  fixtures.closeAll();
  vi.useRealTimers();
});
beforeEach(() => {
  vi.clearAllMocks();
  const now = Math.floor(Date.now() / 1000);
  const midnight = Math.floor(now / 86400) * 86400;
  issuer.mockResolvedValue({
    slices: [{ name: "JLTXX government fund shares", pct: 100, risk: "low" }],
    metadata: { navPerToken: 1, sourceTimestamp: midnight, freshnessMode: "verified", details: {
      cusip: "46655R119", shareClassNumber: "4397", ticker: "JLTXX", classAssetsUsd: 600_000_000,
      dealingDate: new Date(midnight * 1000).toISOString().slice(0, 10),
    } },
  });
  shares.mockResolvedValue({
    chain: "ethereum", contractAddress: "0x09864f52b035ae22ee739dfa5c748fa080d07bd8",
    rawShares: "60000000000", decimals: 2, blockNumber: 100, blockHash: `0x${"a".repeat(64)}`, observedAt: now - 900,
  });
});
describe("staged JLTXX canonical reserve writer", () => {
  it("writes a matched current staged attempt without adding active membership or an accepted generation", async () => {
    const { db, sqlite } = fixtures.open();
    const packet = await bootstrapJltxxReserves(db, new Map(), new AbortController().signal);
    expect(packet).toMatchObject({ evidenceCaptured: true, admissionAllowed: false, runtimePriceMarketcapPass: false, reason: "native-class-temporal-review-unavailable" });
    const current = sqlite.prepare("SELECT c.source, c.attempt_id, c.config_fingerprint, c.fetched_at, s.last_success_at, s.last_success_attempt_id, s.config_fingerprint AS state_fingerprint FROM reserve_composition c JOIN reserve_sync_state s USING (stablecoin_id) WHERE c.stablecoin_id = 'jltxx-jpmorgan'").get() as Record<string, unknown>;
    const fingerprint = computeLiveReserveConfigFingerprint(WORKER_TRACKED_META_BY_ID.get("jltxx-jpmorgan")!.liveReservesConfig!);
    expect(current.config_fingerprint).toBe(fingerprint);
    expect(current.state_fingerprint).toBe(fingerprint);
    expect(current.attempt_id).toBe(current.last_success_attempt_id);
    expect(current.fetched_at).toBe(current.last_success_at);
    expect(CONFIGURED_COINS.some((coin) => coin.id === "jltxx-jpmorgan")).toBe(false);
    expect(sqlite.prepare("SELECT COUNT(*) AS n FROM reserve_composition_history WHERE stablecoin_id = 'jltxx-jpmorgan'").get()).toEqual({ n: 1 });
  });
  it("retains staged JLTXX evidence through ordinary finalization but deletes retired adapter rows", async () => {
    const { db, sqlite } = fixtures.open();
    const packet = await bootstrapJltxxReserves(db, new Map(), new AbortController().signal);
    expect(packet.evidenceCaptured).toBe(true);
    const compositionBefore = sqlite.prepare("SELECT * FROM reserve_composition WHERE stablecoin_id = 'jltxx-jpmorgan'").get();
    const stateBefore = sqlite.prepare("SELECT * FROM reserve_sync_state WHERE stablecoin_id = 'jltxx-jpmorgan'").get();
    const retiredBindings = [
      { id: "stbt-matrixdock", adapter: "matrixdock-stbt" },
      { id: "usdv-solomon", adapter: "solomon" },
      { id: "usdh-hubble", adapter: "hubble" },
    ];
    const now = Math.floor(Date.now() / 1000);
    for (const { id, adapter } of retiredBindings) {
      expect(WORKER_TRACKED_META_BY_ID.has(id)).toBe(true);
      expect(CONFIGURED_COINS.some((coin) => coin.id === id)).toBe(false);
      sqlite.prepare("INSERT INTO reserve_composition (stablecoin_id, slices, fetched_at, source) VALUES (?, '[]', ?, ?)").run(id, now, adapter);
      sqlite.prepare("INSERT INTO reserve_sync_state (stablecoin_id, adapter_key, breaker_key, last_status) VALUES (?, ?, ?, 'ok')").run(id, adapter, `live-reserves:${adapter}`);
    }

    vi.useFakeTimers();
    // Neither the next four-hour finalize nor later age pruning may destroy referenced staged evidence.
    for (const elapsedSec of [4 * 60 * 60, 31 * 24 * 60 * 60]) {
      vi.setSystemTime((now + elapsedSec) * 1000);
      const telemetry = createAdapterLatencyCollector();
      const result = await finalizeReserveSyncRun({
        db, total: CONFIGURED_COINS.length, runStartedAt: now + elapsedSec, runStartedMs: Date.now(),
        counts: { synced: 0, failed: 0, skipped: 0, circuitSkipped: 0, deferredSkipped: 0, deferredCoins: 0, attemptedCoins: 0 },
        warningMessages: [], coinsWithErrors: [], coinsWithWarnings: [],
        breaker: { breakerKeys: new Set(), breakerOutcomes: new Map() },
        deferredTail: {
          nextCursorStablecoinId: null, cursorTailState: null, cursorRecordedAt: null,
          cursorTailCompletedAt: null, cursorTailFailedAt: null, cursorTailError: null, runBudgetTruncationCount: 0,
        },
        checkpointOwned: false, attemptFailureSummaries: [], budgetConfig: resolveLiveReserveSyncBudgetConfig(),
        phaseTimings: { setup: 0, queue: 0, adapter: 0, d1CoinPersistence: 0 },
        adapterLatency: telemetry.finalize(), adapterTelemetryProgress: telemetry.progress(),
      });
      expect(JSON.parse(result.metadata!)).toMatchObject({
        artifactCleanupSkipped: false, artifactCleanupWarningCount: 0, historyPruneSkipped: false,
        artifactCleanup: {
          syncStateDeleted: elapsedSec === 4 * 60 * 60 ? retiredBindings.length : 0,
          compositionDeleted: elapsedSec === 4 * 60 * 60 ? retiredBindings.length : 0,
        },
      });
      expect(sqlite.prepare("SELECT * FROM reserve_composition WHERE stablecoin_id = 'jltxx-jpmorgan'").get()).toEqual(compositionBefore);
      expect(sqlite.prepare("SELECT * FROM reserve_sync_state WHERE stablecoin_id = 'jltxx-jpmorgan'").get()).toEqual(stateBefore);
      expect(sqlite.prepare("SELECT COUNT(*) AS n FROM reserve_composition_history WHERE stablecoin_id = 'jltxx-jpmorgan'").get()).toEqual({ n: 1 });
      expect(sqlite.prepare("SELECT COUNT(*) AS n FROM reserve_sync_attempt_history WHERE stablecoin_id = 'jltxx-jpmorgan'").get()).toEqual({ n: 1 });
    }
    for (const { id } of retiredBindings) {
      expect(sqlite.prepare("SELECT stablecoin_id FROM reserve_composition WHERE stablecoin_id = ?").get(id)).toBeUndefined();
      expect(sqlite.prepare("SELECT stablecoin_id FROM reserve_sync_state WHERE stablecoin_id = ?").get(id)).toBeUndefined();
    }
    expect(WORKER_TRACKED_META_BY_ID.get("jltxx-jpmorgan")?.status).toBe("quarantined");
    expect(CONFIGURED_COINS.some((coin) => coin.id === "jltxx-jpmorgan")).toBe(false);
    expect(sqlite.prepare("SELECT key FROM cache WHERE key = 'live-reserves:accepted-generation:v1'").get()).toBeUndefined();
  });
  it("does not claim current evidence when an adapter attempt fails", async () => {
    issuer.mockRejectedValue(new Error("issuer source unavailable"));
    const { db, sqlite } = fixtures.open();
    expect(await bootstrapJltxxReserves(db, new Map(), new AbortController().signal)).toMatchObject({ evidenceCaptured: false, admissionAllowed: false });
    expect(sqlite.prepare("SELECT last_status FROM reserve_sync_state WHERE stablecoin_id = 'jltxx-jpmorgan'").get()).toEqual({ last_status: "error" });
    expect(sqlite.prepare("SELECT COUNT(*) AS n FROM reserve_composition WHERE stablecoin_id = 'jltxx-jpmorgan'").get()).toEqual({ n: 0 });
  });
});
