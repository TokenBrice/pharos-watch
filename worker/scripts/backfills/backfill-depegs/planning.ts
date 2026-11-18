import { logWorkerEventArgs } from "../../../src/lib/structured-log";
import { PSI_ELIGIBLE_META_BY_ID } from "@shared/lib/psi-eligible";
import { isCommodityPeg } from "@shared/lib/filter-tags";
import { DAY_SECONDS, HOUR_SECONDS } from "@shared/lib/time-constants";
import { MAX_SUPPLY_SNAPSHOT_DISTANCE_SEC } from "@shared/lib/rate-series";
import type { D1Database } from "@cloudflare/workers-types";
import type { StablecoinMeta } from "@shared/types/stablecoin-meta-schemas";
import { DEFILLAMA_BASE, USER_AGENT } from "../../../src/lib/constants";
import { fetchJsonWithRetry } from "../../../src/lib/fetch-retry";
import {
  type FxTimeSeries,
  PEG_TO_FX,
  SECONDARY_PEG_TO_FX,
  OTHER_COIN_FX,
  fetchHistoricalFxRates,
  fetchHistoricalSecondaryFxRates,
  fetchHistoricalCommodityPeers,
  HISTORICAL_INTRADAY_PAIRING_SEC,
  type CommodityPeg,
  type HistoricalCommoditySources,
} from "../../../src/lib/backfill-fx";
import type { BackfillReplayWindow } from "../../../src/lib/backfill-day-window";
import type { SupplyPoint } from "../../../src/lib/historical-depeg-extraction";
import {
  acquireDefiLlamaDetailMaterialization,
  DEFILLAMA_DETAIL_MAX_RESPONSE_BYTES,
} from "../../../src/api/stablecoin-detail/defillama";

interface CoinDetail {
  gecko_id?: string;
  address?: string;
  tokens?: SupplyPoint[];
}

export interface PreparedBackfillCoin {
  meta: StablecoinMeta;
  geckoId?: string;
  supplyTokens: SupplyPoint[];
}

export interface BackfillPlan {
  preparedCoins: PreparedBackfillCoin[];
  fxSeries: Record<string, FxTimeSeries[]>;
  commodityPeers: HistoricalCommoditySources;
  commodityPegs: CommodityPeg[];
}

export async function buildBackfillPlan(opts: {
  db: D1Database;
  coins: StablecoinMeta[];
  replayWindow: BackfillReplayWindow | null;
  coingeckoApiKey: string | null;
  dryRun?: boolean;
}): Promise<BackfillPlan> {
  const { db, coins, replayWindow, coingeckoApiKey } = opts;

  const processable = coins.filter((m) => !m.flags.navToken);

  const neededFxCurrencies = new Set<string>();
  const neededSecondaryFxCurrencies = new Set<string>();
  const neededCommodityPegs = new Set<CommodityPeg>();
  const preparedCoins: PreparedBackfillCoin[] = [];

  const nowSec = Math.floor(Date.now() / 1000);
  const endDate = new Date(Math.min(replayWindow?.replayEndSec ?? nowSec, nowSec) * 1000).toISOString().slice(0, 10);
  let historicalFxStartDate = endDate;

  for (const meta of processable) {
    let detail: CoinDetail | null = null;
    const dlId = meta.llamaId ?? meta.id;
    try {
      const release = await acquireDefiLlamaDetailMaterialization();
      try {
        const result = await fetchJsonWithRetry<CoinDetail>(
          `${DEFILLAMA_BASE}/stablecoin/${encodeURIComponent(dlId)}`,
          { headers: { "User-Agent": USER_AGENT } },
          1,
          { timeoutMs: 10_000, maxResponseBytes: DEFILLAMA_DETAIL_MAX_RESPONSE_BYTES },
        );
        if (result?.response.ok) {
          const raw = result.body;
          if (raw && typeof raw === "object") {
            // Retain only replay inputs; do not keep the unused per-chain history.
            detail = { gecko_id: raw.gecko_id, address: raw.address, tokens: raw.tokens };
          }
        }
      } finally {
        release();
      }
    } catch (err) {
      logWorkerEventArgs("api", "error", `[backfill-depegs] Failed to fetch detail for ${meta.symbol}:`, err);
    }

    const trackedMeta = PSI_ELIGIBLE_META_BY_ID.get(meta.id);
    const geckoId = trackedMeta?.geckoId ?? detail?.gecko_id;
    const supplyTokens = detail?.tokens ?? [];
    preparedCoins.push({
      meta,
      geckoId,
      supplyTokens,
    });

    const peg = meta.flags.pegCurrency;
    if (peg === "USD" || supplyTokens.length === 0) continue;

    const firstSupplyTimestamp = supplyTokens.reduce((earliest, point) => {
      const ts = Number(point.date);
      return Number.isSafeInteger(ts) && ts > 0 ? Math.min(earliest, ts) : earliest;
    }, Infinity);
    if (!Number.isFinite(firstSupplyTimestamp)) continue;
    const startSec = replayWindow?.replayStartSec ?? firstSupplyTimestamp;
    const earliestDate = new Date(Math.max(0, startSec - 15 * DAY_SECONDS) * 1000).toISOString().slice(0, 10);
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

  const fxSeriesPrimary = await fetchHistoricalFxRates([...neededFxCurrencies], historicalFxStartDate, endDate);
  const fxSeriesSecondary = await fetchHistoricalSecondaryFxRates(
    db, [...neededSecondaryFxCurrencies], historicalFxStartDate, endDate, undefined, opts.dryRun,
  );

  const commodityRange = {
    startSec: Math.max(0, (replayWindow?.replayStartSec ?? Date.parse(historicalFxStartDate) / 1000)
      - MAX_SUPPLY_SNAPSHOT_DISTANCE_SEC - HISTORICAL_INTRADAY_PAIRING_SEC - HOUR_SECONDS),
    endSec: Math.min(replayWindow?.replayEndSec ?? nowSec, nowSec),
  };
  const commodityPegs = [...neededCommodityPegs].sort();
  const commodityPeers = commodityPegs.length > 0
    ? await fetchHistoricalCommodityPeers(commodityRange, coingeckoApiKey, commodityPegs, db)
    : {};
  const fxSeries = { ...fxSeriesPrimary, ...fxSeriesSecondary };

  return {
    preparedCoins,
    fxSeries,
    commodityPeers,
    commodityPegs,
  };
}
