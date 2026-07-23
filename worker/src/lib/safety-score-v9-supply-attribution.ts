import { CHAIN_META } from "@shared/lib/chains";
import { sha256Hex } from "@shared/lib/sha256";
import { stableJsonStringifyV1 } from "@shared/lib/stable-json";
import { getCirculatingRaw } from "@shared/lib/supply";
import { ACTIVE_META_BY_ID } from "@shared/lib/stablecoins/registry";
import type { StablecoinData } from "@shared/types/market";
import { rethrowIfAborted, throwIfAborted } from "./abort";
import type { ChainRpcConfig } from "./chain-registry";
import {
  fetchEvmMulticall3Aggregate3AtBlock,
  type EvmMulticall3Result,
} from "./evm-rpc";
import { encodeBalanceOfCallData, TOTAL_SUPPLY_SELECTOR } from "./evm-selectors";
import type { ReportCardsFixedInput } from "./report-cards-fixed-input";

interface LockMintSupplyAttributionConfig {
  canonicalChain: string;
  lockboxAddresses: readonly string[];
  pooledRepresentationLabel: string;
}

const LOCK_MINT_SUPPLY_ATTRIBUTIONS: Readonly<Record<string, LockMintSupplyAttributionConfig>> = {
  "xaut-tether": {
    canonicalChain: "ethereum",
    lockboxAddresses: ["0xb9c2321bb7d0db468f570d10a424d1cc8efd696c"],
    pooledRepresentationLabel: "XAUt0 lock-mint pool",
  },
};

const LOCK_MINT_SHARE_SCALE = 10n ** 15n;

export interface LockMintSupplyPartition {
  currentSupplyUsdByChain: Record<string, number>;
  canonicalSupplyUsd: number;
  pooledRepresentationSupplyUsd: number;
}

type V9SupplyAttributionById = ReportCardsFixedInput["safetyScoreV9SupplyAttributionById"];
type V9CurrentChainRows = Record<string, { current: number }>;

/**
 * Partitions an existing aggregate liability by the observed canonical
 * lockbox share. Locked backing and its wrapped holder claims are counted once.
 */
export function deriveLockMintSupplyPartition(input: {
  aggregateSupplyUsd: number;
  canonicalTotalSupplyRaw: bigint;
  lockboxBalancesRaw: readonly bigint[];
  canonicalChainLabel: string;
  pooledRepresentationLabel: string;
}): LockMintSupplyPartition | null {
  if (!Number.isFinite(input.aggregateSupplyUsd) || input.aggregateSupplyUsd <= 0) return null;
  if (input.canonicalTotalSupplyRaw <= 0n || input.lockboxBalancesRaw.length === 0) return null;

  let lockedRaw = 0n;
  for (const balance of input.lockboxBalancesRaw) {
    if (balance < 0n) return null;
    lockedRaw += balance;
  }
  if (lockedRaw <= 0n || lockedRaw >= input.canonicalTotalSupplyRaw) return null;

  const pooledShareScaled =
    (lockedRaw * LOCK_MINT_SHARE_SCALE + input.canonicalTotalSupplyRaw / 2n) /
    input.canonicalTotalSupplyRaw;
  const pooledShare = Number(pooledShareScaled) / Number(LOCK_MINT_SHARE_SCALE);
  if (!Number.isFinite(pooledShare) || pooledShare <= 0 || pooledShare >= 1) return null;

  const pooledRepresentationSupplyUsd = input.aggregateSupplyUsd * pooledShare;
  const canonicalSupplyUsd = input.aggregateSupplyUsd - pooledRepresentationSupplyUsd;
  if (
    !Number.isFinite(canonicalSupplyUsd) ||
    canonicalSupplyUsd <= 0 ||
    !Number.isFinite(pooledRepresentationSupplyUsd) ||
    pooledRepresentationSupplyUsd <= 0
  ) {
    return null;
  }

  return {
    currentSupplyUsdByChain: {
      [input.canonicalChainLabel]: canonicalSupplyUsd,
      [input.pooledRepresentationLabel]: pooledRepresentationSupplyUsd,
    },
    canonicalSupplyUsd,
    pooledRepresentationSupplyUsd,
  };
}

function decodeUint256(result: EvmMulticall3Result | undefined): bigint | null {
  if (!result?.success || !/^0x[0-9a-fA-F]{64}$/.test(result.returnData)) return null;
  return BigInt(result.returnData);
}

async function observeLockMintSupplyPartition(
  asset: StablecoinData,
  config: LockMintSupplyAttributionConfig,
  chainRpcs: Map<string, ChainRpcConfig>,
  signal?: AbortSignal,
): Promise<LockMintSupplyPartition | null> {
  const meta = ACTIVE_META_BY_ID.get(asset.id);
  const canonicalContract = meta?.contracts?.find((contract) => contract.chain === config.canonicalChain);
  const canonicalChain = CHAIN_META[config.canonicalChain];
  if (!canonicalContract || canonicalChain?.type !== "evm" || !chainRpcs.has(config.canonicalChain)) return null;

  const aggregateSupplyUsd = getCirculatingRaw(asset);
  if (!Number.isFinite(aggregateSupplyUsd) || aggregateSupplyUsd <= 0) return null;

  const calls = [
    {
      label: "canonical-total-supply",
      target: canonicalContract.address,
      callData: TOTAL_SUPPLY_SELECTOR,
      allowFailure: false,
    },
    ...config.lockboxAddresses.map((lockboxAddress, index) => ({
      label: `lockbox-balance:${index}`,
      target: canonicalContract.address,
      callData: encodeBalanceOfCallData(lockboxAddress),
      allowFailure: false,
    })),
  ];
  const results = await fetchEvmMulticall3Aggregate3AtBlock(
    config.canonicalChain,
    calls,
    "latest",
    {
      chainRpcs,
      signal,
      timeoutMs: 10_000,
      maxRetries: 1,
    },
  );
  if (!results || results.length !== calls.length) return null;

  const canonicalTotalSupplyRaw = decodeUint256(results[0]);
  const lockboxBalancesRaw = results.slice(1).map(decodeUint256);
  if (canonicalTotalSupplyRaw === null || lockboxBalancesRaw.some((balance) => balance === null)) return null;

  return deriveLockMintSupplyPartition({
    aggregateSupplyUsd,
    canonicalTotalSupplyRaw,
    lockboxBalancesRaw: lockboxBalancesRaw as bigint[],
    canonicalChainLabel: canonicalChain.name,
    pooledRepresentationLabel: config.pooledRepresentationLabel,
  });
}

/**
 * Captures V9-only supply attribution without mutating the public stablecoin
 * row or the V8 chain map used by exact replay.
 */
export async function captureSafetyScoreV9SupplyAttributionById(
  assets: readonly StablecoinData[],
  observedAtSec: number,
  chainRpcs?: Map<string, ChainRpcConfig>,
  signal?: AbortSignal,
): Promise<V9SupplyAttributionById> {
  if (!chainRpcs || chainRpcs.size === 0) return {};
  const assetsById = new Map(assets.map((asset) => [asset.id, asset]));
  const attributionById: V9SupplyAttributionById = {};

  for (const [assetId, config] of Object.entries(LOCK_MINT_SUPPLY_ATTRIBUTIONS)) {
    throwIfAborted(signal);
    const asset = assetsById.get(assetId);
    if (!asset) continue;
    const existingSupplyUsd = Object.values(asset.chainCirculating).reduce((sum, row) => sum + row.current, 0);
    if (existingSupplyUsd > 0) continue;

    try {
      const partition = await observeLockMintSupplyPartition(asset, config, chainRpcs, signal);
      if (!partition) continue;
      attributionById[assetId] = {
        model: "canonical-lock-mint-partition-v1",
        observedAtSec,
        currentSupplyUsdByChain: partition.currentSupplyUsdByChain,
      };
    } catch (error) {
      rethrowIfAborted(error, signal);
      console.warn(`[safety-score-v9] Supply attribution failed for ${asset.symbol}:`, error);
    }
  }

  return attributionById;
}

export function safetyScoreV9ChainRows(
  fixedInput: Readonly<ReportCardsFixedInput>,
  assetId: string,
): V9CurrentChainRows {
  const attribution = fixedInput.safetyScoreV9SupplyAttributionById?.[assetId];
  if (attribution) {
    return Object.fromEntries(
      Object.entries(attribution.currentSupplyUsdByChain).map(([chain, current]) => [chain, { current }]),
    );
  }
  return fixedInput.chainCirculatingById[assetId] ?? {};
}

export function safetyScoreV9ChainSupplyObservedAtSec(
  fixedInput: Readonly<ReportCardsFixedInput>,
  assetId: string,
  fallbackObservedAtSec: number,
): number {
  return fixedInput.safetyScoreV9SupplyAttributionById?.[assetId]?.observedAtSec ?? fallbackObservedAtSec;
}

export function safetyScoreV9ChainSupplySourcePayload(fixedInput: Readonly<ReportCardsFixedInput>) {
  const attributionById = fixedInput.safetyScoreV9SupplyAttributionById ?? {};
  return {
    chainCirculatingById: fixedInput.chainCirculatingById,
    ...(Object.keys(attributionById).length > 0
      ? { safetyScoreV9SupplyAttributionById: attributionById }
      : {}),
    dexDeploymentSupplyCoverageById: fixedInput.dexDeploymentSupplyCoverageById,
  };
}

export function safetyScoreV9ChainSupplySourceGenerationId(
  fixedInput: Readonly<ReportCardsFixedInput>,
): string {
  const digest = sha256Hex(
    stableJsonStringifyV1({
      domain: "safety-score-v9.chain-supply.v1",
      payload: safetyScoreV9ChainSupplySourcePayload(fixedInput),
    }),
  );
  return `chain-supply:v1:${digest}`;
}
