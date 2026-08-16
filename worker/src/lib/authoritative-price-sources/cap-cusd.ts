import { logWorkerEventArgs } from "../structured-log";
import { sumPegBuckets } from "@shared/lib/supply";
import type { StablecoinMeta } from "@shared/types/core";
import type { PeggedAsset } from "../../cron/sync-stablecoins/enrich-prices-shared";
import { fetchEvmCallHexAtBlock } from "../evm-rpc";
import { getPublicFallbackRpcUrls } from "../public-rpc-registry";
import { CIRCUIT_SOURCE } from "../constants";
import {
  collectHistoricalBlockPrices,
  decodeUint256WordBigInt,
  encodeAddress,
  encodeUint256,
  ETHEREUM_CHAIN,
  findNearestSupply,
  getUsdcQuotedRedeemConfig,
  PROTOCOL_REDEEM_SOURCE,
  ratioToNumber,
  type CurrentPriceOverride,
  type HistoricalPriceContext,
  type HistoricalPricePoint,
  type LivePriceContext,
  type PriceSourceProvider,
} from "./helpers";

const CAP_CUSD_ID = "cusd-cap";
const CAP_GET_BURN_AMOUNT_SELECTOR = "0xb7c4a6bf"; // getBurnAmount(address,uint256)
const CAP_SAMPLE_SUPPLY_FRACTION = 0.01;
const CAP_SAMPLE_NOTIONAL_MIN_USD = 1_000;
const CAP_SAMPLE_NOTIONAL_MAX_USD = 1_000_000;

function clampSampleNotionalUsd(supplyUsd: number | null): number {
  const scaled =
    supplyUsd != null && Number.isFinite(supplyUsd) && supplyUsd > 0
      ? supplyUsd * CAP_SAMPLE_SUPPLY_FRACTION
      : CAP_SAMPLE_NOTIONAL_MAX_USD;

  return Math.max(CAP_SAMPLE_NOTIONAL_MIN_USD, Math.min(CAP_SAMPLE_NOTIONAL_MAX_USD, scaled));
}

async function fetchCapRedeemQuote(
  sampleNotionalUsd: number,
  blockNumberOrTag: number | "latest",
  signal?: AbortSignal,
): Promise<number | null> {
  const config = getUsdcQuotedRedeemConfig(CAP_CUSD_ID);
  if (!config) return null;

  const sampleInputAmount = BigInt(Math.round(sampleNotionalUsd)) * 10n ** BigInt(config.contractDecimals);
  if (sampleInputAmount <= 0n) return null;

  const calldata = `${CAP_GET_BURN_AMOUNT_SELECTOR}${encodeAddress(config.quoteContract)}${encodeUint256(sampleInputAmount)}`;
  const quoteHex = await fetchEvmCallHexAtBlock(ETHEREUM_CHAIN, config.contract, calldata, blockNumberOrTag, {
    signal,
    extraRpcUrls: getPublicFallbackRpcUrls(ETHEREUM_CHAIN),
  });
  if (!quoteHex) {
    logWorkerEventArgs("lib", "warn", `[authoritative-price-sources] cusd-cap: RPC returned null`);
    return null;
  }

  const outputAmount = decodeUint256WordBigInt(quoteHex, 0);
  if (outputAmount == null || outputAmount <= 0n) {
    logWorkerEventArgs("lib", "warn", `[authoritative-price-sources] cusd-cap: contract returned zero or invalid output`);
    return null;
  }

  const price = ratioToNumber(outputAmount, config.quoteDecimals, sampleInputAmount, config.contractDecimals);
  return Number.isFinite(price) && price > 0 ? price : null;
}

export const capCusdProvider: PriceSourceProvider = {
  source: PROTOCOL_REDEEM_SOURCE,
  liveCircuitSource: CIRCUIT_SOURCE.PROTOCOL_REDEEM,
  recordNullLiveResultAsCircuitFailure: true,
  matches(stablecoinId: string): boolean {
    return stablecoinId === CAP_CUSD_ID;
  },
  async fetchLivePrice(
    asset: PeggedAsset,
    _context: LivePriceContext,
    signal?: AbortSignal,
  ): Promise<CurrentPriceOverride | null> {
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
