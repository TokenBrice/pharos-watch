import { PSI_ELIGIBLE_STABLECOINS, PSI_ELIGIBLE_META_BY_ID } from "@shared/lib/psi-eligible";
import { isCommodityPeg } from "@shared/lib/filter-tags";
import { DAY_MS } from "@shared/lib/time-constants";
import { derivePegRates } from "@shared/lib/peg-rates";
import { getCirculatingRaw } from "@shared/lib/supply";
import type { D1Database } from "@cloudflare/workers-types";
import type { StablecoinMeta } from "@shared/types/core";
import { DEFILLAMA_BASE, USER_AGENT } from "../../lib/constants";
import { cgUrl, cgHeaders } from "../../lib/coingecko";
import { fetchJsonWithRetry } from "../../lib/fetch-retry";
import { RATE_LIMITS } from "../../lib/rate-limit";
import { loadStablecoinsCache } from "../../lib/stablecoins-cache";
import {
  type FxTimeSeries,
  PEG_TO_FX,
  SECONDARY_PEG_TO_FX,
  OTHER_COIN_FX,
  fetchHistoricalFxRates,
  fetchHistoricalSecondaryFxRates,
  buildCommodityMedianSeriesFromCg,
  type CommodityPeg,
} from "../../lib/backfill-fx";
import type { BackfillReplayWindow } from "../backfill-depegs-window";
import {
  parseSupplyData,
  type SupplyPoint,
  type SupplySnapshot,
} from "../backfill-depegs-extraction";

interface CoinDetail {
  gecko_id?: string;
  address?: string;
  tokens?: SupplyPoint[];
}

export interface PreparedBackfillCoin {
  meta: StablecoinMeta;
  geckoId?: string;
  supplyByDate: SupplySnapshot[];
  currentSupplyUsd: number | null;
}

export interface BackfillPlan {
  preparedCoins: PreparedBackfillCoin[];
  pegRates: Record<string, number>;
  fxRates: Record<string, number> | undefined;
  fxSeries: Record<string, FxTimeSeries[]>;
  commoditySeries: Record<string, FxTimeSeries[]>;
  commodityPegs: CommodityPeg[];
}

export async function buildBackfillPlan(opts: {
  db: D1Database;
  coins: StablecoinMeta[];
  replayWindow: BackfillReplayWindow | null;
  coingeckoApiKey: string | null;
}): Promise<BackfillPlan> {
  const { db, coins, replayWindow, coingeckoApiKey } = opts;

  // Get peg rates from cached stablecoin data
  let pegRates: Record<string, number> = { peggedUSD: 1 };
  let fxRates: Record<string, number> | undefined;
  const currentSupplyById = new Map<string, number>();

  const stablecoinsCache = await loadStablecoinsCache(db, { mode: "lenient" });
  if (stablecoinsCache.kind !== "ok") {
    console.warn(`[backfill-depegs] stablecoins cache ${stablecoinsCache.kind} (${stablecoinsCache.reason})`);
  }
  const stablecoinsPayload =
    stablecoinsCache.kind === "ok" || (stablecoinsCache.kind === "degraded" && stablecoinsCache.payload)
      ? stablecoinsCache.payload
      : null;
  if (stablecoinsPayload) {
    const metaById = new Map(PSI_ELIGIBLE_STABLECOINS.map((s) => [s.id, s]));
    ({ rates: pegRates } = derivePegRates(
      stablecoinsPayload.peggedAssets,
      metaById,
      stablecoinsPayload.fxFallbackRates,
    ));
    fxRates = stablecoinsPayload.fxFallbackRates;
    for (const asset of stablecoinsPayload.peggedAssets) {
      currentSupplyById.set(asset.id, getCirculatingRaw(asset));
    }
  }

  // Filter to processable coins (skip NAV tokens)
  const processable = coins.filter((m) => !m.flags.navToken);

  // Collect coin details and historical FX currencies needed by this batch
  const neededFxCurrencies = new Set<string>();
  const neededSecondaryFxCurrencies = new Set<string>();
  const neededCommodityPegs = new Set<CommodityPeg>();
  const preparedCoins: PreparedBackfillCoin[] = [];

  // Fetch historical FX rates only as far back as the oldest supply snapshot in this batch.
  // If supply history is missing, fall back to 10 years to preserve current behavior.
  const tenYearsAgoMs = Date.now() - 10 * 365 * DAY_MS;
  const defaultStartDate = new Date(tenYearsAgoMs).toISOString().slice(0, 10);
  const endDate = new Date().toISOString().slice(0, 10);
  let historicalFxStartDate = endDate;

  for (const meta of processable) {
    let detail: CoinDetail | null = null;
    const dlId = meta.llamaId ?? meta.id;
    try {
      const result = await fetchJsonWithRetry<CoinDetail>(
        `${DEFILLAMA_BASE}/stablecoin/${encodeURIComponent(dlId)}`,
        { headers: { "User-Agent": USER_AGENT } },
        1,
        { timeoutMs: 10_000 },
      );
      if (result?.response.ok) {
        const raw = result.body;
        if (raw && typeof raw === "object") {
          detail = raw as CoinDetail;
        }
      }
    } catch (err) {
      console.error(`[backfill-depegs] Failed to fetch detail for ${meta.symbol}:`, err);
    }

    const trackedMeta = PSI_ELIGIBLE_META_BY_ID.get(meta.id);
    const geckoId = trackedMeta?.geckoId ?? detail?.gecko_id;
    const supplyByDate = parseSupplyData(detail?.tokens ?? []);
    preparedCoins.push({
      meta,
      geckoId,
      supplyByDate,
      currentSupplyUsd: currentSupplyById.get(meta.id) ?? null,
    });

    const peg = meta.flags.pegCurrency;
    if (peg === "USD") continue;

    let earliestDate: string;
    if (supplyByDate[0]) {
      earliestDate = new Date(supplyByDate[0].ts * 1000).toISOString().slice(0, 10);
    } else if (SECONDARY_PEG_TO_FX[peg] && geckoId) {
      // Secondary FX coins with no DL supply data would otherwise default to 10 years,
      // triggering ~3,600 per-day CDN fetches for the cold-start FX cache build.
      // Fetch the CG ATL/genesis date to anchor the window to the coin's actual inception.
      try {
        await new Promise((r) => setTimeout(r, RATE_LIMITS.COINGECKO_BACKFILL_MS));
        const cgResult = await fetchJsonWithRetry<{
          genesis_date?: string | null;
          market_data?: { atl_date?: Record<string, string> };
        }>(
          cgUrl(
            `/coins/${geckoId}?localization=false&tickers=false&market_data=true&community_data=false&developer_data=false`,
            coingeckoApiKey ?? null,
          ),
          { headers: cgHeaders({ "User-Agent": USER_AGENT }, coingeckoApiKey ?? null) },
          1,
          { timeoutMs: 10_000 },
        );
        if (cgResult?.response.ok) {
          const cgData = cgResult.body;
          const inceptionStr = cgData.genesis_date ?? cgData.market_data?.atl_date?.["usd"];
          if (inceptionStr) {
            const d = new Date(inceptionStr);
            d.setUTCDate(d.getUTCDate() - 7); // 7-day buffer
            earliestDate = d.toISOString().slice(0, 10);
          } else {
            earliestDate = defaultStartDate;
          }
        } else {
          earliestDate = defaultStartDate;
        }
      } catch {
        earliestDate = defaultStartDate;
      }
    } else {
      earliestDate = defaultStartDate;
    }
    if (earliestDate < historicalFxStartDate) {
      historicalFxStartDate = earliestDate;
    }

    if (isCommodityPeg(peg)) {
      neededCommodityPegs.add(peg as CommodityPeg);
    } else {
      const secondaryFx = SECONDARY_PEG_TO_FX[peg];
      if (secondaryFx) {
        neededSecondaryFxCurrencies.add(secondaryFx);
        continue;
      }

      const fx = PEG_TO_FX[peg] ?? OTHER_COIN_FX[meta.id];
      if (fx) {
        neededFxCurrencies.add(fx);
      }
    }
  }

  // Fetch FX rates and commodity peer-median series in parallel.
  // Commodity peg reference is derived from the median of all tracked gold/silver
  // token CG prices — same approach as derivePegRates() in the live system.
  const fxPromise =
    neededFxCurrencies.size > 0
      ? fetchHistoricalFxRates([...neededFxCurrencies], historicalFxStartDate, endDate)
      : Promise.resolve({} as Record<string, FxTimeSeries[]>);

  const secondaryFxPromise =
    neededSecondaryFxCurrencies.size > 0
      ? fetchHistoricalSecondaryFxRates(db, [...neededSecondaryFxCurrencies], historicalFxStartDate, endDate)
      : Promise.resolve({} as Record<string, FxTimeSeries[]>);

  const commodityRange = replayWindow
    ? {
        startSec: replayWindow.replayStartSec,
        endSec: replayWindow.replayEndSec,
      }
    : undefined;
  const commodityPegs = [...neededCommodityPegs].sort();
  const commodityPromise = commodityPegs.length > 0
    ? buildCommodityMedianSeriesFromCg(commodityRange, coingeckoApiKey ?? null, commodityPegs)
    : Promise.resolve({} as Record<string, FxTimeSeries[]>);

  const [fxSeriesPrimary, fxSeriesSecondary, commoditySeries] = await Promise.all([
    fxPromise,
    secondaryFxPromise,
    commodityPromise,
  ]);
  const fxSeries = { ...fxSeriesPrimary, ...fxSeriesSecondary };

  return {
    preparedCoins,
    pegRates,
    fxRates,
    fxSeries,
    commoditySeries,
    commodityPegs,
  };
}
