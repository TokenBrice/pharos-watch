import { splitCompositePriceSource } from "@shared/lib/pricing-sources";
import { isReplaySafePriceSource } from "@shared/lib/pricing-source-policy";
import { TRACKED_META_BY_ID } from "@shared/lib/stablecoins/registry";
import type { PriceConfidence, PriceObservedAtMode, StablecoinMeta } from "@shared/types/core";
import type { PeggedAsset } from "../../cron/sync-stablecoins/enrich-prices-shared";
import { binarySearchNearest } from "../binary-search";
import {
  fetchEvmCallHexAtBlock,
  resolveClosestBlockAtOrBeforeTimestamp,
  type EvmBlockSearchCache,
} from "../evm-rpc";
import { encodeUint256 } from "../evm-selectors";
export { encodeAddress, encodeUint256 } from "../evm-selectors";
import { throwIfAborted } from "../abort";
import { getArchiveFallbackRpcUrls } from "../public-rpc-registry";
import { validateCompositePricingSourceFreshness } from "../pricing-source-freshness";
import type { PriceValidationReferences } from "../price-validation";

export const ETHEREUM_CHAIN = "ethereum";

export const PROTOCOL_REDEEM_SOURCE = "protocol-redeem";

export const USDC_CIRCLE_ID = "usdc-circle";

export const ERC4626_NAV_MIN_RATIO = 0.5;
export const ERC4626_NAV_MAX_RATIO = 10;

export interface Erc4626NavVaultConfig {
  id: string;
  parentId: string;
  chain: string;
  vault: string;
  vaultDecimals: number;
  assetDecimals: number;
  rpcUrls?: readonly string[];
  allowFreshNonReplaySafeParent?: boolean;
}

export async function fetchVaultAssetsPerShareViaSelector(
  config: Erc4626NavVaultConfig,
  selector: string,
  label: string,
  blockNumberOrTag: number | "latest",
  signal?: AbortSignal,
  options?: { throwOnNullQuote?: boolean },
): Promise<number | null> {
  const oneShareRaw = 10n ** BigInt(config.vaultDecimals);
  const calldata = `${selector}${encodeUint256(oneShareRaw)}`;
  const quoteHex = await fetchEvmCallHexAtBlock(config.chain, config.vault, calldata, blockNumberOrTag, {
    signal,
    extraRpcUrls: [...(config.rpcUrls ?? getArchiveFallbackRpcUrls(config.chain))],
  });
  if (!quoteHex) {
    const message = `[authoritative-price-sources] ${config.id}: ${label}() returned null`;
    console.warn(message);
    if (options?.throwOnNullQuote) {
      throw new Error(message);
    }
    return null;
  }

  const outputAmount = decodeUint256WordBigInt(quoteHex, 0);
  if (outputAmount == null || outputAmount <= 0n) {
    console.warn(`[authoritative-price-sources] ${config.id}: ${label}() returned zero or invalid output`);
    return null;
  }

  const assetsPerShare = ratioToNumber(outputAmount, config.assetDecimals, oneShareRaw, config.vaultDecimals);
  if (!Number.isFinite(assetsPerShare) || assetsPerShare <= 0) return null;
  if (assetsPerShare < ERC4626_NAV_MIN_RATIO || assetsPerShare > ERC4626_NAV_MAX_RATIO) {
    console.warn(
      `[authoritative-price-sources] ${config.id}: ${label}() ratio ${assetsPerShare} outside trusted bounds`,
    );
    return null;
  }

  return assetsPerShare;
}

const INHERITED_PARENT_SYNC_MAX_AGE_SEC = 30 * 60;

const CAP_HISTORICAL_MIN_COVERAGE = 0.8;

export interface CurrentPriceOverride {
  price: number;
  source: string;
  confidence: PriceConfidence;
  observedAt?: number | null;
  observedAtMode?: PriceObservedAtMode | null;
  metadata?: {
    inheritedFrom?: string;
    parentSource?: string | null;
    parentConfidence?: PriceConfidence | null;
    parentObservedAt?: number | null;
    parentObservedAtMode?: PriceObservedAtMode | null;
    parentReplaySafe?: boolean;
  };
}

export interface HistoricalPricePoint {
  timestamp: number;
  price: number;
}

export interface HistoricalSupplySnapshot {
  ts: number;
  supply: number;
}

export interface HistoricalPriceContext {
  candidateTimestamps: number[];
  supplySnapshots?: HistoricalSupplySnapshot[];
  signal?: AbortSignal;
  coingeckoApiKey?: string | null;
}

export interface HistoricalPriceResolution {
  matched: boolean;
  source: string | null;
  prices: HistoricalPricePoint[] | null;
}

export interface LivePriceContext {
  assetsById: Map<string, PeggedAsset>;
  validationReferences?: PriceValidationReferences;
}

export interface PriceSourceProvider {
  source: string;
  liveCircuitSource?: string;
  recordNullLiveResultAsCircuitFailure?: boolean;
  matches(stablecoinId: string): boolean;
  matchesHistoricalPrices?(stablecoinId: string): boolean;
  fetchLivePrice?(
    asset: PeggedAsset,
    context: LivePriceContext,
    signal?: AbortSignal,
  ): Promise<CurrentPriceOverride | null>;
  fetchHistoricalPrices?(meta: StablecoinMeta, context: HistoricalPriceContext): Promise<HistoricalPricePoint[] | null>;
}

export type HistoricalBlockPriceResolver = (
  blockNumber: number,
  timestamp: number,
  signal?: AbortSignal,
) => Promise<number | null>;

export function decodeUint256WordBigInt(result: `0x${string}`, wordIndex = 0): bigint | null {
  const start = 2 + wordIndex * 64;
  const end = start + 64;
  if (result.length < end) return null;

  try {
    return BigInt(`0x${result.slice(start, end)}`);
  } catch (err) {
    console.warn("[price-sources] hex parse ignored:", err);
    return null;
  }
}

export function ratioToNumber(
  outputAmount: bigint,
  outputDecimals: number,
  inputAmount: bigint,
  inputDecimals: number,
  precision = 8,
): number {
  if (inputAmount <= 0n) return Number.NaN;

  const scale = 10n ** BigInt(precision);
  const numerator = outputAmount * 10n ** BigInt(inputDecimals) * scale;
  const denominator = inputAmount * 10n ** BigInt(outputDecimals);
  if (denominator <= 0n) return Number.NaN;

  return Number(numerator / denominator) / 10 ** precision;
}

function getFinitePositivePrice(asset: Pick<PeggedAsset, "price"> | undefined): number | null {
  const price = asset?.price;
  return typeof price === "number" && Number.isFinite(price) && price > 0 ? price : null;
}

function isExplicitAuthoritativeParent(asset: PeggedAsset): boolean {
  return asset.priceSource === PROTOCOL_REDEEM_SOURCE &&
    asset.priceConfidence !== "fallback" &&
    asset.priceConfidence !== "low" &&
    asset.priceConfidence != null;
}

function normalizeFreshSyncedAt(value: number | null | undefined, nowSec: number): number | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return null;
  const syncedAt = Math.floor(value);
  if (syncedAt > nowSec + 60) return null;
  return nowSec - syncedAt <= INHERITED_PARENT_SYNC_MAX_AGE_SEC ? syncedAt : null;
}

interface LiveParentTrustOptions {
  allowFreshNonReplaySafeParent?: boolean;
}

function resolveTrustedInheritedParent(asset: PeggedAsset, nowSec: number, options?: LiveParentTrustOptions): {
  price: number;
  observedAt: number;
  observedAtMode: PriceObservedAtMode | null;
  replaySafe: boolean;
} | null {
  const price = getFinitePositivePrice(asset);
  if (price == null) return null;

  const parentSource = asset.priceSource ?? null;
  const parentConfidence = asset.priceConfidence ?? null;
  if (!parentSource) return null;

  const confidenceTrusted = parentConfidence === "high" || isExplicitAuthoritativeParent(asset);
  if (!confidenceTrusted) return null;

  const replaySafe = isReplaySafePriceSource(parentSource);
  if (!replaySafe) {
    const sourceParts = splitCompositePriceSource(parentSource);
    if (!options?.allowFreshNonReplaySafeParent || sourceParts.includes("cached")) {
      return null;
    }
  }

  const observedAt = asset.priceObservedAt ?? asset.priceUpdatedAt ?? null;
  const observedAtMode = asset.priceObservedAtMode ?? null;
  const freshness = validateCompositePricingSourceFreshness({
    source: parentSource,
    observedAt,
    observedAtMode,
    nowSec,
    requireObservedAt: true,
  });
  if (!freshness.accepted || freshness.observedAt == null) {
    const syncedAt = normalizeFreshSyncedAt(asset.priceSyncedAt, nowSec);
    if (
      freshness.accepted === false &&
      freshness.reason === "stale_observed_at" &&
      syncedAt != null &&
      splitCompositePriceSource(parentSource).length > 1
    ) {
      return {
        price,
        observedAt: syncedAt,
        observedAtMode: "local_fetch",
        replaySafe,
      };
    }
    return null;
  }

  return {
    price,
    observedAt: freshness.observedAt,
    observedAtMode: freshness.observedAtMode,
    replaySafe,
  };
}

export interface TrustedOverrideParent {
  parentId: string;
  parentAsset: PeggedAsset;
  trustedParent: {
    price: number;
    observedAt: number;
    observedAtMode: PriceObservedAtMode | null;
    replaySafe: boolean;
  };
}

export function resolveTrustedOverrideParent(
  context: LivePriceContext,
  parentId: string,
  untrustedParentMessage: () => string,
  options?: LiveParentTrustOptions,
): TrustedOverrideParent | null {
  const parentAsset = context.assetsById.get(parentId);
  if (!parentAsset) return null;

  const trustedParent = resolveTrustedInheritedParent(parentAsset, Math.floor(Date.now() / 1000), options);
  if (!trustedParent) {
    console.warn(untrustedParentMessage());
    return null;
  }

  return {
    parentId,
    parentAsset,
    trustedParent,
  };
}

export function buildParentDerivedLiveOverride(
  parent: TrustedOverrideParent,
  parentPriceMultiplier: number,
): CurrentPriceOverride | null {
  const price = parent.trustedParent.price * parentPriceMultiplier;
  if (!Number.isFinite(price) || price <= 0) return null;

  const parentObservedAt = parent.parentAsset.priceObservedAt ?? parent.parentAsset.priceUpdatedAt ?? null;
  return {
    price,
    source: PROTOCOL_REDEEM_SOURCE,
    confidence: "high",
    observedAt: parent.trustedParent.observedAt,
    observedAtMode: parent.trustedParent.observedAtMode,
    metadata: {
      inheritedFrom: parent.parentId,
      parentSource: parent.parentAsset.priceSource ?? null,
      parentConfidence: parent.parentAsset.priceConfidence ?? null,
      parentObservedAt,
      parentObservedAtMode: parent.parentAsset.priceObservedAtMode ?? null,
      parentReplaySafe: parent.trustedParent.replaySafe,
    },
  };
}

export function findNearestSupply(
  snapshots: HistoricalSupplySnapshot[] | undefined,
  timestamp: number,
): number | null {
  if (!snapshots || snapshots.length === 0) return null;
  const nearest = binarySearchNearest(snapshots, timestamp, (s) => s.ts);
  return nearest?.supply ?? null;
}

export function getContractConfig(stablecoinId: string): {
  contract: string;
  contractDecimals: number;
  quoteContract: string;
  quoteDecimals: number;
} | null {
  const meta = TRACKED_META_BY_ID.get(stablecoinId);
  const quoteMeta = TRACKED_META_BY_ID.get(USDC_CIRCLE_ID);
  if (!meta || !quoteMeta) return null;

  const contract = meta.contracts?.find((entry) => entry.chain === ETHEREUM_CHAIN);
  const quoteContract = quoteMeta.contracts?.find((entry) => entry.chain === ETHEREUM_CHAIN);
  if (!contract || !quoteContract) return null;

  return {
    contract: contract.address,
    contractDecimals: contract.decimals,
    quoteContract: quoteContract.address,
    quoteDecimals: quoteContract.decimals,
  };
}

export function normalizeHistoricalTimestamps(candidateTimestamps: number[]): number[] {
  return Array.from(
    new Set(candidateTimestamps.filter((timestamp) => Number.isFinite(timestamp) && timestamp > 0)),
  ).sort((a, b) => a - b);
}

export async function collectHistoricalBlockPrices(
  context: HistoricalPriceContext,
  resolvePrice: HistoricalBlockPriceResolver,
): Promise<HistoricalPricePoint[] | null> {
  const requestedTimestamps = normalizeHistoricalTimestamps(context.candidateTimestamps);
  if (requestedTimestamps.length === 0) return null;

  const blockSearchCache: EvmBlockSearchCache = {
    blockTimestampByNumber: new Map(),
  };
  const quoteByBlock = new Map<number, number>();
  const prices: HistoricalPricePoint[] = [];

  for (const timestamp of requestedTimestamps) {
    throwIfAborted(context.signal);
    const blockNumber = await resolveClosestBlockAtOrBeforeTimestamp(ETHEREUM_CHAIN, timestamp, blockSearchCache, {
      signal: context.signal,
      extraRpcUrls: getArchiveFallbackRpcUrls(ETHEREUM_CHAIN),
      timeoutMs: 15_000,
    });
    if (blockNumber == null) continue;

    let price = quoteByBlock.get(blockNumber) ?? null;
    if (price == null) {
      price = await resolvePrice(blockNumber, timestamp, context.signal);
      if (price == null) continue;
      quoteByBlock.set(blockNumber, price);
    }

    prices.push({ timestamp, price });
  }

  if (prices.length === 0) return null;
  if (prices.length / requestedTimestamps.length < CAP_HISTORICAL_MIN_COVERAGE) {
    return null;
  }

  return prices;
}
