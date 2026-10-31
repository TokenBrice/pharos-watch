import { EXPLICIT_YIELD_SOURCE_POOL_MAP } from "../../lib/yield-config/yield-config-explicit-pools";
import { YIELD_POOL_MAP } from "../../lib/yield-config/yield-config-pools";
import { YIELD_VARIANT_MAP } from "../../lib/yield-config/yield-config-variants";
import type {
  DlPool,
  ResolvedYieldCandidate,
} from "./types";
import {
  logWorkerEventArgs,
} from "../../lib/structured-log";
import type {
  YieldBenchmarkKey,
  YieldSourceInputMeta,
} from "@shared/types/yield";
import {
  coerceFiniteNumber,
  isFiniteNumber,
  isRecord,
} from "@shared/lib/type-guards";
import {
  RISK_FREE_RATE_FALLBACK,
} from "../../lib/constants";
import {
  buildHardcodedUsdBenchmark,
  getYieldBenchmarkStaticMeta,
  type ParsedYieldBenchmarkMeta,
  type ParsedYieldBenchmarkRegistry,
} from "./benchmarks";
import {
  toErrorMessage,
} from "@shared/lib/error-utils";
import {
  DETERMINISTIC_APY_SANITY_MAX,
} from "../yield-helpers";
import {
  PYS_APY_SANITY_MAX,
} from "@shared/lib/yield-scoring";
import {
  sha256Hex,
} from "@shared/lib/sha256";
import {
  type SupplementalSourceFamilyKey,
  SUPPLEMENTAL_SOURCE_FAMILY_KEYS,
} from "./family-registry";

export function isYieldRelevantDlPool(
  pool: Pick<DlPool, "pool" | "symbol" | "stablecoin" | "exposure">,
): boolean {
  if (pool.exposure !== "single") return false;
  if (pool.stablecoin) return true;
  if (Object.values(YIELD_POOL_MAP).includes(pool.pool)) return true;
  if (Object.values(EXPLICIT_YIELD_SOURCE_POOL_MAP).flat().some((config) => config.poolId === pool.pool)) {
    return true;
  }
  const normalizedSymbol = pool.symbol.toLowerCase();
  return Object.values(YIELD_VARIANT_MAP)
    .some((variant) => variant.variantSymbol.toLowerCase() === normalizedSymbol);
}

export const DETERMINISTIC_ONCHAIN_COOLDOWN_SEC = 6 * 3600;
// Cache writers may lead the reading worker briefly during deploy/clock skew.
// A cooldown beyond its fixed six-hour window plus this allowance is corrupt.
const YIELD_CACHE_MAX_FUTURE_SKEW_SEC = 5 * 60;

// ---------------------------------------------------------------------------
// Coercion primitives shared by every cache submodule.
// ---------------------------------------------------------------------------

function toNullableString(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value : null;
}

export function toNonNegativeInteger(value: unknown): number {
  const parsed = coerceFiniteNumber(value);
  if (parsed == null || parsed < 0) return 0;
  return Math.floor(parsed);
}

function toStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter(
    (entry): entry is string => typeof entry === "string" && entry.trim().length > 0,
  );
}

export { isFiniteNumber };

export function isNullableFiniteNumber(value: unknown): value is number | null | undefined {
  return value == null || isFiniteNumber(value);
}

export function isNullableNonNegativeFiniteNumber(
  value: unknown,
): value is number | null | undefined {
  return value == null || (isFiniteNumber(value) && value >= 0);
}

export function isNullableStringValue(value: unknown): value is string | null | undefined {
  return value == null || typeof value === "string";
}

export function isObservedAt(value: unknown, nowSec: number): value is number | null | undefined {
  return value == null || (isFiniteNumber(value) && value >= 0 && value <= nowSec);
}

export function parseCachePayloadUpdatedAt(
  value: unknown,
  cacheUpdatedAt: number,
  nowSec: number,
): number | null {
  const updatedAt = coerceFiniteNumber(value) ?? cacheUpdatedAt;
  return updatedAt <= nowSec ? updatedAt : null;
}

export function summarizeInvalidRows(
  rows: unknown[],
  getKey: (row: unknown, index: number) => string,
): string[] {
  return rows.slice(0, 5).map(getKey);
}

// ---------------------------------------------------------------------------
// Risk-free rate (benchmark) payload normalization — single benchmark.
// ---------------------------------------------------------------------------

interface RiskFreeRateCachePayload {
  key?: YieldBenchmarkKey;
  label?: string;
  currency?: string;
  rate: number;
  recordDate: string | null;
  fetchedAt: number | null;
  source: string;
  isFallback: boolean;
  fallbackMode: string | null;
  isProxy?: boolean;
  lastMarketRate: number | null;
  lastMarketRecordDate: string | null;
  lastMarketFetchedAt: number | null;
  lastMarketSource: string | null;
}

interface RiskFreeRatesCachePayload {
  version: 1;
  benchmarks: {
    USD: RiskFreeRateCachePayload;
    USD_EFFR?: RiskFreeRateCachePayload | null;
    EUR: RiskFreeRateCachePayload | null;
    CHF: RiskFreeRateCachePayload | null;
    GBP: RiskFreeRateCachePayload | null;
    JPY: RiskFreeRateCachePayload | null;
    MXN: RiskFreeRateCachePayload | null;
    BRL: RiskFreeRateCachePayload | null;
    AUD: RiskFreeRateCachePayload | null;
    CAD: RiskFreeRateCachePayload | null;
    RUB: RiskFreeRateCachePayload | null;
    TRY: RiskFreeRateCachePayload | null;
    SGD: RiskFreeRateCachePayload | null;
  };
}

type RiskFreeRateParseDefaults = {
  key?: YieldBenchmarkKey;
  label?: string;
  currency?: string;
  isProxy?: boolean;
};

export function buildRiskFreeRateCachePayload(
  fields: Partial<RiskFreeRateCachePayload> & Pick<RiskFreeRateCachePayload, "rate" | "source">,
): RiskFreeRateCachePayload {
  const inferredLastMarketRate =
    fields.lastMarketRate ??
    (fields.isFallback === true || fields.source === "hardcoded-fallback" ? null : fields.rate);
  const inferredLastMarketRecordDate =
    fields.lastMarketRecordDate ??
    (inferredLastMarketRate != null ? fields.recordDate ?? null : null);
  const inferredLastMarketFetchedAt =
    fields.lastMarketFetchedAt ??
    (inferredLastMarketRate != null ? fields.fetchedAt ?? null : null);
  const inferredLastMarketSource =
    fields.lastMarketSource ??
    (inferredLastMarketRate != null ? fields.source : null);
  const staticMeta =
    fields.key != null
      ? getYieldBenchmarkStaticMeta(fields.key)
      : getYieldBenchmarkStaticMeta("USD");
  return {
    key: fields.key ?? "USD",
    label: fields.label ?? staticMeta.label,
    currency: fields.currency ?? staticMeta.currency,
    rate: fields.rate,
    recordDate: fields.recordDate ?? null,
    fetchedAt: fields.fetchedAt ?? null,
    source: fields.source,
    isFallback: fields.isFallback ?? false,
    fallbackMode: fields.fallbackMode ?? null,
    isProxy: fields.isProxy ?? staticMeta.isProxy,
    lastMarketRate: inferredLastMarketRate,
    lastMarketRecordDate: inferredLastMarketRecordDate,
    lastMarketFetchedAt: inferredLastMarketFetchedAt,
    lastMarketSource: inferredLastMarketSource,
  };
}

export function serializeRiskFreeRateCache(payload: RiskFreeRateCachePayload): string {
  return JSON.stringify(payload);
}

export function buildRiskFreeRatesCachePayload(
  benchmarks: RiskFreeRatesCachePayload["benchmarks"],
): RiskFreeRatesCachePayload {
  return {
    version: 1,
    benchmarks,
  };
}

export function serializeRiskFreeRatesCache(payload: RiskFreeRatesCachePayload): string {
  return JSON.stringify(payload);
}

function parseRiskFreeRateRecord(
  parsed: unknown,
  cacheUpdatedAt: number,
  nowSec: number,
  defaults?: RiskFreeRateParseDefaults,
  legacyFallbackValue: unknown = parsed,
): ParsedYieldBenchmarkMeta | null {
  if (isRecord(parsed)) {
    const rate = coerceFiniteNumber(parsed.rate);
    const fetchedAt = coerceFiniteNumber(parsed.fetchedAt);
    if (rate != null) {
      const isFallback = parsed.isFallback === true;
      const source = toNullableString(parsed.source) ?? "unknown";
      const parsedKey = toNullableString(parsed.key) as YieldBenchmarkKey | null;
      const key = defaults?.key ?? parsedKey ?? "USD";
      const staticMeta = getYieldBenchmarkStaticMeta(key);
      const lastMarketRate =
        coerceFiniteNumber(parsed.lastMarketRate) ??
        (!isFallback && source !== "hardcoded-fallback" ? rate : null);
      return {
        key,
        label: defaults?.label ?? toNullableString(parsed.label) ?? staticMeta.label,
        currency: defaults?.currency ?? toNullableString(parsed.currency) ?? staticMeta.currency,
        rate,
        recordDate: toNullableString(parsed.recordDate),
        fetchedAt,
        ageSeconds: fetchedAt != null ? nowSec - fetchedAt : null,
        source,
        isFallback,
        fallbackMode: toNullableString(parsed.fallbackMode),
        isProxy: defaults?.isProxy ?? (typeof parsed.isProxy === "boolean" ? parsed.isProxy : staticMeta.isProxy),
        lastMarketRate,
        lastMarketRecordDate:
          toNullableString(parsed.lastMarketRecordDate) ??
          (lastMarketRate != null ? toNullableString(parsed.recordDate) : null),
        lastMarketFetchedAt: coerceFiniteNumber(parsed.lastMarketFetchedAt),
        lastMarketSource:
          toNullableString(parsed.lastMarketSource) ??
          (lastMarketRate != null ? source : null),
      };
    }
  }

  const legacyRate = coerceFiniteNumber(legacyFallbackValue);
  if (legacyRate == null) return null;
  const key = defaults?.key ?? "USD";
  const staticMeta = getYieldBenchmarkStaticMeta(key);
  return {
    key,
    label: defaults?.label ?? staticMeta.label,
    currency: defaults?.currency ?? staticMeta.currency,
    rate: legacyRate,
    recordDate: null,
    fetchedAt: cacheUpdatedAt,
    ageSeconds: nowSec - cacheUpdatedAt,
    source: "legacy-scalar",
    isFallback: legacyRate === RISK_FREE_RATE_FALLBACK,
    fallbackMode: legacyRate === RISK_FREE_RATE_FALLBACK ? "legacy-scalar-fallback" : null,
    isProxy: defaults?.isProxy ?? staticMeta.isProxy,
    lastMarketRate: legacyRate === RISK_FREE_RATE_FALLBACK ? null : legacyRate,
    lastMarketRecordDate: null,
    lastMarketFetchedAt: legacyRate === RISK_FREE_RATE_FALLBACK ? null : cacheUpdatedAt,
    lastMarketSource: legacyRate === RISK_FREE_RATE_FALLBACK ? null : "legacy-scalar",
  };
}

export function parseRiskFreeRateCache(
  raw: string,
  cacheUpdatedAt: number,
  nowSec = Math.floor(Date.now() / 1000),
  defaults?: RiskFreeRateParseDefaults,
): ParsedYieldBenchmarkMeta | null {
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parseRiskFreeRateRecord(parsed, cacheUpdatedAt, nowSec, defaults, raw);
  } catch { /* expected: legacy scalar format — fall through to numeric parsing */
  }

  return parseRiskFreeRateRecord(raw, cacheUpdatedAt, nowSec, defaults, raw);
}

export interface ParsedRiskFreeRatesCache {
  registry: ParsedYieldBenchmarkRegistry;
  /** Keys whose stored sub-entry exists but did not parse on this read. */
  invalidKeys: readonly YieldBenchmarkKey[];
}

/**
 * Per-key registry parse. USD is non-nullable in the registry contract, but a
 * single unparseable sub-entry must not discard the other keys: a corrupt USD
 * row degrades USD alone (to the hardcoded fallback, carrying the reason) while
 * every readable key is preserved. `invalidKeys` lets the loader prefer the
 * legacy scalar row for USD when that row is still readable.
 */
export function parseRiskFreeRatesCacheDetailed(
  raw: string,
  cacheUpdatedAt: number,
  nowSec = Math.floor(Date.now() / 1000),
): ParsedRiskFreeRatesCache | null {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!isRecord(parsed) || !isRecord(parsed.benchmarks)) return null;
    const benchmarks = parsed.benchmarks as Record<string, unknown>;

    const parseBundledBenchmark = (
      rawEntry: unknown,
      key: YieldBenchmarkKey,
    ): ParsedYieldBenchmarkMeta | null => {
      const legacyFallbackValue = isRecord(rawEntry) ? rawEntry : JSON.stringify(rawEntry);
      return parseRiskFreeRateRecord(rawEntry, cacheUpdatedAt, nowSec, { key }, legacyFallbackValue);
    };

    const invalidKeys: YieldBenchmarkKey[] = [];
    const parseOptional = (
      key: YieldBenchmarkKey,
    ): ParsedYieldBenchmarkMeta | null => {
      const rawEntry = benchmarks[key];
      if (rawEntry == null) return null;
      const parsedEntry = parseBundledBenchmark(rawEntry, key);
      if (!parsedEntry) invalidKeys.push(key);
      return parsedEntry;
    };

    const usdEntry = benchmarks.USD;
    const usd = usdEntry == null ? null : parseBundledBenchmark(usdEntry, "USD");
    if (!usd) invalidKeys.push("USD");

    return {
      registry: {
        USD: usd ?? buildHardcodedUsdBenchmark(usdEntry == null ? "missing-usd-entry" : "invalid-usd-entry"),
        USD_EFFR: parseOptional("USD_EFFR"),
        EUR: parseOptional("EUR"),
        CHF: parseOptional("CHF"),
        GBP: parseOptional("GBP"),
        JPY: parseOptional("JPY"),
        MXN: parseOptional("MXN"),
        BRL: parseOptional("BRL"),
        AUD: parseOptional("AUD"),
        CAD: parseOptional("CAD"),
        RUB: parseOptional("RUB"),
        TRY: parseOptional("TRY"),
        SGD: parseOptional("SGD"),
      },
      invalidKeys,
    };
  } catch (err) {
    logWorkerEventArgs("handler", "warn", `[yield-sync] Failed to parse bundled benchmarks cache: ${toErrorMessage(err)}`);
    return null;
  }
}

export function parseRiskFreeRatesCache(
  raw: string,
  cacheUpdatedAt: number,
  nowSec = Math.floor(Date.now() / 1000),
): ParsedYieldBenchmarkRegistry | null {
  return parseRiskFreeRatesCacheDetailed(raw, cacheUpdatedAt, nowSec)?.registry ?? null;
}

// ---------------------------------------------------------------------------
// Deterministic on-chain health state — normalization for cron health cache.
// ---------------------------------------------------------------------------

interface DeterministicOnChainHealthStateCachePayload {
  version: 1;
  consecutiveAllFailRuns: number;
  consecutiveMaskedAllFailRuns: number;
  cooldownUntil: number | null;
  lastAttemptedAt: number | null;
  lastAllFailedAt: number | null;
  lastSuccessAt: number | null;
  lastSkippedAt: number | null;
  lastFailureMissingIds: string[];
}

export interface DeterministicOnChainHealthState {
  consecutiveAllFailRuns: number;
  consecutiveMaskedAllFailRuns: number;
  cooldownUntil: number | null;
  lastAttemptedAt: number | null;
  lastAllFailedAt: number | null;
  lastSuccessAt: number | null;
  lastSkippedAt: number | null;
  lastFailureMissingIds: string[];
}

export function getDefaultDeterministicOnChainHealthState(): DeterministicOnChainHealthState {
  return {
    consecutiveAllFailRuns: 0,
    consecutiveMaskedAllFailRuns: 0,
    cooldownUntil: null,
    lastAttemptedAt: null,
    lastAllFailedAt: null,
    lastSuccessAt: null,
    lastSkippedAt: null,
    lastFailureMissingIds: [],
  };
}

export function serializeDeterministicOnChainHealthState(
  state: DeterministicOnChainHealthState,
): string {
  const payload: DeterministicOnChainHealthStateCachePayload = {
    version: 1,
    consecutiveAllFailRuns: state.consecutiveAllFailRuns,
    consecutiveMaskedAllFailRuns: state.consecutiveMaskedAllFailRuns,
    cooldownUntil: state.cooldownUntil,
    lastAttemptedAt: state.lastAttemptedAt,
    lastAllFailedAt: state.lastAllFailedAt,
    lastSuccessAt: state.lastSuccessAt,
    lastSkippedAt: state.lastSkippedAt,
    lastFailureMissingIds: state.lastFailureMissingIds,
  };
  return JSON.stringify(payload);
}

export function parseDeterministicOnChainHealthState(
  raw: string,
  nowSec = Math.floor(Date.now() / 1000),
): DeterministicOnChainHealthState {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!isRecord(parsed)) {
      return getDefaultDeterministicOnChainHealthState();
    }
    const cooldownUntil = coerceFiniteNumber(parsed.cooldownUntil);
    if (
      cooldownUntil != null &&
      cooldownUntil > nowSec + DETERMINISTIC_ONCHAIN_COOLDOWN_SEC + YIELD_CACHE_MAX_FUTURE_SKEW_SEC
    ) {
      return getDefaultDeterministicOnChainHealthState();
    }

    return {
      consecutiveAllFailRuns: toNonNegativeInteger(parsed.consecutiveAllFailRuns),
      consecutiveMaskedAllFailRuns: toNonNegativeInteger(parsed.consecutiveMaskedAllFailRuns),
      cooldownUntil,
      lastAttemptedAt: coerceFiniteNumber(parsed.lastAttemptedAt),
      lastAllFailedAt: coerceFiniteNumber(parsed.lastAllFailedAt),
      lastSuccessAt: coerceFiniteNumber(parsed.lastSuccessAt),
      lastSkippedAt: coerceFiniteNumber(parsed.lastSkippedAt),
      lastFailureMissingIds: toStringArray(parsed.lastFailureMissingIds),
    };
  } catch {
    // Expected when the health-state cache is missing, truncated, or from an older schema.
    return getDefaultDeterministicOnChainHealthState();
  }
}

interface DlStablecoinPoolsCachePayload {
  updatedAt: number;
  source: string;
  poolCount: number;
  data: DlPool[];
}

/**
 * B12 — upper envelope for a single-exposure stablecoin pool's APY. Siblings cap at
 * 100/100/20/500/300; this lane accepted any finite value (a 1e9% row passed
 * `isValidDlPool` and a 1000% pool reached the board). Aligns with the scorer's
 * `PYS_APY_SANITY_MAX` so a row that clears this gate cannot be clamped to a
 * perfect PYS downstream.
 */
const DL_POOL_APY_ENVELOPE_PERCENT = DETERMINISTIC_APY_SANITY_MAX;

function isValidDlPool(value: unknown): value is DlPool {
  if (!isRecord(value)) return false;
  if (typeof value.pool !== "string" || value.pool.trim() === "") return false;
  if (typeof value.chain !== "string" || value.chain.trim() === "") return false;
  if (typeof value.project !== "string" || value.project.trim() === "") return false;
  if (typeof value.symbol !== "string" || value.symbol.trim() === "") return false;
  if (value.poolMeta != null && typeof value.poolMeta !== "string") return false;
  if (!isFiniteNumber(value.tvlUsd) || value.tvlUsd < 0) return false;
  if (!isFiniteNumber(value.apy) || value.apy > DL_POOL_APY_ENVELOPE_PERCENT) return false;
  if (!isNullableFiniteNumber(value.apyBase)) return false;
  if (!isNullableFiniteNumber(value.apyReward)) return false;
  if (value.apyMean30d != null && !isFiniteNumber(value.apyMean30d)) return false;
  if (typeof value.stablecoin !== "boolean") return false;
  if (typeof value.exposure !== "string") return false;
  if (
    value.underlyingTokens != null &&
    (!Array.isArray(value.underlyingTokens) || value.underlyingTokens.some((token) => typeof token !== "string"))
  ) {
    return false;
  }
  return true;
}

export function filterValidDlPools(
  rows: unknown[],
  context: string,
): {
  pools: DlPool[];
  rejectedCount: number;
  rejectedExamples: string[];
  envelopeRejectedCount: number;
  envelopeRejectedPoolIds: string[];
} {
  const pools: DlPool[] = [];
  const rejected: unknown[] = [];
  for (const row of rows) {
    if (isValidDlPool(row)) {
      pools.push(row);
    } else {
      rejected.push(row);
    }
  }
  const envelopeRejected = rejected.filter(
    (row) =>
      isRecord(row) &&
      typeof row.apy === "number" &&
      Number.isFinite(row.apy) &&
      row.apy > DL_POOL_APY_ENVELOPE_PERCENT,
  );
  const rejectedExamples = summarizeInvalidRows(rejected, (row, index) => {
    if (isRecord(row) && typeof row.pool === "string") return row.pool;
    return `row-${index}`;
  });
  if (envelopeRejected.length > 0) {
    logWorkerEventArgs("handler", "warn",
      `[yield-sync] Rejected ${envelopeRejected.length} DL pool row(s) above the ${DL_POOL_APY_ENVELOPE_PERCENT}% APY envelope from ${context}: ${
        summarizeInvalidRows(envelopeRejected, (row, index) => {
          if (isRecord(row) && typeof row.pool === "string") return row.pool;
          return `row-${index}`;
        }).join(", ")
      }`,
    );
  }
  if (rejected.length > 0) {
    logWorkerEventArgs("handler", "warn",
      `[yield-sync] Dropped ${rejected.length} invalid DL pool rows from ${context}: ${rejectedExamples.join(", ")}`,
    );
  }
  return {
    pools,
    rejectedCount: rejected.length,
    rejectedExamples,
    envelopeRejectedCount: envelopeRejected.length,
    // Envelope-rejected rows were read this run but are not publishable
    // evidence. Consumers that treat an absent curated pin as a dead config
    // need their ids to distinguish unavailable from missing (R2/R6).
    envelopeRejectedPoolIds: envelopeRejected.flatMap((row) =>
      isRecord(row) && typeof row.pool === "string" && row.pool.trim() !== "" ? [row.pool] : []),
  };
}

export function buildDlStablecoinPoolsCache(
  pools: DlPool[],
  updatedAt = Math.floor(Date.now() / 1000),
): string {
  const payload: DlStablecoinPoolsCachePayload = {
    updatedAt,
    source: "sync-dex-liquidity",
    poolCount: pools.length,
    data: pools,
  };
  return JSON.stringify(payload);
}

export function parseDlStablecoinPoolsCache(
  raw: string,
  cacheUpdatedAt: number,
  nowSec = Math.floor(Date.now() / 1000),
): {
  pools: DlPool[];
  meta: YieldSourceInputMeta;
  envelopeRejectedCount: number;
  envelopeRejectedPoolIds: string[];
} | null {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (isRecord(parsed) && Array.isArray(parsed.data)) {
      const { pools, envelopeRejectedCount, envelopeRejectedPoolIds } = filterValidDlPools(
        parsed.data,
        "structured dl-stablecoin-pools cache",
      );
      const updatedAt = parseCachePayloadUpdatedAt(parsed.updatedAt, cacheUpdatedAt, nowSec);
      if (updatedAt == null) {
        logWorkerEventArgs("handler", "warn", "[yield-sync] Rejected DL pools cache with future updatedAt");
        return null;
      }
      return {
        pools,
        envelopeRejectedCount,
        envelopeRejectedPoolIds,
        meta: {
          mode: "dex-cache",
          updatedAt,
          ageSeconds: Math.max(0, nowSec - updatedAt),
          poolCount: pools.length,
          fallbackMode: null,
        },
      };
    }
  } catch { /* expected: corrupted or unrecognised cache format */
    return null;
  }

  return null;
}

/**
 * B28: one version constant owns the family cache key prefix, the persisted
 * payload and the run-outcome row, so a payload-shape change invalidates every
 * family across a deploy or a rollback instead of being silently re-read.
 */
const YIELD_SUPPLEMENTAL_SOURCES_CACHE_VERSION = 1;
const YIELD_SUPPLEMENTAL_FAMILY_CACHE_PREFIX =
  `yield:supplemental-sources:v${YIELD_SUPPLEMENTAL_SOURCES_CACHE_VERSION}:`;
const YIELD_SUPPLEMENTAL_RUN_OUTCOME_CACHE_PREFIX =
  `yield:supplemental-source-run:v${YIELD_SUPPLEMENTAL_SOURCES_CACHE_VERSION}`;

export function getYieldSupplementalFamilyCacheKey(family: SupplementalSourceFamilyKey): string {
  return `${YIELD_SUPPLEMENTAL_FAMILY_CACHE_PREFIX}${family}`;
}

/**
 * B1: per-run family outcomes. The writer records which families kept their
 * previous snapshot so the publication can name them in
 * `supplementalMeta.degradedFamilies` (B16 degradation reasons).
 */
export function getYieldSupplementalRunOutcomeCacheKey(): string {
  return YIELD_SUPPLEMENTAL_RUN_OUTCOME_CACHE_PREFIX;
}

export type SupplementalFamilyCacheResult =
  | "published"
  | "skipped-newer"
  | "empty"
  | "empty-published"
  | "retained-previous"
  /** PENDLE-RL: neutral skip — the family kept its retained row because its per-family fetch cadence had not elapsed. */
  | "skipped-not-due"
  /** PENDLE-RL: neutral skip — the family kept its retained row because an active 429 backoff refused the call. */
  | "skipped-backoff";

export interface YieldSupplementalRunOutcome {
  version: number;
  checkedAt: number;
  familyCacheResults: Record<SupplementalSourceFamilyKey, SupplementalFamilyCacheResult>;
  familySnapshotHashes?: Partial<Record<SupplementalSourceFamilyKey, string>>;
  degradedFamilies: SupplementalSourceFamilyKey[];
  /**
   * PENDLE-RL: machine-readable cause per degraded family (R4). Additive:
   * rows written before the field exists parse as no reasons.
   */
  degradedFamilyReasons?: Record<string, string>;
}

export function buildYieldSupplementalRunOutcome(
  familyCacheResults: Record<SupplementalSourceFamilyKey, SupplementalFamilyCacheResult>,
  degradedFamilies: SupplementalSourceFamilyKey[],
  checkedAt = Math.floor(Date.now() / 1000),
  degradedFamilyReasons?: Record<string, string>,
  familySnapshotHashes?: Partial<Record<SupplementalSourceFamilyKey, string>>,
): string {
  const payload: YieldSupplementalRunOutcome = {
    version: YIELD_SUPPLEMENTAL_SOURCES_CACHE_VERSION,
    checkedAt,
    familyCacheResults,
    familySnapshotHashes,
    degradedFamilies,
    ...(degradedFamilyReasons && Object.keys(degradedFamilyReasons).length > 0
      ? { degradedFamilyReasons }
      : {}),
  };
  return JSON.stringify(payload);
}

export interface ParsedYieldSupplementalRunOutcome {
  degradedFamilies: SupplementalSourceFamilyKey[];
  degradedFamilyReasons: Record<string, string>;
  familySnapshotHashes: Partial<Record<SupplementalSourceFamilyKey, string>>;
  familyCacheResults?: Partial<Record<SupplementalSourceFamilyKey, SupplementalFamilyCacheResult>>;
}


/**
 * Families whose last fetch ended degraded. A missing, version-mismatched or
 * malformed row reads as "none known degraded": the retained family markers
 * still carry the age signal, so this is an additive reason, never a gate.
 */
export function parseYieldSupplementalRunOutcome(
  raw: string,
): SupplementalSourceFamilyKey[] {
  return parseYieldSupplementalRunOutcomeDetailed(raw).degradedFamilies;
}

export function parseYieldSupplementalRunOutcomeDetailed(
  raw: string,
): ParsedYieldSupplementalRunOutcome {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!isRecord(parsed)) return { degradedFamilies: [], degradedFamilyReasons: {}, familySnapshotHashes: {} };
    if (parsed.version !== YIELD_SUPPLEMENTAL_SOURCES_CACHE_VERSION) {
      logWorkerEventArgs("handler", "warn",
        `[yield-sync] Ignored supplemental run outcome written by cache version ${String(parsed.version)}`,
      );
      return { degradedFamilies: [], degradedFamilyReasons: {}, familySnapshotHashes: {} };
    }
    const degradedFamilies = Array.isArray(parsed.degradedFamilies)
      ? parsed.degradedFamilies.filter(isSupplementalSourceFamilyKey)
      : [];
    const degradedFamilyReasons: Record<string, string> = {};
    if (isRecord(parsed.degradedFamilyReasons)) {
      for (const family of degradedFamilies) {
        const reason = parsed.degradedFamilyReasons[family];
        if (typeof reason === "string" && reason.trim()) {
          degradedFamilyReasons[family] = reason.trim();
        }
      }
    }
    const familySnapshotHashes: Partial<Record<SupplementalSourceFamilyKey, string>> = {};
    if (isRecord(parsed.familySnapshotHashes)) {
      for (const family of SUPPLEMENTAL_SOURCE_FAMILY_KEYS) {
        const hash = parsed.familySnapshotHashes[family];
        if (typeof hash === "string" && /^[a-f0-9]{64}$/.test(hash)) familySnapshotHashes[family] = hash;
      }
    }
    const familyCacheResults: Partial<Record<SupplementalSourceFamilyKey, SupplementalFamilyCacheResult>> = {};
    if (isRecord(parsed.familyCacheResults)) {
      for (const family of SUPPLEMENTAL_SOURCE_FAMILY_KEYS) {
        const result = parsed.familyCacheResults[family];
        if (result === "published" || result === "skipped-newer" || result === "empty"
          || result === "empty-published" || result === "retained-previous"
          || result === "skipped-not-due" || result === "skipped-backoff") {
          familyCacheResults[family] = result;
        }
      }
    }
    return { degradedFamilies, degradedFamilyReasons, familySnapshotHashes, familyCacheResults };
  } catch (err) {
    logWorkerEventArgs("handler", "warn",
      `[yield-sync] Failed to parse supplemental run outcome: ${toErrorMessage(err)}`,
    );
    return { degradedFamilies: [], degradedFamilyReasons: {}, familySnapshotHashes: {} };
  }
}

/** Bind outcome evidence to exactly the family value and cache publication it consumed. */
export function supplementalFamilySnapshotHash(row: { value: string; updatedAt: number } | null): string {
  return sha256Hex(row == null ? "missing" : JSON.stringify([row.updatedAt, row.value]));
}

/** PENDLE-RL: machine-readable cause recorded when the unkeyed quota backoff degrades the family. */
export const PENDLE_RATE_LIMIT_BACKOFF_REASON = "pendle-rate-limited-backoff";

export type YieldSupplementalPendleBackoffSource =
  | "retry-after"
  | "x-ratelimit-weekly-reset"
  | "x-ratelimit-reset"
  | "default";

export interface YieldSupplementalPendleBackoff {
  backoffUntilSec: number;
  reason: string;
  source: YieldSupplementalPendleBackoffSource;
  recordedAtSec: number;
}

/**
 * PENDLE-RL: persisted 429 backoff for the unkeyed Pendle API. The row records
 * when the per-IP quota window is expected to replenish; the pendle family
 * loader refuses to call Pendle again before that time. An expired or
 * malformed row reads as "no active backoff", so a lost or corrupt row can
 * only cost one request, never wedge the lane.
 */
export function getYieldSupplementalPendleBackoffCacheKey(): string {
  return `${YIELD_SUPPLEMENTAL_FAMILY_CACHE_PREFIX}pendle-backoff`;
}

const PENDLE_BACKOFF_SOURCES: readonly YieldSupplementalPendleBackoffSource[] = [
  "retry-after",
  "x-ratelimit-weekly-reset",
  "x-ratelimit-reset",
  "default",
];

export function buildYieldSupplementalPendleBackoff(input: {
  backoffUntilSec: number;
  source: YieldSupplementalPendleBackoffSource;
  recordedAtSec: number;
}): string {
  return JSON.stringify({
    backoffUntilSec: input.backoffUntilSec,
    reason: PENDLE_RATE_LIMIT_BACKOFF_REASON,
    source: input.source,
    recordedAtSec: input.recordedAtSec,
  } satisfies YieldSupplementalPendleBackoff);
}

export function parseYieldSupplementalPendleBackoff(
  raw: string | null | undefined,
  nowSec: number,
): YieldSupplementalPendleBackoff | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!isRecord(parsed)) return null;
    const backoffUntilSec = parsed.backoffUntilSec;
    if (
      typeof backoffUntilSec !== "number"
      || !Number.isInteger(backoffUntilSec)
      || backoffUntilSec <= nowSec
      || typeof parsed.recordedAtSec !== "number"
      || !Number.isSafeInteger(parsed.recordedAtSec)
      || parsed.recordedAtSec < 0
      || parsed.recordedAtSec > nowSec + 60
      || backoffUntilSec <= parsed.recordedAtSec
      || backoffUntilSec - parsed.recordedAtSec > 7 * 86400
    ) {
      return null;
    }
    const source = PENDLE_BACKOFF_SOURCES.includes(parsed.source as YieldSupplementalPendleBackoffSource)
      ? (parsed.source as YieldSupplementalPendleBackoffSource)
      : "default";
    return {
      backoffUntilSec,
      reason: PENDLE_RATE_LIMIT_BACKOFF_REASON,
      source,
      recordedAtSec: parsed.recordedAtSec,
    };
  } catch {
    return null;
  }
}

function isSupplementalSourceFamilyKey(value: unknown): value is SupplementalSourceFamilyKey {
  return typeof value === "string"
    && (SUPPLEMENTAL_SOURCE_FAMILY_KEYS as readonly string[]).includes(value);
}

interface YieldSupplementalSourcesCachePayload {
  version: 1;
  updatedAt: number;
  source: string;
  sourceCount: number;
  data: ResolvedYieldCandidate[];
}

interface ParsedYieldSupplementalSourcesCache {
  candidates: ResolvedYieldCandidate[];
  updatedAt: number;
  ageSeconds: number;
  sourceCount: number;
  /** Rows the stored snapshot listed that no longer pass read validation. */
  rejectedCount: number;
}

function isResolvedYieldCandidate(value: unknown, nowSec: number): value is ResolvedYieldCandidate {
  if (!isRecord(value)) return false;
  if (typeof value.symbol !== "string" || value.symbol.trim() === "") return false;
  if (value.chain != null && typeof value.chain !== "string") return false;
  if (value.address != null && typeof value.address !== "string") return false;
  if (!isRecord(value.yield)) return false;
  const candidateYield = value.yield;
  if (typeof candidateYield.sourceKey !== "string" || candidateYield.sourceKey.trim() === "") return false;
  if (!isFiniteNumber(candidateYield.currentApy) || candidateYield.currentApy > PYS_APY_SANITY_MAX) return false;
  if (!isNullableFiniteNumber(candidateYield.apyBase)) return false;
  if (!isNullableFiniteNumber(candidateYield.apyReward)) return false;
  if (!isNullableStringValue(candidateYield.sourcePool)) return false;
  if (!isNullableNonNegativeFiniteNumber(candidateYield.sourceTvlUsd)) return false;
  if (
    candidateYield.dataSource !== "onchain" &&
    candidateYield.dataSource !== "defillama" &&
    candidateYield.dataSource !== "defillama-auto" &&
    candidateYield.dataSource !== "price-derived" &&
    candidateYield.dataSource !== "rate-derived" &&
    candidateYield.dataSource !== "protocol-api"
  ) {
    return false;
  }
  if (!isNullableFiniteNumber(candidateYield.exchangeRate)) return false;
  if (!isObservedAt(candidateYield.sourceObservedAt, nowSec)) return false;
  if (!isObservedAt(candidateYield.comparisonAnchorObservedAt, nowSec)) return false;
  if (candidateYield.yieldSource != null && typeof candidateYield.yieldSource !== "string") return false;
  if (candidateYield.project != null && typeof candidateYield.project !== "string") return false;
  return true;
}

function filterValidSupplementalCandidates(
  rows: unknown[],
  nowSec: number,
): { candidates: ResolvedYieldCandidate[]; rejectedCount: number; rejectedExamples: string[] } {
  const candidates: ResolvedYieldCandidate[] = [];
  const rejected: unknown[] = [];
  for (const row of rows) {
    if (isResolvedYieldCandidate(row, nowSec)) {
      candidates.push(row);
    } else {
      rejected.push(row);
    }
  }
  const rejectedExamples = summarizeInvalidRows(rejected, (row, index) => {
    if (isRecord(row) && isRecord(row.yield) && typeof row.yield.sourceKey === "string") {
      return row.yield.sourceKey;
    }
    return `row-${index}`;
  });
  if (rejected.length > 0) {
    logWorkerEventArgs("handler", "warn",
      `[yield-sync] Dropped ${rejected.length} invalid supplemental yield source rows: ${rejectedExamples.join(", ")}`,
    );
  }
  return { candidates, rejectedCount: rejected.length, rejectedExamples };
}

export function buildYieldSupplementalFamilyCache(
  candidates: ResolvedYieldCandidate[],
  updatedAt = Math.floor(Date.now() / 1000),
): string {
  const payload: YieldSupplementalSourcesCachePayload = {
    version: YIELD_SUPPLEMENTAL_SOURCES_CACHE_VERSION,
    updatedAt,
    source: "sync-yield-supplemental",
    sourceCount: candidates.length,
    data: candidates,
  };
  return JSON.stringify(payload);
}

export function parseYieldSupplementalSourcesCache(
  raw: string,
  cacheUpdatedAt: number,
  nowSec = Math.floor(Date.now() / 1000),
): ParsedYieldSupplementalSourcesCache | null {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (isRecord(parsed) && parsed.version !== YIELD_SUPPLEMENTAL_SOURCES_CACHE_VERSION) {
      logWorkerEventArgs("handler", "warn",
        `[yield-sync] Rejected supplemental sources cache written by version ${String(parsed.version)}; expected ${YIELD_SUPPLEMENTAL_SOURCES_CACHE_VERSION}`,
      );
      return null;
    }
    if (isRecord(parsed) && Array.isArray(parsed.data)) {
      const { candidates, rejectedCount } = filterValidSupplementalCandidates(parsed.data, nowSec);
      const updatedAt = parseCachePayloadUpdatedAt(parsed.updatedAt, cacheUpdatedAt, nowSec);
      if (updatedAt == null) {
        logWorkerEventArgs("handler", "warn", "[yield-sync] Rejected supplemental sources cache with future updatedAt");
        return null;
      }
      return {
        candidates,
        updatedAt,
        ageSeconds: Math.max(0, nowSec - updatedAt),
        sourceCount: toNonNegativeInteger(parsed.sourceCount) || candidates.length,
        rejectedCount,
      };
    }
  } catch (err) {
    logWorkerEventArgs("handler", "warn", `[yield-sync] Failed to parse supplemental sources cache: ${toErrorMessage(err)}`);
    return null;
  }

  return null;
}
