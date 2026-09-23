import { getPricingSourceRegistryEntry } from "@shared/lib/pricing-source-registry";
import { splitCompositePriceSource } from "@shared/lib/pricing-sources";
import { TRACKED_META_BY_ID } from "@shared/lib/stablecoins/registry";
import type { StablecoinMeta } from "@shared/types/core";
import { fetchMarketBackfillPriceSeries } from "../../api/backfill-price-sources";
import { validateCompositePricingSourceFreshness } from "../pricing-source-freshness";
import { hasPublishableCurrentPrice } from "../price-publication-state";
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
const USDN_NOBLE_ID = "usdn-noble";
const WM_M0_ID = "wm-m0";
const AUSD_AGORA_ID = "ausd-agora";
const WEUSD_PICWE_ID = "weusd-picwe";

interface InheritedTrackedPriceConfig {
  parentId: string;
  multiplier?: number;
  allowFreshNonReplaySafeParent?: boolean;
  allowFreshReplaySafeSingleSourceParent?: boolean;
  requireReportedSingleSourceConfidence?: boolean;
  marketPriceWins?: boolean;
}

const INHERITED_TRACKED_PRICE_CONFIGS = {
  [USDAI_USD_AI_ID]: { parentId: PYUSD_PAYPAL_ID },
  "iusd-initia": { parentId: AUSD_AGORA_ID },
  "usdcx-movement": { parentId: USDC_CIRCLE_ID },
  [M_M0_ID]: {
    parentId: WM_M0_ID,
    allowFreshReplaySafeSingleSourceParent: true,
    requireReportedSingleSourceConfidence: true,
  },
  [USDK_KAST_ID]: {
    parentId: WM_M0_ID,
    allowFreshNonReplaySafeParent: true,
    allowFreshReplaySafeSingleSourceParent: true,
  },
  [XO_EXODUS_ID]: {
    parentId: WM_M0_ID,
    allowFreshNonReplaySafeParent: true,
    allowFreshReplaySafeSingleSourceParent: true,
  },
  [USDN_NOBLE_ID]: {
    parentId: M_M0_ID,
    allowFreshReplaySafeSingleSourceParent: true,
  },
  [USDNR_NERONA_ID]: { parentId: WM_M0_ID },
  // WEUSD's 0.99 redemption floor is only a missing-price fallback. A usable
  // secondary-market quote must remain visible so depeg detection sees discounts.
  [WEUSD_PICWE_ID]: {
    parentId: USDC_CIRCLE_ID,
    multiplier: 0.99,
    marketPriceWins: true,
  },
} as const satisfies Record<string, InheritedTrackedPriceConfig>;

function getInheritedTrackedPriceConfig(stablecoinId: string): InheritedTrackedPriceConfig | null {
  return INHERITED_TRACKED_PRICE_CONFIGS[
    stablecoinId as keyof typeof INHERITED_TRACKED_PRICE_CONFIGS
  ] ?? null;
}

/**
 * A market price only wins over the redemption fallback while it is a current,
 * registry-admitted market observation. Restored or carry-forward rows keep
 * their original observation time (only `priceSyncedAt` moves), so provenance
 * age — never the sync stamp — decides whether the incumbent is usable, and
 * protocol/cached provenance is not a market quote at any age.
 */
function hasCurrentMarketPriceWin(asset: PeggedAsset, nowSec: number): boolean {
  if (!hasPublishableCurrentPrice(asset)) return false;
  const source = asset.priceSource;
  if (!source) return false;
  for (const part of splitCompositePriceSource(source)) {
    const entry = getPricingSourceRegistryEntry(part);
    if (!entry || entry.isRetired || entry.isProtocolOverride || entry.trustTier === "cached_replay") {
      return false;
    }
  }
  const observedAt = asset.priceObservedAt ?? asset.priceUpdatedAt ?? null;
  if (observedAt == null) return false;
  return validateCompositePricingSourceFreshness({
    source,
    observedAt,
    nowSec,
    requireObservedAt: true,
  }).accepted;
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
  livePriority: 0,
  matches(stablecoinId: string): boolean {
    return getInheritedTrackedPriceConfig(stablecoinId) != null;
  },
  async fetchLivePrice(
    asset: PeggedAsset,
    context: LivePriceContext,
  ): Promise<CurrentPriceOverride | null> {
    const config = getInheritedTrackedPriceConfig(asset.id);
    if (!config) return null;
    const nowSec = Math.floor(Date.now() / 1000);
    if (config.marketPriceWins && hasCurrentMarketPriceWin(asset, nowSec)) return null;

    const parent = resolveTrustedOverrideParent(
      context,
      config.parentId,
      () =>
        `[authoritative-price-sources] ${asset.id}: skipped inherited ${config.parentId} price because parent provenance is not trusted`,
      {
        allowFreshNonReplaySafeParent: config.allowFreshNonReplaySafeParent,
        allowFreshReplaySafeSingleSourceParent: config.allowFreshReplaySafeSingleSourceParent,
        requireReportedSingleSourceConfidence: config.requireReportedSingleSourceConfidence,
      },
    );
    if (!parent) return null;

    return buildParentDerivedLiveOverride(parent, config.multiplier ?? 1);
  },
  matchesHistoricalPrices(stablecoinId: string): boolean {
    return !getInheritedTrackedPriceConfig(stablecoinId)?.marketPriceWins;
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
