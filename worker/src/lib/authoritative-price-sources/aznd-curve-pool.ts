import type { PeggedAsset } from "../../cron/sync-stablecoins/enrich-prices-shared";
import { CIRCUIT_SOURCE } from "../constants";
import { fetchEvmBlockNumber, fetchEvmBlockTimestamp, fetchEvmCallHexAtBlock } from "../evm-rpc";
import { hasPublishableCurrentPrice } from "../price-publication-state";
import { getPublicFallbackRpcUrls } from "../public-rpc-registry";
import {
  decodeUint256WordBigInt,
  encodeUint256,
  resolveTrustedOverrideParent,
  type CurrentPriceOverride,
  type LivePriceContext,
  type PriceSourceProvider,
} from "./helpers";

const AZND_CURVE_SOURCE = "curve-thin-onchain";

const AZND_ID = "aznd-mu-digital";
const USDC_ID = "usdc-circle";
const CHAIN = "ethereum";
const POOL = "0x0d381fc68487365e90c32c90323352b325e21d23";
const AZND = "0x52c66b5e7f8fde20843de900c5c8b4b0f23708a0";
const USDC = "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48";
const COINS_SELECTOR = "0xc6610657";
const BALANCES_SELECTOR = "0x4903b0d1";
const GET_DY_SELECTOR = "0x5e0d443f";
const AZND_INDEX = 0;
const USDC_INDEX = 1;
const AZND_DECIMALS = 18;
const USDC_DECIMALS = 6;
const SMALL_QUOTE_AZND = 1;
const IMPACT_QUOTE_AZND = 10;
const MIN_AZND_BALANCE = 1_000;
const MIN_USDC_BALANCE = 100;
const MAX_QUOTE_IMPACT_RATIO = 0.05;
const MAX_BLOCK_AGE_SEC = 5 * 60;

function decodeAddressWord(value: `0x${string}` | null): string | null {
  if (!value || value.length < 66) return null;
  return `0x${value.slice(26, 66)}`.toLowerCase();
}

function decimalFromRaw(value: bigint, decimals: number): number {
  const scale = 10n ** BigInt(decimals);
  return Number(value / scale) + Number(value % scale) / Number(scale);
}

function encodeIndexedCall(selector: string, index: number): string {
  return `${selector}${encodeUint256(index)}`;
}

function encodeGetDy(inputTokens: number): string {
  const inputRaw = BigInt(inputTokens) * 10n ** BigInt(AZND_DECIMALS);
  return `${GET_DY_SELECTOR}${encodeUint256(AZND_INDEX)}${encodeUint256(USDC_INDEX)}${encodeUint256(inputRaw)}`;
}

function quotePrice(outputRaw: bigint | null, inputTokens: number): number | null {
  if (outputRaw == null || outputRaw <= 0n) return null;
  const output = decimalFromRaw(outputRaw, USDC_DECIMALS);
  const price = output / inputTokens;
  return Number.isFinite(price) && price > 0 ? price : null;
}

export async function fetchAzndCurvePoolPrice(
  context: LivePriceContext,
  signal?: AbortSignal,
): Promise<CurrentPriceOverride | null> {
  const quoteParent = resolveTrustedOverrideParent(
    context,
    USDC_ID,
    () => `[authoritative-price-sources] ${AZND_ID}: trusted USDC quote dependency unavailable`,
    {
      allowFreshNonReplaySafeParent: true,
      allowFreshReplaySafeSingleSourceParent: true,
    },
  );
  if (!quoteParent) return null;

  const rpcOptions = { signal, extraRpcUrls: getPublicFallbackRpcUrls(CHAIN) };
  const blockNumber = await fetchEvmBlockNumber(CHAIN, rpcOptions);
  if (blockNumber == null) return null;
  const blockTimestamp = await fetchEvmBlockTimestamp(CHAIN, blockNumber, rpcOptions);
  const nowSec = Math.floor(Date.now() / 1000);
  if (blockTimestamp == null || blockTimestamp > nowSec + 60 || nowSec - blockTimestamp > MAX_BLOCK_AGE_SEC) {
    return null;
  }

  // Keep exact-pool RPCs serial so this fallback never consumes the cron's
  // entire six-connection allowance while another producer is still draining.
  const coin0Raw = await fetchEvmCallHexAtBlock(
    CHAIN, POOL, encodeIndexedCall(COINS_SELECTOR, AZND_INDEX), blockNumber, rpcOptions,
  );
  const coin1Raw = await fetchEvmCallHexAtBlock(
    CHAIN, POOL, encodeIndexedCall(COINS_SELECTOR, USDC_INDEX), blockNumber, rpcOptions,
  );
  const azndBalanceRaw = await fetchEvmCallHexAtBlock(
    CHAIN, POOL, encodeIndexedCall(BALANCES_SELECTOR, AZND_INDEX), blockNumber, rpcOptions,
  );
  const usdcBalanceRaw = await fetchEvmCallHexAtBlock(
    CHAIN, POOL, encodeIndexedCall(BALANCES_SELECTOR, USDC_INDEX), blockNumber, rpcOptions,
  );
  const smallQuoteRaw = await fetchEvmCallHexAtBlock(
    CHAIN, POOL, encodeGetDy(SMALL_QUOTE_AZND), blockNumber, rpcOptions,
  );
  const impactQuoteRaw = await fetchEvmCallHexAtBlock(
    CHAIN, POOL, encodeGetDy(IMPACT_QUOTE_AZND), blockNumber, rpcOptions,
  );

  if (decodeAddressWord(coin0Raw) !== AZND || decodeAddressWord(coin1Raw) !== USDC) return null;
  const azndBalance = azndBalanceRaw ? decodeUint256WordBigInt(azndBalanceRaw) : null;
  const usdcBalance = usdcBalanceRaw ? decodeUint256WordBigInt(usdcBalanceRaw) : null;
  if (azndBalance == null || usdcBalance == null) return null;
  if (
    decimalFromRaw(azndBalance, AZND_DECIMALS) < MIN_AZND_BALANCE ||
    decimalFromRaw(usdcBalance, USDC_DECIMALS) < MIN_USDC_BALANCE
  ) {
    return null;
  }

  const smallPrice = quotePrice(
    smallQuoteRaw ? decodeUint256WordBigInt(smallQuoteRaw) : null,
    SMALL_QUOTE_AZND,
  );
  const impactPrice = quotePrice(
    impactQuoteRaw ? decodeUint256WordBigInt(impactQuoteRaw) : null,
    IMPACT_QUOTE_AZND,
  );
  if (smallPrice == null || impactPrice == null) return null;
  if (Math.abs(impactPrice - smallPrice) / smallPrice > MAX_QUOTE_IMPACT_RATIO) return null;

  return {
    price: smallPrice * quoteParent.trustedParent.price,
    source: AZND_CURVE_SOURCE,
    confidence: "fallback",
    observedAt: blockTimestamp,
    observedAtMode: "upstream",
  };
}

export const azndCurvePoolProvider: PriceSourceProvider = {
  source: AZND_CURVE_SOURCE,
  liveMissingOnly: true,
  liveCircuitSource: CIRCUIT_SOURCE.AZND_CURVE_POOL,
  livePriority: 1,
  liveTimeoutMs: 6_000,
  matches(stablecoinId: string): boolean {
    return stablecoinId === AZND_ID;
  },
  async fetchLivePrice(
    asset: PeggedAsset,
    context: LivePriceContext,
    signal?: AbortSignal,
  ): Promise<CurrentPriceOverride | null> {
    if (hasPublishableCurrentPrice(asset)) {
      return null;
    }
    return fetchAzndCurvePoolPrice(context, signal);
  },
};
