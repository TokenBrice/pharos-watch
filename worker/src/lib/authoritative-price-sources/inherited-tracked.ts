import { TRACKED_META_BY_ID } from "@shared/lib/stablecoins/registry";
import type { StablecoinMeta } from "@shared/types/core";
import { fetchMarketBackfillPriceSeries } from "../../api/backfill-price-sources";
import type { PeggedAsset } from "../../cron/sync-stablecoins/enrich-prices-shared";
import {
  buildParentDerivedLiveOverride,
  PROTOCOL_REDEEM_SOURCE,
  resolveTrustedOverrideParent,
  USDC_CIRCLE_ID,
  type CurrentPriceOverride,
  type HistoricalPriceContext,
  type HistoricalPricePoint,
  type LivePriceContext,
  type PriceSourceProvider,
} from "./helpers";

const USDAI_USD_AI_ID = "usdai-usd-ai";
const PYUSD_PAYPAL_ID = "pyusd-paypal";
const M_M0_ID = "m-m0";
const USDK_KAST_ID = "usdk-kast";
const XO_EXODUS_ID = "xo-exodus";
const USDNR_NERONA_ID = "usdnr-nerona";
const WM_M0_ID = "wm-m0";
const AUSD_AGORA_ID = "ausd-agora";
const WEUSD_PICWE_ID = "weusd-picwe";

interface InheritedTrackedPriceConfig {
  parentId: string;
  multiplier?: number;
}

const INHERITED_TRACKED_PRICE_CONFIGS = {
  [USDAI_USD_AI_ID]: { parentId: PYUSD_PAYPAL_ID },
  "iusd-initia": { parentId: AUSD_AGORA_ID },
  "usdcx-movement": { parentId: USDC_CIRCLE_ID },
  [M_M0_ID]: { parentId: WM_M0_ID },
  [USDK_KAST_ID]: { parentId: WM_M0_ID },
  [XO_EXODUS_ID]: { parentId: WM_M0_ID },
  [USDNR_NERONA_ID]: { parentId: WM_M0_ID },
  [WEUSD_PICWE_ID]: { parentId: USDC_CIRCLE_ID, multiplier: 0.99 },
} as const satisfies Record<string, InheritedTrackedPriceConfig>;

function getInheritedTrackedPriceConfig(stablecoinId: string): InheritedTrackedPriceConfig | null {
  return INHERITED_TRACKED_PRICE_CONFIGS[
    stablecoinId as keyof typeof INHERITED_TRACKED_PRICE_CONFIGS
  ] ?? null;
}

async function replayInheritedTrackedPriceSeries(
  config: InheritedTrackedPriceConfig,
  context: HistoricalPriceContext,
): Promise<HistoricalPricePoint[] | null> {
  const parentMeta = TRACKED_META_BY_ID.get(config.parentId);
  if (!parentMeta?.geckoId) return null;

  const series = await fetchMarketBackfillPriceSeries(parentMeta, parentMeta.geckoId, {
    granularity: "hourly",
    coingeckoApiKey: context.coingeckoApiKey ?? null,
  });
  if (!series.prices) return null;

  const multiplier = config.multiplier ?? 1;
  return multiplier === 1
    ? series.prices
    : series.prices.map((point) => ({ ...point, price: point.price * multiplier }));
}

export const inheritedTrackedPriceProvider: PriceSourceProvider = {
  source: PROTOCOL_REDEEM_SOURCE,
  matches(stablecoinId: string): boolean {
    return getInheritedTrackedPriceConfig(stablecoinId) != null;
  },
  async fetchLivePrice(
    asset: PeggedAsset,
    context: LivePriceContext,
  ): Promise<CurrentPriceOverride | null> {
    const config = getInheritedTrackedPriceConfig(asset.id);
    if (!config) return null;

    const parent = resolveTrustedOverrideParent(
      context,
      config.parentId,
      () =>
        `[authoritative-price-sources] ${asset.id}: skipped inherited ${config.parentId} price because parent provenance is not trusted`,
    );
    if (!parent) return null;

    return buildParentDerivedLiveOverride(parent, config.multiplier ?? 1);
  },
  async fetchHistoricalPrices(
    meta: StablecoinMeta,
    context: HistoricalPriceContext,
  ): Promise<HistoricalPricePoint[] | null> {
    const config = getInheritedTrackedPriceConfig(meta.id);
    if (!config) return null;

    return replayInheritedTrackedPriceSeries(config, context);
  },
};
