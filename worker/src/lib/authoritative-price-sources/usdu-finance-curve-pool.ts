import type { PeggedAsset } from "../../cron/sync-stablecoins/enrich-prices-shared";
import { CIRCUIT_SOURCE } from "../constants";
import { hasPublishableCurrentPrice } from "../price-publication-state";
import {
  ETHEREUM_CHAIN,
  fetchGuardedCurvePoolPrice,
  USDC_CIRCLE_ID,
  type CurrentPriceOverride,
  type LivePriceContext,
  type PriceSourceProvider,
} from "./helpers";

const USDU_FINANCE_CURVE_SOURCE = "curve-thin-onchain";

const USDU_FINANCE_ID = "usdu-usdu-finance";
// Reviewed CurveStableSwapNG USDC/USDU pool on Ethereum
// (runtime code hash 0xda9fdb047b330372d1fcbe9e4bad15f9806c8d6bf78df18bf7d6e52786b5af2f).
// Observed 2026-11-24: 3,598.93 USDC and 46,573.25 USDU; 1 and 100 USDU sold
// for 0.975353 and 0.974709 USDC/USDU (6.6 bps impact).
const POOL = "0x6c5ff8dce52be77b4ece6b51996018f0c1713ba9";
const USDC = "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48";
const USDU = "0xdde3ec717f220fc6a29d6a4be73f91da5b718e55";
const COINS_SELECTOR = "0xc6610657";
const BALANCES_SELECTOR = "0x4903b0d1";
const GET_DY_SELECTOR = "0x5e0d443f";
const USDC_INDEX = 0;
const USDU_INDEX = 1;
const USDC_DECIMALS = 6;
const USDU_DECIMALS = 18;
const SMALL_QUOTE_USDU = 1;
const IMPACT_QUOTE_USDU = 100;
const MIN_USDC_BALANCE = 1_000;
const MIN_USDU_BALANCE = 1_000;
const MAX_QUOTE_IMPACT_RATIO = 0.05;
const MAX_BLOCK_AGE_SEC = 5 * 60;

/**
 * Missing-only exact-pool USDU/USDC Curve quote for `usdu-usdu-finance`
 * (distinct from Universal USD `usdu-universal`). Publishes `curve-thin-onchain`
 * fallback evidence (non-replay-safe, non-depeg-authoritative, generic
 * severe-downside/temporal-jump guards preserved) and dates the USD value at
 * the older of the Ethereum block and trusted USDC parent clocks.
 */
async function fetchUsduFinanceCurvePoolPrice(
  context: LivePriceContext,
  signal?: AbortSignal,
): Promise<CurrentPriceOverride | null> {
  return fetchGuardedCurvePoolPrice({
    assetId: USDU_FINANCE_ID,
    source: USDU_FINANCE_CURVE_SOURCE,
    chain: ETHEREUM_CHAIN,
    pool: POOL,
    tokens: [
      { address: USDC, index: USDC_INDEX, decimals: USDC_DECIMALS, minBalance: MIN_USDC_BALANCE },
      { address: USDU, index: USDU_INDEX, decimals: USDU_DECIMALS, minBalance: MIN_USDU_BALANCE },
    ],
    coinsSelector: COINS_SELECTOR,
    balancesSelector: BALANCES_SELECTOR,
    quoteSelector: GET_DY_SELECTOR,
    quoteInputIndex: USDU_INDEX,
    quoteOutputIndex: USDC_INDEX,
    quoteInputDecimals: USDU_DECIMALS,
    smallQuoteTokens: SMALL_QUOTE_USDU,
    impactQuoteTokens: IMPACT_QUOTE_USDU,
    maxQuoteImpactRatio: MAX_QUOTE_IMPACT_RATIO,
    maxBlockAgeSec: MAX_BLOCK_AGE_SEC,
  }, context, signal);
}

export const usduFinanceCurvePoolProvider: PriceSourceProvider = {
  source: USDU_FINANCE_CURVE_SOURCE,
  liveMissingOnly: true,
  liveCircuitSource: CIRCUIT_SOURCE.USDU_FINANCE_CURVE_POOL,
  livePriority: 1,
  liveTimeoutMs: 6_000,
  liveParentByAssetId: { [USDU_FINANCE_ID]: USDC_CIRCLE_ID },
  matches(stablecoinId: string): boolean {
    return stablecoinId === USDU_FINANCE_ID;
  },
  async fetchLivePrice(
    asset: PeggedAsset,
    context: LivePriceContext,
    signal?: AbortSignal,
  ): Promise<CurrentPriceOverride | null> {
    if (hasPublishableCurrentPrice(asset)) {
      return null;
    }
    return fetchUsduFinanceCurvePoolPrice(context, signal);
  },
};
