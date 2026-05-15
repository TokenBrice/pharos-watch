import type { StablecoinMeta } from "@shared/types/core";
import type { PeggedAsset } from "../../cron/sync-stablecoins/enrich-prices-shared";
import { rethrowIfAborted } from "../abort";
import type { PriceValidationReferences } from "../price-validation";
import { capCusdProvider } from "./cap-cusd";
import { erc4626NavProvider } from "./erc4626-nav";
import {
  type CurrentPriceOverride,
  type HistoricalPriceContext,
  type HistoricalPriceResolution,
  type LivePriceContext,
  type PriceSourceProvider,
} from "./helpers";
import { idleCdoTrancheProvider } from "./idle-cdo-tranche";
import { inheritedTrackedPriceProvider } from "./inherited-tracked";
import { iusdInfinifiProvider } from "./infinifi-iusd";
import { previewRedeemProvider } from "./preview-redeem";
import { protocolParProvider } from "./protocol-par";

export type {
  CurrentPriceOverride,
  HistoricalPriceContext,
  HistoricalPricePoint,
  HistoricalPriceResolution,
  HistoricalSupplySnapshot,
} from "./helpers";

const AUTHORITATIVE_PRICE_PROVIDERS: PriceSourceProvider[] = [
  capCusdProvider,
  iusdInfinifiProvider,
  inheritedTrackedPriceProvider,
  protocolParProvider,
  erc4626NavProvider,
  previewRedeemProvider,
  idleCdoTrancheProvider,
];

export async function fetchAuthoritativeLivePriceOverrides(
  assets: PeggedAsset[],
  signal?: AbortSignal,
  validationReferences?: PriceValidationReferences,
): Promise<Map<string, CurrentPriceOverride>> {
  const results = new Map<string, CurrentPriceOverride>();
  const liveContext: LivePriceContext = {
    assetsById: new Map(assets.map((asset) => [asset.id, asset])),
    validationReferences,
  };

  for (const asset of assets) {
    const provider = AUTHORITATIVE_PRICE_PROVIDERS.find((candidate) => candidate.matches(asset.id));
    if (!provider?.fetchLivePrice) continue;

    try {
      const override = await provider.fetchLivePrice(asset, liveContext, signal);
      if (override) {
        results.set(asset.id, override);
      }
    } catch (error) {
      rethrowIfAborted(error, signal);
      console.warn(`[authoritative-price-sources] ${asset.id} live override failed:`, error);
    }
  }

  return results;
}

export async function fetchAuthoritativeHistoricalPriceSeries(
  meta: StablecoinMeta,
  context: HistoricalPriceContext,
): Promise<HistoricalPriceResolution> {
  const provider = AUTHORITATIVE_PRICE_PROVIDERS.find((candidate) =>
    candidate.matches(meta.id) && (candidate.matchesHistoricalPrices?.(meta.id) ?? true)
  );
  if (!provider?.fetchHistoricalPrices) {
    return { matched: false, source: null, prices: null };
  }

  try {
    const prices = await provider.fetchHistoricalPrices(meta, context);
    return {
      matched: true,
      source: provider.source,
      prices,
    };
  } catch (error) {
    rethrowIfAborted(error, context.signal);
    console.warn(`[authoritative-price-sources] ${meta.id} historical source failed:`, error);
    return {
      matched: true,
      source: provider.source,
      prices: null,
    };
  }
}
