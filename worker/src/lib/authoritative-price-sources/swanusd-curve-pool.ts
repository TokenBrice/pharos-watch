import type { PeggedAsset } from "../../cron/sync-stablecoins/enrich-prices-shared";
import { CIRCUIT_SOURCE } from "../constants";
import { fetchEvmBlockNumber, fetchEvmBlockTimestamp, fetchEvmRpcBatch, isHexResult } from "../evm-rpc";
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

const SWANUSD_CURVE_SOURCE = "curve-thin-onchain";

const SWANUSD_ID = "swanusd-swan";
const USDC_ID = "usdc-circle";
const CHAIN = "ethereum";
const POOL = "0xc1488f04027afea94fa68586b4ff245098a59432";
const USDC = "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48";
const SWANUSD = "0x9bf2b2f57a2968a0e81546ed50cbbbb7c9d6e05e";
const COINS_SELECTOR = "0xc6610657";
const BALANCES_SELECTOR = "0x4903b0d1";
const GET_DY_SELECTOR = "0x5e0d443f";
const USDC_INDEX = 0;
const SWANUSD_INDEX = 1;
const USDC_DECIMALS = 6;
const SWANUSD_DECIMALS = 18;
// 1 and 10 swanUSD were 0.999945 and 0.9999445 USDC at block 26299913, so the
// size guard costs 0.05 bps today and still rejects a pool skewed into dust.
const SMALL_QUOTE_SWANUSD = 1;
const IMPACT_QUOTE_SWANUSD = 10;
// Liquidity-existence floors, not market-depth claims: they reject a drained or
// one-sided pool, while the source stays fallback-confidence and missing-only.
const MIN_SWANUSD_BALANCE = 1_000;
const MIN_USDC_BALANCE = 1_000;
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
  const inputRaw = BigInt(inputTokens) * 10n ** BigInt(SWANUSD_DECIMALS);
  return `${GET_DY_SELECTOR}${encodeUint256(SWANUSD_INDEX)}${encodeUint256(USDC_INDEX)}${encodeUint256(inputRaw)}`;
}

function quotePrice(outputRaw: bigint | null, inputTokens: number): number | null {
  if (outputRaw == null || outputRaw <= 0n) return null;
  const output = decimalFromRaw(outputRaw, USDC_DECIMALS);
  const price = output / inputTokens;
  return Number.isFinite(price) && price > 0 ? price : null;
}

/**
 * Exact-pool swanUSD/USDC quote for rows that would otherwise stay missing.
 *
 * This pool is swanUSD's only market and also CoinGecko's only swanUSD ticker,
 * and its entire LP supply sits in the issuer manager Safe
 * (0x9d5df30f475cea915b1ed4c0cca59255c897b61b). The quote is therefore a
 * direct re-read of the same single-party venue, not independent corroboration
 * of the CoinGecko mark: it publishes as `curve-thin-onchain` fallback evidence,
 * stays non-replay-safe and non-depeg-authoritative, keeps the generic
 * severe-downside and temporal-jump publication guards, and never displaces a
 * usable incumbent price. Its USD value is only as fresh as its older input, so
 * the observation time is the older of the pool block and the trusted USDC
 * parent, and this route's budget judges that clock rather than renewing the
 * parent's.
 */
export async function fetchSwanusdCurvePoolPrice(
  context: LivePriceContext,
  signal?: AbortSignal,
): Promise<CurrentPriceOverride | null> {
  const quoteParent = resolveTrustedOverrideParent(
    context,
    USDC_ID,
    () => `[authoritative-price-sources] ${SWANUSD_ID}: trusted USDC quote dependency unavailable`,
    {
      allowFreshNonReplaySafeParent: true,
      allowFreshReplaySafeSingleSourceParent: true,
    },
  );
  if (!quoteParent) return null;

  // The derived USD price is only as fresh as its older input. A USDC parent
  // already outside this route's five-minute budget can never publish, so reject
  // it before spending the block and pool reads.
  if (Math.floor(Date.now() / 1000) - quoteParent.trustedParent.observedAt > MAX_BLOCK_AGE_SEC) return null;

  // Configured Worker RPCs first; public endpoints are only the fallback tail.
  const rpcOptions = { signal, chainRpcs: context.chainRpcs, extraRpcUrls: getPublicFallbackRpcUrls(CHAIN) };
  const blockNumber = await fetchEvmBlockNumber(CHAIN, rpcOptions);
  if (blockNumber == null) return null;
  const blockTimestamp = await fetchEvmBlockTimestamp(CHAIN, blockNumber, rpcOptions);
  const nowSec = Math.floor(Date.now() / 1000);
  if (blockTimestamp == null || blockTimestamp > nowSec + 60 || nowSec - blockTimestamp > MAX_BLOCK_AGE_SEC) {
    return null;
  }

  // Batch direct eth_call envelopes to retain caller semantics and one pinned
  // block while consuming only one connection for the six pool reads.
  const results = await fetchEvmRpcBatch(CHAIN, [
    encodeIndexedCall(COINS_SELECTOR, USDC_INDEX),
    encodeIndexedCall(COINS_SELECTOR, SWANUSD_INDEX),
    encodeIndexedCall(BALANCES_SELECTOR, USDC_INDEX),
    encodeIndexedCall(BALANCES_SELECTOR, SWANUSD_INDEX),
    encodeGetDy(SMALL_QUOTE_SWANUSD),
    encodeGetDy(IMPACT_QUOTE_SWANUSD),
  ].map((data) => ({
    method: "eth_call",
    params: [{ to: POOL, data }, `0x${blockNumber.toString(16)}`],
  })), rpcOptions);
  if (!results || results.length !== 6) return null;
  const [coin0Raw, coin1Raw, usdcBalanceRaw, swanusdBalanceRaw, smallQuoteRaw, impactQuoteRaw] = results.map(
    (value) => typeof value === "string" && isHexResult(value) ? value : null,
  );

  if (decodeAddressWord(coin0Raw) !== USDC || decodeAddressWord(coin1Raw) !== SWANUSD) return null;
  const usdcBalance = usdcBalanceRaw ? decodeUint256WordBigInt(usdcBalanceRaw) : null;
  const swanusdBalance = swanusdBalanceRaw ? decodeUint256WordBigInt(swanusdBalanceRaw) : null;
  if (usdcBalance == null || swanusdBalance == null) return null;
  if (
    decimalFromRaw(usdcBalance, USDC_DECIMALS) < MIN_USDC_BALANCE ||
    decimalFromRaw(swanusdBalance, SWANUSD_DECIMALS) < MIN_SWANUSD_BALANCE
  ) {
    return null;
  }

  const smallPrice = quotePrice(
    smallQuoteRaw ? decodeUint256WordBigInt(smallQuoteRaw) : null,
    SMALL_QUOTE_SWANUSD,
  );
  const impactPrice = quotePrice(
    impactQuoteRaw ? decodeUint256WordBigInt(impactQuoteRaw) : null,
    IMPACT_QUOTE_SWANUSD,
  );
  if (smallPrice == null || impactPrice == null) return null;
  if (Math.abs(impactPrice - smallPrice) / smallPrice > MAX_QUOTE_IMPACT_RATIO) return null;

  // Provenance keeps the older dependency clock: multiplying by the USDC parent
  // must not renew the parent's observation time under this route's budget.
  const parentClockSelected = quoteParent.trustedParent.observedAt < blockTimestamp;
  const observedAt = parentClockSelected ? quoteParent.trustedParent.observedAt : blockTimestamp;
  if (Math.floor(Date.now() / 1000) - observedAt > MAX_BLOCK_AGE_SEC) return null;
  return {
    price: smallPrice * quoteParent.trustedParent.price,
    source: SWANUSD_CURVE_SOURCE,
    confidence: "fallback",
    observedAt,
    observedAtMode: parentClockSelected ? quoteParent.trustedParent.observedAtMode ?? "upstream" : "upstream",
  };
}

export const swanusdCurvePoolProvider: PriceSourceProvider = {
  source: SWANUSD_CURVE_SOURCE,
  liveMissingOnly: true,
  liveCircuitSource: CIRCUIT_SOURCE.SWANUSD_CURVE_POOL,
  livePriority: 1,
  liveTimeoutMs: 6_000,
  liveParentByAssetId: { [SWANUSD_ID]: USDC_ID },
  matches(stablecoinId: string): boolean {
    return stablecoinId === SWANUSD_ID;
  },
  async fetchLivePrice(
    asset: PeggedAsset,
    context: LivePriceContext,
    signal?: AbortSignal,
  ): Promise<CurrentPriceOverride | null> {
    if (hasPublishableCurrentPrice(asset)) {
      return null;
    }
    return fetchSwanusdCurvePoolPrice(context, signal);
  },
};
