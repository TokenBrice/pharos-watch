import type { PublicHealthAssessment } from "../public-health-assessment";
import { ACTIVE_IDS } from "@shared/lib/stablecoins/registry";
import { STATUS_MISSING_PRICE_THRESHOLDS } from "@shared/lib/status-thresholds";
import { makeHealthyHealthResponse } from "@shared/test-utils/health-fixtures";
import { makeNoopD1 } from "../../test-helpers/noop-d1";
import { mockD1, type MockTableConfig } from "@shared/test-utils/mock-d1";
import { assessD1Capacity } from "@shared/lib/d1-capacity";
import { stableJsonStringifyV1 } from "@shared/lib/stable-json";
import type { ReserveFeedReview } from "@shared/types/live-reserves";
import type { SafetyScoreV9PublicationIdentity } from "@shared/types/safety-score-publication";
import type { V9PublicationHealth } from "@shared/types/report-cards-v9";
import { PUBLIC_STATUS_COMPONENT_IDS, type HealthResponse, type StatusResponse } from "@shared/types/status";
import {
  makeDataQuality,
  makeReserveComposition as makeBaseReserveComposition,
} from "@shared/types/__tests__/status.test-support";
import type { AvailabilityEvaluationInput, DataQualityEvaluationInput } from "../status/evaluation-rules";
import {
  evaluateStablecoinActivePriceCoverage,
  type StablecoinPriceGapReview,
} from "../stablecoin-publication-coverage";
import { EXPECTED_FX_PEG_KEYS } from "../fx-config";
import { fxRatesCacheRows } from "./fx-rate-state.test-support";

export function makePriceCoverageMetadata(
  nowSec: number,
  missingId: string | null,
  consecutive = 2,
  alertEligible = true,
  compact = false,
  marketCapUsd = 88_000_000,
): Record<string, unknown> {
  const activeIds = [...ACTIVE_IDS];
  const missingIds = missingId == null ? [] : [missingId];
  const eligibleIds = alertEligible ? missingIds : [];
  return {
    activePublicationCoverage: {
      complete: true, expectedActiveCount: activeIds.length, presentActiveCount: activeIds.length,
      waivedActiveCount: 0, missingActiveIds: [], waivedActiveIds: [], expiredWaiverIds: [],
    },
    activePriceCoverage: {
      complete: missingId == null, expectedActiveCount: activeIds.length, presentActiveCount: activeIds.length,
      pricedActiveCount: activeIds.length - missingIds.length, missingPriceCount: missingIds.length,
      pricedActiveIds: activeIds.filter((id) => id !== missingId), missingActiveIds: missingIds,
      affectedMarketCapUsd: missingId == null ? 0 : marketCapUsd,
      missingActiveAssets: compact || missingId == null ? [] : [{
        stablecoinId: missingId, symbol: "MISS", marketCapUsd,
        currentPrice: null, currentSource: null, currentObservedAt: null, currentConfidence: null,
        consecutiveMissingGenerations: consecutive, lastAcceptedPrice: 1.001,
        lastAcceptedSource: "pyth", lastAcceptedObservedAt: nowSec - 900 * consecutive,
        rejectionReason: "no-accepted-price", alertEligible,
      }],
      ...(compact ? { missingActiveState: [[missingId, consecutive, 0.999, "redstone", nowSec - 3_600, "no-accepted-price"]] } : {}),
      alertEligibleCount: eligibleIds.length, alertEligibleIds: eligibleIds,
      maxConsecutiveMissingGenerations: missingId == null ? 0 : consecutive,
    },
  };
}

export function makePublicHealth(
  overallStatus: PublicHealthAssessment["overallStatus"] = "healthy",
  overrides: Partial<PublicHealthAssessment> = {},
): PublicHealthAssessment {
  const healthy = makeHealthyHealthResponse();

  return {
    dbHealthy: true,
    overallStatus,
    statusExcludingCacheFreshness: "healthy",
    statusExcludingCacheEvidence: "healthy",
    warnings: [],
    caches: {},
    cacheImpactStatus: overallStatus,
    cacheQualityImpactStatus: "healthy",
    worstCacheRatio: 0,
    cacheFailures: [],
    cacheDiagnostics: [],
    cacheWarnings: [],
    blacklist: healthy.blacklist,
    blacklistMetrics: null,
    blacklistQueryError: null,
    mintBurn: healthy.mintBurn,
    mintBurnImpactStatus: "healthy",
    mintBurnQueryError: null,
    mintBurnLastRunStatus: "ok",
    mintBurnBootstrap: false,
    repairRunnerAutoRepairCount: null,
    circuits: {},
    openCircuitCount: 0,
    circuitImpactStatus: "healthy",
    circuitQueryError: null,
    d1Capacity: null,
    d1CapacityImpactStatus: "healthy",
    d1CapacityQueryError: null,
    safetyScorePublication: {
      ...healthy.safetyScorePublication!,
      acceptedAtSec: Math.floor(Date.now() / 1000) - 30,
      attemptedAtSec: Math.floor(Date.now() / 1000) - 30,
    },
    safetyScorePublicationUnavailableReason: null,
    safetyScoreImpactStatus: "healthy",
    stablecoinPublication: {
      status: "complete",
      expectedActiveCount: 0,
      presentActiveCount: 0,
      waivedActiveCount: 0,
      missingActiveIds: [],
      waivedActiveIds: [],
      expiredWaiverIds: [],
      observedAt: null,
    },
    stablecoinPublicationImpactStatus: "healthy",
    activePriceCoverage: {
      status: "complete",
      expectedActiveCount: 0,
      presentActiveCount: 0,
      pricedActiveCount: 0,
      missingPriceCount: 0,
      pricedActiveIds: [],
      missingActiveIds: [],
      affectedMarketCapUsd: 0,
      missingActiveAssets: [],
      alertEligibleCount: 0,
      alertEligibleIds: [],
      maxConsecutiveMissingGenerations: 0,
      observedAt: null,
    },
    activePriceCoverageImpactStatus: "healthy",
    schedulerLiveness: {
      status: "healthy", observedAt: Math.floor(Date.now() / 1000),
      lastAnyStartedAt: Math.floor(Date.now() / 1000) - 30,
      lastFiveMinuteStartedAt: Math.floor(Date.now() / 1000) - 30, ageSeconds: 30,
      warningAfterSec: 600, staleAfterSec: 1200,
      lanes: ["fiveMinuteReserveRecovery", "fiveMinuteTelegramAlerts", "digestTriggerPoll"].map((scheduleKey) => ({
        scheduleKey, lastStartedAt: Math.floor(Date.now() / 1000) - 30,
      })),
      unavailableReason: null,
      heavy: {
        scheduleKey: "v9SupplyAttributionOffset", lastStartedAt: Math.floor(Date.now() / 1000) - 30,
        ageSeconds: 30, warningAfterSec: 1800, staleAfterSec: 2700, status: "healthy", unavailableReason: null,
      },
    },
    schedulerLivenessImpactStatus: "healthy",
    ...overrides,
  };
}

/**
 * Minimal D1 mock that returns a stablecoins cache row and empty results for
 * every other query. Enough to drive `assessPublicHealth` through its cache
 * enrichment path without having to mock every downstream sub-query.
 */
export function makeMinimalDb(
  nowSec: number,
  d1Capacity?: Record<string, unknown>,
  stablecoinPublicationMetadata?: Record<string, unknown>,
): D1Database {
  // P2-08 bound the coverage scan at a seven-day `started_at` fence, so the
  // snapshot read now arrives through `bind()`.
  const firstFor = async <T>(sql: string) => {
    if (sql === "SELECT 1") return { "1": 1 } as T;
    if (d1Capacity && sql.includes("SELECT value, updated_at FROM cache WHERE key = ?")) {
      return {
        value: JSON.stringify({ version: 1, assessment: d1Capacity }),
        updated_at: nowSec,
      } as T;
    }
    if (stablecoinPublicationMetadata && sql.includes("job = 'sync-stablecoins'")) {
      return {
        started_at: nowSec - 30,
        metadata: JSON.stringify(stablecoinPublicationMetadata),
      } as T;
    }
    return null as T | null;
  };
  return makeNoopD1({
    prepare: (sql: string) => ({
      bind: (..._args: unknown[]) => ({
        all: async <T>() => {
          if (sql.includes("cache WHERE key IN")) {
            return {
              results: [{ key: "stablecoins", updated_at: nowSec - 60 }] as T[],
              success: true,
              meta: {},
            };
          }
          return { results: [] as T[], success: true, meta: {} };
        },
        first: async <T>() => firstFor<T>(sql),
        run: async () => ({ success: true, meta: {} }),
      }),
      all: async <T>() => ({ results: [] as T[], success: true, meta: {} }),
      first: async <T>() => firstFor<T>(sql),
      run: async () => ({ success: true, meta: {} }),
    }),
    batch: async () => [],
    exec: async () => ({ count: 0, duration: 0 }),
    dump: async () => new ArrayBuffer(0),
  });
}

export function makeMintBurnAssessmentDb(
  nowSec: number,
  options: {
    latestRunStatus?: string | null;
    latestSuccessfulSyncAt?: number | null;
    latestSuccessfulSyncError?: unknown;
    rowCount?: number | null;
    rowCountError?: unknown;
    publicationMetadata?: Record<string, unknown>;
    publicationQueryError?: unknown;
    yieldSafetyError?: unknown;
    yieldSafetyIdentity?: SafetyScoreV9PublicationIdentity;
    /** Overrides the readable `$.identity` extraction, e.g. a newer build's envelope. */
    liveIdentityEnvelope?: Record<string, unknown> | null;
    yieldSafetyPublishedAt?: number | null;
    yieldPublishedAt?: number;
    yieldSafetyLiveReadError?: unknown;
    yieldSafetyHealthReadError?: unknown;
    safetyScorePublication?: V9PublicationHealth | null;
    producerHistoryError?: unknown;
    blacklistError?: unknown;
    blacklistAggregate?: { total: number; missing: number; missing_recent: number; classification_missing?: number; classification_watch?: number };
    dbError?: unknown;
    dbSentinelMissing?: boolean;
    cacheError?: unknown;
    circuitError?: unknown;
    latestRunError?: unknown;
    fxFutureSec?: number;
    cacheMissing?: boolean;
  } = {},
): D1Database {
  const latestRunStatus = options.latestRunStatus !== undefined ? options.latestRunStatus : "ok";
  const latestSuccessfulSyncAt =
    options.latestSuccessfulSyncAt !== undefined ? options.latestSuccessfulSyncAt : nowSec - 300;
  const rowCount = options.rowCount !== undefined ? options.rowCount : 4321;
  const safetyScorePublication = options.safetyScorePublication === undefined ? {
    schemaVersion: 2 as const,
    status: "current" as const,
    acceptedPublicationGenerationId: options.yieldSafetyIdentity?.publicationGenerationId ?? "fixture-safety-publication",
    acceptedAtSec: nowSec - 60,
    attemptedAtSec: nowSec - 60,
    heldSinceSec: null,
    reasons: [],
  } : options.safetyScorePublication;
  const cacheRows = [
    { key: "stablecoins", updated_at: nowSec - 60, value: "{}" },
    { key: "stablecoin-charts", updated_at: nowSec - 60, value: "{}" },
    { key: "usds-status", updated_at: nowSec - 60, value: "{}" },
    ...fxRatesCacheRows(nowSec - 60 + (options.fxFutureSec ?? 0), Object.fromEntries(EXPECTED_FX_PEG_KEYS.map((key) => [key, 1]))),
    {
      key: "ops:d1-capacity:v1",
      updated_at: nowSec,
      value: JSON.stringify({ version: 1, assessment: assessD1Capacity({ observedAt: nowSec, databaseSizeBytes: 1_000_000_000 }) }),
    },
    { key: "freshness:dex-liquidity", updated_at: nowSec - 60, value: JSON.stringify({ updatedAt: nowSec - 60, source: "sync-dex-liquidity", publishStatus: "ok", generationId: "fixture-generation" }), served_generation_id: "fixture-generation" },
    { key: "freshness:yield-data", updated_at: nowSec - 60, value: JSON.stringify({ updatedAt: nowSec - 60, source: "sync-yield-data", publishStatus: "ok", generationId: "fixture-generation" }), served_generation_id: "fixture-generation" },
    { key: "freshness:dews", updated_at: nowSec - 60, value: JSON.stringify({ updatedAt: nowSec - 60, source: "compute-dews", publishStatus: "ok", generationId: "fixture-generation" }), served_generation_id: "fixture-generation" },
  ];
  const timestampLookup: MockTableConfig = {
    match: "as started_at FROM cron_runs",
    matchBinds: ["sync-mint-burn"],
    rows: [],
    ...(options.latestSuccessfulSyncError
      ? { throwError: options.latestSuccessfulSyncError }
      : { first: { started_at: latestSuccessfulSyncAt } }),
  };
  const rowCountLookup: MockTableConfig = {
    match: "item_count",
    matchBinds: ["cron-sentinel", "mint-burn-growth-watchdog"],
    rows: [],
    ...(options.rowCountError
      ? { throwError: options.rowCountError }
      : {
          first: rowCount == null ? null : {
            job: "mint-burn-growth-watchdog",
            item_count: rowCount,
            metadata: JSON.stringify({ rowCount }),
          },
        }),
  };

  const liveIdentityEnvelope = options.liveIdentityEnvelope !== undefined
    ? options.liveIdentityEnvelope
    : options.yieldSafetyIdentity ? {
        candidateId: "fixture-candidate",
        policyVersion: options.yieldSafetyIdentity.methodologyVersion,
        publicationGenerationId: options.yieldSafetyIdentity.publicationGenerationId,
        baseInputGenerationId: options.yieldSafetyIdentity.baseInputGenerationId,
        factSetDigest: "d".repeat(64),
        policyId: options.yieldSafetyIdentity.policyId,
        policyDigest: options.yieldSafetyIdentity.policyDigest,
        evaluationBuildDigest: options.yieldSafetyIdentity.evaluationBuildDigest,
        resultDigest: "e".repeat(64),
      } : null;

  return mockD1([
    { match: "AS last_any", rows: [], first: { observed_at: nowSec, last_any: nowSec - 30, reserve: nowSec - 30, telegram: nowSec - 30, digest: nowSec - 30, heavy: nowSec - 30 } },
    {
      match: "job = 'sync-stablecoins'", rows: [],
      ...(options.publicationQueryError
        ? { throwError: options.publicationQueryError }
        : {
            first: options.publicationMetadata
              ? { started_at: nowSec - 30, metadata: JSON.stringify(options.publicationMetadata) }
              : null,
          }),
    },
    { match: "blacklist-gap-aggregate", rows: [], first: options.blacklistAggregate ?? { total: 0, missing: 0, missing_recent: 0 }, ...(options.blacklistError ? { throwError: options.blacklistError } : {}) },
    { match: "SELECT 1", rows: [], first: options.dbSentinelMissing ? null : { value: 1 }, ...(options.dbError ? { throwError: options.dbError } : {}) },
    { match: "cache WHERE key IN", rows: options.cacheMissing ? cacheRows.filter((row) => row.key !== "stablecoins") : cacheRows,
      ...(options.cacheError ? { throwError: options.cacheError } : {}) },
    {
      match: "SELECT value, updated_at FROM cache WHERE key = ?",
      matchBinds: ["ops:d1-capacity:v1"],
      rows: [],
      first: cacheRows.find((row) => row.key === "ops:d1-capacity:v1"),
    },
    {
      match: "SELECT value, updated_at FROM cache WHERE key = ?",
      matchBinds: ["report-cards:v9:publication-health"],
      rows: [],
      ...(options.yieldSafetyHealthReadError
        ? { throwError: options.yieldSafetyHealthReadError }
        : {
            first: safetyScorePublication ? {
              value: stableJsonStringifyV1(safetyScorePublication),
              updated_at: safetyScorePublication.attemptedAtSec,
            } : null,
          }),
    },
    {
      match: "AS publication_identity",
      matchBinds: ["report-cards:v9"],
      rows: [],
      ...(options.yieldSafetyLiveReadError
        ? { throwError: options.yieldSafetyLiveReadError }
        : {
            first: liveIdentityEnvelope ? {
              publication_identity: JSON.stringify(liveIdentityEnvelope),
            } : null,
          }),
    },
    { match: "SELECT value, updated_at FROM cache WHERE key = ?", rows: [], first: null },
    {
      match: "stamped_identity",
      matchBinds: ["yield-rankings"],
      rows: [],
      ...(options.yieldSafetyError
        ? { throwError: options.yieldSafetyError }
        : {
            first: options.yieldSafetyIdentity ? {
              updated_at: options.yieldPublishedAt ?? nowSec - 60,
              stamped_identity: JSON.stringify(options.yieldSafetyIdentity),
              safety_published_at: options.yieldSafetyPublishedAt === undefined ? nowSec - 60 : options.yieldSafetyPublishedAt,
            } : null,
          }),
    },
    { match: "SELECT key, value FROM cache WHERE key >= 'circuit:' AND key < 'circuit;'", rows: [], ...(options.circuitError ? { throwError: options.circuitError } : {}) },
    { match: "blacklist-gap-metrics-cache-read", rows: [], first: null },
    {
      match: "GROUP BY job",
      rows: ["sync-dex-liquidity", "sync-yield-data", "compute-dews"].map((job) => ({
        job, started_at: nowSec - 60, generation_id: "fixture-generation", degraded_runs_since_ok: 0,
      })),
      ...(options.producerHistoryError ? { throwError: options.producerHistoryError } : {}),
    },
    {
      match: "SELECT status",
      matchBinds: ["sync-mint-burn"],
      rows: [],
      first: latestRunStatus == null ? null : { status: latestRunStatus },
      ...(options.latestRunError ? { throwError: options.latestRunError } : {}),
    },
    timestampLookup,
    rowCountLookup,
    { match: "FROM cron_runs", rows: [], first: null },
  ]);
}

export function makeReserveComposition(overrides?: Partial<Exclude<StatusResponse["reserveComposition"], { status: "unavailable" }>>): Exclude<StatusResponse["reserveComposition"], { status: "unavailable" }> {
  return makeBaseReserveComposition({
    configuredCoins: 10, freshCoins: 10, independentFreshEligible: 4, independentFreshUnverified: 2,
    staticValidatedFresh: 2, weakProbeFresh: 2, lastSuccessAt: 1_700_000_000, oldestFreshAgeSec: 3600,
    freshCoverageRatio: 1, authoritativeFreshCoverageRatio: 0.8, ...overrides,
  });
}

export function makeAvailabilityCauseInput(publicHealth: PublicHealthAssessment) {
  return {
    publicHealth, availabilityImpactingUnhealthyCrons: 0, watchUnhealthyCrons: 0, degradedCronRuns: 0,
    cronErrorCount: 0, availabilityImpactingCronErrors: 0, availabilityImpactingConsecutiveCronErrors: 0,
    cronHistoryQueryFailed: false, cronProgressQueryFailed: false, cronLeaseQueryFailed: false,
  };
}

export function makeAvailabilityEvaluationInput(overrides: Partial<AvailabilityEvaluationInput> = {}): AvailabilityEvaluationInput {
  return { ...makeAvailabilityCauseInput(overrides.publicHealth ?? makePublicHealth()), ...overrides };
}

export function makeDataQualityEvaluationInput(overrides: Partial<DataQualityEvaluationInput> = {}): DataQualityEvaluationInput {
  const publicHealth = makePublicHealth();
  return {
    nowSec: 1_700_000_000, dataQuality: makeDataQuality(), repairRunnerAutoRepairCount: null,
    activePriceCoverage: publicHealth.activePriceCoverage, missingPriceRatio: 0, blacklistMissingRatio: 0,
    blacklistRecentMissing: 0, onchainAssessment: { status: "healthy", causes: [], representative: false },
    onchainAssessmentCauses: [], reserveCompositionQueryFailed: false, reserveComposition: makeReserveComposition(),
    reserveCompositionStatus: "healthy", redemptionCapacityCoverage: null, activePriceCoverageImpactStatus: "healthy", ...overrides,
  };
}

export function createReviewExpiryReminderHelpers(nowSec: number) {
  const priceReview = (stablecoinId: string, remainingSec: number): StablecoinPriceGapReview => ({
    stablecoinId, owner: "ops", reason: "Reviewed missing-price evidence.",
    sources: ["https://example.com/price-evidence"], reviewedAt: nowSec - 86400, expiresAt: nowSec + remainingSec,
  });
  const priceInput = (reviews: StablecoinPriceGapReview[], coverageClock = nowSec, price: number | null = null): DataQualityEvaluationInput => {
    const ev = evaluateStablecoinActivePriceCoverage(reviews.map((r) => ({ id: r.stablecoinId, price })), reviews.map((r) => r.stablecoinId), { nowSec: coverageClock, priceGapReviews: reviews });
    return makeDataQualityEvaluationInput({ nowSec, activePriceCoverage: { ...ev, status: ev.complete ? "complete" : "incomplete", observedAt: coverageClock } });
  };
  const reserveReview = (stablecoinId: string, remainingSec: number): ReserveFeedReview => ({
    stablecoinId, adapterKey: "accountable", failureCategory: "unknown", warningCodes: [],
    errorPrefix: "primary:http-json: accountable:stale-portfolio-timestamp", owner: "ops", reason: "Reviewed stale portfolio evidence.",
    sources: [{ url: "https://example.com/reserve-evidence", evidenceDate: "2023-11-13" }], reviewedAt: nowSec - 86400, expiresAt: nowSec + remainingSec,
  });
  const reserveInput = (reviews: ReserveFeedReview[]): DataQualityEvaluationInput =>
    makeDataQualityEvaluationInput({ nowSec, reserveComposition: makeReserveComposition({ acknowledgedFeedIds: reviews.map((r) => r.stablecoinId), acknowledgedFeeds: reviews }) });
  return { priceReview, priceInput, reserveReview, reserveInput };
}

export function makeG4ListingOmissionFixture(nowSec: number, expectedActiveCount: number, missingIds: readonly string[], retainedCapUsd = 5_000_000): {
  dataQualityInput: DataQualityEvaluationInput; publicHealthInput: HealthResponse;
} {
  const evaluated = evaluateStablecoinActivePriceCoverage([], [...missingIds], {
    nowSec,
    previousAcceptedAssetsById: new Map(missingIds.map((id) => [id, { id, circulating: { peggedUSD: retainedCapUsd }, supplyObservedAt: nowSec - 900 }])),
  });
  const stablecoinPublication = {
    status: "incomplete" as const, expectedActiveCount, presentActiveCount: expectedActiveCount - missingIds.length,
    waivedActiveCount: 0, missingActiveIds: [...missingIds], waivedActiveIds: [] as string[], expiredWaiverIds: [] as string[], observedAt: nowSec,
  };
  return {
    dataQualityInput: makeDataQualityEvaluationInput({
      nowSec, dataQuality: makeDataQuality({ stablecoinPublication }),
      activePriceCoverage: { ...evaluated, status: "incomplete", observedAt: nowSec },
    }),
    publicHealthInput: { ...makeHealthyHealthResponse(), stablecoinPublication },
  };
}

export function makeG4PriceGapCoverage(
  roster: readonly string[], nowSec: number, missingCount: number, generations: 1 | 2,
  options: { extraTransientCount?: number; boostFirstCapUsd?: number } = {},
): PublicHealthAssessment["activePriceCoverage"] {
  const first = evaluateStablecoinActivePriceCoverage(roster.slice(missingCount).map((id) => ({ id, price: 1, priceSource: "coingecko" })), [...roster], { nowSec: nowSec - 900 });
  const evaluated = generations === 1
    ? first
    : evaluateStablecoinActivePriceCoverage(roster.slice(missingCount + (options.extraTransientCount ?? 0)).map((id) => ({ id, price: 1, priceSource: "coingecko" })), [...roster], { nowSec, previousCoverage: first });
  const missingActiveAssets = evaluated.missingActiveAssets.map((a, i) =>
    i === 0 && options.boostFirstCapUsd != null
      ? { ...a, marketCapUsd: options.boostFirstCapUsd, consecutiveMissingGenerations: STATUS_MISSING_PRICE_THRESHOLDS.generationsElevated + 4 }
      : a);
  return { ...evaluated, missingActiveAssets, status: "incomplete", observedAt: nowSec };
}

export function makeG4OperationalPublicPrior(nowSec: number) {
  return new Map(PUBLIC_STATUS_COMPONENT_IDS.map((id) => [id, { state: "operational" as const, since: nowSec - 3_600, reasons: [] as string[], summary: "" }]));
}

export function makeG4ReserveSteadyStateComposition(configuredCoins: number, failed: number) {
  return makeReserveComposition({
    configuredCoins, freshCoins: configuredCoins - 10 - failed, errorCoins: failed, degradedCoins: 6, healthDegradedCoins: 0, missingCoins: 4,
    independentFreshEligible: 220, independentFreshUnverified: 40, staticValidatedFresh: 30, weakProbeFresh: configuredCoins - 300 - failed,
  });
}

export function makeG4ReserveNoHistoryComposition(configuredCoins: number) {
  return makeReserveComposition({
    configuredCoins, freshCoins: 0, errorCoins: 0, degradedCoins: 0, healthDegradedCoins: 0, missingCoins: configuredCoins,
    independentFreshEligible: 0, independentFreshUnverified: 0, staticValidatedFresh: 0, weakProbeFresh: 0,
    lastSuccessAt: null, oldestFreshAgeSec: null, freshCoverageRatio: 0, authoritativeFreshCoverageRatio: 0, acknowledgedFeedIds: [],
  });
}
