import { logWorkerEventArgs } from "../structured-log";
import { getCirculatingRaw } from "@shared/lib/supply";
import type { PeggedAsset } from "../../cron/sync-stablecoins/enrich-prices-shared";
import { fetchEvmCallHexAtBlock } from "../evm-rpc";
import { getPublicFallbackRpcUrls } from "../public-rpc-registry";
import {
  decodeUint256WordBigInt,
  encodeAddress,
  encodeUint256,
  ETHEREUM_CHAIN,
  findNearestSupply,
  getUsdcQuotedRedeemConfig,
  ratioToNumber,
  type HistoricalPriceContext,
} from "./helpers";
import { createProtocolRedeemProvider } from "./protocol-redeem-provider";

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

export const capCusdProvider = createProtocolRedeemProvider({
  stablecoinId: CAP_CUSD_ID,
  async fetchLiveQuote(asset: PeggedAsset, signal?: AbortSignal): Promise<number | null> {
    const sampleNotionalUsd = clampSampleNotionalUsd(getCirculatingRaw(asset));
    return fetchCapRedeemQuote(sampleNotionalUsd, "latest", signal);
  },
  async fetchHistoricalQuote(
    context: HistoricalPriceContext,
    blockNumber: number,
    timestamp: number,
    signal?: AbortSignal,
  ): Promise<number | null> {
    const supplyUsd = findNearestSupply(context.supplySnapshots, timestamp);
    return fetchCapRedeemQuote(clampSampleNotionalUsd(supplyUsd), blockNumber, signal);
  },
});
