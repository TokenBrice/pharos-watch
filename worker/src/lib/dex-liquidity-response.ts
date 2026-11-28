import { logWorkerEventArgs } from "./structured-log";
import { safeJsonParse } from "./api-cache-read";
import { assessFreshnessTimestamp } from "./api-freshness-age";
import { STAGED_POOL_PRICE_MAX_AGE_HOURS } from "./dex-cron-constants";
import { API_CACHE_PROFILES as CACHE_PROFILES } from "@shared/lib/api-cache-profiles";
import { CURVE_NAV_SPOT_QUOTE_POLICY } from "../cron/dex-liquidity/types";
import {
  assessClockedCurveNavPayload,
  getDexAggregateObservedAt,
  isClockedCurveNavPayload,
  mapClockedCurveNavReasonToApiUnavailableReason,
  validateClockedCurveNavCaptureRecord,
} from "./depeg-trust-policy";
import type { TvlComparisonUnavailableReason } from "@shared/types/stress";
import { CURRENT_DEPLOYMENT_KEYS, deploymentKey, normalizeDexLiquidityEvidence } from "./dex-liquidity";
import { DexLiquidityCronMetadataSchema } from "./schemas";
import {
  DexExitRouteObservationsSchema,
  ExitRouteObservationCoverageSchema,
  type ExitRouteObservation,
  type ExitRouteObservationCoverage,
} from "@shared/types/exit-route";
import {
  DexPermanentLiquiditySchema,
  FluidSwapStatusSchema,
  DexEffectiveDepthSchema,
  type DexEffectiveDepth,
  DexPoolVolumeObservationSchema,
  LiquidityScoreUnavailableReasonSchema,
  type LiquidityPoolSourceFamily,
  type LiquidityScoreUnavailableReason,
} from "@shared/types/dex-liquidity";
import {
  DexRetiredSolidlyLegacyModelSchema,
} from "@shared/types/dex-execution-legacy";
import { CHAIN_META } from "@shared/types/chain-identity";
import { canonicalExitRouteChain } from "@shared/types/exit-route-identity";
import { toErrorMessage } from "@shared/lib/error-utils";
import {
  DEX_DISCOVERY_PROVIDER_REGISTRY,
  DEX_UNSUPPORTED_CHAIN_WAIVER_REASON,
  getDexDiscoveryProviders,
} from "@shared/lib/dex-deployment-coverage";
import { liquidityTvlBasisEpoch } from "@shared/lib/dex-liquidity-evidence";
import { parseDexVolumeAvailabilityRecord } from "@shared/lib/dex-volume-availability";

const TREND_BASELINE_CONFIDENCE_MIN = 0.5;
const TREND_24H_TOLERANCE_SEC = 12 * 3600;
const TREND_7D_TOLERANCE_SEC = 36 * 3600;


export interface DexHistoryRow {
  stablecoin_id: string;
  total_tvl_usd: number;
  snapshot_date: number;
  coverage_class: string | null;
  coverage_confidence: number | null;
  methodology_version: string | null;
  volume_availability_json?: string | null;
  exit_route_summary_json?: string | null;
}

export interface DexPriceRow {
  stablecoin_id: string;
  dex_price_usd: number;
  deviation_from_primary_bps: number | null;
  source_pool_count: number;
  source_total_tvl: number;
  price_sources_json: string | null;
  updated_at: number;
}

export interface DexPriceAdmission {
  pricePayload: unknown;
  priceAgeSeconds: number | null;
  priceMaxAgeSec: number;
  unavailableReason: string | null;
  clockedCurveNav: boolean;
  priceRemainingSec: number | null;
  quotePublishedAtSec: number | null;
  clockedCurveNavPoolIds: ReadonlySet<string>;
}

/**
 * Bound a cacheable `Cache-Control` header (`s-maxage` and `max-age`) by the
 * earliest remaining NAV quote lifetime, emitting `no-store` when `<= 0`.
 */
export function boundCacheControlMaxAge(cacheControl: string, maxLifetimeSec: number): string {
  if (/\b(?:no-store|no-cache|private)\b/i.test(cacheControl)) return cacheControl;
  const boundedSec = Number.isFinite(maxLifetimeSec) ? Math.floor(maxLifetimeSec) : 0;
  if (boundedSec <= 0) return CACHE_PROFILES.noStore;
  return cacheControl.replace(/\b(s-maxage|max-age)\s*=\s*(\d+)/gi, (_match, directive: string, value: string) => {
    const existing = Number(value);
    const next = Number.isFinite(existing) ? Math.min(existing, boundedSec) : boundedSec;
    return `${directive}=${Math.max(1, next)}`;
  });
}

/**
 * Prices are a separate publication; the liquidity row's clock cannot admit
 * them. Both writers stamp the orchestrator's syncStartSec, so any drift
 * between the two clocks is a publication mismatch.
 */
export function admitDexPriceRow(
  priceRow: Pick<DexPriceRow, "updated_at" | "price_sources_json"> | undefined,
  liquidityUpdatedAt: number,
  nowSec: number,
  logContext: string,
): DexPriceAdmission {
  const pricePayload = safeJsonParse<unknown>(priceRow?.price_sources_json, null, logContext);
  const clockedCurveNav = isClockedCurveNavPayload(pricePayload);
  const priceMaxAgeSec = clockedCurveNav
    ? CURVE_NAV_SPOT_QUOTE_POLICY.quoteMaxAgeSec
    : STAGED_POOL_PRICE_MAX_AGE_HOURS * 3600;
  const { aggregateObservedAt, aggregateClockReason } = getDexAggregateObservedAt(pricePayload, nowSec, "display");
  const publicationAge = clockedCurveNav
    ? assessFreshnessTimestamp(nowSec, priceRow?.updated_at, 0)
    : assessFreshnessTimestamp(nowSec, priceRow?.updated_at);
  const priceAge = clockedCurveNav
    ? assessFreshnessTimestamp(nowSec, aggregateObservedAt, 0)
    : assessFreshnessTimestamp(nowSec, aggregateObservedAt);
  const isAgeStale = (ageSeconds: number) =>
    clockedCurveNav ? ageSeconds >= priceMaxAgeSec : ageSeconds > priceMaxAgeSec;
  const captureAssessment = clockedCurveNav
    ? assessClockedCurveNavPayload(pricePayload, {
        nowSec,
        publicationUpdatedAt: priceRow?.updated_at,
        aggregateObservedAt,
      })
    : null;
  const unavailableReason = !priceRow ? "missing-price"
    : publicationAge.reason != null ? publicationAge.reason
    : isAgeStale(publicationAge.ageSeconds) ? "stale-price"
    : priceRow.updated_at !== liquidityUpdatedAt ? "publication-mismatch"
    : aggregateClockReason === "aggregate-clock-invalid" ? "invalid-timestamp"
    : aggregateClockReason === "aggregate-clock-future" ? "future-timestamp"
    : priceAge.reason != null ? priceAge.reason
    : isAgeStale(priceAge.ageSeconds) ? "stale-price"
    : captureAssessment?.reason != null
      ? mapClockedCurveNavReasonToApiUnavailableReason(captureAssessment.reason)
    : null;
  const priceRemainingSec =
    clockedCurveNav && unavailableReason == null && captureAssessment?.earliestClockSec != null
      ? captureAssessment.earliestClockSec + priceMaxAgeSec - nowSec
      : null;
  return {
    pricePayload,
    priceAgeSeconds: priceAge.ageSeconds,
    priceMaxAgeSec,
    unavailableReason,
    clockedCurveNav,
    priceRemainingSec,
    quotePublishedAtSec: captureAssessment?.quotePublishedAtSec ?? null,
    clockedCurveNavPoolIds: new Set(captureAssessment?.poolIds ?? []),
  };
}

export interface DexLiquidityCronRow {
  status: string;
  metadata: string | null;
}

export interface DexDeploymentOutcomeRow {
  stablecoin_id: string;
  chain: string;
  contract_address: string;
  outcome: "observed_pools" | "verified_no_pools" | "provider_inaccessible";
  provider_set_json: string;
  reason: string;
  observed_pool_count: number;
  observed_at: number;
  waiver_owner: string | null;
  waiver_reason: string | null;
  waiver_expires_at: number | null;
}

export interface NormalizedDexScoreDetails {
  effectiveDepth?: DexEffectiveDepth;
  scoreComponents: unknown;
  exitRouteObservations: ExitRouteObservation[] | null;
  exitRouteObservationCoverage: ExitRouteObservationCoverage;
  /** Producer-recorded NR reason; null when absent (rated, or scored before it was recorded). */
  liquidityScoreUnavailableReason: LiquidityScoreUnavailableReason | null;
}

const UNKNOWN_EXIT_ROUTE_COVERAGE: ExitRouteObservationCoverage = {
  status: "unknown",
  capabilityMatrixVersion: "unknown",
  retainedPoolCount: 0,
  observationCount: 0,
  scoreEligibleObservationCount: 0,
  unsupportedPoolCount: 0,
  evidenceCounts: {},
  unsupportedReasons: { producerEnvelopeAbsent: 1 },
};

const SCORE_COMPONENT_KEYS = ["tvlDepth", "volumeActivity", "poolQuality", "durability", "pairDiversity"] as const;

function projectLegacyScoreComponents(details: Record<string, unknown>): Record<string, number | null> | null {
  const projected: Record<string, number | null> = {};
  for (const key of SCORE_COMPONENT_KEYS) {
    const value = details[key];
    // DEC-19: an unavailable activity component is an explicit null; the valid
    // components stay displayable. Every other component must be finite.
    if (key === "volumeActivity" && value === null) {
      projected[key] = null;
      continue;
    }
    if (typeof value !== "number" || !Number.isFinite(value)) return null;
    projected[key] = value;
  }
  return projected;
}

export function normalizeDexScoreDetails(
  json: string | null,
  context = "dex-liquidity-response:score_components_json",
): NormalizedDexScoreDetails {
  const parsed = safeJsonParse<unknown>(json, null, context);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return {
      scoreComponents: parsed,
      exitRouteObservations: null,
      exitRouteObservationCoverage: UNKNOWN_EXIT_ROUTE_COVERAGE,
      liquidityScoreUnavailableReason: null,
    };
  }

  const details = parsed as Record<string, unknown>;
  const observations = DexExitRouteObservationsSchema.safeParse(details.exitRouteObservations);
  const coverage = ExitRouteObservationCoverageSchema.safeParse(details.exitRouteObservationCoverage);
  const depth = DexEffectiveDepthSchema.safeParse(details.effectiveDepth);
  const unavailableReason = LiquidityScoreUnavailableReasonSchema.safeParse(details.liquidityScoreUnavailableReason);
  return {
    ...(depth.success ? { effectiveDepth: depth.data } : {}),
    scoreComponents: projectLegacyScoreComponents(details),
    exitRouteObservations: observations.success ? observations.data : null,
    exitRouteObservationCoverage: coverage.success ? coverage.data : UNKNOWN_EXIT_ROUTE_COVERAGE,
    liquidityScoreUnavailableReason: unavailableReason.success ? unavailableReason.data : null,
  };
}

const DEX_DISCOVERY_PROVIDER_IDS = new Set<string>(
  DEX_DISCOVERY_PROVIDER_REGISTRY.map((provider) => provider.providerId),
);

/**
 * Read a persisted provider scope with the same admission as the census
 * reader. Unreadable or invalid evidence returns null instead of an
 * affirmative empty provider list.
 */
function parsePersistedProviderSet(json: string, context: string): string[] | null {
  const parsed = safeJsonParse<unknown>(json, null, context);
  return Array.isArray(parsed)
    && new Set(parsed).size === parsed.length
    && parsed.every((provider) => typeof provider === "string" && DEX_DISCOVERY_PROVIDER_IDS.has(provider))
    ? parsed as string[]
    : null;
}

export function buildDexDeploymentCoverage(rows: readonly DexDeploymentOutcomeRow[], nowSec: number) {
  const byStablecoin = new Map<
    string,
    {
      observedPools: number;
      verifiedNoPools: number;
      providerInaccessible: number;
      deployments: Array<Record<string, unknown>>;
    }
  >();
  for (const row of rows) {
    // Rows keyed under a superseded identity (pre-canonical lowercase non-EVM
    // addresses) are not deployments; counting them double-reports one mint.
    // loadDexLiquiditySnapshot already applies this same registry filter.
    if (!CURRENT_DEPLOYMENT_KEYS.has(deploymentKey(row.stablecoin_id, row.chain, row.contract_address))) {
      continue;
    }
    const providers = parsePersistedProviderSet(
      row.provider_set_json,
      `dex-liquidity:${row.stablecoin_id}:${row.chain}:providers`,
    );
    // The census classifies the same unreadable row invalid and excludes it;
    // publishing a deployment with an invented provider scope would disagree.
    if (providers == null) continue;
    const coverage = byStablecoin.get(row.stablecoin_id) ?? {
      observedPools: 0,
      verifiedNoPools: 0,
      providerInaccessible: 0,
      deployments: [],
    };
    if (row.outcome === "observed_pools") coverage.observedPools++;
    else if (row.outcome === "verified_no_pools") coverage.verifiedNoPools++;
    else coverage.providerInaccessible++;
    const waiverActive = row.waiver_expires_at != null && row.waiver_expires_at > nowSec && !!row.waiver_owner &&
      // Unsupported-chain waivers persisted before a provider registration are
      // superseded immediately, without waiting for the crawl rotation.
      (row.waiver_reason !== DEX_UNSUPPORTED_CHAIN_WAIVER_REASON ||
        getDexDiscoveryProviders(row.chain, row.contract_address).length === 0);
    coverage.deployments.push({
      chain: row.chain,
      contractAddress: row.contract_address,
      outcome: row.outcome,
      providers,
      reason: row.reason,
      observedPoolCount: row.observed_pool_count,
      observedAt: row.observed_at,
      waiver: waiverActive
        ? {
            owner: row.waiver_owner,
            reason: row.waiver_reason,
            expiresAt: row.waiver_expires_at,
          }
        : null,
    });
    byStablecoin.set(row.stablecoin_id, coverage);
  }
  return byStablecoin;
}

type DexLiquidityPoolResponse = {
  source?: string;
} & Record<string, unknown>;

function normalizePoolSource(source: unknown): LiquidityPoolSourceFamily | undefined {
  if (typeof source !== "string" || source.length === 0) return undefined;
  if (
    source === "dl" ||
    source === "cg_onchain" ||
    source === "gecko_terminal" ||
    source === "dexscreener" ||
    source === "cg_tickers" ||
    source === "horizon" ||
    source === "aquarius" ||
    source === "tezos" ||
    source === "icon-balanced" ||
    source === "kava-swap" ||
    source === "osmosis-sqs" ||
    source === "noble-swap" ||
    source === "sundaeswap" ||
    source === "direct_api"
  ) {
    return source;
  }
  return undefined;
}

function pickAllowedKeys(obj: Record<string, unknown>, allowed: Set<string>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of allowed) {
    if (obj[key] !== undefined) out[key] = obj[key];
  }
  return out;
}
function toChainDisplay(chain: unknown): unknown {
  if (typeof chain !== "string") return chain;
  const canonical = canonicalExitRouteChain(chain);
  return CHAIN_META[canonical]?.name ?? chain;
}

const ALLOWED_POOL_KEYS = new Set<string>([
  "project",
  "chain",
  "symbol",
  "poolType",
  "tvlUsd",
  "volumeUsd1d",
  "volumeUsd7d",
  "price",
  "source",
]);
const ALLOWED_EXTRA_KEYS = new Set<string>([
  "amplificationCoefficient",
  "balanceRatio",
  "feeTier",
  "organicFraction",
  "pairQuality",
  "stressIndex",
  "maturityDays",
  "balanceDetails",
  "measurement",
  "effectiveTvl",
  "isMetaPool",
  "registryId",
  "lockedLiquidityPct",
  "orderbookDepthUsd",
  "orderbookDepthUpUsd",
  "orderbookTvlBasis",
  "executionCapabilityGate",
  "ammExecutionModel",
  "measuredExecution",
  "permanentLiquidity",
  "fluidSwapStatus",
]);

export interface TopPoolsPriceAdmissionContext {
  nowSec: number;
  publicationUpdatedAt?: number | null;
  quotePublishedAtSec?: number | null;
  parentHasPriceRow?: boolean;
  parentClockedNav?: boolean;
  parentClockedNavUnavailable?: boolean;
  parentClockedNavPoolIds?: ReadonlySet<string>;
  /** Invoked with the remaining lifetime (seconds) of each admitted non-null clocked NAV topPool price. */
  onClockedNavRemainingSec?: (remainingSec: number) => void;
}

const TOP_POOLS_PARSE_FAILURE = Symbol("top-pools-parse-failure");

export function normalizeTopPools(
  json: string,
  context?: string,
  priceContext?: TopPoolsPriceAdmissionContext,
): DexLiquidityPoolResponse[];
export function normalizeTopPools(
  json: string | null,
  context?: string,
  priceContext?: TopPoolsPriceAdmissionContext,
): DexLiquidityPoolResponse[] | null;
export function normalizeTopPools(
  json: string | null,
  context = "dex-liquidity-response:top_pools_json",
  priceContext?: TopPoolsPriceAdmissionContext,
): DexLiquidityPoolResponse[] | null {
  const parsed = safeJsonParse<unknown>(json, TOP_POOLS_PARSE_FAILURE, context);
  if (parsed === TOP_POOLS_PARSE_FAILURE) return null;
  if (!Array.isArray(parsed)) return [];

  const pools: DexLiquidityPoolResponse[] = [];
  for (const pool of parsed) {
    if (!pool || typeof pool !== "object" || Array.isArray(pool)) continue;
    const poolRecord = pool as Record<string, unknown>;
    const cleaned = pickAllowedKeys(poolRecord, ALLOWED_POOL_KEYS);
    if (cleaned.price === undefined && typeof poolRecord.displayPrice === "number" &&
      Number.isFinite(poolRecord.displayPrice) && poolRecord.displayPrice > 0) {
      cleaned.price = poolRecord.displayPrice;
    }
    if (priceContext && cleaned.price !== undefined) {
      const poolNavQuote = poolRecord.curveNavSpotQuote;
      const poolId = typeof poolRecord.poolId === "string" && poolRecord.poolId.trim().length > 0
        ? poolRecord.poolId
        : null;
      let navQuoteFailed = false;
      let navQuoteRemainingSec: number | null = null;
      if (poolNavQuote !== undefined) {
        const maxAgeSec = CURVE_NAV_SPOT_QUOTE_POLICY.quoteMaxAgeSec;
        const publicationUpdatedAt = priceContext.publicationUpdatedAt ?? null;
        const hasValidParentClockedNavMeta =
          priceContext.parentClockedNav === true &&
          priceContext.parentClockedNavUnavailable !== true &&
          (priceContext.quotePublishedAtSec == null ||
            (Number.isSafeInteger(priceContext.quotePublishedAtSec) && priceContext.quotePublishedAtSec > 0));
        // Explicitly reject NAV-tagged topPools when a same-generation parent dex_prices
        // row exists without clocked NAV policy metadata, instead of relying on
        // captureEvaluatedAtSec > updated_at side effects.
        const parentRejectedClockedNavPolicy =
          priceContext.parentHasPriceRow === true && priceContext.parentClockedNav === false;
        const poolQuotePublishedAtSec =
          typeof poolRecord.quotePublishedAtSec === "number" &&
          Number.isSafeInteger(poolRecord.quotePublishedAtSec) &&
          poolRecord.quotePublishedAtSec > 0
            ? poolRecord.quotePublishedAtSec
            : null;
        const poolQuoteExpiresAtSec =
          poolRecord.quoteExpiresAtSec === undefined
            ? undefined
            : typeof poolRecord.quoteExpiresAtSec === "number" &&
                Number.isSafeInteger(poolRecord.quoteExpiresAtSec) &&
                poolRecord.quoteExpiresAtSec > 0
              ? poolRecord.quoteExpiresAtSec
              : null;
        const effectivePublishedAtSec = hasValidParentClockedNavMeta
          ? (priceContext.quotePublishedAtSec ?? publicationUpdatedAt)
          : poolQuotePublishedAtSec;
        const missingStandaloneReceipt = !hasValidParentClockedNavMeta && effectivePublishedAtSec == null;
        const poolExpiryInvalid =
          poolQuoteExpiresAtSec === null ||
          (poolQuoteExpiresAtSec !== undefined && priceContext.nowSec >= poolQuoteExpiresAtSec);
        const publicationClockInvalid =
          !Number.isSafeInteger(priceContext.nowSec) ||
          priceContext.nowSec <= 0 ||
          (publicationUpdatedAt != null &&
            (!Number.isSafeInteger(publicationUpdatedAt) ||
              publicationUpdatedAt <= 0 ||
              publicationUpdatedAt > priceContext.nowSec ||
              priceContext.nowSec - publicationUpdatedAt >= maxAgeSec)) ||
          (effectivePublishedAtSec != null &&
            (!Number.isSafeInteger(effectivePublishedAtSec) ||
              effectivePublishedAtSec <= 0 ||
              effectivePublishedAtSec > priceContext.nowSec ||
              priceContext.nowSec - effectivePublishedAtSec >= maxAgeSec ||
              (publicationUpdatedAt != null && effectivePublishedAtSec < publicationUpdatedAt)));
        if (parentRejectedClockedNavPolicy || missingStandaloneReceipt || poolExpiryInvalid || publicationClockInvalid) {
          navQuoteFailed = true;
        } else {
          const check = validateClockedCurveNavCaptureRecord(poolNavQuote, {
            nowSec: priceContext.nowSec,
            effectivePublishedAtSec,
            publicationUpdatedAt,
          });
          const omittedFromParentCaptures =
            hasValidParentClockedNavMeta &&
            (priceContext.parentClockedNavPoolIds?.size ?? 0) > 0 &&
            (poolId == null || priceContext.parentClockedNavPoolIds?.has(poolId) !== true);
          if (check.reason != null || omittedFromParentCaptures) {
            navQuoteFailed = true;
          } else if (check.earliestClockSec != null) {
            let clockFloor = check.earliestClockSec;
            if (publicationUpdatedAt != null) clockFloor = Math.min(clockFloor, publicationUpdatedAt);
            if (effectivePublishedAtSec != null) clockFloor = Math.min(clockFloor, effectivePublishedAtSec);
            navQuoteRemainingSec = clockFloor + maxAgeSec - priceContext.nowSec;
            if (poolQuoteExpiresAtSec !== undefined) {
              navQuoteRemainingSec = Math.min(navQuoteRemainingSec, poolQuoteExpiresAtSec - priceContext.nowSec);
            }
            if (navQuoteRemainingSec <= 0) navQuoteFailed = true;
          }
        }
      }
      const matchesParentClockedNav =
        priceContext.parentClockedNavUnavailable === true && (
          poolNavQuote !== undefined ||
          poolId == null ||
          (priceContext.parentClockedNavPoolIds?.size ?? 0) === 0 ||
          priceContext.parentClockedNavPoolIds?.has(poolId) === true
        );
      if (navQuoteFailed || matchesParentClockedNav) {
        cleaned.price = null;
      } else if (navQuoteRemainingSec != null && cleaned.price != null) {
        priceContext.onClockedNavRemainingSec?.(navQuoteRemainingSec);
      }
    }
    if (typeof poolRecord.chain === "string") {
      cleaned.chain = toChainDisplay(poolRecord.chain);
    }
    if (poolRecord.extra && typeof poolRecord.extra === "object" && !Array.isArray(poolRecord.extra)) {
      const cleanedExtra = pickAllowedKeys(poolRecord.extra as Record<string, unknown>, ALLOWED_EXTRA_KEYS);
      const retired = DexRetiredSolidlyLegacyModelSchema.safeParse(cleanedExtra.ammExecutionModel);
      if (retired.success) cleanedExtra.ammExecutionModel = retired.data;
      // A malformed lock is dropped; it must not fail the row's wire schema.
      if (!DexPermanentLiquiditySchema.safeParse(cleanedExtra.permanentLiquidity).success) {
        delete cleanedExtra.permanentLiquidity;
      }
      if (cleanedExtra.fluidSwapStatus !== undefined && !FluidSwapStatusSchema.safeParse(cleanedExtra.fluidSwapStatus).success) {
        delete cleanedExtra.fluidSwapStatus;
      }
      cleaned.extra = cleanedExtra;
    }
    // Absent = legacy row whose volume eligibility was never recorded; a
    // malformed observation is dropped rather than published as measured.
    const volumeObservation = DexPoolVolumeObservationSchema.safeParse(poolRecord.volumeObservation);
    if (volumeObservation.success) {
      cleaned.volumeObservation = volumeObservation.data;
    }
    const normalizedSource = normalizePoolSource(poolRecord.source);
    if (normalizedSource != null) {
      cleaned.source = normalizedSource;
    } else {
      logWorkerEventArgs("lib", "info", "[dex-liquidity] Unknown pool source:", poolRecord.source);
      delete cleaned.source;
    }
    pools.push(cleaned as DexLiquidityPoolResponse);
  }
  return pools;
}

// A historical current anchor (backfill) or an independent score/volume
// observation has no TVL comparator yet. It still uses the same admission,
// nearest-date and tolerance policy as a TVL trend.
export function selectLiquidityObservation<T extends DexHistoryRow>(
  history: T[],
  targetSec: number,
  toleranceSec: number,
): T | null {
  return selectHistoryObservation(history, targetSec, toleranceSec, null).baseline;
}

// TVL comparisons require the stored current identity, never the runtime
// methodology. Explicit NULL is legacy epoch 0; an omitted projection is not.
export function selectTrendBaseline<T extends DexHistoryRow>(
  history: T[],
  targetSec: number,
  toleranceSec: number,
  currentMethodologyVersion: string | null,
): T | null {
  if (currentMethodologyVersion === undefined) return null;
  return selectHistoryObservation(history, targetSec, toleranceSec, liquidityTvlBasisEpoch(currentMethodologyVersion)).baseline;
}

export function getDexTvlObservedAt(
  volume: ReturnType<typeof parseDexVolumeAvailabilityRecord>,
  latestPossibleSec: number,
): number | null {
  const observedAt = volume.status === "recorded" ? volume.record["24h"].asOfSec : null;
  return observedAt != null && observedAt > 0 && observedAt <= latestPossibleSec ? observedAt : null;
}

export function selectObservedTrendBaseline<T extends DexHistoryRow>(
  history: T[],
  observedAt: number | null,
  lookbackSec: number,
  toleranceSec: number,
  currentMethodologyVersion: string | null,
): T | null {
  return assessObservedTrendBaseline(history, observedAt, lookbackSec, toleranceSec, currentMethodologyVersion, false).baseline;
}

export function assessObservedTrendBaseline<T extends DexHistoryRow>(
  history: T[],
  observedAt: number | null,
  lookbackSec: number,
  toleranceSec: number,
  currentMethodologyVersion: string | null,
  explainBasisChange = true,
): { baseline: T | null; reason?: TvlComparisonUnavailableReason } {
  if (observedAt == null) return { baseline: null, reason: "current-tvl-clock-unavailable" };
  if (currentMethodologyVersion === undefined) return { baseline: null, reason: "tvl-methodology-unavailable" };
  const { baseline, differentBasis } = selectHistoryObservation(history, observedAt - lookbackSec, toleranceSec,
    liquidityTvlBasisEpoch(currentMethodologyVersion), (row) => {
      const sampleAt = getDexTvlObservedAt(parseDexVolumeAvailabilityRecord(row.volume_availability_json), observedAt);
      return sampleAt != null && sampleAt < observedAt ? sampleAt : null;
    }, explainBasisChange);

  return baseline ? { baseline } : {
    baseline: null, reason: differentBasis ? "methodology-basis-change" : "weekly-tvl-observation-unavailable",
  };
}

function selectHistoryObservation<T extends DexHistoryRow>(
  history: T[],
  targetSec: number,
  toleranceSec: number,
  currentEpoch: number | null,
  getObservationTime: (row: T) => number | null = (row) => row.snapshot_date,
  explainBasisChange = false,
): { baseline: T | null; differentBasis: boolean } {
  let best: T | null = null;
  let bestDistance = Number.POSITIVE_INFINITY;
  let differentBasis = false;

  for (const row of history) {
    if (currentEpoch != null && row.methodology_version === undefined) continue;
    const comparable = currentEpoch == null || liquidityTvlBasisEpoch(row.methodology_version) === currentEpoch;
    if (!comparable && !explainBasisChange) continue;
    try {
      if (normalizeDexLiquidityEvidence(row).coverageConfidence < TREND_BASELINE_CONFIDENCE_MIN) continue;
    } catch {
      continue;
    }
    if (row.total_tvl_usd <= 0) continue;

    const observationTime = getObservationTime(row);
    if (observationTime == null) continue;
    const distance = Math.abs(observationTime - targetSec);
    if (distance > toleranceSec) continue;
    if (!comparable) {
      // A basis break explains the gap only for an otherwise admissible observation.
      differentBasis = true;
      continue;
    }
    if (distance < bestDistance) {
      best = row;
      bestDistance = distance;
    }
  }

  return { baseline: best, differentBasis };
}

export function getDexLiquidityTrendTolerances() {
  return {
    day: TREND_24H_TOLERANCE_SEC,
    week: TREND_7D_TOLERANCE_SEC,
  };
}

export type DexLiquidityWarningSurface =
  | { scope: "global" }
  | { scope: "coin"; stablecoinId: string };

const GLOBAL_WARNING_SURFACE: DexLiquidityWarningSurface = { scope: "global" };

// Coin findings stay on the named asset; chain TVL movement alone cannot prove input loss.
const COIN_SCOPED_DRIFT_FLAG = /^(major-tvl-cliff|watchlist-pool-drop):.+$/;

export function buildDexLiquidityWarning(
  latestCron: DexLiquidityCronRow | null,
  surface: DexLiquidityWarningSurface = GLOBAL_WARNING_SURFACE,
): string | null {
  if (!latestCron) return null;

  let failedSources: string[] = [];
  let nearCoverageGuard = false;
  let nearValueGuard = false;
  let nearMajorCoverageGuard = false;
  let qualityDriftSeverity: "none" | "medium" | "high" = "none";
  let qualityDriftFlags: string[] = [];
  if (latestCron.metadata) {
    try {
      const raw: unknown = JSON.parse(latestCron.metadata);
      const parsed = DexLiquidityCronMetadataSchema.parse(raw);
      failedSources = parsed.failedSources;
      nearCoverageGuard = parsed.sourceCoverage.nearCoverageGuard;
      nearValueGuard = parsed.sourceCoverage.nearValueGuard;
      nearMajorCoverageGuard = parsed.sourceCoverage.nearMajorCoverageGuard;
      qualityDriftSeverity = parsed.sourceCoverage.qualityDriftSeverity ?? "none";
      qualityDriftFlags = parsed.sourceCoverage.qualityDriftFlags ?? [];
    } catch (err) {
      logWorkerEventArgs("lib", "info", "[dex-liquidity] Malformed cron metadata:", toErrorMessage(err));
    }
  }

  if (surface.scope === "coin") {
    const coinFlags = qualityDriftFlags.filter(
      (flag) => COIN_SCOPED_DRIFT_FLAG.test(flag) && flag.endsWith(`:${surface.stablecoinId}`),
    );
    if (coinFlags.length === 0) return null;
    return `199 - "Latest sync-dex-liquidity run flagged this asset (qualityDriftFlags=${coinFlags.join(",")})"`;
  }

  if (latestCron.status !== "degraded" && latestCron.status !== "error" && qualityDriftSeverity === "none") return null;

  const scopedOnly =
    failedSources.length === 0
    && !nearCoverageGuard && !nearValueGuard && !nearMajorCoverageGuard
    && qualityDriftFlags.length > 0
    && qualityDriftFlags.every((flag) => COIN_SCOPED_DRIFT_FLAG.test(flag) || flag.startsWith("chain-tvl-drop:"));
  if (latestCron.status === "ok" && scopedOnly) return null;

  const details: string[] = [];
  if (failedSources.length > 0) details.push(`failedSources=${failedSources.join(",")}`);
  if (nearCoverageGuard) details.push("nearCoverageGuard");
  if (nearValueGuard) details.push("nearValueGuard");
  if (nearMajorCoverageGuard) details.push("nearMajorCoverageGuard");
  if (qualityDriftSeverity !== "none") details.push(`qualityDrift=${qualityDriftSeverity}`);
  if (qualityDriftFlags.length > 0) details.push(`qualityDriftFlags=${qualityDriftFlags.join(",")}`);

  const suffix = details.length > 0 ? ` (${details.join("; ")})` : "";
  if (latestCron.status === "error") {
    return `199 - "Latest sync-dex-liquidity run failed; serving last successful dataset${suffix}"`;
  }
  if (latestCron.status === "ok" && qualityDriftSeverity !== "none") {
    return `199 - "Latest sync-dex-liquidity run shows ${qualityDriftSeverity} quality drift${suffix}"`;
  }
  return `199 - "Latest sync-dex-liquidity run degraded${suffix}"`;
}
