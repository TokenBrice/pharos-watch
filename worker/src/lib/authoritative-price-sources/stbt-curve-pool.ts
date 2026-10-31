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

const STBT_CURVE_SOURCE = "curve-thin-onchain";

const STBT_ID = "stbt-matrixdock";
const USDC_ID = "usdc-circle";
const CHAIN = "ethereum";
const POOL = "0x892d701d94a43bdbcb5ea28891daca2fa22a690b";
const STBT = "0x530824da86689c9c17cdc2871ff29b058345b44a";
const CRV3 = "0x6c3f90f043a72fa612cbac8115ee7e52bde6e490";
const COINS_SELECTOR = "0xc6610657";
const BALANCES_SELECTOR = "0x4903b0d1";
// get_dy_underlying(int128,int128,uint256): metapool underlying indices are
// 0=STBT, 1=DAI, 2=USDC, 3=USDT.
const GET_DY_UNDERLYING_SELECTOR = "0x07211ef7";
const STBT_INDEX = 0;
const CRV3_INDEX = 1;
const USDC_UNDERLYING_INDEX = 2;
const STBT_DECIMALS = 18;
const CRV3_DECIMALS = 18;
const USDC_DECIMALS = 6;
// 1 and 10 STBT quoted at about 0.99439 and 0.99412 USDC on 2026-10-31, so the
// size guard costs 3 bps today and still rejects a pool skewed into dust.
const SMALL_QUOTE_STBT = 1;
const IMPACT_QUOTE_STBT = 10;
// Liquidity-existence floors, not market-depth claims: they reject a drained or
// one-sided pool, while the source stays fallback-confidence and missing-only.
const MIN_STBT_BALANCE = 1_000;
const MIN_CRV3_BALANCE = 1_000;
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

function encodeGetDyUnderlying(inputTokens: number): string {
  const inputRaw = BigInt(inputTokens) * 10n ** BigInt(STBT_DECIMALS);
  return `${GET_DY_UNDERLYING_SELECTOR}${encodeUint256(STBT_INDEX)}${encodeUint256(USDC_UNDERLYING_INDEX)}${encodeUint256(inputRaw)}`;
}

function quotePrice(outputRaw: bigint | null, inputTokens: number): number | null {
  if (outputRaw == null || outputRaw <= 0n) return null;
  const output = decimalFromRaw(outputRaw, USDC_DECIMALS);
  const price = output / inputTokens;
  return Number.isFinite(price) && price > 0 ? price : null;
}

/**
 * Exact-pool STBT/3Crv metapool quote for rows that would otherwise stay missing.
 *
 * The reviewed factory metapool (coins(0) STBT, coins(1) 3Crv) has no tracked
 * CoinGecko or DefiLlama id, and DefiLlama's exact-1.0 contract mark is not an
 * observed market. `get_dy_underlying(0, 2)` sells STBT into USDC through the
 * 3pool base LP, so the quote is executable USDC proceeds rather than the
 * metapool's STBT/3Crv ratio. It publishes as `curve-thin-onchain` fallback
 * evidence, stays non-replay-safe and non-depeg-authoritative, keeps the
 * generic severe-downside and temporal-jump publication guards, and never
 * displaces a usable incumbent price. Its USD value is only as fresh as its
 * older input, so the observation time is the older of the pool block and the
 * trusted USDC parent, and this route's budget judges that clock rather than
 * renewing the parent's.
 */
export async function fetchStbtCurvePoolPrice(
  context: LivePriceContext,
  signal?: AbortSignal,
): Promise<CurrentPriceOverride | null> {
  const quoteParent = resolveTrustedOverrideParent(
    context,
    USDC_ID,
    () => `[authoritative-price-sources] ${STBT_ID}: trusted USDC quote dependency unavailable`,
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
    encodeIndexedCall(COINS_SELECTOR, STBT_INDEX),
    encodeIndexedCall(COINS_SELECTOR, CRV3_INDEX),
    encodeIndexedCall(BALANCES_SELECTOR, STBT_INDEX),
    encodeIndexedCall(BALANCES_SELECTOR, CRV3_INDEX),
    encodeGetDyUnderlying(SMALL_QUOTE_STBT),
    encodeGetDyUnderlying(IMPACT_QUOTE_STBT),
  ].map((data) => ({
    method: "eth_call",
    params: [{ to: POOL, data }, `0x${blockNumber.toString(16)}`],
  })), rpcOptions);
  if (!results || results.length !== 6) return null;
  const [coin0Raw, coin1Raw, stbtBalanceRaw, crv3BalanceRaw, smallQuoteRaw, impactQuoteRaw] = results.map(
    (value) => typeof value === "string" && isHexResult(value) ? value : null,
  );

  if (decodeAddressWord(coin0Raw) !== STBT || decodeAddressWord(coin1Raw) !== CRV3) return null;
  const stbtBalance = stbtBalanceRaw ? decodeUint256WordBigInt(stbtBalanceRaw) : null;
  const crv3Balance = crv3BalanceRaw ? decodeUint256WordBigInt(crv3BalanceRaw) : null;
  if (stbtBalance == null || crv3Balance == null) return null;
  if (
    decimalFromRaw(stbtBalance, STBT_DECIMALS) < MIN_STBT_BALANCE ||
    decimalFromRaw(crv3Balance, CRV3_DECIMALS) < MIN_CRV3_BALANCE
  ) {
    return null;
  }

  const smallPrice = quotePrice(
    smallQuoteRaw ? decodeUint256WordBigInt(smallQuoteRaw) : null,
    SMALL_QUOTE_STBT,
  );
  const impactPrice = quotePrice(
    impactQuoteRaw ? decodeUint256WordBigInt(impactQuoteRaw) : null,
    IMPACT_QUOTE_STBT,
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
    source: STBT_CURVE_SOURCE,
    confidence: "fallback",
    observedAt,
    observedAtMode: parentClockSelected ? quoteParent.trustedParent.observedAtMode ?? "upstream" : "upstream",
  };
}

export const stbtCurvePoolProvider: PriceSourceProvider = {
  source: STBT_CURVE_SOURCE,
  liveMissingOnly: true,
  liveCircuitSource: CIRCUIT_SOURCE.STBT_CURVE_POOL,
  livePriority: 1,
  liveTimeoutMs: 6_000,
  liveParentByAssetId: { [STBT_ID]: USDC_ID },
  matches(stablecoinId: string): boolean {
    return stablecoinId === STBT_ID;
  },
  async fetchLivePrice(
    asset: PeggedAsset,
    context: LivePriceContext,
    signal?: AbortSignal,
  ): Promise<CurrentPriceOverride | null> {
    if (hasPublishableCurrentPrice(asset)) {
      return null;
    }
    return fetchStbtCurvePoolPrice(context, signal);
  },
};
