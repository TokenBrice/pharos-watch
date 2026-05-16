import { ACTIVE_STABLECOINS, TRACKED_META_BY_ID } from "@shared/lib/stablecoins/registry";
import type { ChainRpcConfig } from "../../lib/chain-registry";
import { normalizeTokenAddress } from "../dex-liquidity/token-resolution";
import {
  COMPOUND_V3_COMETS,
  fetchAaveV3SupplyRates,
  fetchBeefySources,
  fetchCompoundV3SupplyRates,
  fetchMorphoVaultSources,
  fetchPendleMarketSources,
  fetchYearnKongSources,
  type AaveV3SupplyRateRow,
  type AaveV3RateTarget,
  type OptionalRpcFamilyTelemetry,
} from "./sources";
import { runOptionalSourceFamily } from "./optional-source-runtime";
import type { ResolvedYieldCandidate } from "./types";

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
  budgetExhausted: false,
  endpointStrategy: "alternating-fallback-primary",
};

interface SupplementalSourceFamilyContext {
  startSec: number;
  signal?: AbortSignal;
  chainRpcs?: Map<string, ChainRpcConfig>;
}

export interface SupplementalSourceFamilyResult {
  key: SupplementalSourceFamilyKey;
  candidates: ResolvedYieldCandidate[];
  sourceFamilyCount: number;
  telemetry?: OptionalRpcFamilyTelemetry;
}

export type SupplementalSourceFamilyKey =
  | "morpho"
  | "pendle"
  | "yearnKong"
  | "beefy"
  | "compoundV3"
  | "aaveV3";

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

const SUPPLEMENTAL_SOURCE_KEY_EXAMPLE_LIMIT = 5;
export const SUPPLEMENTAL_SOURCE_FAMILY_CONCURRENCY = 1;

export const SUPPLEMENTAL_SOURCE_FAMILY_KEYS: SupplementalSourceFamilyKey[] = [
  "morpho",
  "pendle",
  "yearnKong",
  "beefy",
  "compoundV3",
  "aaveV3",
];

export function getSupplementalCandidateFamily(
  sourceKey: string | null | undefined,
): SupplementalSourceFamilyKey | null {
  if (!sourceKey) return null;
  if (sourceKey.startsWith("protocol-api:morpho-vault:")) return "morpho";
  if (sourceKey.startsWith("protocol-api:pendle:")) return "pendle";
  if (
    sourceKey.startsWith("protocol-api:yearn:") ||
    sourceKey.startsWith("protocol-api:kong:") ||
    sourceKey.startsWith("protocol-api:k3:")
  ) {
    return "yearnKong";
  }
  if (sourceKey.startsWith("protocol-api:beefy:")) return "beefy";
  if (sourceKey.startsWith("protocol-api:compound-v3-supply:")) return "compoundV3";
  if (sourceKey.startsWith("aave-v3-onchain:")) return "aaveV3";
  return null;
}

function buildSourceFamilyCountRecord(): SourceFamilyCountRecord {
  return {
    morpho: 0,
    pendle: 0,
    yearnKong: 0,
    beefy: 0,
    compoundV3: 0,
    aaveV3: 0,
  };
}

function buildSourceFamilyExampleRecord(): SourceFamilyExampleRecord {
  return {
    morpho: [],
    pendle: [],
    yearnKong: [],
    beefy: [],
    compoundV3: [],
    aaveV3: [],
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

function buildAaveRowsFromLegacyRates(
  rates: Map<string, { apy: number; chain: string; sourceTvlUsd: number }>,
): AaveV3SupplyRateRow[] {
  return [...rates.entries()].flatMap(([stablecoinId, { apy, chain, sourceTvlUsd }]) => {
    const meta = TRACKED_META_BY_ID.get(stablecoinId);
    const assetAddress = getTrackedContractAddress(stablecoinId, chain);
    if (!meta || !assetAddress) return [];
    return [{
      stablecoinId,
      symbol: meta.symbol,
      chain,
      assetAddress,
      apy,
      sourceTvlUsd,
    }];
  });
}

async function runMorphoFamily(
  context: SupplementalSourceFamilyContext,
): Promise<SupplementalSourceFamilyResult> {
  const candidates = await runOptionalSourceFamily(
    "Morpho supplemental family",
    context.signal,
    () => fetchMorphoVaultSources(context.signal),
    [] as ResolvedYieldCandidate[],
  );
  return { key: "morpho", candidates, sourceFamilyCount: candidates.length };
}

async function runPendleFamily(
  context: SupplementalSourceFamilyContext,
): Promise<SupplementalSourceFamilyResult> {
  const candidates = await runOptionalSourceFamily(
    "Pendle supplemental family",
    context.signal,
    () => fetchPendleMarketSources(context.signal),
    [] as ResolvedYieldCandidate[],
  );
  return { key: "pendle", candidates, sourceFamilyCount: candidates.length };
}

async function runYearnKongFamily(
  context: SupplementalSourceFamilyContext,
): Promise<SupplementalSourceFamilyResult> {
  const candidates = await runOptionalSourceFamily(
    "Yearn Kong supplemental family",
    context.signal,
    () => fetchYearnKongSources(context.signal),
    [] as ResolvedYieldCandidate[],
  );
  return { key: "yearnKong", candidates, sourceFamilyCount: candidates.length };
}

async function runBeefyFamily(
  context: SupplementalSourceFamilyContext,
): Promise<SupplementalSourceFamilyResult> {
  const candidates = await runOptionalSourceFamily(
    "Beefy supplemental family",
    context.signal,
    () => fetchBeefySources(context.signal),
    [] as ResolvedYieldCandidate[],
  );
  return { key: "beefy", candidates, sourceFamilyCount: candidates.length };
}

async function runCompoundFamily(
  context: SupplementalSourceFamilyContext,
): Promise<SupplementalSourceFamilyResult> {
  const { results, telemetry } = await runOptionalSourceFamily(
    "Compound V3 supplemental family",
    context.signal,
    () => fetchCompoundV3SupplyRates([...COMPOUND_V3_COMETS], context.signal, context.chainRpcs),
    {
      results: [],
      telemetry: EMPTY_OPTIONAL_RPC_TELEMETRY,
    },
  );

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
      telemetry: EMPTY_OPTIONAL_RPC_TELEMETRY,
    };
  }

  const { rates, results, telemetry } = await runOptionalSourceFamily(
    "Aave V3 supplemental family",
    context.signal,
    () => fetchAaveV3SupplyRates(targets, context.signal, context.chainRpcs),
    {
      rates: new Map(),
      results: [],
      telemetry: EMPTY_OPTIONAL_RPC_TELEMETRY,
    },
  );

  const candidates: ResolvedYieldCandidate[] = [];
  const aaveRows = results.length > 0 ? results : buildAaveRowsFromLegacyRates(rates);
  for (const { stablecoinId, symbol, apy, chain, assetAddress, sourceTvlUsd } of aaveRows) {
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
    sourceFamilyCount: aaveRows.length,
    telemetry,
  };
}

const SUPPLEMENTAL_SOURCE_FAMILY_REGISTRY = [
  runMorphoFamily,
  runPendleFamily,
  runYearnKongFamily,
  runBeefyFamily,
  runCompoundFamily,
  runAaveFamily,
] as const;

async function runSupplementalFamiliesWithConcurrency(
  context: SupplementalSourceFamilyContext,
): Promise<SupplementalSourceFamilyResult[]> {
  const results: SupplementalSourceFamilyResult[] = [];
  let nextFamilyIndex = 0;
  const workerCount = Math.min(
    SUPPLEMENTAL_SOURCE_FAMILY_CONCURRENCY,
    SUPPLEMENTAL_SOURCE_FAMILY_REGISTRY.length,
  );

  await Promise.all(
    Array.from({ length: workerCount }, async () => {
      while (nextFamilyIndex < SUPPLEMENTAL_SOURCE_FAMILY_REGISTRY.length) {
        const familyIndex = nextFamilyIndex;
        nextFamilyIndex += 1;
        const runFamily = SUPPLEMENTAL_SOURCE_FAMILY_REGISTRY[familyIndex];
        results[familyIndex] = await runFamily(context);
      }
    }),
  );

  return results;
}

export async function loadSupplementalSourceFamilies(
  context: SupplementalSourceFamilyContext,
): Promise<{
  candidates: ResolvedYieldCandidate[];
  familyResults: SupplementalSourceFamilyResult[];
  sourceFamilyCounts: SourceFamilyCountRecord;
  supplementalSourceAccounting: SupplementalSourceAccounting;
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

  for (const result of familyResults) {
    sourceFamilyCounts[result.key] = result.sourceFamilyCount;
  }

  return {
    candidates: familyResults.flatMap((result) => result.candidates),
    familyResults,
    sourceFamilyCounts,
    supplementalSourceAccounting: {
      familyExecution: {
        familyCount: SUPPLEMENTAL_SOURCE_FAMILY_KEYS.length,
        concurrencyLimit: SUPPLEMENTAL_SOURCE_FAMILY_CONCURRENCY,
      },
      malformedSourceDrops,
      sizeGatedDrops: buildDropBucket(),
    },
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
