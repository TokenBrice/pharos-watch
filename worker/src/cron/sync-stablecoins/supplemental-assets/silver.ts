import { logWorkerEventArgs } from "../../../lib/structured-log";
import { isKinesisWrapperSupplyId } from "@shared/lib/onchain-supply-probe";
import { isKinesisWrapperSupplyCutoverActive } from "@shared/lib/supply-perimeter-changes";
import { ACTIVE_STABLECOINS } from "@shared/lib/stablecoins/registry";
import type { StablecoinMeta } from "@shared/types/stablecoin-meta-schemas";
import { fetchTextWithRetry } from "../../../lib/fetch-retry";
import { USER_AGENT } from "../../../lib/constants";
import { cgHeaders, cgUrl } from "../../../lib/coingecko";
import { validatePricingSourceFreshness } from "../../../lib/pricing-source-freshness";
import { resolveMarketCap } from "../../../lib/resolve-market-cap";
import { throwIfAborted } from "../../../lib/abort";
import type { ChainRpcConfig } from "../../../lib/chain-registry";
import type { DwellirNativeCapability } from "../../../lib/dwellir-native";
import type { PeggedAsset } from "../enrich-prices";
import {
  admitCommodityValuation,
  fetchCommodityTokens,
  fetchSupplementalPriceData,
  resolveCuratedAggregateSupplementalSupply,
  resolveSupplementalPrice,
  resolveSupplementalCoinGeckoMcap,
  toPositiveFiniteNumber,
  type CoinGeckoMcapData,
  type CommodityValuationEvidence,
} from "./shared";

const SILVER_METAS = ACTIVE_STABLECOINS.filter((stablecoin) => stablecoin.flags.pegCurrency === "SILVER");

async function fetchCoinGeckoCirculatingSupplyMap(
  metas: StablecoinMeta[],
  logPrefix: string,
  signal?: AbortSignal,
  coingeckoApiKey?: string | null,
): Promise<Map<string, { supply: number; observedAt: number }>> {
  const cgIds = metas.map((token) => token.geckoId).filter(Boolean).join(",");
  if (!cgIds) return new Map();

  const cgMarketsResult = await fetchTextWithRetry(
    cgUrl(`/coins/markets?vs_currency=usd&ids=${cgIds}`, coingeckoApiKey ?? null),
    {
      headers: cgHeaders({ Accept: "application/json", "User-Agent": USER_AGENT }, coingeckoApiKey ?? null),
      signal,
    },
  );

  if (!cgMarketsResult?.response.ok) {
    logWorkerEventArgs("handler", "warn",
      `[${logPrefix}] CG markets fetch failed (${cgMarketsResult?.response.status ?? "no response"}), falling back to cgData mcap`,
    );
    return new Map();
  }

  let cgMarketsRaw: unknown;
  try {
    cgMarketsRaw = JSON.parse(cgMarketsResult.body);
  } catch (err) {
    logWorkerEventArgs("handler", "warn", `[${logPrefix}] CG markets payload parse failed:`, err);
    return new Map();
  }
  if (!Array.isArray(cgMarketsRaw)) {
    logWorkerEventArgs("handler", "warn", `[${logPrefix}] CG markets returned unexpected shape, falling back to cgData mcap`);
    return new Map();
  }

  const supplyMap = new Map<string, { supply: number; observedAt: number }>();
  for (const item of cgMarketsRaw as Array<{ id: string; circulating_supply?: number; last_updated?: string }>) {
    const freshness = validatePricingSourceFreshness({
      source: "coingecko",
      observedAt: typeof item.last_updated === "string" ? Date.parse(item.last_updated) / 1000 : null,
      observedAtMode: "upstream",
      requireObservedAt: true,
    });
    if (freshness.accepted && freshness.observedAt != null && item.circulating_supply != null && Number.isFinite(item.circulating_supply) && item.circulating_supply >= 0) {
      supplyMap.set(item.id, { supply: item.circulating_supply, observedAt: freshness.observedAt });
    }
  }
  return supplyMap;
}

export async function fetchSilverTokens(
  cgData: CoinGeckoMcapData,
  signal?: AbortSignal,
  coingeckoApiKey?: string | null,
  db?: D1Database,
  chainRpcs?: Map<string, ChainRpcConfig>,
  dwellirNative?: DwellirNativeCapability,
  evidence?: CommodityValuationEvidence,
): Promise<PeggedAsset[]> {
  if (SILVER_METAS.length === 0) return [];
  throwIfAborted(signal);
  const nowSec = Math.floor(Date.now() / 1000);

  try {
    const [priceData, cgSupplyMap] = await Promise.all([
      fetchSupplementalPriceData(SILVER_METAS, "silver", signal, db),
      fetchCoinGeckoCirculatingSupplyMap(SILVER_METAS.filter((meta) => !isKinesisWrapperSupplyCutoverActive(meta.id, nowSec)), "silver", signal, coingeckoApiKey),
    ]);

    return fetchCommodityTokens(SILVER_METAS, {
      logPrefix: "silver",
      priceData,
      cgData,
      resolveSupply: async (meta) => {
        const aggregate = await resolveCuratedAggregateSupplementalSupply(meta, priceData, cgData, chainRpcs, signal, dwellirNative, evidence);
        if (aggregate) return aggregate;
        if (isKinesisWrapperSupplyCutoverActive(meta.id, nowSec)) return { mcap: null, supplySource: "onchain-supply-withheld" };
        const observed = meta.geckoId ? cgSupplyMap.get(meta.geckoId) : undefined;
        const quote = admitCommodityValuation(meta, resolveSupplementalPrice(priceData, cgData, meta.geckoId), evidence);
        const cgMcap = resolveSupplementalCoinGeckoMcap(cgData, meta.geckoId);
        const resolvedMcap = resolveMarketCap(cgMcap ?? undefined, observed?.supply, quote?.price ?? 0);
        if (observed && (observed.supply === 0 || (quote && resolvedMcap > 0 && resolvedMcap !== cgMcap))) {
          if (cgMcap != null && resolvedMcap !== cgMcap) {
            logWorkerEventArgs("handler", "warn", `[silver] ${meta.symbol}: rejecting CoinGecko cap in favor of observed circulating supply`);
          }
          return {
            // The program count can value its pre-cutover cap but is not wrapper stock.
            circulatingNative: isKinesisWrapperSupplyId(meta.id) ? null : observed.supply,
            valuationPriceUsd: quote?.price,
            valuationObservedAtSec: quote?.observedAt,
            mcap: observed.supply === 0 ? 0 : resolvedMcap,
            supplySource: "coingecko-fallback",
            supplyObservedAt: observed.observedAt,
          };
        }
        const cgEntry = meta.geckoId ? cgData[meta.geckoId] : undefined;
        const capClock = cgMcap == null ? null : cgEntry?.last_updated_at;
        const cgPrice = toPositiveFiniteNumber(cgEntry?.usd);
        const pairedQuote = cgPrice != null && capClock != null && observed?.observedAt === capClock && cgMcap != null &&
          Math.abs(observed.supply * cgPrice - cgMcap) <= 1e-12 * cgMcap
          ? admitCommodityValuation(meta, { price: cgPrice, observedAt: capClock, observedAtMode: "upstream", source: "coingecko" }, evidence) : null;
        return {
          circulatingNative: pairedQuote && !isKinesisWrapperSupplyId(meta.id) ? observed?.supply : null,
          valuationPriceUsd: pairedQuote?.price ?? null,
          valuationObservedAtSec: pairedQuote?.observedAt ?? null,
          mcap: cgMcap,
          supplySource: "coingecko-fallback",
          supplyObservedAt: capClock,
        };
      },
    });
  } catch (err) {
    if (signal?.aborted) throw err instanceof Error ? err : new Error(String(err));
    logWorkerEventArgs("handler", "error", "[silver] fetchSilverTokens failed:", err);
    return [];
  }
}
