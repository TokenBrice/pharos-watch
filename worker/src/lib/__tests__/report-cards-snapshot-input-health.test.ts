import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mockD1 } from "@shared/test-utils/mock-d1";
import { makeStablecoin } from "@shared/test-utils/stablecoin";
import { ACTIVE_META_BY_ID, ACTIVE_STABLECOINS } from "@shared/lib/stablecoins/registry";
import { resolveDexDeploymentCensusMaxAgeSec } from "../../cron/dex-liquidity/deployment-census-coverage";
import { createLatestSchemaSqlite } from "@shared/test-utils/latest-schema-sqlite";
import { createSqliteD1 } from "@shared/test-utils/sqlite-d1";
import { computeLiveReserveConfigFingerprint, getLiveReserveAdapterDefinition } from "@shared/lib/live-reserve-adapters";
import { getRedemptionBackstopConfig } from "@shared/lib/redemption-backstops";
import { assessReserveFetchFreshness } from "../live-reserves/store-snapshot-state";
import { makeRedemptionWriteRecord } from "./redemption-backstops-store.test-support";
import { makeWorkerSafetyScoreV9Publication, makeWorkerV9Card } from "../../test-helpers/report-cards-v9";
import { assessV9Publication } from "../safety-score-v9/publication-assessment";
import type * as RedemptionStoreModule from "../redemption-backstops-store";
import type * as DexStoreModule from "../dex-liquidity";
import type * as LiveReserveStoreModule from "../live-reserves/store";
import type * as SnapshotModule from "../report-cards-snapshot";
import { buildNativeSafetyScoreV9Capture } from "../safety-score-v9/capture";
import { reserveLossOutcome } from "../live-reserves/loss";

const scrvusdMeta = ACTIVE_META_BY_ID.get("scrvusd-curve")!;
// The rotating-sweep window grows with the reviewed deployment footprint, so the
// stale case sits one second past the window the production loader derives.
const scrvusdCensusMaxAgeSec = resolveDexDeploymentCensusMaxAgeSec([
  ...(scrvusdMeta.contracts ?? []),
  ...(scrvusdMeta.tradedContracts ?? []),
]);

const mocks = vi.hoisted(() => ({
  getCache: vi.fn(),
  loadDexLiquiditySnapshot: vi.fn(),
  loadRedemptionBackstopSnapshot: vi.fn(),
  loadFreshIndependentLiveReserveMap: vi.fn(),
}));

vi.mock("../db-cache", () => ({
  getCache: mocks.getCache,
}));

vi.mock("../dex-liquidity", async (importOriginal) => ({
  ...(await importOriginal<typeof DexStoreModule>()),
  loadDexLiquiditySnapshot: mocks.loadDexLiquiditySnapshot,
}));

vi.mock("../redemption-backstops-store", async (importOriginal) => ({
  ...(await importOriginal<typeof RedemptionStoreModule>()),
  loadRedemptionBackstopSnapshot:
    mocks.loadRedemptionBackstopSnapshot,
}));

vi.mock("../live-reserves/store", async (importOriginal) => ({
  ...(await importOriginal<typeof LiveReserveStoreModule>()),
  loadFreshIndependentLiveReserveMap:
    mocks.loadFreshIndependentLiveReserveMap,
}));

vi.mock("../peg-analytics", () => ({
  derivePegAnalyticsSnapshot: vi.fn(async () => ({ nowSec: NOW_SEC, pegDataById: new Map(), eventsByCoin: new Map() })),
}));
vi.mock("../peg-analytics-cache", () => ({ publishPegAnalyticsCache: vi.fn(async () => true) }));
vi.mock("../report-card-evidence-journal-store", () => ({ loadReportCardEvidenceJournalByIdV1: vi.fn(async () => ({})) }));
vi.mock("../collateral-drift", () => ({ summarizeCollateralDriftFromLiveReserveMap: () => ({ fallbackCoins: [] }) }));
vi.mock("../report-cards-snapshot", async (importOriginal) => ({
  ...(await importOriginal<typeof SnapshotModule>()),
  loadExactDexPublicationGeneration: vi.fn(async () => ({ generationId: `dex-liquidity-${NOW_SEC}`, updatedAt: NOW_SEC })),
}));
// The integration under test is store -> loader -> capture -> publication health.
// Full-catalog native codec consistency is exercised in its separate suite.
vi.mock("../safety-score-v9/native-input", () => ({
  computeNativeDexLiquidityPayloadFingerprint: () => "c".repeat(64),
  normalizeNativeV9Input: (value: unknown) => value,
}));

const {
  loadReportCardsSnapshotInputs,
} = await import("../report-cards-snapshot-inputs");
const {
  RedemptionBackstopSnapshotUnavailableError,
} = await import("../redemption-backstops-store");

const NOW_SEC = 1_700_000_000;

function db() {
  return mockD1([
    {
      match: "FROM dex_liquidity",
      rows: [],
    },
  ]);
}

function stablecoinsCache() {
  return {
    kind: "ok" as const,
    payload: { peggedAssets: [] },
    updatedAt: NOW_SEC,
  };
}

function liveReserves() {
  return Object.assign(new Map(), {
    provenanceById: new Map(),
  });
}

describe("report-card V9 publication input health", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW_SEC * 1_000);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    mocks.getCache.mockReset().mockResolvedValue(null);
    mocks.loadDexLiquiditySnapshot.mockReset().mockResolvedValue({
      map: {},
      latestUpdatedAt: NOW_SEC - 60,
    });
    mocks.loadRedemptionBackstopSnapshot.mockReset().mockResolvedValue({
      map: {},
      latestUpdatedAt: NOW_SEC - 60,
      runId: "redemption:current",
      methodologyVersion: "redemption:test",
      reserveInputAssessment: { state: "fresh", quarantined: {} },
    });
    mocks.loadFreshIndependentLiveReserveMap
      .mockReset()
      .mockResolvedValue(liveReserves());
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it.each([
    { status: "ok", failureMetadata: {}, admitted: true },
    { status: "degraded", failureMetadata: {}, admitted: true },
    { status: "error", failureMetadata: {}, admitted: false },
    { status: "degraded", failureMetadata: { reason: "fallback-withheld-score-grade-retained", failureCategory: "parse-failure" }, admitted: false },
  ])("distinguishes tied-clock unstamped legacy $status (admitted: $admitted) through real SQLite loaders and capture", async ({ status, failureMetadata, admitted }) => {
    const { sqlite, db: database } = createLatestSchemaSqlite();
    try {
      const reserveStore = await vi.importActual<typeof LiveReserveStoreModule>("../live-reserves/store");
      const redemptionStore = await vi.importActual<typeof RedemptionStoreModule>("../redemption-backstops-store");
      const assetIds = ["iusd-infinifi", "lusd-liquity"];
      const runId = "redemption:legacy-reserves";
      const generationId = "reserve:legacy-reserves";
      const fetchedAt = NOW_SEC - 60;
      const entries = assetIds.map((assetId) => {
        const config = ACTIVE_META_BY_ID.get(assetId)!.liveReservesConfig!;
        const adapter = getLiveReserveAdapterDefinition(config.adapter)!;
        const fingerprint = computeLiveReserveConfigFingerprint(config);
        sqlite.prepare(`INSERT INTO reserve_composition
          (stablecoin_id, slices, fetched_at, source, metadata, warning_count, warnings,
           adapter_source_model, adapter_evidence_class, config_fingerprint, attempt_id)
          VALUES (?, ?, ?, ?, ?, 0, NULL, ?, ?, ?, NULL)`).run(
          assetId, JSON.stringify([{ name: "Measured cash", pct: 100, risk: "low" }]),
          fetchedAt, config.adapter, JSON.stringify({ freshnessMode: "not-applicable" }),
          adapter.sourceModel, adapter.evidenceClass, fingerprint,
        );
        sqlite.prepare(`INSERT INTO reserve_sync_state
          (stablecoin_id, adapter_key, breaker_key, last_attempted_at, last_success_at,
           last_status, warning_count, warnings, last_error, metadata, config_fingerprint,
           last_attempt_id, last_success_attempt_id, pending_attempt_id)
          VALUES (?, ?, ?, ?, ?, ?, 0, NULL, NULL, ?, ?, NULL, NULL, NULL)`).run(
          assetId, config.adapter, `live-reserves:${config.breakerScope ?? config.adapter}`,
          fetchedAt, fetchedAt, assetId === assetIds[0] ? status : "ok",
          JSON.stringify(assetId === assetIds[0] ? failureMetadata : {}), fingerprint,
        );
        return makeRedemptionWriteRecord({
          stablecoinId: assetId, updatedAt: NOW_SEC, routeFamily: getRedemptionBackstopConfig(assetId)!.routeFamily,
          reserveInput: { generationId, contentSha256: "a".repeat(64), stablecoinId: assetId,
            attemptId: null, configFingerprint: fingerprint,
            freshness: assessReserveFetchFreshness({ fetchedAt, attemptId: null,
              metadata: { freshnessMode: "not-applicable" } }, NOW_SEC, 172800) },
        });
      });
      await redemptionStore.upsertRedemptionBackstopSnapshots(database, entries, {
        runId, metadata: { reserveViewSchemaVersion: 2, reserveGenerationId: generationId,
          reserveContentSha256: "a".repeat(64), runClockSec: NOW_SEC,
          consumedReserveInputs: Object.fromEntries(entries.map((entry) => [entry.stablecoinId, entry.reserveInput])) },
      });
      mocks.loadFreshIndependentLiveReserveMap.mockImplementation(reserveStore.loadFreshIndependentLiveReserveMap);
      mocks.loadRedemptionBackstopSnapshot.mockImplementation(redemptionStore.loadRedemptionBackstopSnapshot);
      mocks.loadDexLiquiditySnapshot.mockResolvedValue({
        map: Object.fromEntries(ACTIVE_STABLECOINS.map((coin) => [coin.id, { methodologyVersion: "1.0" }])),
        latestUpdatedAt: NOW_SEC,
      });
      const preloadedStablecoinsCache = stablecoinsCache();
      const loaded = await loadReportCardsSnapshotInputs(database, { preloadedStablecoinsCache });
      const admittedIds = admitted ? assetIds : assetIds.slice(1);
      expect([...loaded.liveReserveMap.keys()].sort()).toEqual([...admittedIds].sort());
      expect(loaded.reserveLossLineageById?.size).toBe(admitted ? 0 : 1);
      if (!admitted) expect(loaded.reserveLossLineageById?.get(assetIds[0])?.latest).toMatchObject({
        disposition: "unknown", reason: "legacy-refresh-loss-unproved", observedAtSec: fetchedAt, attemptId: null,
      });
      expect(Object.keys(loaded.redemptionBackstopMap).sort()).toEqual([...assetIds].sort());
      const { input } = await buildNativeSafetyScoreV9Capture(database, { preloadedStablecoinsCache });
      expect(input.v9PublicationInputHealth.redemption.state).toBe("current");
      expect(input.redemptionStale).toBe(false);
      expect(Object.keys(input.redemptionBackstopMap).sort()).toEqual([...admittedIds].sort());
      if (admitted) {
        expect(input.reserveLossLineageById).toEqual({});
        expect(input.redemptionLossOutcomesByAssetId).toEqual({});
      } else {
        expect(input.redemptionLossOutcomesByAssetId?.[assetIds[0]]).toMatchObject([{
          disposition: "unknown", reason: "legacy-refresh-loss-unproved", observedAtSec: fetchedAt, attemptId: null,
        }]);
      }
      for (const entry of entries.filter((entry) => admittedIds.includes(entry.stablecoinId))) {
        expect(input.redemptionBackstopMap[entry.stablecoinId].reserveInput).toEqual(entry.reserveInput);
      }
    } finally { sqlite.close(); }
  });

  it.each(["clean", "operational", "unproved-finalized"] as const)("preserves finalized evidence while pending and requires final proof through real loaders (%s)", async (scenario) => {
    const { sqlite, db: database } = createLatestSchemaSqlite();
    try {
      const reserveStore = await vi.importActual<typeof LiveReserveStoreModule>("../live-reserves/store");
      const redemptionStore = await vi.importActual<typeof RedemptionStoreModule>("../redemption-backstops-store");
      const assetId = "iusd-infinifi";
      const config = ACTIVE_META_BY_ID.get(assetId)!.liveReservesConfig!;
      const adapter = getLiveReserveAdapterDefinition(config.adapter)!;
      const fingerprint = computeLiveReserveConfigFingerprint(config);
      const fetchedAt = NOW_SEC - 60;
      const breakerKey = `live-reserves:${config.breakerScope ?? config.adapter}`;
      const composition = { stablecoinId: assetId, source: config.adapter, configFingerprint: fingerprint,
        fetchedAt, attemptId: "reserve-success", slices: [{ name: "Measured cash", pct: 100, risk: "low" as const }],
        metadata: { freshnessMode: "not-applicable" as const }, warningCount: 0, warnings: [],
        adapterSourceModel: adapter.sourceModel, adapterEvidenceClass: adapter.evidenceClass };
      await reserveStore.beginReserveSyncAttempt(database, {
        stablecoinId: assetId, adapterKey: config.adapter, breakerKey, attemptedAt: fetchedAt,
        attemptId: composition.attemptId, configFingerprint: fingerprint,
      });
      await reserveStore.finalizeReserveSyncSuccess(database, composition, {
        stablecoinId: assetId, adapterKey: config.adapter, breakerKey, configFingerprint: fingerprint,
        lastAttemptedAt: fetchedAt, lastSuccessAt: fetchedAt, lastStatus: "ok", warnings: [], warningCount: 0,
        lastError: null, metadata: {}, lastAttemptId: composition.attemptId, pendingAttemptId: composition.attemptId,
        lastSuccessAttemptId: composition.attemptId,
      }, Number.MAX_SAFE_INTEGER);
      const generationId = "reserve:pending-census";
      const entry = makeRedemptionWriteRecord({
        stablecoinId: assetId, updatedAt: NOW_SEC, routeFamily: getRedemptionBackstopConfig(assetId)!.routeFamily,
        reserveInput: { generationId, contentSha256: "a".repeat(64), stablecoinId: assetId,
          attemptId: composition.attemptId, configFingerprint: fingerprint,
          freshness: assessReserveFetchFreshness(composition, NOW_SEC, 172800) },
      });
      const peer = makeRedemptionWriteRecord({ stablecoinId: "usdc-circle", updatedAt: NOW_SEC, score: 0 });
      await redemptionStore.upsertRedemptionBackstopSnapshots(database, [entry, peer], {
        runId: "redemption:pending-census", metadata: {
          reserveViewSchemaVersion: 2, reserveGenerationId: generationId, reserveContentSha256: "a".repeat(64),
          runClockSec: NOW_SEC, consumedReserveInputs: { [assetId]: entry.reserveInput },
        },
      });
      mocks.loadFreshIndependentLiveReserveMap.mockImplementation(reserveStore.loadFreshIndependentLiveReserveMap);
      mocks.loadRedemptionBackstopSnapshot.mockImplementation(redemptionStore.loadRedemptionBackstopSnapshot);
      mocks.loadDexLiquiditySnapshot.mockResolvedValue({
        map: Object.fromEntries(ACTIVE_STABLECOINS.map((coin) => [coin.id, { methodologyVersion: "1.0" }])),
        latestUpdatedAt: NOW_SEC,
      });
      const finalizeOperationalDeferral = async (attemptId: string, observedAtSec: number) => {
        const state = (await reserveStore.loadReserveSyncStateMap(database)).get(assetId)!;
        const loss = reserveLossOutcome({ assetId, sourceId: fingerprint, attemptId, observedAtSec,
          reason: "budget-deferred", legs: [{ key: "primary", sourceId: fingerprint, result: "not-started",
            loss: { key: "primary", sourceId: fingerprint, disposition: "operational", reason: "budget-deferred",
              proof: `${attemptId}:before-collector` } }],
          priorEvidence: { ref: `reserve-composition:${assetId}:${composition.attemptId}`,
            observedAtSec: fetchedAt, expiresAtSec: fetchedAt + 172801 } });
        await reserveStore.finalizeReserveSyncAttempt(database, {
          ...state, lastStatus: "skipped", lastError: loss.reason, metadata: { reserveLoss: loss },
        });
      };
      const preloadedStablecoinsCache = stablecoinsCache();
      if (scenario !== "clean") {
        await reserveStore.beginReserveSyncAttempt(database, {
          stablecoinId: assetId, adapterKey: config.adapter, breakerKey, attemptedAt: NOW_SEC - 50,
          attemptId: "previous-deferral", configFingerprint: fingerprint,
        });
        await finalizeOperationalDeferral("previous-deferral", NOW_SEC - 50);
      }
      const before = await buildNativeSafetyScoreV9Capture(database, { preloadedStablecoinsCache });
      expect(before.input.liveReserveMap[assetId]).toEqual(composition.slices);
      expect(Object.keys(before.input.redemptionBackstopMap).sort()).toEqual([assetId, peer.stablecoinId].sort());
      await reserveStore.beginReserveSyncAttempt(database, {
        stablecoinId: assetId, adapterKey: config.adapter, breakerKey, attemptedAt: NOW_SEC - 40,
        attemptId: "current-attempt", configFingerprint: fingerprint,
      });
      const pending = await buildNativeSafetyScoreV9Capture(database, { preloadedStablecoinsCache });
      expect(pending.input.liveReserveMap[assetId]).toEqual(composition.slices);
      expect(Object.keys(pending.input.redemptionBackstopMap).sort()).toEqual([assetId, peer.stablecoinId].sort());
      expect(pending.input.v9PublicationInputHealth.redemption.state).toBe("current");
      expect(pending.input.redemptionBackstopMap[assetId].reserveInput).toEqual(entry.reserveInput);
      expect(pending.input.reserveLossLineageById?.[assetId]?.latest)
        .toEqual(before.input.reserveLossLineageById?.[assetId]?.latest);
      expect(pending.input.redemptionLossOutcomesByAssetId?.[assetId]).toBeUndefined();
      expect(pending.input.liveReserveProvenanceMap[assetId].fetchedAt).toBe(fetchedAt);
      if (scenario === "unproved-finalized") {
        // Model a finalized legacy writer that retained the previous packet without current proof.
        sqlite.prepare("UPDATE reserve_sync_state SET pending_attempt_id = NULL, last_status = 'error' WHERE stablecoin_id = ?")
          .run(assetId);
        const finalized = await buildNativeSafetyScoreV9Capture(database, { preloadedStablecoinsCache });
        expect(finalized.input.liveReserveMap[assetId]).toBeUndefined();
        expect(Object.keys(finalized.input.redemptionBackstopMap)).toEqual([peer.stablecoinId]);
        expect(finalized.input.v9PublicationInputHealth.redemption.state).toBe("current");
        expect(finalized.input.reserveLossLineageById?.[assetId]?.latest).toMatchObject({
          disposition: "unknown", reason: "current-attempt-proof-mismatched",
          attemptId: "current-attempt", observedAtSec: NOW_SEC - 40,
        });
        expect(finalized.input.redemptionLossOutcomesByAssetId?.[assetId]?.[0]).toMatchObject({
          disposition: "unknown", attemptId: "current-attempt", observedAtSec: NOW_SEC - 40,
        });
      } else {
        await finalizeOperationalDeferral("current-attempt", NOW_SEC - 40);
        const finalized = await buildNativeSafetyScoreV9Capture(database, { preloadedStablecoinsCache });
        expect(finalized.input.liveReserveMap[assetId]).toEqual(composition.slices);
        expect(Object.keys(finalized.input.redemptionBackstopMap).sort()).toEqual([assetId, peer.stablecoinId].sort());
        expect(finalized.input.redemptionBackstopMap[assetId].reserveInput).toEqual(entry.reserveInput);
        expect(finalized.input.redemptionLossOutcomesByAssetId?.[assetId]).toBeUndefined();
        expect(finalized.input.liveReserveProvenanceMap[assetId].fetchedAt).toBe(fetchedAt);
      }
      expect(sqlite.prepare("SELECT fetched_at, attempt_id FROM reserve_composition WHERE stablecoin_id = ?").get(assetId))
        .toEqual({ fetched_at: fetchedAt, attempt_id: composition.attemptId });
      expect(sqlite.prepare("SELECT COUNT(*) AS count FROM reserve_composition_history WHERE stablecoin_id = ?").get(assetId))
        .toEqual({ count: 1 });
    } finally { sqlite.close(); }
  });

  it.each([true, false])("captures stale census losses without changing the global hold (binding valid: %s)", async (bindingValid) => {
    const sqlite = createLatestSchemaSqlite().sqlite;
    try {
      const database = createSqliteD1(sqlite);
      const realStore = await vi.importActual<typeof RedemptionStoreModule>("../redemption-backstops-store");
      const runClock = NOW_SEC - 8 * 3600 - 1;
      const assetId = "iusd-infinifi";
      const runId = "redemption:stale-census";
      const entry = makeRedemptionWriteRecord({
        stablecoinId: assetId, updatedAt: runClock, routeFamily: getRedemptionBackstopConfig(assetId)!.routeFamily,
      });
      const reserveInput = {
        generationId: "reserve:stale-census", contentSha256: "a".repeat(64), stablecoinId: assetId, attemptId: "success",
        configFingerprint: computeLiveReserveConfigFingerprint(ACTIVE_META_BY_ID.get(assetId)!.liveReservesConfig!),
        freshness: assessReserveFetchFreshness({
          fetchedAt: runClock - 60, attemptId: "success", metadata: { freshnessMode: "not-applicable" },
        }, runClock, 172800),
      };
      entry.reserveInput = reserveInput;
      const peer = makeRedemptionWriteRecord({ stablecoinId: "usdc-circle", updatedAt: runClock, score: 0 });
      await realStore.upsertRedemptionBackstopSnapshots(database, [entry, peer], {
        runId,
        metadata: bindingValid ? {
          reserveViewSchemaVersion: 2, reserveGenerationId: reserveInput.generationId,
          reserveContentSha256: reserveInput.contentSha256, runClockSec: runClock,
          consumedReserveInputs: { [assetId]: reserveInput },
        } : {},
      });
      mocks.loadRedemptionBackstopSnapshot.mockImplementation(realStore.loadRedemptionBackstopSnapshot);
      mocks.loadDexLiquiditySnapshot.mockResolvedValue({
        map: Object.fromEntries(ACTIVE_STABLECOINS.map((coin) => [coin.id, { methodologyVersion: "1.0" }])),
        latestUpdatedAt: NOW_SEC,
      });
      const reserves = Object.assign(new Map(ACTIVE_STABLECOINS.filter((coin) =>
        coin.liveReservesConfig !== undefined &&
        getLiveReserveAdapterDefinition(coin.liveReservesConfig.adapter)?.evidenceClass === "independent",
      ).map((coin) => [coin.id, []])), {
        provenanceById: new Map(),
        lossLineageById: new Map([[assetId, {
          latest: null, invalidations: {},
          authority: { attemptId: "success", observedAtSec: runClock - 60, sourceId: reserveInput.configFingerprint },
        }]]),
      });
      mocks.loadFreshIndependentLiveReserveMap.mockResolvedValue(reserves);
      const preloadedStablecoinsCache = stablecoinsCache();
      const loaded = await loadReportCardsSnapshotInputs(database, { preloadedStablecoinsCache });
      expect(loaded.redemptionStale).toBe(true);
      expect(loaded.redemptionSnapshotProvenance.latestUpdatedAt).toBe(runClock);
      expect(loaded.redemptionSnapshotProvenance.runMetadata?.consumedReserveInputs).toEqual(
        bindingValid ? { [assetId]: reserveInput } : undefined,
      );
      expect(loaded.redemptionBackstopMap).toEqual({});
      expect(Object.keys(loaded.redemptionSnapshotProvenance.assetCensus ?? {}).sort()).toEqual([assetId, "usdc-circle"].sort());
      const { input } = await buildNativeSafetyScoreV9Capture(database, { preloadedStablecoinsCache });
      expect(input.redemptionBackstopMap).toEqual({});
      expect(input.inputFreshness.redemptionBackstops).toMatchObject({ updatedAt: runClock, ageSeconds: 28801, stale: true });
      expect(input.v9PublicationInputHealth.redemption).toMatchObject({
        state: bindingValid ? "stale" : "unavailable",
        generationId: runId, updatedAtSec: runClock,
      });
      const affectedAssetIds = Object.keys(input.redemptionLossOutcomesByAssetId ?? {});
      if (bindingValid) {
        expect(input.redemptionGenerationId).toBe("redemption-backstops-unavailable");
        expect(affectedAssetIds.sort()).toEqual([assetId, "usdc-circle"].sort());
        for (const id of affectedAssetIds) {
          expect(input.redemptionLossOutcomesByAssetId![id]).toMatchObject([{
            reason: "output-stale", disposition: "evidential", runId, observedAtSec: runClock, priorEvidence: null,
          }]);
          expect(input.pipelineGapByAssetId?.[id]?.[0].verdict.proof).toMatchObject({
            rejectionCode: "redemption-admission-output-stale", sourceGenerationId: input.redemptionGenerationId,
          });
        }
        expect(input.redemptionLossOutcomesByAssetId?.["usdt-tether"]).toBeUndefined();
      } else {
        expect(affectedAssetIds).toEqual([]);
      }
      const assessment = assessV9Publication({
        inputHealth: input.v9PublicationInputHealth,
        candidate: makeWorkerSafetyScoreV9Publication({ cards: [assetId, "usdc-circle", "usdt-tether"].map((id) => makeWorkerV9Card({ id })) }),
        acceptedPublication: null, coverageFloors: [],
      });
      expect(assessment.decision).toBe("hold");
      expect(assessment.reasons.filter((reason) => reason.code.startsWith("redemption-"))).toEqual(
        bindingValid ? [{ code: "redemption-stale" }] : [{ code: "redemption-unavailable" }],
      );
    } finally {
      sqlite.close();
    }
  });

  it.each([
    { id: "scrvusd-curve", ageSec: 20 * 60 * 60, observedSupplyRatio: 1, unknownChains: [] },
    // r2/data/results/scrvusd-curve.json adds six satellites: the rotating census sweep stays fresh past 48h.
    { id: "scrvusd-curve", ageSec: 48 * 60 * 60 + 1, observedSupplyRatio: 1, unknownChains: [] },
    { id: "scrvusd-curve", ageSec: scrvusdCensusMaxAgeSec + 1, observedSupplyRatio: 0, unknownChains: ["ethereum"] },
    { id: "usdc-circle", ageSec: 72 * 60 * 60, observedSupplyRatio: 1, unknownChains: [] },
  ])("ages deployment census independently of quotes ($id, $ageSec seconds)", async ({
    id, ageSec, observedSupplyRatio, unknownChains,
  }) => {
    const asset = makeStablecoin({
      id,
      contracts: [{ chain: "ethereum", address: "0x111", decimals: 18 }],
      chainCirculating: {
        Ethereum: { current: 100, circulatingPrevDay: 100, circulatingPrevWeek: 100, circulatingPrevMonth: 100 },
      },
    });
    mocks.loadDexLiquiditySnapshot.mockResolvedValue({
      map: { [asset.id]: {} },
      latestUpdatedAt: NOW_SEC - 4 * 60 * 60 - 1,
    });
    const inputs = await loadReportCardsSnapshotInputs(mockD1([{
      match: "FROM dex_liquidity",
      rows: [{
        stablecoin_id: asset.id,
        chain: "ethereum",
        contract_address: "0x111",
        outcome: "observed_pools",
        outcome_observed_at: NOW_SEC - ageSec,
        chain_tvl_json: JSON.stringify({ ethereum: 1_000 }),
      }],
    }]), {
      preloadedStablecoinsCache: {
        ...stablecoinsCache(),
        payload: { peggedAssets: [asset] },
      },
    });

    expect(inputs.dexLiquiditySnapshot.map[asset.id]).toMatchObject({
      deploymentSupplyCoverage: { observedSupplyRatio, unknownChains },
    });
    expect(inputs.liquidityStale).toBe(true);
    expect(inputs.v9PublicationInputHealth.dex.state).toBe("stale");
  });

  it("records a fulfilled but stale DEX scoring snapshot as stale", async () => {
    mocks.loadDexLiquiditySnapshot.mockResolvedValue({
      map: {},
      latestUpdatedAt: 1,
    });

    const inputs = await loadReportCardsSnapshotInputs(db(), {
      preloadedStablecoinsCache: stablecoinsCache(),
    });

    expect(inputs.v9PublicationInputHealth.dex).toEqual({
      state: "stale",
      generationId: "dex-liquidity-1",
      updatedAtSec: 1,
    });
  });

  it("records a rejected DEX scoring load as unavailable", async () => {
    mocks.loadDexLiquiditySnapshot.mockRejectedValue(
      new Error("DEX worker unavailable"),
    );

    const inputs = await loadReportCardsSnapshotInputs(db(), {
      preloadedStablecoinsCache: stablecoinsCache(),
    });

    expect(inputs.v9PublicationInputHealth.dex).toEqual({
      state: "unavailable",
      generationId: null,
      updatedAtSec: null,
    });
  });

  it("preserves applicable redemption and live-reserve loader failures", async () => {
    mocks.loadRedemptionBackstopSnapshot.mockRejectedValue(
      new RedemptionBackstopSnapshotUnavailableError(
        "redemption snapshot unavailable",
      ),
    );
    mocks.loadFreshIndependentLiveReserveMap.mockRejectedValue(
      new Error("live reserves unavailable"),
    );

    const inputs = await loadReportCardsSnapshotInputs(db(), {
      preloadedStablecoinsCache: stablecoinsCache(),
    });

    expect(inputs.v9PublicationInputHealth.redemption).toEqual({
      state: "unavailable",
      generationId: null,
      updatedAtSec: null,
    });
    expect(inputs.v9PublicationInputHealth.liveReserves).toEqual({
      state: "unavailable",
      coverageRatio: null,
    });
  });

  it("records zero coverage for a fulfilled empty independent reserve map", async () => {
    const inputs = await loadReportCardsSnapshotInputs(db(), {
      preloadedStablecoinsCache: stablecoinsCache(),
    });

    expect(inputs.v9PublicationInputHealth.liveReserves).toEqual({
      state: "available",
      coverageRatio: 0,
    });
  });

  it("holds a run whose consumed reserve binding is incompatible without changing the run clock", async () => {
    mocks.loadRedemptionBackstopSnapshot.mockResolvedValue({
      map: { test: { stablecoinId: "test" } }, latestUpdatedAt: NOW_SEC - 60,
      runId: "redemption:actual", methodologyVersion: "redemption:test", reserveInputAssessment: { state: "unavailable", quarantined: {} },
    });
    const inputs = await loadReportCardsSnapshotInputs(db(), { preloadedStablecoinsCache: stablecoinsCache() });
    expect(inputs.redemptionBackstopMap).toEqual({});
    expect(inputs.v9PublicationInputHealth.redemption).toEqual({ state: "unavailable", generationId: "redemption:actual", updatedAtSec: NOW_SEC - 60 });
    expect(inputs.inputFreshness.redemptionBackstops.ageSeconds).toBe(60);
  });

  it("keeps a run current when only individual assets carry inadmissible reserve evidence", async () => {
    const map = { test: { stablecoinId: "test" }, other: { stablecoinId: "other" } };
    mocks.loadRedemptionBackstopSnapshot.mockResolvedValue({
      map, latestUpdatedAt: NOW_SEC - 60, runId: "redemption:actual", methodologyVersion: "redemption:test",
      reserveInputAssessment: { state: "fresh", quarantined: { test: "freshness-unverified" } },
    });
    const inputs = await loadReportCardsSnapshotInputs(db(), { preloadedStablecoinsCache: stablecoinsCache() });
    expect(inputs.redemptionBackstopMap).toEqual(map);
    expect(inputs.v9PublicationInputHealth.redemption.state).toBe("current");
  });

  it("marks a completed empty redemption snapshot as not applicable", async () => {
    const inputs = await loadReportCardsSnapshotInputs(db(), {
      preloadedStablecoinsCache: stablecoinsCache(),
    });

    expect(inputs.v9PublicationInputHealth.redemption).toEqual({
      state: "not-applicable",
      generationId: "redemption:current",
      updatedAtSec: NOW_SEC - 60,
    });
  });
});
