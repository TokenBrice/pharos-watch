import { PSI_ELIGIBLE_STABLECOINS, PSI_ELIGIBLE_META_BY_ID } from "@shared/lib/psi-eligible";
import { DAY_MS } from "@shared/lib/time-constants";
import { derivePegRates, getPegReference } from "@shared/lib/peg-rates";
import { cancelResponseBodyQuietly } from "../lib/response-body";
import {
  DEFILLAMA_BASE,
  RUB_FALLBACK,
  USER_AGENT,
} from "../lib/constants";
import { errorResponse, jsonResponse } from "../lib/api-utils";
import { cgUrl, cgHeaders } from "../lib/coingecko";
import { fetchWithRetry } from "../lib/fetch-retry";
import { RATE_LIMITS } from "../lib/rate-limit";
import type { D1Database } from "@cloudflare/workers-types";
import type { StablecoinMeta } from "@shared/types/core";
import { selectBackfillCoins } from "../lib/backfill-query";
import { buildAdminJobSummary, noAdminTargetsResponse, runAdminJob } from "../lib/admin-job";
import { loadStablecoinsCache } from "../lib/stablecoins-cache";

// ── Imports from extracted modules (used in this file) ──────────────
import {
  type FxTimeSeries,
  PEG_TO_FX,
  SECONDARY_PEG_TO_FX,
  OTHER_COIN_FX,
  COMMODITY_PEGS,
  fetchHistoricalFxRates,
  fetchHistoricalSecondaryFxRates,
  buildCommodityMedianSeriesFromCg,
  buildFxLookup,
} from "./backfill-fx";

import {
  BACKFILL_REPLAY_CONTEXT_DAYS,
  MAX_BACKFILL_REPLAY_CONTEXT_DAYS,
  buildBackfillDeleteStmt,
  buildReplayWindow,
  parseContextDaysParam,
  parseDayParam,
} from "./backfill-depegs-window";
import {
  parseSupplyData,
  type SupplyPoint,
  type SupplySnapshot,
} from "./backfill-depegs-extraction";
import {
  buildBackfillReplayPreview,
  loadExistingReplayRows,
  type BackfillReplayPreview,
} from "./backfill-depegs-preview";
import { backfillCoin } from "./backfill-depegs-replay";

const BATCH_SIZE = 3;
const BATCH_CHUNK_SIZE = 100;
/** Per-coin detail from /stablecoin/:id — includes gecko_id and historical supply */
interface CoinDetail {
  gecko_id?: string;
  address?: string;
  tokens?: SupplyPoint[];
}

interface PreparedBackfillCoin {
  meta: StablecoinMeta;
  geckoId?: string;
  supplyByDate: SupplySnapshot[];
}

export async function handleBackfillDepegs(
  db: D1Database,
  url: URL,
  trustedAdmin?: boolean,
  request?: Request,
  coingeckoApiKey?: string | null,
): Promise<Response> {
  return runAdminJob(
    { request, trustedAdmin, url },
    async (context) => {
      const { dryRun } = context;
      const hasExplicitReplayWindow = url.searchParams.has("startDay") || url.searchParams.has("endDay");
      const requestedStartDay = parseDayParam(url.searchParams.get("startDay"));
      const requestedEndDay = parseDayParam(url.searchParams.get("endDay"));
      const requestedContextDays = parseContextDaysParam(url.searchParams.get("contextDays"));
      if (
        (url.searchParams.get("startDay") && requestedStartDay == null) ||
        (url.searchParams.get("endDay") && requestedEndDay == null)
      ) {
        return errorResponse(400, "Invalid startDay/endDay. Use Unix seconds/milliseconds or YYYY-MM-DD.");
      }
      if (url.searchParams.get("contextDays") && requestedContextDays == null) {
        return errorResponse(
          400,
          `Invalid contextDays. Use an integer between 0 and ${MAX_BACKFILL_REPLAY_CONTEXT_DAYS}.`,
        );
      }
      if (
        requestedStartDay != null &&
        requestedEndDay != null &&
        requestedStartDay > requestedEndDay
      ) {
        return errorResponse(400, "Invalid startDay/endDay: startDay must be <= endDay.");
      }
      const replayWindow = hasExplicitReplayWindow
        ? buildReplayWindow(
            requestedStartDay,
            requestedEndDay,
            requestedContextDays ?? BACKFILL_REPLAY_CONTEXT_DAYS,
          )
        : null;

      const selection = selectBackfillCoins(url, PSI_ELIGIBLE_STABLECOINS, {
        defaultBatchSize: BATCH_SIZE,
        allowBatchSizeOverride: false,
      });
      if ("response" in selection) {
        return selection.response;
      }
      const coins = selection.coins;

      if (coins.length === 0) {
        return noAdminTargetsResponse();
      }

      // Get peg rates from cached stablecoin data
      let pegRates: Record<string, number> = { peggedUSD: 1 };
      let fxRates: Record<string, number> | undefined;

      const stablecoinsCache = await loadStablecoinsCache(db, { mode: "lenient", allowLegacyArray: true });
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
      }

      // Filter to processable coins (skip NAV tokens)
      const processable = coins.filter((m) => !m.flags.navToken);

      // Manual overrides for coins where DefiLlama has wrong/missing geckoId

      let totalEvents = 0;
      const errors: string[] = [];
      const skipped: string[] = [];
      const previews: BackfillReplayPreview[] = [];

      // Collect coin details and historical FX currencies needed by this batch
      const neededFxCurrencies = new Set<string>();
      const neededSecondaryFxCurrencies = new Set<string>();
      let needsCommodities = false;
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
          const res = await fetch(`${DEFILLAMA_BASE}/stablecoin/${encodeURIComponent(dlId)}`);
          if (res.ok) {
            const raw = await res.json();
            if (raw && typeof raw === "object") {
              detail = raw as CoinDetail;
            }
          } else {
            await cancelResponseBodyQuietly(res);
          }
        } catch (err) {
          console.error(`[backfill-depegs] Failed to fetch detail for ${meta.symbol}:`, err);
        }

        const trackedMeta = PSI_ELIGIBLE_META_BY_ID.get(meta.id);
        const geckoId = trackedMeta?.geckoId ?? detail?.gecko_id;
        const supplyByDate = parseSupplyData(detail?.tokens ?? []);
        preparedCoins.push({ meta, geckoId, supplyByDate });

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
            const cgRes = await fetchWithRetry(
              cgUrl(
                `/coins/${geckoId}?localization=false&tickers=false&market_data=true&community_data=false&developer_data=false`,
                coingeckoApiKey ?? null,
              ),
              { headers: cgHeaders({ "User-Agent": USER_AGENT }, coingeckoApiKey ?? null) },
              1,
              { timeoutMs: 10_000 },
            );
            if (cgRes?.ok) {
              const cgData = (await cgRes.json()) as {
                genesis_date?: string | null;
                market_data?: { atl_date?: Record<string, string> };
              };
              const inceptionStr = cgData.genesis_date ?? cgData.market_data?.atl_date?.["usd"];
              if (inceptionStr) {
                const d = new Date(inceptionStr);
                d.setUTCDate(d.getUTCDate() - 7); // 7-day buffer
                earliestDate = d.toISOString().slice(0, 10);
              } else {
                earliestDate = defaultStartDate;
              }
            } else {
              await cancelResponseBodyQuietly(cgRes);
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

        if (COMMODITY_PEGS.has(peg)) {
          needsCommodities = true;
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

      const commodityPromise = needsCommodities
        ? buildCommodityMedianSeriesFromCg()
        : Promise.resolve({} as Record<string, FxTimeSeries[]>);

      const [fxSeriesPrimary, fxSeriesSecondary, commoditySeries] = await Promise.all([
        fxPromise,
        secondaryFxPromise,
        commodityPromise,
      ]);
      const fxSeries = { ...fxSeriesPrimary, ...fxSeriesSecondary };

      // Process coins sequentially — each still needs CG price history fetch.
      // Serializing avoids memory pressure from parsing multiple large JSON responses.
      for (const { meta, geckoId, supplyByDate } of preparedCoins) {
        if (!geckoId) {
          skipped.push(meta.symbol);
          continue;
        }

        // Build time-varying peg reference function for this coin
        const peg = meta.flags.pegCurrency;
        const pegType = `pegged${peg}`;
        const currentPegRef = getPegReference(pegType, pegRates, meta.commodityOunces);
        let getPegRef: (timestamp: number) => number;

        if (peg === "USD") {
          getPegRef = () => 1;
        } else if (COMMODITY_PEGS.has(peg)) {
          // Commodity peg (gold/silver): use historical spot price series
          const series = commoditySeries[peg] ?? [];
          const fallback = currentPegRef > 0 ? currentPegRef : 1;
          const spotLookup = buildFxLookup(series, fallback);
          if (meta.commodityOunces && meta.commodityOunces > 0) {
            const oz = meta.commodityOunces;
            getPegRef = (ts) => spotLookup(ts) * oz;
          } else {
            getPegRef = spotLookup;
          }
        } else {
          const fxCode = PEG_TO_FX[peg] ?? SECONDARY_PEG_TO_FX[peg] ?? OTHER_COIN_FX[meta.id];
          const series = fxCode ? (fxSeries[fxCode] ?? []) : [];
          const fallbackRate = fxRates?.[pegType];
          const fallback =
            typeof fallbackRate === "number" && fallbackRate > 0
              ? fallbackRate
              : currentPegRef > 0
                ? currentPegRef
                : peg === "RUB"
                  ? RUB_FALLBACK
                  : 1;
          const fxLookup = buildFxLookup(series, fallback);
          getPegRef = fxLookup;
        }

        try {
          const replay = await backfillCoin(
            meta,
            geckoId,
            getPegRef,
            supplyByDate,
            fxRates,
            replayWindow,
            coingeckoApiKey ?? null,
          );
          const events = replay.events;

          if (dryRun) {
            const existingRows = await loadExistingReplayRows(db, meta.id, replayWindow);
            previews.push(buildBackfillReplayPreview({
              meta,
              sourceKind: replay.sourceKind,
              authoritativeSource: replay.authoritativeSource,
              marketDiagnostics: replay.marketDiagnostics,
              existingRows,
              events,
            }));
            if (events === null) {
              skipped.push(meta.symbol);
              continue;
            }
            totalEvents += events.length;
            continue;
          }

          // null = no trusted historical source available -> preserve existing rows
          if (events === null) {
            skipped.push(meta.symbol);
            continue;
          }

          // Only replace backfill-sourced events; preserve live-cron-detected events
          // (live cron catches brief intraday depegs that daily backfill data misses).
          const deleteStmt = buildBackfillDeleteStmt(db, meta.id, replayWindow);
          if (events.length > 0) {
            const insertStmts = events.map((e) =>
              db
                .prepare(
                  `INSERT INTO depeg_events (stablecoin_id, symbol, peg_type, direction, peak_deviation_bps, started_at, ended_at, start_price, peak_price, recovery_price, peg_reference, source)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'backfill')`,
                )
                .bind(
                  meta.id,
                  meta.symbol,
                  e.pegType,
                  e.direction,
                  e.peakDeviationBps,
                  e.startedAt,
                  e.endedAt,
                  e.startPrice,
                  e.peakPrice,
                  e.recoveryPrice,
                  e.pegRef,
                ),
            );
            await db.batch([deleteStmt]);
            for (let i = 0; i < insertStmts.length; i += BATCH_CHUNK_SIZE) {
              const chunk = insertStmts.slice(i, i + BATCH_CHUNK_SIZE);
              await db.batch(chunk);
            }
            totalEvents += events.length;
          } else {
            await deleteStmt.run();
          }
        } catch (err) {
          errors.push(`${meta.symbol}: ${err}`);
        }
      }

      if (dryRun) {
        return jsonResponse(buildAdminJobSummary({
          dryRun: true,
          coinsProcessed: coins.length,
          recomputedBackfillEvents: totalEvents,
          startDay: replayWindow?.startDay ?? null,
          endDay: replayWindow?.endDay ?? null,
          contextDays: replayWindow?.contextDays ?? null,
          previews,
          skipped,
          errors,
          commodities: needsCommodities
            ? {
                goldDataPoints: commoditySeries["GOLD"]?.length ?? 0,
                silverDataPoints: commoditySeries["SILVER"]?.length ?? 0,
              }
            : undefined,
        }));
      }

      return jsonResponse(buildAdminJobSummary({
        coinsProcessed: coins.length,
        eventsCreated: totalEvents,
        skipped,
        errors,
        commodities: needsCommodities
          ? {
              goldDataPoints: commoditySeries["GOLD"]?.length ?? 0,
              silverDataPoints: commoditySeries["SILVER"]?.length ?? 0,
            }
          : undefined,
      }));
    },
  );
}
