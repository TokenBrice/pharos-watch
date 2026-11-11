import type { PeggedAsset } from "../../cron/sync-stablecoins/enrich-prices-shared";
import { CIRCUIT_SOURCE } from "../constants";
import { hasPublishableCurrentPrice } from "../price-publication-state";
import {
  fetchGuardedCurvePoolPrice,
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
  return fetchGuardedCurvePoolPrice({
    assetId: SWANUSD_ID,
    source: SWANUSD_CURVE_SOURCE,
    chain: CHAIN,
    pool: POOL,
    tokens: [
      { address: USDC, index: USDC_INDEX, decimals: USDC_DECIMALS, minBalance: MIN_USDC_BALANCE },
      { address: SWANUSD, index: SWANUSD_INDEX, decimals: SWANUSD_DECIMALS, minBalance: MIN_SWANUSD_BALANCE },
    ],
    coinsSelector: COINS_SELECTOR,
    balancesSelector: BALANCES_SELECTOR,
    quoteSelector: GET_DY_SELECTOR,
    quoteInputIndex: SWANUSD_INDEX,
    quoteOutputIndex: USDC_INDEX,
    quoteInputDecimals: SWANUSD_DECIMALS,
    smallQuoteTokens: SMALL_QUOTE_SWANUSD,
    impactQuoteTokens: IMPACT_QUOTE_SWANUSD,
    maxQuoteImpactRatio: MAX_QUOTE_IMPACT_RATIO,
    maxBlockAgeSec: MAX_BLOCK_AGE_SEC,
  }, context, signal);
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
