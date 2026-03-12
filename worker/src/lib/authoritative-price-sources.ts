import { TRACKED_META_BY_ID } from "@shared/lib/stablecoins";
import type { PriceConfidence, StablecoinMeta } from "@shared/types";
import type { PeggedAsset } from "../cron/enrich-prices";
import {
  fetchEvmCallHexAtBlock,
  resolveClosestBlockAtOrBeforeTimestamp,
  type EvmBlockSearchCache,
} from "./evm-rpc";

const ETHEREUM_CHAIN = "ethereum";
const ETHEREUM_ARCHIVE_FALLBACK_URLS = ["https://ethereum-rpc.publicnode.com"];

const CAP_CUSD_ID = "cusd-cap";
const USDC_CIRCLE_ID = "usdc-circle";
const CAP_GET_BURN_AMOUNT_SELECTOR = "0xb7c4a6bf"; // getBurnAmount(address,uint256)

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
}

export interface HistoricalPriceResolution {
  matched: boolean;
  source: string | null;
  prices: HistoricalPricePoint[] | null;
}

interface PriceSourceProvider {
  source: string;
  matches(stablecoinId: string): boolean;
  fetchLivePrice?(asset: PeggedAsset, signal?: AbortSignal): Promise<CurrentPriceOverride | null>;
  fetchHistoricalPrices?(meta: StablecoinMeta, context: HistoricalPriceContext): Promise<HistoricalPricePoint[] | null>;
}

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
  const start = 2 + (wordIndex * 64);
  const end = start + 64;
  if (result.length < end) return null;

  try {
    return BigInt(`0x${result.slice(start, end)}`);
  } catch {
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
  const numerator = outputAmount * (10n ** BigInt(inputDecimals)) * scale;
  const denominator = inputAmount * (10n ** BigInt(outputDecimals));
  if (denominator <= 0n) return Number.NaN;

  return Number(numerator / denominator) / (10 ** precision);
}

function clampSampleNotionalUsd(supplyUsd: number | null): number {
  const scaled = supplyUsd != null && Number.isFinite(supplyUsd) && supplyUsd > 0
    ? supplyUsd * CAP_SAMPLE_SUPPLY_FRACTION
    : CAP_SAMPLE_NOTIONAL_MAX_USD;

  return Math.max(
    CAP_SAMPLE_NOTIONAL_MIN_USD,
    Math.min(CAP_SAMPLE_NOTIONAL_MAX_USD, scaled),
  );
}

function findNearestSupply(snapshots: HistoricalSupplySnapshot[] | undefined, timestamp: number): number | null {
  if (!snapshots || snapshots.length === 0) return null;

  let lo = 0;
  let hi = snapshots.length - 1;
  while (lo <= hi) {
    const mid = Math.floor((lo + hi) / 2);
    if (snapshots[mid].ts < timestamp) {
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }

  const candidates = [
    lo > 0 ? snapshots[lo - 1] : null,
    lo < snapshots.length ? snapshots[lo] : null,
  ].filter((value): value is HistoricalSupplySnapshot => value !== null);

  if (candidates.length === 0) return null;
  candidates.sort((a, b) => Math.abs(a.ts - timestamp) - Math.abs(b.ts - timestamp));
  return candidates[0].supply;
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

async function fetchCapRedeemQuote(
  sampleNotionalUsd: number,
  blockNumberOrTag: number | "latest",
  signal?: AbortSignal,
): Promise<number | null> {
  const config = getContractConfig(CAP_CUSD_ID);
  if (!config) return null;

  const sampleInputAmount = BigInt(Math.round(sampleNotionalUsd)) * (10n ** BigInt(config.contractDecimals));
  if (sampleInputAmount <= 0n) return null;

  const calldata =
    `${CAP_GET_BURN_AMOUNT_SELECTOR}${encodeAddress(config.quoteContract)}${encodeUint256(sampleInputAmount)}`;
  const quoteHex = await fetchEvmCallHexAtBlock(
    ETHEREUM_CHAIN,
    config.contract,
    calldata,
    blockNumberOrTag,
    {
      signal,
      extraRpcUrls: ETHEREUM_ARCHIVE_FALLBACK_URLS,
    },
  );
  if (!quoteHex) return null;

  const outputAmount = decodeUint256Word(quoteHex, 0);
  if (outputAmount == null || outputAmount <= 0n) return null;

  const price = ratioToNumber(
    outputAmount,
    config.quoteDecimals,
    sampleInputAmount,
    config.contractDecimals,
  );
  return Number.isFinite(price) && price > 0 ? price : null;
}

const capCusdProvider: PriceSourceProvider = {
  source: "protocol-redeem",
  matches(stablecoinId: string): boolean {
    return stablecoinId === CAP_CUSD_ID;
  },
  async fetchLivePrice(asset: PeggedAsset, signal?: AbortSignal): Promise<CurrentPriceOverride | null> {
    const sampleNotionalUsd = clampSampleNotionalUsd(sumCirculatingUsd(asset));
    const price = await fetchCapRedeemQuote(sampleNotionalUsd, "latest", signal);
    if (price == null) return null;

    return {
      price,
      source: "protocol-redeem",
      confidence: "high",
    };
  },
  async fetchHistoricalPrices(
    meta: StablecoinMeta,
    context: HistoricalPriceContext,
  ): Promise<HistoricalPricePoint[] | null> {
    const requestedTimestamps = Array.from(
      new Set(
        context.candidateTimestamps.filter((timestamp) => Number.isFinite(timestamp) && timestamp > 0),
      ),
    ).sort((a, b) => a - b);
    if (requestedTimestamps.length === 0) return null;

    const blockSearchCache: EvmBlockSearchCache = {
      blockTimestampByNumber: new Map(),
    };
    const quoteByBlock = new Map<number, number>();
    const prices: HistoricalPricePoint[] = [];

    for (const timestamp of requestedTimestamps) {
      const blockNumber = await resolveClosestBlockAtOrBeforeTimestamp(
        ETHEREUM_CHAIN,
        timestamp,
        blockSearchCache,
        {
          signal: context.signal,
          extraRpcUrls: ETHEREUM_ARCHIVE_FALLBACK_URLS,
          timeoutMs: 15_000,
        },
      );
      if (blockNumber == null) continue;

      let price = quoteByBlock.get(blockNumber) ?? null;
      if (price == null) {
        const supplyUsd = findNearestSupply(context.supplySnapshots, timestamp);
        const sampleNotionalUsd = clampSampleNotionalUsd(supplyUsd);
        price = await fetchCapRedeemQuote(sampleNotionalUsd, blockNumber, context.signal);
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
  },
};

const AUTHORITATIVE_PRICE_PROVIDERS: PriceSourceProvider[] = [
  capCusdProvider,
];

export async function fetchAuthoritativeLivePriceOverrides(
  assets: PeggedAsset[],
  signal?: AbortSignal,
): Promise<Map<string, CurrentPriceOverride>> {
  const results = new Map<string, CurrentPriceOverride>();

  for (const asset of assets) {
    const provider = AUTHORITATIVE_PRICE_PROVIDERS.find((candidate) => candidate.matches(asset.id));
    if (!provider?.fetchLivePrice) continue;

    try {
      const override = await provider.fetchLivePrice(asset, signal);
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
