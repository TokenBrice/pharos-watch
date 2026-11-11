import type { PeggedAsset } from "../../cron/sync-stablecoins/enrich-prices-shared";
import { CIRCUIT_SOURCE } from "../constants";
import { hasPublishableCurrentPrice } from "../pricing/price-publication-state";
import {
  fetchGuardedCurvePoolPrice,
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
  return fetchGuardedCurvePoolPrice({
    assetId: STBT_ID,
    source: STBT_CURVE_SOURCE,
    chain: CHAIN,
    pool: POOL,
    tokens: [
      { address: STBT, index: STBT_INDEX, decimals: STBT_DECIMALS, minBalance: MIN_STBT_BALANCE },
      { address: CRV3, index: CRV3_INDEX, decimals: CRV3_DECIMALS, minBalance: MIN_CRV3_BALANCE },
    ],
    coinsSelector: COINS_SELECTOR,
    balancesSelector: BALANCES_SELECTOR,
    quoteSelector: GET_DY_UNDERLYING_SELECTOR,
    quoteInputIndex: STBT_INDEX,
    quoteOutputIndex: USDC_UNDERLYING_INDEX,
    quoteInputDecimals: STBT_DECIMALS,
    smallQuoteTokens: SMALL_QUOTE_STBT,
    impactQuoteTokens: IMPACT_QUOTE_STBT,
    maxQuoteImpactRatio: MAX_QUOTE_IMPACT_RATIO,
    maxBlockAgeSec: MAX_BLOCK_AGE_SEC,
  }, context, signal);
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
