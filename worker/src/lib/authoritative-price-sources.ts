import { TRACKED_META_BY_ID } from "@shared/lib/stablecoins";
import type { PriceConfidence, StablecoinMeta } from "@shared/types/core";
import type { PeggedAsset } from "../cron/sync-stablecoins/enrich-prices-shared";
import { fetchMarketBackfillPriceSeries } from "../api/backfill-price-sources";
import { binarySearchNearest } from "./binary-search";
import { fetchEvmCallHexAtBlock, resolveClosestBlockAtOrBeforeTimestamp, type EvmBlockSearchCache } from "./evm-rpc";
import { getArchiveFallbackRpcUrls } from "./public-rpc-registry";

const ETHEREUM_CHAIN = "ethereum";

const PROTOCOL_REDEEM_SOURCE = "protocol-redeem";
const CAP_CUSD_ID = "cusd-cap";
const IUSD_INFINIFI_ID = "iusd-infinifi";
const USDAI_USD_AI_ID = "usdai-usd-ai";
const PYUSD_PAYPAL_ID = "pyusd-paypal";
const USDC_CIRCLE_ID = "usdc-circle";
const CAP_GET_BURN_AMOUNT_SELECTOR = "0xb7c4a6bf"; // getBurnAmount(address,uint256)
const IUSD_RECEIPT_TO_ASSET_SELECTOR = "0xf308cf65"; // receiptToAsset(uint256)
const IUSD_INFINIFI_REDEEM_CONTROLLER = "0xCb1747E89a43DEdcF4A2b831a0D94859EFeC7601";

// crvUSD PriceAggregator — exported for use as a regular consensus source
export const CRVUSD_PRICE_AGGREGATOR = "0xe5Afcf332a5457E8FafCD668BcE3dF953762Dfe7";
export const CRVUSD_PRICE_SELECTOR = "0xa035b1fe"; // price() — returns crvUSD price in USD scaled by 1e18

const CAP_SAMPLE_SUPPLY_FRACTION = 0.01;
const CAP_SAMPLE_NOTIONAL_MIN_USD = 1_000;
const CAP_SAMPLE_NOTIONAL_MAX_USD = 1_000_000;
const CAP_HISTORICAL_MIN_COVERAGE = 0.8;

export interface CurrentPriceOverride {
  price: number;
  source: string;
  confidence: PriceConfidence;
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

function sumCirculatingUsd(asset: Pick<PeggedAsset, "circulating">): number {
  const circulating = asset.circulating;
  if (!circulating || typeof circulating !== "object") return 0;
  return Object.values(circulating).reduce(
    (sum, value) => sum + (typeof value === "number" && Number.isFinite(value) ? value : 0),
    0,
  );
}

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
    const sampleNotionalUsd = clampSampleNotionalUsd(sumCirculatingUsd(asset));
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

const usdaiPyusdProvider: PriceSourceProvider = {
  source: PROTOCOL_REDEEM_SOURCE,
  matches(stablecoinId: string): boolean {
    return stablecoinId === USDAI_USD_AI_ID;
  },
  async fetchLivePrice(
    _asset: PeggedAsset,
    context: LivePriceContext,
  ): Promise<CurrentPriceOverride | null> {
    const pyusdAsset = context.assetsById.get(PYUSD_PAYPAL_ID);
    const price = getFinitePositivePrice(pyusdAsset);
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
    // Base USDAI is modeled as an instantly redeemable PYUSD wrapper, so replay the tracked PYUSD series.
    const pyusdMeta = TRACKED_META_BY_ID.get(PYUSD_PAYPAL_ID);
    if (!pyusdMeta?.geckoId) return null;

    const series = await fetchMarketBackfillPriceSeries(pyusdMeta, pyusdMeta.geckoId, {
      granularity: "hourly",
      coingeckoApiKey: context.coingeckoApiKey ?? null,
    });
    return series.prices;
  },
};

const AUTHORITATIVE_PRICE_PROVIDERS: PriceSourceProvider[] = [
  capCusdProvider,
  iusdInfinifiProvider,
  usdaiPyusdProvider,
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
    console.warn(`[authoritative-price-sources] ${meta.id} historical source failed:`, error);
    return {
      matched: true,
      source: provider.source,
      prices: null,
    };
  }
}
