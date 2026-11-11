import type { PeggedAsset } from "../../cron/sync-stablecoins/enrich-prices-shared";
import { CIRCUIT_SOURCE } from "../constants";
import { hasPublishableCurrentPrice } from "../price-publication-state";
import {
  fetchGuardedCurvePoolPrice,
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

export async function fetchAzndCurvePoolPrice(
  context: LivePriceContext,
  signal?: AbortSignal,
): Promise<CurrentPriceOverride | null> {
  return fetchGuardedCurvePoolPrice({
    assetId: AZND_ID,
    source: AZND_CURVE_SOURCE,
    chain: CHAIN,
    pool: POOL,
    tokens: [
      { address: AZND, index: AZND_INDEX, decimals: AZND_DECIMALS, minBalance: MIN_AZND_BALANCE },
      { address: USDC, index: USDC_INDEX, decimals: USDC_DECIMALS, minBalance: MIN_USDC_BALANCE },
    ],
    coinsSelector: COINS_SELECTOR,
    balancesSelector: BALANCES_SELECTOR,
    quoteSelector: GET_DY_SELECTOR,
    quoteInputIndex: AZND_INDEX,
    quoteOutputIndex: USDC_INDEX,
    quoteInputDecimals: AZND_DECIMALS,
    smallQuoteTokens: SMALL_QUOTE_AZND,
    impactQuoteTokens: IMPACT_QUOTE_AZND,
    maxQuoteImpactRatio: MAX_QUOTE_IMPACT_RATIO,
    maxBlockAgeSec: MAX_BLOCK_AGE_SEC,
  }, context, signal);
}

export const azndCurvePoolProvider: PriceSourceProvider = {
  source: AZND_CURVE_SOURCE,
  liveMissingOnly: true,
  liveCircuitSource: CIRCUIT_SOURCE.AZND_CURVE_POOL,
  livePriority: 1,
  liveTimeoutMs: 6_000,
  liveParentByAssetId: { [AZND_ID]: USDC_ID },
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
