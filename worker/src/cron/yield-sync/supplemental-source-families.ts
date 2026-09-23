import { ACTIVE_STABLECOINS, TRACKED_META_BY_ID } from "@shared/lib/stablecoins/registry";
import { PYS_APY_SANITY_MAX } from "@shared/lib/yield-scoring";
import type { ChainRpcConfig } from "../../lib/chain-registry";
import { mapWithConcurrency } from "../../lib/concurrency";
import { getCaches, setCache } from "../../lib/db-cache";
import { logWorkerEvent } from "../../lib/structured-log";
import {
  PENDLE_SUPPLEMENTAL_FETCH_CADENCE_SEC,
  PENDLE_SUPPLEMENTAL_STALE_THRESHOLD_MS,
  SUPPLEMENTAL_SOURCE_STALE_THRESHOLD_MS,
} from "../../lib/yield-ranking-helpers";
import type { VaultsFyiRuntimeConfig } from "../../lib/env";
import { normalizeTokenAddress } from "../dex-liquidity/token-resolution";
import {
  COMPOUND_V3_COMETS,
  createOptionalRpcFamilyTelemetry,
  fetchAaveV3SupplyRates,
  fetchBeefySources,
  fetchCompoundV3SupplyRates,
  fetchMorphoVaultSources,
  fetchPendleMarketSources,
  fetchRoycoDawnSources,
  fetchVaultsFyiSources,
  fetchYearnKongSources,
  type AaveV3RateTarget,
  type OptionalRpcFamilyTelemetry,
  type VaultsFyiSourceResult,
  type VaultsFyiTelemetry,
} from "./sources";
import type { SupplementalFamilyFetchResult } from "./sources-optional-protocols-supplemental";
import { OPTIONAL_RPC_MISSING_TARGET_EXAMPLE_LIMIT } from "./sources-rpc";
import { runOptionalSourceFamily } from "./optional-source-runtime";
import type { ResolvedYieldCandidate } from "./types";
import {
  SUPPLEMENTAL_SOURCE_FAMILY_KEYS,
  type SupplementalSourceFamilyKey,
} from "./supplemental-source-family-keys";
import { resolveYieldSourceKeyRoute } from "./yield-source-key-routing";
import {
  PENDLE_RATE_LIMIT_BACKOFF_REASON,
  buildYieldSupplementalPendleBackoff,
  getYieldSupplementalFamilyCacheKey,
  getYieldSupplementalPendleBackoffCacheKey,
  parseYieldSupplementalPendleBackoff,
  parseYieldSupplementalSourcesCache,
} from "./cache/supplemental-cache-keys";

const AAVE_SUPPORTED_CHAINS = new Set(["ethereum", "arbitrum", "base"]);
const AAVE_TARGETS_PER_RUN = 6;
const AAVE_TARGET_ROTATION_INTERVAL_SEC = 4 * 60 * 60;
const AAVE_ORDINARY_MISS_RATIO_LIMIT = 0.5;

/** Pendle alone refreshes daily; the other families still refresh each producer run. */
const SUPPLEMENTAL_FAMILY_FETCH_CADENCE_SEC = {
  pendle: PENDLE_SUPPLEMENTAL_FETCH_CADENCE_SEC,
} as const;

const SUPPLEMENTAL_FAMILY_STALE_THRESHOLD_SEC: Partial<Record<SupplementalSourceFamilyKey, number>> = {
  pendle: PENDLE_SUPPLEMENTAL_STALE_THRESHOLD_MS / 1000,
};

export function getSupplementalFamilyStaleThresholdSec(family: SupplementalSourceFamilyKey): number {
  return SUPPLEMENTAL_FAMILY_STALE_THRESHOLD_SEC[family] ?? SUPPLEMENTAL_SOURCE_STALE_THRESHOLD_MS / 1000;
}


interface SupplementalSourceFamilyContext {
  db?: D1Database;
  startSec: number;
  signal?: AbortSignal;
  chainRpcs?: Map<string, ChainRpcConfig>;
  vaultsFyi?: VaultsFyiRuntimeConfig;
}

export interface SupplementalSourceFamilyResult {
  key: SupplementalSourceFamilyKey;
  candidates: ResolvedYieldCandidate[];
  sourceFamilyCount: number;
  inventoryCount?: number;
  status: "ok" | "failed";
  /**
   * B1: the fetch ended early (HTTP/parse failure or partial pagination), so the
   * previous family snapshot is retained instead of being replaced by an
   * incomplete one.
   */
  degraded: boolean;
  /**
   * PENDLE-RL: neutral skip — the family kept its retained snapshot without a
   * fetch (per-family cadence not elapsed, or an active 429 backoff refused
   * the call). The writer leaves the family cache row untouched and the run
   * stays non-degraded while the retained row is inside its staleness budget.
   */
  skipReason?: "pendle-cadence-not-due" | "pendle-rate-limited-backoff";
  /** PENDLE-RL (R4): machine-readable cause carried into the run-outcome row when degraded. */
  degradedReason?: string;
  telemetry?: OptionalRpcFamilyTelemetry;
  provider?: unknown;
}

type SupplementalSourceFamilyStatus = SupplementalSourceFamilyResult["status"];

export interface SupplementalDedupeDiscardedValue {
  sourceKey: string;
  discardedApy: number;
  discardedObservedAt: number | null;
  keptApy: number;
  keptObservedAt: number | null;
}

type SourceFamilyCountRecord = Record<SupplementalSourceFamilyKey, number>;
type SourceFamilyExampleRecord = Record<SupplementalSourceFamilyKey, string[]>;

export interface SupplementalDropBucket {
  total: number;
  bySourceFamily: SourceFamilyCountRecord;
  exampleSourceKeysBySourceFamily: SourceFamilyExampleRecord;
}

export interface SupplementalSourceAccounting {
  familyExecution: {
    familyCount: number;
    concurrencyLimit: number;
  };
  malformedSourceDrops: SupplementalDropBucket;
  apyEnvelopeDrops: SupplementalDropBucket;
}

export interface SupplementalSourceFamilySummary {
  status: SupplementalSourceFamilyStatus;
  rawCandidateCount: number;
  candidateCount: number;
  inventoryCount?: number;
  malformedDropCount: number;
  /** B1: true when this family's fetch ended early and its snapshot was retained. */
  degraded: boolean;
  /**
   * B27: values collapsed by the intra-family dedupe, newest `sourceObservedAt`
   * wins with `sourceTvlUsd` as the tie-break. Bounded example list.
   */
  dedupeDiscardedValues?: SupplementalDedupeDiscardedValue[];
  optionalRpc?: {
    targetCount: number;
    attemptedCount: number;
    resolvedTargetCount: number;
    emittedCount: number;
    missingTargetCount: number;
    budgetExhausted: boolean;
    missingByChain: Record<string, number>;
    missingReasonCounts: Record<string, number>;
    missingTargetExamples: string[];
    missingTargetExamplesTruncated: boolean;
  };
  provider?: unknown;
}

type SupplementalSourceFamilySummaryRecord = Record<
  SupplementalSourceFamilyKey,
  SupplementalSourceFamilySummary
>;

const SUPPLEMENTAL_SOURCE_KEY_EXAMPLE_LIMIT = 5;
export const SUPPLEMENTAL_SOURCE_FAMILY_CONCURRENCY = 1;


function shouldPublishVaultsFyiFamilyCache(
  telemetry: VaultsFyiTelemetry | undefined,
  candidateCount: number,
): boolean {
  if (!telemetry) return false;
  if (telemetry.status === "ok") return true;
  if (telemetry.status === "partial") {
    return telemetry.skipReason === "credit-cap" && candidateCount > 0;
  }
  return telemetry.skipReason === "disabled"
    || telemetry.skipReason === "no-key";
}

export function getSupplementalCandidateFamily(
  sourceKey: string | null | undefined,
): SupplementalSourceFamilyKey | null {
  return resolveYieldSourceKeyRoute(sourceKey)?.family ?? null;
}

function buildSourceFamilyCountRecord(): SourceFamilyCountRecord {
  return {
    morpho: 0,
    pendle: 0,
    yearnKong: 0,
    beefy: 0,
    vaultsFyi: 0,
    compoundV3: 0,
    aaveV3: 0,
    roycoDawn: 0,
  };
}

function buildSourceFamilyExampleRecord(): SourceFamilyExampleRecord {
  return {
    morpho: [],
    pendle: [],
    yearnKong: [],
    beefy: [],
    vaultsFyi: [],
    compoundV3: [],
    aaveV3: [],
    roycoDawn: [],
  };
}

function buildDropBucket(): SupplementalDropBucket {
  return {
    total: 0,
    bySourceFamily: buildSourceFamilyCountRecord(),
    exampleSourceKeysBySourceFamily: buildSourceFamilyExampleRecord(),
  };
}

function getSupplementalCandidateSourceKey(candidate: ResolvedYieldCandidate): string {
  const maybeYield = (candidate as { yield?: { sourceKey?: unknown } }).yield;
  return typeof maybeYield?.sourceKey === "string" && maybeYield.sourceKey.trim()
    ? maybeYield.sourceKey.trim()
    : "(missing-source-key)";
}

async function runOptionalSupplementalFamily<T>(
  label: string,
  signal: AbortSignal | undefined,
  fn: () => Promise<T>,
  fallback: T,
): Promise<{ value: T; status: SupplementalSourceFamilyStatus }> {
  return runOptionalSourceFamily<{ value: T; status: SupplementalSourceFamilyStatus }>(
    label,
    signal,
    async () => ({ value: await fn(), status: "ok" }),
    { value: fallback, status: "failed" as const },
  );
}

function isStructurallyValidSupplementalCandidate(candidate: ResolvedYieldCandidate): boolean {
  const maybeCandidate = candidate as {
    symbol?: unknown;
    yield?: {
      currentApy?: unknown;
      sourceKey?: unknown;
      dataSource?: unknown;
    };
  };

  return (
    typeof maybeCandidate.symbol === "string" &&
    maybeCandidate.symbol.trim().length > 0 &&
    typeof maybeCandidate.yield?.sourceKey === "string" &&
    maybeCandidate.yield.sourceKey.trim().length > 0 &&
    typeof maybeCandidate.yield.currentApy === "number" &&
    Number.isFinite(maybeCandidate.yield.currentApy) &&
    typeof maybeCandidate.yield.dataSource === "string"
  );
}

function recordDropExample(
  bucket: SupplementalDropBucket,
  familyKey: SupplementalSourceFamilyKey,
  sourceKey: string,
): void {
  bucket.total += 1;
  bucket.bySourceFamily[familyKey] += 1;

  const examples = bucket.exampleSourceKeysBySourceFamily[familyKey];
  if (examples.length < SUPPLEMENTAL_SOURCE_KEY_EXAMPLE_LIMIT && !examples.includes(sourceKey)) {
    examples.push(sourceKey);
  }
}

function filterMalformedSupplementalCandidates(
  result: SupplementalSourceFamilyResult,
  malformedSourceDrops: SupplementalDropBucket,
  apyEnvelopeDrops: SupplementalDropBucket,
): SupplementalSourceFamilyResult {
  const candidates: ResolvedYieldCandidate[] = [];
  for (const candidate of result.candidates) {
    if (!isStructurallyValidSupplementalCandidate(candidate)) {
      recordDropExample(
        malformedSourceDrops,
        result.key,
        getSupplementalCandidateSourceKey(candidate),
      );
      continue;
    }
    if (candidate.yield.currentApy > PYS_APY_SANITY_MAX) {
      recordDropExample(
        apyEnvelopeDrops,
        result.key,
        getSupplementalCandidateSourceKey(candidate),
      );
      continue;
    }
    candidates.push(candidate);
  }

  return { ...result, candidates };
}

function buildOptionalRpcSummary(telemetry: OptionalRpcFamilyTelemetry): SupplementalSourceFamilySummary["optionalRpc"] {
  return {
    targetCount: telemetry.targetCount,
    attemptedCount: telemetry.attemptedCount,
    resolvedTargetCount: telemetry.resolvedTargetCount,
    emittedCount: telemetry.emittedCount,
    missingTargetCount: telemetry.missingTargetCount,
    budgetExhausted: telemetry.budgetExhausted,
    missingByChain: telemetry.missingByChain,
    missingReasonCounts: telemetry.missingReasonCounts,
    missingTargetExamples: telemetry.missingTargets.slice(0, OPTIONAL_RPC_MISSING_TARGET_EXAMPLE_LIMIT),
    missingTargetExamplesTruncated:
      telemetry.missingTargetsTruncated
      || telemetry.missingTargets.length > OPTIONAL_RPC_MISSING_TARGET_EXAMPLE_LIMIT,
  };
}

/**
 * Compound probes a fixed, small inventory. Any missing target makes that
 * family incomplete, so the writer retains its prior snapshot.
 */
function rpcFamilyFetchEndedDegraded(
  status: SupplementalSourceFamilyStatus,
  telemetry: OptionalRpcFamilyTelemetry | undefined,
): boolean {
  return status === "failed"
    || (telemetry != null && telemetry.attemptedCount > 0 && telemetry.missingTargetCount > 0);
}

/**
 * Aave probes a bounded rotating target window. An ordinary isolated miss can
 * replace the family cache when a strict majority of probes resolved, while
 * budget exhaustion, a wholly unresolved RPC run, or a miss ratio of 50% or
 * more retains the previous snapshot.
 */
function aaveFamilyFetchEndedDegraded(
  status: SupplementalSourceFamilyStatus,
  telemetry: OptionalRpcFamilyTelemetry | undefined,
): boolean {
  if (status === "failed" || !telemetry) return status === "failed";
  if (telemetry.budgetExhausted) return true;
  if (telemetry.targetCount > 0 && telemetry.resolvedTargetCount === 0) return true;
  return telemetry.targetCount > 0
    && telemetry.missingTargetCount / telemetry.targetCount >= AAVE_ORDINARY_MISS_RATIO_LIMIT;
}

function buildSourceFamilySummaries(
  familyResults: SupplementalSourceFamilyResult[],
  malformedSourceDrops: SupplementalDropBucket,
): SupplementalSourceFamilySummaryRecord {
  const summaries = Object.fromEntries(
    SUPPLEMENTAL_SOURCE_FAMILY_KEYS.map((family) => [family, {
      status: "failed" as SupplementalSourceFamilyStatus,
      rawCandidateCount: 0,
      candidateCount: 0,
      malformedDropCount: malformedSourceDrops.bySourceFamily[family],
      degraded: true,
    }]),
  ) as SupplementalSourceFamilySummaryRecord;

  for (const result of familyResults) {
    const summary: SupplementalSourceFamilySummary = {
      status: result.status,
      rawCandidateCount: result.sourceFamilyCount,
      candidateCount: result.candidates.length,
      malformedDropCount: malformedSourceDrops.bySourceFamily[result.key],
      degraded: result.degraded,
    };
    if (result.inventoryCount != null) {
      summary.inventoryCount = result.inventoryCount;
    }
    if (result.telemetry) {
      summary.optionalRpc = buildOptionalRpcSummary(result.telemetry);
    }
    if (result.provider) {
      summary.provider = result.provider;
    }
    summaries[result.key] = summary;
  }

  return summaries;
}

function getTrackedContractAddress(stablecoinId: string, chain: string): string | null {
  const meta = TRACKED_META_BY_ID.get(stablecoinId);
  const contract = meta?.contracts?.find((entry) => entry.chain === chain && entry.address);
  return contract?.address ?? null;
}

function buildAaveTargets(startSec: number): AaveV3RateTarget[] {
  const targets: AaveV3RateTarget[] = [];

  for (const meta of ACTIVE_STABLECOINS) {
    for (const contract of meta.contracts ?? []) {
      if (
        AAVE_SUPPORTED_CHAINS.has(contract.chain) &&
        contract.address &&
        !targets.some((target) => target.stablecoinId === meta.id && target.chain === contract.chain)
      ) {
        targets.push({
          stablecoinId: meta.id,
          symbol: meta.symbol,
          chain: contract.chain,
          assetAddress: contract.address,
          assetDecimals: contract.decimals,
        });
      }
    }
  }

  if (targets.length <= AAVE_TARGETS_PER_RUN) return targets;
  const rotation = Math.floor(startSec / AAVE_TARGET_ROTATION_INTERVAL_SEC);
  const start = (rotation * AAVE_TARGETS_PER_RUN) % targets.length;
  return Array.from(
    { length: AAVE_TARGETS_PER_RUN },
    (_, index) => targets[(start + index) % targets.length]!,
  );
}

function buildAaveSourceKey(stablecoinId: string, chain: string, assetAddress: string | null): string {
  const normalizedAddress = normalizeTokenAddress(assetAddress ?? "");
  return normalizedAddress
    ? `aave-v3-onchain:${chain}:${normalizedAddress}`
    : `aave-v3-onchain:${chain}:${stablecoinId}`;
}

interface SimpleSupplementalFamily {
  key: "morpho" | "yearnKong" | "beefy" | "roycoDawn";
  label: string;
  fetch: (signal?: AbortSignal) => Promise<{
    candidates: ResolvedYieldCandidate[];
    degraded: boolean;
  }>;
}

const SIMPLE_SUPPLEMENTAL_FAMILIES: Record<SimpleSupplementalFamily["key"], SimpleSupplementalFamily> = {
  morpho: {
    key: "morpho",
    label: "Morpho supplemental family",
    fetch: fetchMorphoVaultSources,
  },
  yearnKong: {
    key: "yearnKong",
    label: "Yearn Kong supplemental family",
    fetch: fetchYearnKongSources,
  },
  beefy: {
    key: "beefy",
    label: "Beefy supplemental family",
    fetch: fetchBeefySources,
  },
  roycoDawn: {
    key: "roycoDawn",
    label: "Royco Dawn supplemental family",
    fetch: fetchRoycoDawnSources,
  },
};

/** Anonymous Pendle requests share an IP quota; skips never refresh observation timestamps. */
async function runPendleFamily(
  context: SupplementalSourceFamilyContext,
): Promise<SupplementalSourceFamilyResult> {
  const { db, startSec, signal } = context;
  const familyKey = getYieldSupplementalFamilyCacheKey("pendle");
  const backoffKey = getYieldSupplementalPendleBackoffCacheKey();
  // A failed state read must not kill the whole producer run: fall back to an
  // ungated fetch, which costs at most the three page requests.
  let rows = new Map<string, { value: string; updatedAt: number }>();
  if (db) {
    try {
      rows = await getCaches(db, [familyKey, backoffKey]);
    } catch (error) {
      logWorkerEvent({
        scope: "lib",
        job: "sync-yield-supplemental",
        level: "warn",
        event: "pendle-lane-state-read-failed",
        message: "Pendle lane state read failed; fetching without cadence/backoff gate",
        error,
      });
    }
  }
  const row = rows.get(familyKey);
  const retained = row ? parseYieldSupplementalSourcesCache(row.value, row.updatedAt, startSec) : null;
  let backoff = parseYieldSupplementalPendleBackoff(rows.get(backoffKey)?.value, startSec);
  const notDue = retained != null && retained.ageSeconds < SUPPLEMENTAL_FAMILY_FETCH_CADENCE_SEC.pendle;

  if (!backoff && !notDue) {
    const { value, status } = await runOptionalSupplementalFamily<SupplementalFamilyFetchResult>(
      "Pendle supplemental family",
      signal,
      () => fetchPendleMarketSources(signal),
      { candidates: [], degraded: false },
    );
    if (!value.rateLimited) {
      return {
        key: "pendle",
        candidates: value.candidates,
        sourceFamilyCount: value.candidates.length,
        status,
        degraded: status === "failed" || value.degraded,
      };
    }
    const recordedAtSec = Math.floor(Date.now() / 1000);
    backoff = {
      backoffUntilSec: recordedAtSec + value.rateLimited.backoffSec,
      source: value.rateLimited.source,
      recordedAtSec,
      reason: PENDLE_RATE_LIMIT_BACKOFF_REASON,
    };
    // A failed write must not kill the run: the in-memory window still governs
    // this execution, and the next run re-derives it from a fresh 429.
    if (db) {
      try {
        await setCache(db, backoffKey, buildYieldSupplementalPendleBackoff(backoff), signal);
      } catch (error) {
        logWorkerEvent({
          scope: "lib",
          job: "sync-yield-supplemental",
          level: "warn",
          event: "pendle-backoff-write-failed",
          message: "Pendle rate-limit backoff row could not be persisted",
          error,
        });
      }
    }
  }

  const fresh = retained != null && retained.ageSeconds <= getSupplementalFamilyStaleThresholdSec("pendle");
  const candidates = fresh ? retained.candidates : [];
  return {
    key: "pendle",
    candidates,
    sourceFamilyCount: candidates.length,
    status: "ok",
    degraded: !fresh,
    ...(fresh
      ? { skipReason: backoff ? "pendle-rate-limited-backoff" : "pendle-cadence-not-due" }
      : { degradedReason: PENDLE_RATE_LIMIT_BACKOFF_REASON }),
  };
}

async function runSimpleSupplementalFamily(
  context: SupplementalSourceFamilyContext,
  family: SimpleSupplementalFamily,
): Promise<SupplementalSourceFamilyResult> {
  const { value, status } = await runOptionalSupplementalFamily(
    family.label,
    context.signal,
    () => family.fetch(context.signal),
    { candidates: [], degraded: false },
  );
  return {
    key: family.key,
    candidates: value.candidates,
    sourceFamilyCount: value.candidates.length,
    status,
    degraded: status === "failed" || value.degraded,
  };
}

async function runVaultsFyiFamily(
  context: SupplementalSourceFamilyContext,
): Promise<SupplementalSourceFamilyResult> {
  const { value, status } = await runOptionalSupplementalFamily<VaultsFyiSourceResult | null>(
    "vaults.fyi supplemental family",
    context.signal,
    () =>
      fetchVaultsFyiSources({
        db: context.db,
        config: context.vaultsFyi,
        signal: context.signal,
        startSec: context.startSec,
      }),
    null,
  );
  const candidates = value?.candidates ?? [];
  const telemetry = value?.telemetry;
  const canPublish = status === "ok" && shouldPublishVaultsFyiFamilyCache(telemetry, candidates.length);
  return {
    key: "vaultsFyi",
    candidates,
    sourceFamilyCount: candidates.length,
    inventoryCount: telemetry?.rawVaultCount,
    status: canPublish ? "ok" : "failed",
    degraded: status !== "ok" || !canPublish,
    provider: telemetry ? { vaultsFyi: telemetry } : undefined,
  };
}

async function runCompoundFamily(
  context: SupplementalSourceFamilyContext,
): Promise<SupplementalSourceFamilyResult> {
  const { value, status } = await runOptionalSupplementalFamily(
    "Compound V3 supplemental family",
    context.signal,
    () => fetchCompoundV3SupplyRates([...COMPOUND_V3_COMETS], context.signal, context.chainRpcs),
    {
      results: [],
      telemetry: createOptionalRpcFamilyTelemetry(0),
    },
  );
  const { results, telemetry } = value;

  const candidates: ResolvedYieldCandidate[] = [];
  for (const result of results) {
    candidates.push({
      symbol: result.symbol,
      chain: result.chain,
      address: getTrackedContractAddress(result.stablecoinId, result.chain),
      yield: result.yield,
    });
  }

  return {
    key: "compoundV3",
    candidates,
    sourceFamilyCount: results.length,
    status,
    degraded: rpcFamilyFetchEndedDegraded(status, telemetry),
    telemetry,
  };
}

async function runAaveFamily(
  context: SupplementalSourceFamilyContext,
): Promise<SupplementalSourceFamilyResult> {
  const targets = buildAaveTargets(context.startSec);
  if (targets.length === 0) {
    return {
      key: "aaveV3",
      candidates: [],
      sourceFamilyCount: 0,
      status: "ok",
      degraded: false,
      telemetry: createOptionalRpcFamilyTelemetry(0),
    };
  }

  const { value, status } = await runOptionalSupplementalFamily(
    "Aave V3 supplemental family",
    context.signal,
    () => fetchAaveV3SupplyRates(targets, context.signal, context.chainRpcs),
    {
      results: [],
      telemetry: createOptionalRpcFamilyTelemetry(0),
    },
  );
  const { results, telemetry } = value;

  const candidates: ResolvedYieldCandidate[] = [];
  for (const { stablecoinId, symbol, apy, chain, assetAddress, sourceTvlUsd } of results) {
    if (apy <= 0) continue;
    candidates.push({
      stablecoinId,
      symbol,
      chain,
      address: assetAddress,
      yield: {
        currentApy: apy,
        apyBase: apy,
        apyReward: null,
        sourcePool: null,
        sourceTvlUsd,
        dataSource: "protocol-api",
        exchangeRate: null,
        sourceKey: buildAaveSourceKey(stablecoinId, chain, assetAddress),
        yieldSource: `Aave v3 (${chain})`,
        yieldType: "lending-opportunity",
        sourceObservedAt: context.startSec,
        comparisonAnchorObservedAt: null,
      },
    });
  }

  return {
    key: "aaveV3",
    candidates,
    sourceFamilyCount: results.length,
    status,
    degraded: aaveFamilyFetchEndedDegraded(status, telemetry),
    telemetry,
  };
}

const SUPPLEMENTAL_SOURCE_FAMILY_REGISTRY = [
  (context: SupplementalSourceFamilyContext) =>
    runSimpleSupplementalFamily(context, SIMPLE_SUPPLEMENTAL_FAMILIES.morpho),
  runPendleFamily,
  (context: SupplementalSourceFamilyContext) =>
    runSimpleSupplementalFamily(context, SIMPLE_SUPPLEMENTAL_FAMILIES.yearnKong),
  (context: SupplementalSourceFamilyContext) =>
    runSimpleSupplementalFamily(context, SIMPLE_SUPPLEMENTAL_FAMILIES.beefy),
  runVaultsFyiFamily,
  runCompoundFamily,
  runAaveFamily,
  (context: SupplementalSourceFamilyContext) =>
    runSimpleSupplementalFamily(context, SIMPLE_SUPPLEMENTAL_FAMILIES.roycoDawn),
] as const;

function runSupplementalFamiliesWithConcurrency(
  context: SupplementalSourceFamilyContext,
): Promise<SupplementalSourceFamilyResult[]> {
  return mapWithConcurrency(
    SUPPLEMENTAL_SOURCE_FAMILY_REGISTRY,
    SUPPLEMENTAL_SOURCE_FAMILY_CONCURRENCY,
    (runFamily) => runFamily(context),
  );
}

export async function loadSupplementalSourceFamilies(
  context: SupplementalSourceFamilyContext,
): Promise<{
  candidates: ResolvedYieldCandidate[];
  familyResults: SupplementalSourceFamilyResult[];
  sourceFamilyCounts: SourceFamilyCountRecord;
  sourceFamilyInventoryCounts: SourceFamilyCountRecord;
  supplementalSourceAccounting: SupplementalSourceAccounting;
  sourceFamilySummaries: SupplementalSourceFamilySummaryRecord;
  optionalRpcTelemetry: {
    compoundV3: OptionalRpcFamilyTelemetry;
    aaveV3: OptionalRpcFamilyTelemetry;
  };
}> {
  const rawFamilyResults = await runSupplementalFamiliesWithConcurrency(context);
  const malformedSourceDrops = buildDropBucket();
  const apyEnvelopeDrops = buildDropBucket();
  const familyResults = rawFamilyResults.map((result) =>
    filterMalformedSupplementalCandidates(result, malformedSourceDrops, apyEnvelopeDrops),
  );
  const sourceFamilyCounts = buildSourceFamilyCountRecord();
  const sourceFamilyInventoryCounts = buildSourceFamilyCountRecord();

  for (const result of familyResults) {
    sourceFamilyCounts[result.key] = result.sourceFamilyCount;
    sourceFamilyInventoryCounts[result.key] = result.inventoryCount ?? result.sourceFamilyCount;
  }

  return {
    candidates: familyResults.flatMap((result) => result.candidates),
    familyResults,
    sourceFamilyCounts,
    sourceFamilyInventoryCounts,
    supplementalSourceAccounting: {
      familyExecution: {
        familyCount: SUPPLEMENTAL_SOURCE_FAMILY_KEYS.length,
        concurrencyLimit: SUPPLEMENTAL_SOURCE_FAMILY_CONCURRENCY,
      },
      malformedSourceDrops,
      apyEnvelopeDrops,
    },
    sourceFamilySummaries: buildSourceFamilySummaries(familyResults, malformedSourceDrops),
    optionalRpcTelemetry: {
      compoundV3:
        familyResults.find((result) => result.key === "compoundV3")?.telemetry
        ?? createOptionalRpcFamilyTelemetry(0),
      aaveV3:
        familyResults.find((result) => result.key === "aaveV3")?.telemetry
        ?? createOptionalRpcFamilyTelemetry(0),
    },
  };
}
