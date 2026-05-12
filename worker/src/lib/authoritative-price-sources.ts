import { TRACKED_META_BY_ID } from "@shared/lib/stablecoins";
import { sumPegBuckets } from "@shared/lib/supply";
import type { PriceConfidence, PriceObservedAtMode, StablecoinMeta } from "@shared/types/core";
import type { PeggedAsset } from "../cron/sync-stablecoins/enrich-prices-shared";
import { fetchMarketBackfillPriceSeries } from "../api/backfill-price-sources";
import { binarySearchNearest } from "./binary-search";
import { fetchEvmCallHexAtBlock, resolveClosestBlockAtOrBeforeTimestamp, type EvmBlockSearchCache } from "./evm-rpc";
import { getArchiveFallbackRpcUrls } from "./public-rpc-registry";
import { rethrowIfAborted } from "./abort";
import { validateCompositePricingSourceFreshness } from "./pricing-source-freshness";
import { isReplaySafePriceSource } from "./pricing-source-policy";

const ETHEREUM_CHAIN = "ethereum";

const PROTOCOL_REDEEM_SOURCE = "protocol-redeem";
const CAP_CUSD_ID = "cusd-cap";
const IUSD_INFINIFI_ID = "iusd-infinifi";
const USDAI_USD_AI_ID = "usdai-usd-ai";
const PYUSD_PAYPAL_ID = "pyusd-paypal";
const USDK_KAST_ID = "usdk-kast";
const XO_EXODUS_ID = "xo-exodus";
const USDNR_NERONA_ID = "usdnr-nerona";
const WM_M0_ID = "wm-m0";
const USDC_CIRCLE_ID = "usdc-circle";
const CAP_GET_BURN_AMOUNT_SELECTOR = "0xb7c4a6bf"; // getBurnAmount(address,uint256)
const IUSD_RECEIPT_TO_ASSET_SELECTOR = "0xf308cf65"; // receiptToAsset(uint256)
const IUSD_INFINIFI_REDEEM_CONTROLLER = "0xCb1747E89a43DEdcF4A2b831a0D94859EFeC7601";
const ERC4626_CONVERT_TO_ASSETS_SELECTOR = "0x07a2d13a"; // convertToAssets(uint256)
const ERC4626_NAV_MIN_RATIO = 0.5;
const ERC4626_NAV_MAX_RATIO = 10;

const CAP_SAMPLE_SUPPLY_FRACTION = 0.01;
const CAP_SAMPLE_NOTIONAL_MIN_USD = 1_000;
const CAP_SAMPLE_NOTIONAL_MAX_USD = 1_000_000;
const CAP_HISTORICAL_MIN_COVERAGE = 0.8;
const INHERITED_TRACKED_PRICE_PARENTS = {
  [USDAI_USD_AI_ID]: PYUSD_PAYPAL_ID,
  [USDK_KAST_ID]: WM_M0_ID,
  [XO_EXODUS_ID]: WM_M0_ID,
  [USDNR_NERONA_ID]: WM_M0_ID,
} as const satisfies Record<string, string>;

interface Erc4626NavVaultConfig {
  id: string;
  parentId: string;
  chain: string;
  vault: string;
  vaultDecimals: number;
  assetDecimals: number;
}

// ERC-4626 vaults that should be priced from `convertToAssets(1 share)` * parent.price.
// Each entry must have a single tracked parent that already prices through normal consensus.
const ERC4626_NAV_VAULTS: readonly Erc4626NavVaultConfig[] = [
  {
    id: "susdt-spark",
    parentId: "usdt-tether",
    chain: ETHEREUM_CHAIN,
    vault: "0xe2e7a17dff93280dec073c995595155283e3c372",
    vaultDecimals: 6,
    assetDecimals: 6,
  },
  {
    id: "gtusdc-gauntlet",
    parentId: USDC_CIRCLE_ID,
    chain: ETHEREUM_CHAIN,
    vault: "0xdd0f28e19c1780eb6396170735d45153d261490d",
    vaultDecimals: 18,
    assetDecimals: 6,
  },
  {
    id: "yvusdc-yearn",
    parentId: USDC_CIRCLE_ID,
    chain: ETHEREUM_CHAIN,
    vault: "0xbe53a109b494e5c9f97b9cd39fe969be68bf6204",
    vaultDecimals: 6,
    assetDecimals: 6,
  },
  {
    id: "sgho-aave",
    parentId: "gho-aave",
    chain: ETHEREUM_CHAIN,
    vault: "0x1a88df1cfe15af22b3c4c783d4e6f7f9e0c1885d",
    vaultDecimals: 18,
    assetDecimals: 18,
  },
  {
    id: "stkgho-umbrella-aave",
    parentId: "gho-aave",
    chain: ETHEREUM_CHAIN,
    vault: "0x4f827a63755855cdf3e8f3bcd20265c833f15033",
    vaultDecimals: 18,
    assetDecimals: 18,
  },
  {
    id: "sbold-k3-capital",
    parentId: "bold-liquity",
    chain: ETHEREUM_CHAIN,
    vault: "0x50bd66d59911f5e086ec87ae43c811e0d059dd11",
    vaultDecimals: 18,
    assetDecimals: 18,
  },
];

const ERC4626_NAV_VAULTS_BY_ID = new Map<string, Erc4626NavVaultConfig>(
  ERC4626_NAV_VAULTS.map((entry) => [entry.id, entry]),
);

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

interface LivePriceContext {
  assetsById: Map<string, PeggedAsset>;
}

interface PriceSourceProvider {
  source: string;
  matches(stablecoinId: string): boolean;
  fetchLivePrice?(
    asset: PeggedAsset,
    context: LivePriceContext,
    signal?: AbortSignal,
  ): Promise<CurrentPriceOverride | null>;
  fetchHistoricalPrices?(meta: StablecoinMeta, context: HistoricalPriceContext): Promise<HistoricalPricePoint[] | null>;
}

type HistoricalBlockPriceResolver = (
  blockNumber: number,
  timestamp: number,
  signal?: AbortSignal,
) => Promise<number | null>;

function encodeAddress(address: string): string {
  return address.replace(/^0x/i, "").toLowerCase().padStart(64, "0");
}

function encodeUint256(value: bigint): string {
  return value.toString(16).padStart(64, "0");
}

function decodeUint256Word(result: `0x${string}`, wordIndex = 0): bigint | null {
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

function ratioToNumber(
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

function clampSampleNotionalUsd(supplyUsd: number | null): number {
  const scaled =
    supplyUsd != null && Number.isFinite(supplyUsd) && supplyUsd > 0
      ? supplyUsd * CAP_SAMPLE_SUPPLY_FRACTION
      : CAP_SAMPLE_NOTIONAL_MAX_USD;

  return Math.max(CAP_SAMPLE_NOTIONAL_MIN_USD, Math.min(CAP_SAMPLE_NOTIONAL_MAX_USD, scaled));
}

function getFinitePositivePrice(asset: Pick<PeggedAsset, "price"> | undefined): number | null {
  const price = asset?.price;
  return typeof price === "number" && Number.isFinite(price) && price > 0 ? price : null;
}

function getInheritedTrackedPriceParentId(stablecoinId: string): string | null {
  return INHERITED_TRACKED_PRICE_PARENTS[stablecoinId as keyof typeof INHERITED_TRACKED_PRICE_PARENTS] ?? null;
}

function isExplicitAuthoritativeParent(asset: PeggedAsset): boolean {
  return asset.priceSource === PROTOCOL_REDEEM_SOURCE &&
    asset.priceConfidence !== "fallback" &&
    asset.priceConfidence !== "low" &&
    asset.priceConfidence != null;
}

function resolveTrustedInheritedParent(asset: PeggedAsset, nowSec: number): {
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
  if (!replaySafe) return null;

  const observedAt = asset.priceObservedAt ?? asset.priceUpdatedAt ?? null;
  const observedAtMode = asset.priceObservedAtMode ?? null;
  const freshness = validateCompositePricingSourceFreshness({
    source: parentSource,
    observedAt,
    observedAtMode,
    nowSec,
    requireObservedAt: true,
  });
  if (!freshness.accepted || freshness.observedAt == null) return null;

  return {
    price,
    observedAt: freshness.observedAt,
    observedAtMode: freshness.observedAtMode,
    replaySafe,
  };
}

function findNearestSupply(snapshots: HistoricalSupplySnapshot[] | undefined, timestamp: number): number | null {
  if (!snapshots || snapshots.length === 0) return null;
  const nearest = binarySearchNearest(snapshots, timestamp, (s) => s.ts);
  return nearest?.supply ?? null;
}

function getContractConfig(stablecoinId: string): {
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

function normalizeHistoricalTimestamps(candidateTimestamps: number[]): number[] {
  return Array.from(
    new Set(candidateTimestamps.filter((timestamp) => Number.isFinite(timestamp) && timestamp > 0)),
  ).sort((a, b) => a - b);
}

async function collectHistoricalBlockPrices(
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

async function fetchCapRedeemQuote(
  sampleNotionalUsd: number,
  blockNumberOrTag: number | "latest",
  signal?: AbortSignal,
): Promise<number | null> {
  const config = getContractConfig(CAP_CUSD_ID);
  if (!config) return null;

  const sampleInputAmount = BigInt(Math.round(sampleNotionalUsd)) * 10n ** BigInt(config.contractDecimals);
  if (sampleInputAmount <= 0n) return null;

  const calldata = `${CAP_GET_BURN_AMOUNT_SELECTOR}${encodeAddress(config.quoteContract)}${encodeUint256(sampleInputAmount)}`;
  const quoteHex = await fetchEvmCallHexAtBlock(ETHEREUM_CHAIN, config.contract, calldata, blockNumberOrTag, {
    signal,
    extraRpcUrls: getArchiveFallbackRpcUrls(ETHEREUM_CHAIN),
  });
  if (!quoteHex) {
    console.warn(`[authoritative-price-sources] cusd-cap: RPC returned null`);
    return null;
  }

  const outputAmount = decodeUint256Word(quoteHex, 0);
  if (outputAmount == null || outputAmount <= 0n) {
    console.warn(`[authoritative-price-sources] cusd-cap: contract returned zero or invalid output`);
    return null;
  }

  const price = ratioToNumber(outputAmount, config.quoteDecimals, sampleInputAmount, config.contractDecimals);
  return Number.isFinite(price) && price > 0 ? price : null;
}

const capCusdProvider: PriceSourceProvider = {
  source: PROTOCOL_REDEEM_SOURCE,
  matches(stablecoinId: string): boolean {
    return stablecoinId === CAP_CUSD_ID;
  },
  async fetchLivePrice(asset: PeggedAsset, _context: LivePriceContext, signal?: AbortSignal): Promise<CurrentPriceOverride | null> {
    const sampleNotionalUsd = clampSampleNotionalUsd(sumPegBuckets(asset.circulating));
    const price = await fetchCapRedeemQuote(sampleNotionalUsd, "latest", signal);
    if (price == null) return null;

    return {
      price,
      source: PROTOCOL_REDEEM_SOURCE,
      confidence: "high",
    };
  },
  async fetchHistoricalPrices(
    _meta: StablecoinMeta,
    context: HistoricalPriceContext,
  ): Promise<HistoricalPricePoint[] | null> {
    return collectHistoricalBlockPrices(context, async (blockNumber, timestamp, signal) => {
      const supplyUsd = findNearestSupply(context.supplySnapshots, timestamp);
      const sampleNotionalUsd = clampSampleNotionalUsd(supplyUsd);
      return fetchCapRedeemQuote(sampleNotionalUsd, blockNumber, signal);
    });
  },
};

async function fetchInfiniFiRedeemQuote(
  blockNumberOrTag: number | "latest",
  signal?: AbortSignal,
): Promise<number | null> {
  const config = getContractConfig(IUSD_INFINIFI_ID);
  if (!config) return null;

  const inputAmount = 10n ** BigInt(config.contractDecimals);
  const quoteHex = await fetchEvmCallHexAtBlock(
    ETHEREUM_CHAIN,
    IUSD_INFINIFI_REDEEM_CONTROLLER,
    `${IUSD_RECEIPT_TO_ASSET_SELECTOR}${encodeUint256(inputAmount)}`,
    blockNumberOrTag,
    {
      signal,
      extraRpcUrls: getArchiveFallbackRpcUrls(ETHEREUM_CHAIN),
    },
  );
  if (!quoteHex) {
    console.warn(`[authoritative-price-sources] iusd-infinifi: RPC returned null`);
    return null;
  }

  const outputAmount = decodeUint256Word(quoteHex, 0);
  if (outputAmount == null || outputAmount <= 0n) {
    console.warn(`[authoritative-price-sources] iusd-infinifi: contract returned zero or invalid output`);
    return null;
  }

  const price = ratioToNumber(outputAmount, config.quoteDecimals, inputAmount, config.contractDecimals);
  return Number.isFinite(price) && price > 0 ? price : null;
}

const iusdInfinifiProvider: PriceSourceProvider = {
  source: PROTOCOL_REDEEM_SOURCE,
  matches(stablecoinId: string): boolean {
    return stablecoinId === IUSD_INFINIFI_ID;
  },
  async fetchLivePrice(
    _asset: PeggedAsset,
    _context: LivePriceContext,
    signal?: AbortSignal,
  ): Promise<CurrentPriceOverride | null> {
    const price = await fetchInfiniFiRedeemQuote("latest", signal);
    if (price == null) return null;

    return {
      price,
      source: PROTOCOL_REDEEM_SOURCE,
      confidence: "high",
    };
  },
  async fetchHistoricalPrices(
    _meta: StablecoinMeta,
    context: HistoricalPriceContext,
  ): Promise<HistoricalPricePoint[] | null> {
    return collectHistoricalBlockPrices(
      context,
      (blockNumber, _timestamp, signal) => fetchInfiniFiRedeemQuote(blockNumber, signal),
    );
  },
};

async function replayInheritedTrackedPriceSeries(
  parentId: string,
  context: HistoricalPriceContext,
): Promise<HistoricalPricePoint[] | null> {
  const parentMeta = TRACKED_META_BY_ID.get(parentId);
  if (!parentMeta?.geckoId) return null;

  const series = await fetchMarketBackfillPriceSeries(parentMeta, parentMeta.geckoId, {
    granularity: "hourly",
    coingeckoApiKey: context.coingeckoApiKey ?? null,
  });
  return series.prices;
}

const inheritedTrackedPriceProvider: PriceSourceProvider = {
  source: PROTOCOL_REDEEM_SOURCE,
  matches(stablecoinId: string): boolean {
    return getInheritedTrackedPriceParentId(stablecoinId) != null;
  },
  async fetchLivePrice(
    asset: PeggedAsset,
    context: LivePriceContext,
  ): Promise<CurrentPriceOverride | null> {
    const parentId = getInheritedTrackedPriceParentId(asset.id);
    if (!parentId) return null;

    const parentAsset = context.assetsById.get(parentId);
    if (!parentAsset) return null;

    const trustedParent = resolveTrustedInheritedParent(parentAsset, Math.floor(Date.now() / 1000));
    if (!trustedParent) {
      console.warn(
        `[authoritative-price-sources] ${asset.id}: skipped inherited ${parentId} price because parent provenance is not trusted`,
      );
      return null;
    }

    const parentObservedAt = parentAsset.priceObservedAt ?? parentAsset.priceUpdatedAt ?? null;
    return {
      price: trustedParent.price,
      source: PROTOCOL_REDEEM_SOURCE,
      confidence: "high",
      observedAt: trustedParent.observedAt,
      observedAtMode: trustedParent.observedAtMode,
      metadata: {
        inheritedFrom: parentId,
        parentSource: parentAsset.priceSource ?? null,
        parentConfidence: parentAsset.priceConfidence ?? null,
        parentObservedAt,
        parentObservedAtMode: parentAsset.priceObservedAtMode ?? null,
        parentReplaySafe: trustedParent.replaySafe,
      },
    };
  },
  async fetchHistoricalPrices(
    meta: StablecoinMeta,
    context: HistoricalPriceContext,
  ): Promise<HistoricalPricePoint[] | null> {
    const parentId = getInheritedTrackedPriceParentId(meta.id);
    if (!parentId) return null;

    return replayInheritedTrackedPriceSeries(parentId, context);
  },
};

async function fetchErc4626AssetsPerShare(
  config: Erc4626NavVaultConfig,
  blockNumberOrTag: number | "latest",
  signal?: AbortSignal,
): Promise<number | null> {
  const oneShareRaw = 10n ** BigInt(config.vaultDecimals);
  const calldata = `${ERC4626_CONVERT_TO_ASSETS_SELECTOR}${encodeUint256(oneShareRaw)}`;
  const quoteHex = await fetchEvmCallHexAtBlock(config.chain, config.vault, calldata, blockNumberOrTag, {
    signal,
    extraRpcUrls: getArchiveFallbackRpcUrls(config.chain),
  });
  if (!quoteHex) {
    console.warn(`[authoritative-price-sources] ${config.id}: convertToAssets() returned null`);
    return null;
  }
  const outputAmount = decodeUint256Word(quoteHex, 0);
  if (outputAmount == null || outputAmount <= 0n) {
    console.warn(`[authoritative-price-sources] ${config.id}: convertToAssets() returned zero or invalid output`);
    return null;
  }
  const assetsPerShare = ratioToNumber(outputAmount, config.assetDecimals, oneShareRaw, config.vaultDecimals);
  if (!Number.isFinite(assetsPerShare) || assetsPerShare <= 0) return null;
  if (assetsPerShare < ERC4626_NAV_MIN_RATIO || assetsPerShare > ERC4626_NAV_MAX_RATIO) {
    console.warn(
      `[authoritative-price-sources] ${config.id}: convertToAssets() ratio ${assetsPerShare} outside trusted bounds`,
    );
    return null;
  }
  return assetsPerShare;
}

const erc4626NavProvider: PriceSourceProvider = {
  source: PROTOCOL_REDEEM_SOURCE,
  matches(stablecoinId: string): boolean {
    return ERC4626_NAV_VAULTS_BY_ID.has(stablecoinId);
  },
  async fetchLivePrice(
    asset: PeggedAsset,
    context: LivePriceContext,
    signal?: AbortSignal,
  ): Promise<CurrentPriceOverride | null> {
    const config = ERC4626_NAV_VAULTS_BY_ID.get(asset.id);
    if (!config) return null;

    const parentAsset = context.assetsById.get(config.parentId);
    if (!parentAsset) return null;

    const trustedParent = resolveTrustedInheritedParent(parentAsset, Math.floor(Date.now() / 1000));
    if (!trustedParent) {
      console.warn(
        `[authoritative-price-sources] ${asset.id}: skipped ERC-4626 NAV price because parent ${config.parentId} provenance is not trusted`,
      );
      return null;
    }

    const assetsPerShare = await fetchErc4626AssetsPerShare(config, "latest", signal);
    if (assetsPerShare == null) return null;

    const price = assetsPerShare * trustedParent.price;
    if (!Number.isFinite(price) || price <= 0) return null;

    const parentObservedAt = parentAsset.priceObservedAt ?? parentAsset.priceUpdatedAt ?? null;
    return {
      price,
      source: PROTOCOL_REDEEM_SOURCE,
      confidence: "high",
      observedAt: trustedParent.observedAt,
      observedAtMode: trustedParent.observedAtMode,
      metadata: {
        inheritedFrom: config.parentId,
        parentSource: parentAsset.priceSource ?? null,
        parentConfidence: parentAsset.priceConfidence ?? null,
        parentObservedAt,
        parentObservedAtMode: parentAsset.priceObservedAtMode ?? null,
        parentReplaySafe: trustedParent.replaySafe,
      },
    };
  },
};

const AUTHORITATIVE_PRICE_PROVIDERS: PriceSourceProvider[] = [
  capCusdProvider,
  iusdInfinifiProvider,
  inheritedTrackedPriceProvider,
  erc4626NavProvider,
];

export async function fetchAuthoritativeLivePriceOverrides(
  assets: PeggedAsset[],
  signal?: AbortSignal,
): Promise<Map<string, CurrentPriceOverride>> {
  const results = new Map<string, CurrentPriceOverride>();
  const liveContext: LivePriceContext = {
    assetsById: new Map(assets.map((asset) => [asset.id, asset])),
  };

  for (const asset of assets) {
    const provider = AUTHORITATIVE_PRICE_PROVIDERS.find((candidate) => candidate.matches(asset.id));
    if (!provider?.fetchLivePrice) continue;

    try {
      const override = await provider.fetchLivePrice(asset, liveContext, signal);
      if (override) {
        results.set(asset.id, override);
      }
    } catch (error) {
      rethrowIfAborted(error, signal);
      console.warn(`[authoritative-price-sources] ${asset.id} live override failed:`, error);
    }
  }

  return results;
}

export async function fetchAuthoritativeHistoricalPriceSeries(
  meta: StablecoinMeta,
  context: HistoricalPriceContext,
): Promise<HistoricalPriceResolution> {
  const provider = AUTHORITATIVE_PRICE_PROVIDERS.find((candidate) => candidate.matches(meta.id));
  if (!provider?.fetchHistoricalPrices) {
    return { matched: false, source: null, prices: null };
  }

  try {
    const prices = await provider.fetchHistoricalPrices(meta, context);
    return {
      matched: true,
      source: provider.source,
      prices,
    };
  } catch (error) {
    rethrowIfAborted(error, context.signal);
    console.warn(`[authoritative-price-sources] ${meta.id} historical source failed:`, error);
    return {
      matched: true,
      source: provider.source,
      prices: null,
    };
  }
}
