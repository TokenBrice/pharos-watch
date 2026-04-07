import { ACTIVE_STABLECOINS, TRACKED_META_BY_ID } from "@shared/lib/stablecoins";
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

interface SupplementalSourceFamilyResult {
  key: "morpho" | "pendle" | "yearnKong" | "beefy" | "compoundV3" | "aaveV3";
  candidates: ResolvedYieldCandidate[];
  sourceFamilyCount: number;
  telemetry?: OptionalRpcFamilyTelemetry;
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

  const { rates, telemetry } = await runOptionalSourceFamily(
    "Aave V3 supplemental family",
    context.signal,
    () => fetchAaveV3SupplyRates(targets, context.signal, context.chainRpcs),
    {
      rates: new Map(),
      telemetry: EMPTY_OPTIONAL_RPC_TELEMETRY,
    },
  );

  const candidates: ResolvedYieldCandidate[] = [];
  for (const [stablecoinId, { apy, chain }] of rates) {
    const meta = TRACKED_META_BY_ID.get(stablecoinId);
    if (!meta || apy <= 0) continue;
    const assetAddress = getTrackedContractAddress(stablecoinId, chain);
    candidates.push({
      symbol: meta.symbol,
      chain,
      address: assetAddress,
      yield: {
        currentApy: apy,
        apyBase: apy,
        apyReward: null,
        sourcePool: null,
        sourceTvlUsd: null,
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
    sourceFamilyCount: rates.size,
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

export async function loadSupplementalSourceFamilies(
  context: SupplementalSourceFamilyContext,
): Promise<{
  candidates: ResolvedYieldCandidate[];
  sourceFamilyCounts: Record<SupplementalSourceFamilyResult["key"], number>;
  optionalRpcTelemetry: {
    compoundV3: OptionalRpcFamilyTelemetry;
    aaveV3: OptionalRpcFamilyTelemetry;
  };
}> {
  const familyResults = await Promise.all(
    SUPPLEMENTAL_SOURCE_FAMILY_REGISTRY.map((runFamily) => runFamily(context)),
  );

  const sourceFamilyCounts = {
    morpho: 0,
    pendle: 0,
    yearnKong: 0,
    beefy: 0,
    compoundV3: 0,
    aaveV3: 0,
  };

  for (const result of familyResults) {
    sourceFamilyCounts[result.key] = result.sourceFamilyCount;
  }

  return {
    candidates: familyResults.flatMap((result) => result.candidates),
    sourceFamilyCounts,
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
