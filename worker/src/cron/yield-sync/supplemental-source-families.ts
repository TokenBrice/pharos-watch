import { ACTIVE_STABLECOINS, TRACKED_META_BY_ID } from "@shared/lib/stablecoins/registry";
import type { ChainRpcConfig } from "../../lib/chain-registry";
import { mapWithConcurrency } from "../../lib/concurrency";
import type { VaultsFyiRuntimeConfig } from "../../lib/env";
import { normalizeTokenAddress } from "../dex-liquidity/token-resolution";
import {
  COMPOUND_V3_COMETS,
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
import { OPTIONAL_RPC_MISSING_TARGET_EXAMPLE_LIMIT } from "./sources-rpc";
import { runOptionalSourceFamily } from "./optional-source-runtime";
import type { ResolvedYieldCandidate } from "./types";
import type { SupplementalSourceFamilyKey } from "./supplemental-source-family-keys";
import { resolveYieldSourceKeyRoute } from "./yield-source-key-routing";

const AAVE_SUPPORTED_CHAINS = new Set(["ethereum", "arbitrum", "base"]);

const EMPTY_OPTIONAL_RPC_TELEMETRY: OptionalRpcFamilyTelemetry = {
  targetCount: 0,
  attemptedCount: 0,
  resolvedTargetCount: 0,
  emittedCount: 0,
  missingTargetCount: 0,
  missingByChain: {},
  missingReasonCounts: {},
  missingTargets: [],
  missingTargetsTruncated: false,
  budgetExhausted: false,
  endpointStrategy: "alternating-fallback-primary",
};

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
  sizeGatedDrops: SupplementalDropBucket;
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

export const SUPPLEMENTAL_SOURCE_FAMILY_KEYS: SupplementalSourceFamilyKey[] = [
  "morpho",
  "pendle",
  "yearnKong",
  "beefy",
  "vaultsFyi",
  "compoundV3",
  "aaveV3",
  "roycoDawn",
];

export const REQUIRED_SUPPLEMENTAL_SOURCE_FAMILY_KEYS: SupplementalSourceFamilyKey[] = [
  "morpho",
  "pendle",
  "yearnKong",
  "beefy",
  "compoundV3",
  "aaveV3",
  "roycoDawn",
];

function shouldPublishVaultsFyiFamilyCache(
  telemetry: VaultsFyiTelemetry | undefined,
  candidateCount: number,
): boolean {
  if (!telemetry) return false;
  if (telemetry.status === "ok" || telemetry.status === "partial") return true;
  if (telemetry.skipReason === "credit-cap") return candidateCount > 0;
  return telemetry.skipReason === "disabled"
    || telemetry.skipReason === "no-key"
    || telemetry.skipReason === "invalid-config";
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
 * SRC-SUPP-2: the RPC families fetch target-by-target, so a run where some
 * targets failed resolves with a partial list and an `ok` status. Publishing it
 * would replace the previous full snapshot with the partial one, so a fetch
 * that attempted targets and missed any of them is degraded exactly like an
 * HTTP family that ended early, and the writer retains instead (B1).
 */
function rpcFamilyFetchEndedDegraded(
  status: SupplementalSourceFamilyStatus,
  telemetry: OptionalRpcFamilyTelemetry | undefined,
): boolean {
  return status === "failed"
    || (telemetry != null && telemetry.attemptedCount > 0 && telemetry.missingTargetCount > 0);
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

function buildAaveTargets(): AaveV3RateTarget[] {
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

  return targets;
}

function buildAaveSourceKey(stablecoinId: string, chain: string, assetAddress: string | null): string {
  const normalizedAddress = normalizeTokenAddress(assetAddress ?? "");
  return normalizedAddress
    ? `aave-v3-onchain:${chain}:${normalizedAddress}`
    : `aave-v3-onchain:${chain}:${stablecoinId}`;
}

async function runMorphoFamily(
  context: SupplementalSourceFamilyContext,
): Promise<SupplementalSourceFamilyResult> {
  const { value, status } = await runOptionalSupplementalFamily(
    "Morpho supplemental family",
    context.signal,
    () => fetchMorphoVaultSources(context.signal),
    { candidates: [], degraded: false },
  );
  return {
    key: "morpho",
    candidates: value.candidates,
    sourceFamilyCount: value.candidates.length,
    status,
    degraded: status === "failed" || value.degraded,
  };
}

async function runPendleFamily(
  context: SupplementalSourceFamilyContext,
): Promise<SupplementalSourceFamilyResult> {
  const { value, status } = await runOptionalSupplementalFamily(
    "Pendle supplemental family",
    context.signal,
    () => fetchPendleMarketSources(context.signal),
    { candidates: [], degraded: false },
  );
  return {
    key: "pendle",
    candidates: value.candidates,
    sourceFamilyCount: value.candidates.length,
    status,
    degraded: status === "failed" || value.degraded,
  };
}

async function runYearnKongFamily(
  context: SupplementalSourceFamilyContext,
): Promise<SupplementalSourceFamilyResult> {
  const { value, status } = await runOptionalSupplementalFamily(
    "Yearn Kong supplemental family",
    context.signal,
    () => fetchYearnKongSources(context.signal),
    { candidates: [], degraded: false },
  );
  return {
    key: "yearnKong",
    candidates: value.candidates,
    sourceFamilyCount: value.candidates.length,
    status,
    degraded: status === "failed" || value.degraded,
  };
}

async function runBeefyFamily(
  context: SupplementalSourceFamilyContext,
): Promise<SupplementalSourceFamilyResult> {
  const { value, status } = await runOptionalSupplementalFamily(
    "Beefy supplemental family",
    context.signal,
    () => fetchBeefySources(context.signal),
    { candidates: [], degraded: false },
  );
  return {
    key: "beefy",
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
      telemetry: EMPTY_OPTIONAL_RPC_TELEMETRY,
    },
  );
  const { results, telemetry } = value;

  const candidates: ResolvedYieldCandidate[] = [];
  for (const result of results) {
    const target = COMPOUND_V3_COMETS.find(
      (entry) =>
        result.yield.sourceKey === `protocol-api:compound-v3-supply:${entry.chain}:${entry.comet.toLowerCase()}`,
    );
    if (!target) continue;
    candidates.push({
      symbol: target.symbol,
      chain: target.chain,
      address: getTrackedContractAddress(result.stablecoinId, target.chain),
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
  const targets = buildAaveTargets();
  if (targets.length === 0) {
    return {
      key: "aaveV3",
      candidates: [],
      sourceFamilyCount: 0,
      status: "ok",
      degraded: false,
      telemetry: EMPTY_OPTIONAL_RPC_TELEMETRY,
    };
  }

  const { value, status } = await runOptionalSupplementalFamily(
    "Aave V3 supplemental family",
    context.signal,
    () => fetchAaveV3SupplyRates(targets, context.signal, context.chainRpcs),
    {
      results: [],
      telemetry: EMPTY_OPTIONAL_RPC_TELEMETRY,
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
    degraded: rpcFamilyFetchEndedDegraded(status, telemetry),
    telemetry,
  };
}

async function runRoycoDawnFamily(
  context: SupplementalSourceFamilyContext,
): Promise<SupplementalSourceFamilyResult> {
  const { value, status } = await runOptionalSupplementalFamily(
    "Royco Dawn supplemental family",
    context.signal,
    () => fetchRoycoDawnSources(context.signal),
    { candidates: [], degraded: false },
  );
  return {
    key: "roycoDawn",
    candidates: value.candidates,
    sourceFamilyCount: value.candidates.length,
    status,
    // SRC-SUPP-2: a pagination failure returns the pages fetched so far, so the
    // early-end flag has to retain the previous full snapshot like the RPC
    // families' partial telemetry.
    degraded: status === "failed" || value.degraded,
  };
}

const SUPPLEMENTAL_SOURCE_FAMILY_REGISTRY = [
  runMorphoFamily,
  runPendleFamily,
  runYearnKongFamily,
  runBeefyFamily,
  runVaultsFyiFamily,
  runCompoundFamily,
  runAaveFamily,
  runRoycoDawnFamily,
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
  const familyResults = rawFamilyResults.map((result) =>
    filterMalformedSupplementalCandidates(result, malformedSourceDrops),
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
      sizeGatedDrops: buildDropBucket(),
    },
    sourceFamilySummaries: buildSourceFamilySummaries(familyResults, malformedSourceDrops),
    optionalRpcTelemetry: {
      compoundV3:
        familyResults.find((result) => result.key === "compoundV3")?.telemetry
        ?? EMPTY_OPTIONAL_RPC_TELEMETRY,
      aaveV3:
        familyResults.find((result) => result.key === "aaveV3")?.telemetry
        ?? EMPTY_OPTIONAL_RPC_TELEMETRY,
    },
  };
}
