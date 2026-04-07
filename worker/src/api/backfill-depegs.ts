import { PSI_ELIGIBLE_STABLECOINS, PSI_ELIGIBLE_META_BY_ID } from "@shared/lib/psi-eligible";
import { DAY_SECONDS, DAY_MS } from "@shared/lib/time-constants";
import { derivePegRates, getPegReference } from "@shared/lib/peg-rates";
import { cancelResponseBodyQuietly } from "../lib/response-body";
import {
  getDepegThresholdBps,
  DEFILLAMA_BASE,
  RUB_FALLBACK,
  USER_AGENT,
  DEPEG_CONFIRMATION_SUPPLY_THRESHOLD,
} from "../lib/constants";
import {
  buildPriceReasonablenessOptions,
  buildPriceValidationContext,
  type PriceReasonablenessOptions,
  validatePriceCandidateAgainstReference,
} from "../lib/price-validation";
import { errorResponse, jsonResponse } from "../lib/api-utils";
import { binarySearchNearest } from "../lib/binary-search";
import { cgUrl, cgHeaders } from "../lib/coingecko";
import { fetchWithRetry } from "../lib/fetch-retry";
import { RATE_LIMITS } from "../lib/rate-limit";
import type { StablecoinMeta } from "@shared/types/core";
import { sumPegBuckets } from "@shared/lib/supply";
import { selectBackfillCoins } from "../lib/backfill-query";
import { buildAdminJobSummary, noAdminTargetsResponse, runAdminJob } from "../lib/admin-job";
import { loadStablecoinsCache } from "../lib/stablecoins-cache";
import { fetchAuthoritativeHistoricalPriceSeries } from "../lib/authoritative-price-sources";

// ── Re-exports from extracted modules (preserve public API) ─────────
export {
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

export {
  type PricePoint,
  fetchCgPriceHistoryDaily,
  fetchCgPriceHistoryHourly,
  fetchDlPriceChart,
  collapsePricesToDailyTimestamps,
  fetchMarketBackfillPrices,
} from "./backfill-price-sources";

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
  type HistoricalMarketSourceDiagnostics,
  type HistoricalMarketPriceSeriesResult,
  type PricePoint,
  collapsePricesToDailyTimestamps,
  fetchMarketBackfillPriceSeries,
} from "./backfill-price-sources";

const BATCH_SIZE = 3;
const BATCH_CHUNK_SIZE = 100;
const BACKFILL_REPLAY_CONTEXT_DAYS = 7;

/** Consecutive above-threshold data points needed to confirm a large-cap depeg.
 *  Mirrors the live system's pending → re-check → promote flow. */
const BACKFILL_MIN_CONFIRM_POINTS = 2;

/** Max gap (seconds) between data points before pending resets.
 *  6h handles CG hourly gaps but resets for day-scale gaps. */
const BACKFILL_PENDING_MAX_GAP_SEC = 6 * 3600;

interface SupplyPoint {
  date: string;
  circulating?: Record<string, number>;
}

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

interface BackfillReplayWindow {
  startDay: number | null;
  endDay: number | null;
  compareStartSec: number | null;
  compareEndSec: number | null;
  replayStartSec: number | null;
  replayEndSec: number | null;
}

export interface ExistingDepegEventRow {
  id: number;
  stablecoin_id: string;
  symbol: string;
  peg_type: string;
  direction: string;
  peak_deviation_bps: number;
  started_at: number;
  ended_at: number | null;
  start_price: number;
  peak_price: number | null;
  recovery_price: number | null;
  peg_reference: number;
  source: string;
}

interface BackfillReplayPreview {
  stablecoinId: string;
  symbol: string;
  replaySource: "market" | "authoritative" | "preserve-existing";
  authoritativeSource: string | null;
  marketSourcesUsed: string[];
  mergeReasons: string[];
  policyAdjustmentCount: number;
  existingBackfillEventCount: number;
  recomputedBackfillEventCount: number | null;
  existingLiveEventCount: number;
  existingOpenLiveEventCount: number;
  exactMatch: boolean | null;
  removedBackfillEventCount: number;
  removedBackfillEventIdsSample: number[];
  addedBackfillEventCount: number;
  addedBackfillEventsSample: Array<{
    direction: string;
    peakDeviationBps: number;
    startedAt: number;
    endedAt: number | null;
  }>;
}

function parseDayParam(raw: string | null): number | null {
  if (!raw) return null;
  if (/^\d+$/.test(raw)) {
    const parsed = Number(raw);
    if (!Number.isFinite(parsed)) return null;
    const seconds = parsed > 1e12 ? Math.floor(parsed / 1000) : parsed;
    return Math.floor(seconds / DAY_SECONDS) * DAY_SECONDS;
  }

  const parsedMs = Date.parse(raw);
  if (Number.isNaN(parsedMs)) return null;
  return Math.floor(parsedMs / 1000 / DAY_SECONDS) * DAY_SECONDS;
}

function buildReplayWindow(startDay: number | null, endDay: number | null): BackfillReplayWindow {
  const compareStartSec = startDay;
  const compareEndSec = endDay != null ? endDay + DAY_SECONDS - 1 : null;
  return {
    startDay,
    endDay,
    compareStartSec,
    compareEndSec,
    replayStartSec:
      compareStartSec != null
        ? Math.max(0, compareStartSec - BACKFILL_REPLAY_CONTEXT_DAYS * DAY_SECONDS)
        : null,
    replayEndSec:
      compareEndSec != null
        ? compareEndSec + BACKFILL_REPLAY_CONTEXT_DAYS * DAY_SECONDS
        : null,
  };
}

function timestampInReplayWindow(timestamp: number, replayWindow: BackfillReplayWindow | null): boolean {
  if (replayWindow?.replayStartSec != null && timestamp < replayWindow.replayStartSec) return false;
  if (replayWindow?.replayEndSec != null && timestamp > replayWindow.replayEndSec) return false;
  return true;
}

function eventOverlapsReplayWindow(
  event: Pick<BackfillEvent, "startedAt" | "endedAt">,
  replayWindow: BackfillReplayWindow | null,
): boolean {
  if (!replayWindow) return true;
  const eventEnd = event.endedAt ?? event.startedAt;
  if (replayWindow.compareStartSec != null && eventEnd < replayWindow.compareStartSec) return false;
  if (replayWindow.compareEndSec != null && event.startedAt > replayWindow.compareEndSec) return false;
  return true;
}

function existingRowOverlapsReplayWindow(
  row: Pick<ExistingDepegEventRow, "started_at" | "ended_at">,
  replayWindow: BackfillReplayWindow | null,
): boolean {
  if (!replayWindow) return true;
  const rowEnd = row.ended_at ?? row.started_at;
  if (replayWindow.compareStartSec != null && rowEnd < replayWindow.compareStartSec) return false;
  if (replayWindow.compareEndSec != null && row.started_at > replayWindow.compareEndSec) return false;
  return true;
}

function buildBackfillDeleteStmt(
  db: D1Database,
  stablecoinId: string,
  replayWindow: BackfillReplayWindow | null,
): D1PreparedStatement {
  if (!replayWindow) {
    return db
      .prepare("DELETE FROM depeg_events WHERE stablecoin_id = ? AND source = 'backfill'")
      .bind(stablecoinId);
  }

  let sql = "DELETE FROM depeg_events WHERE stablecoin_id = ? AND source = 'backfill'";
  const binds: unknown[] = [stablecoinId];
  if (replayWindow.compareStartSec != null) {
    sql += " AND COALESCE(ended_at, started_at) >= ?";
    binds.push(replayWindow.compareStartSec);
  }
  if (replayWindow.compareEndSec != null) {
    sql += " AND started_at <= ?";
    binds.push(replayWindow.compareEndSec);
  }
  return db.prepare(sql).bind(...binds);
}

export async function handleBackfillDepegs(
  db: D1Database,
  url: URL,
  trustedAdmin?: boolean,
  request?: Request,
): Promise<Response> {
  return runAdminJob(
    { request, trustedAdmin, url },
    async (context) => {
      const { dryRun } = context;
      const hasExplicitReplayWindow = url.searchParams.has("startDay") || url.searchParams.has("endDay");
      const requestedStartDay = parseDayParam(url.searchParams.get("startDay"));
      const requestedEndDay = parseDayParam(url.searchParams.get("endDay"));
      if (
        (url.searchParams.get("startDay") && requestedStartDay == null) ||
        (url.searchParams.get("endDay") && requestedEndDay == null)
      ) {
        return errorResponse(400, "Invalid startDay/endDay. Use Unix seconds/milliseconds or YYYY-MM-DD.");
      }
      if (
        requestedStartDay != null &&
        requestedEndDay != null &&
        requestedStartDay > requestedEndDay
      ) {
        return errorResponse(400, "Invalid startDay/endDay: startDay must be <= endDay.");
      }
      const replayWindow = hasExplicitReplayWindow
        ? buildReplayWindow(requestedStartDay, requestedEndDay)
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
              ),
              { headers: cgHeaders({ "User-Agent": USER_AGENT }) },
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
          const replay = await backfillCoin(meta, geckoId, getPegRef, supplyByDate, fxRates, replayWindow);
          const events = replay.events;

          // null = CG had no price data → preserve existing events
          if (events === null) {
            if (dryRun) {
              const existingRows = await db
                .prepare(
                  "SELECT id, stablecoin_id, symbol, peg_type, direction, peak_deviation_bps, started_at, ended_at, start_price, peak_price, recovery_price, peg_reference, source FROM depeg_events WHERE stablecoin_id = ? ORDER BY started_at",
                )
                .bind(meta.id)
                .all<ExistingDepegEventRow>();
              const existingResults = existingRows.results ?? [];
              const existingBackfillRows = existingResults.filter((row) => (
                row.source === "backfill" && existingRowOverlapsReplayWindow(row, replayWindow)
              ));
              const existingLiveRows = existingResults.filter((row) => row.source === "live");
              previews.push({
                stablecoinId: meta.id,
                symbol: meta.symbol,
                replaySource: replay.sourceKind,
                authoritativeSource: replay.authoritativeSource,
                marketSourcesUsed: replay.marketDiagnostics?.sourcesUsed ?? [],
                mergeReasons: replay.marketDiagnostics?.mergeReasons ?? [],
                policyAdjustmentCount: replay.marketDiagnostics?.policyAdjustments.length ?? 0,
                existingBackfillEventCount: existingBackfillRows.length,
                recomputedBackfillEventCount: null,
                existingLiveEventCount: existingLiveRows.length,
                existingOpenLiveEventCount: existingLiveRows.filter((row) => row.ended_at == null).length,
                exactMatch: null,
                removedBackfillEventCount: 0,
                removedBackfillEventIdsSample: [],
                addedBackfillEventCount: 0,
                addedBackfillEventsSample: [],
              });
            }
            skipped.push(meta.symbol);
            continue;
          }

          if (dryRun) {
            const existingRows = await db
              .prepare(
                "SELECT id, stablecoin_id, symbol, peg_type, direction, peak_deviation_bps, started_at, ended_at, start_price, peak_price, recovery_price, peg_reference, source FROM depeg_events WHERE stablecoin_id = ? ORDER BY started_at",
              )
              .bind(meta.id)
              .all<ExistingDepegEventRow>();
            const existingResults = existingRows.results ?? [];
            const existingBackfillRows = existingResults.filter((row) => (
              row.source === "backfill" && existingRowOverlapsReplayWindow(row, replayWindow)
            ));
            const existingLiveRows = existingResults.filter((row) => row.source === "live");
            const diff = summarizeBackfillReplayDiff(existingBackfillRows, events);
            previews.push({
              stablecoinId: meta.id,
              symbol: meta.symbol,
              replaySource: replay.sourceKind,
              authoritativeSource: replay.authoritativeSource,
              marketSourcesUsed: replay.marketDiagnostics?.sourcesUsed ?? [],
              mergeReasons: replay.marketDiagnostics?.mergeReasons ?? [],
              policyAdjustmentCount: replay.marketDiagnostics?.policyAdjustments.length ?? 0,
              existingBackfillEventCount: existingBackfillRows.length,
              recomputedBackfillEventCount: events.length,
              existingLiveEventCount: existingLiveRows.length,
              existingOpenLiveEventCount: existingLiveRows.filter((row) => row.ended_at == null).length,
              exactMatch: diff.exactMatch,
              removedBackfillEventCount: diff.removedBackfillEventCount,
              removedBackfillEventIdsSample: diff.removedBackfillEventIdsSample,
              addedBackfillEventCount: diff.addedBackfillEventCount,
              addedBackfillEventsSample: diff.addedBackfillEventsSample,
            });
            totalEvents += events.length;
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

export interface BackfillEvent {
  pegType: string;
  direction: string;
  peakDeviationBps: number;
  startedAt: number;
  endedAt: number | null;
  startPrice: number;
  peakPrice: number;
  recoveryPrice: number | null;
  pegRef: number;
}

interface SupplySnapshot {
  ts: number;
  supply: number;
}

interface BackfillCoinReplayResult {
  events: BackfillEvent[] | null;
  sourceKind: "market" | "authoritative" | "preserve-existing";
  authoritativeSource: string | null;
  marketDiagnostics: HistoricalMarketSourceDiagnostics | null;
}

const BACKFILL_DIFF_SAMPLE_LIMIT = 20;

function formatBackfillNumber(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return "null";
  return value.toString();
}

function buildBackfillEventFingerprint(event: BackfillEvent): string {
  return [
    event.direction,
    event.peakDeviationBps,
    event.startedAt,
    event.endedAt ?? "null",
    formatBackfillNumber(event.startPrice),
    formatBackfillNumber(event.peakPrice),
    formatBackfillNumber(event.recoveryPrice),
    formatBackfillNumber(event.pegRef),
  ].join("|");
}

function buildExistingBackfillFingerprint(row: ExistingDepegEventRow): string {
  return [
    row.direction,
    row.peak_deviation_bps,
    row.started_at,
    row.ended_at ?? "null",
    formatBackfillNumber(row.start_price),
    formatBackfillNumber(row.peak_price),
    formatBackfillNumber(row.recovery_price),
    formatBackfillNumber(row.peg_reference),
  ].join("|");
}

function incrementCount(target: Map<string, number>, key: string): void {
  target.set(key, (target.get(key) ?? 0) + 1);
}

export function summarizeBackfillReplayDiff(
  existingBackfillRows: ExistingDepegEventRow[],
  recomputedEvents: BackfillEvent[],
): {
  exactMatch: boolean;
  removedBackfillEventCount: number;
  removedBackfillEventIdsSample: number[];
  addedBackfillEventCount: number;
  addedBackfillEventsSample: Array<{
    direction: string;
    peakDeviationBps: number;
    startedAt: number;
    endedAt: number | null;
  }>;
} {
  const expectedCounts = new Map<string, number>();
  for (const event of recomputedEvents) {
    incrementCount(expectedCounts, buildBackfillEventFingerprint(event));
  }

  const removedBackfillEventIdsSample: number[] = [];
  let removedBackfillEventCount = 0;
  for (const row of existingBackfillRows) {
    const key = buildExistingBackfillFingerprint(row);
    const remaining = expectedCounts.get(key) ?? 0;
    if (remaining > 0) {
      expectedCounts.set(key, remaining - 1);
      continue;
    }
    removedBackfillEventCount++;
    if (removedBackfillEventIdsSample.length < BACKFILL_DIFF_SAMPLE_LIMIT) {
      removedBackfillEventIdsSample.push(row.id);
    }
  }

  const existingCounts = new Map<string, number>();
  for (const row of existingBackfillRows) {
    incrementCount(existingCounts, buildExistingBackfillFingerprint(row));
  }

  const addedBackfillEventsSample: Array<{
    direction: string;
    peakDeviationBps: number;
    startedAt: number;
    endedAt: number | null;
  }> = [];
  let addedBackfillEventCount = 0;
  for (const event of recomputedEvents) {
    const key = buildBackfillEventFingerprint(event);
    const remaining = existingCounts.get(key) ?? 0;
    if (remaining > 0) {
      existingCounts.set(key, remaining - 1);
      continue;
    }
    addedBackfillEventCount++;
    if (addedBackfillEventsSample.length < BACKFILL_DIFF_SAMPLE_LIMIT) {
      addedBackfillEventsSample.push({
        direction: event.direction,
        peakDeviationBps: event.peakDeviationBps,
        startedAt: event.startedAt,
        endedAt: event.endedAt,
      });
    }
  }

  return {
    exactMatch: removedBackfillEventCount === 0 && addedBackfillEventCount === 0,
    removedBackfillEventCount,
    removedBackfillEventIdsSample,
    addedBackfillEventCount,
    addedBackfillEventsSample,
  };
}

/** Returns null events when no trusted historical source is available (caller should preserve existing rows). */
async function backfillCoin(
  meta: StablecoinMeta,
  geckoId: string,
  getPegRef: (timestamp: number) => number,
  supplyByDate: SupplySnapshot[],
  fxRates?: Record<string, number>,
  replayWindow?: BackfillReplayWindow | null,
): Promise<BackfillCoinReplayResult> {
  const pegType = `pegged${meta.flags.pegCurrency}`;
  const candidateSupplySnapshots = replayWindow
    ? supplyByDate.filter((snapshot) => timestampInReplayWindow(snapshot.ts, replayWindow))
    : supplyByDate;

  let marketSeries: HistoricalMarketPriceSeriesResult | null = null;
  const loadMarketSeries = async (): Promise<HistoricalMarketPriceSeriesResult> => {
    if (marketSeries != null) return marketSeries;
    marketSeries = await fetchMarketBackfillPriceSeries(meta, geckoId, {
      granularity: "hourly",
      range: replayWindow
        ? {
            startSec: replayWindow.replayStartSec,
            endSec: replayWindow.replayEndSec,
          }
        : undefined,
    });
    if (
      marketSeries.diagnostics.mergeReasons.length > 0 ||
      marketSeries.diagnostics.policyAdjustments.length > 0
    ) {
      console.log(
        `[backfill-depegs] ${meta.id} historical market replay used ${marketSeries.diagnostics.sourcesUsed.join("+") || "none"}`
          + ` mergeReasons=${marketSeries.diagnostics.mergeReasons.join(",") || "none"}`
          + ` adjustments=${marketSeries.diagnostics.policyAdjustments.length}`,
      );
    }
    return marketSeries;
  };

  const candidateTimestamps =
    candidateSupplySnapshots.length > 0
      ? candidateSupplySnapshots.map((snapshot) => snapshot.ts)
      : collapsePricesToDailyTimestamps((await loadMarketSeries()).prices ?? []);

  const authoritativeHistory = await fetchAuthoritativeHistoricalPriceSeries(meta, {
    candidateTimestamps,
    supplySnapshots: supplyByDate,
  });

  let prices: PricePoint[] | null;
  let sourceKind: BackfillCoinReplayResult["sourceKind"];
  let marketDiagnostics: HistoricalMarketSourceDiagnostics | null = null;
  if (authoritativeHistory.matched) {
    prices = authoritativeHistory.prices;
    if (!prices || prices.length === 0) {
      console.warn(
        `[backfill-depegs] authoritative historical price source unavailable for ${meta.symbol}` +
          `${authoritativeHistory.source ? ` (${authoritativeHistory.source})` : ""}; preserving existing backfill rows`,
      );
      return {
        events: null,
        sourceKind: "preserve-existing",
        authoritativeSource: authoritativeHistory.source,
        marketDiagnostics: null,
      };
    }
    sourceKind = "authoritative";
  } else {
    const series = await loadMarketSeries();
    prices = series.prices;
    marketDiagnostics = series.diagnostics;
    if (!prices || prices.length === 0) {
      return {
        events: null,
        sourceKind: "preserve-existing",
        authoritativeSource: null,
        marketDiagnostics,
      };
    }
    sourceKind = "market";
  }

  if (prices && replayWindow) {
    prices = prices.filter((point) => timestampInReplayWindow(point.timestamp, replayWindow));
  }

  const extractedEvents = extractDepegEvents(
    prices,
    getPegRef,
    pegType,
    supplyByDate,
    fxRates,
    buildPriceReasonablenessOptions({
      navToken: meta.flags.navToken,
      commodityOunces: meta.commodityOunces,
    }),
  );
  return {
    events: replayWindow
      ? extractedEvents.filter((event) => eventOverlapsReplayWindow(event, replayWindow))
      : extractedEvents,
    sourceKind,
    authoritativeSource: authoritativeHistory.matched ? authoritativeHistory.source : null,
    marketDiagnostics,
  };
}

export function parseSupplyData(tokens: SupplyPoint[]): SupplySnapshot[] {
  const map = new Map<number, number>();
  for (const point of tokens) {
    const ts = parseInt(point.date, 10);
    if (isNaN(ts)) continue;
    const supply = sumPegBuckets(point.circulating);
    map.set(ts, supply);
  }
  return Array.from(map.entries())
    .map(([ts, supply]) => ({ ts, supply }))
    .sort((a, b) => a.ts - b.ts);
}

export function findNearestSupply(supplyByDate: SupplySnapshot[], timestamp: number): number | null {
  if (supplyByDate.length === 0) return null;
  const nearest = binarySearchNearest(supplyByDate, timestamp, (s) => s.ts);
  return nearest?.supply ?? null;
}

export function extractDepegEvents(
  prices: PricePoint[],
  getPegRef: (timestamp: number) => number,
  pegType: string,
  supplyByDate: SupplySnapshot[],
  fxRates?: Record<string, number>,
  priceValidationOpts?: PriceReasonablenessOptions,
): BackfillEvent[] {
  const threshold = getDepegThresholdBps(pegType);
  const events: BackfillEvent[] = [];
  let current: BackfillEvent | null = null;
  const validationContext = buildPriceValidationContext({
    pegType,
    navToken: priceValidationOpts?.navToken,
    commodityOunces: priceValidationOpts?.commodityOunces,
  });

  // Pending state for large-cap confirmation (mirrors live pending → confirm flow)
  let pending: {
    direction: string;
    count: number;
    firstTs: number;
    lastTs: number;
    peakBps: number;
    startPrice: number;
    peakPrice: number;
    pegRef: number;
  } | null = null;

  /** Promote pending to an active event */
  function promotePending(): void {
    if (!pending) return;
    current = {
      pegType,
      direction: pending.direction,
      peakDeviationBps: pending.peakBps,
      startedAt: pending.firstTs,
      endedAt: null,
      startPrice: pending.startPrice,
      peakPrice: pending.peakPrice,
      recoveryPrice: null,
      pegRef: pending.pegRef,
    };
    pending = null;
  }

  for (const point of prices) {
    const { timestamp, price } = point;
    if (price <= 0) continue;

    if (supplyByDate.length > 0) {
      const supply = findNearestSupply(supplyByDate, timestamp);
      if (supply !== null && supply < 1_000_000) continue;
    }

    const pegRef = getPegRef(timestamp);
    if (pegRef <= 0) continue;
    const decision = validatePriceCandidateAgainstReference(price, validationContext, "historical_backfill", {
      price: pegRef,
      type: fxRates ? "fresh" : "none",
    });
    if (!decision.accepted) continue;

    const bps = Math.round((price / pegRef - 1) * 10000);
    const absBps = Math.abs(bps);
    const direction = bps >= 0 ? "above" : "below";

    // Determine if this coin is large-cap at this point in time
    const supply = findNearestSupply(supplyByDate, timestamp);
    const isLargeCap = supply !== null && supply >= DEPEG_CONFIRMATION_SUPPLY_THRESHOLD;

    if (absBps >= threshold) {
      if (current) {
        if (current.direction !== direction) {
          // Direction change: close current event, fall through to "no event" path below
          current.endedAt = timestamp;
          current.recoveryPrice = price;
          events.push(current);
          current = null;
          // fall through — will be handled as "no active event" below
        } else {
          // Same direction: update peak, continue
          if (absBps > Math.abs(current.peakDeviationBps)) {
            current.peakDeviationBps = bps;
            current.peakPrice = price;
          }
          continue;
        }
      }

      // No active event — decide whether to open immediately or require confirmation
      if (!isLargeCap) {
        // Small cap: instant event (existing behavior)
        current = {
          pegType,
          direction,
          peakDeviationBps: bps,
          startedAt: timestamp,
          endedAt: null,
          startPrice: price,
          peakPrice: price,
          recoveryPrice: null,
          pegRef,
        };
        pending = null;
      } else {
        // Large cap: require consecutive confirmation points
        if (!pending || pending.direction !== direction || timestamp - pending.lastTs > BACKFILL_PENDING_MAX_GAP_SEC) {
          // Start new pending
          pending = {
            direction,
            count: 1,
            firstTs: timestamp,
            lastTs: timestamp,
            peakBps: bps,
            startPrice: price,
            peakPrice: price,
            pegRef,
          };
        } else {
          // Continue pending
          pending.count++;
          pending.lastTs = timestamp;
          if (absBps > Math.abs(pending.peakBps)) {
            pending.peakBps = bps;
            pending.peakPrice = price;
          }
          if (pending.count >= BACKFILL_MIN_CONFIRM_POINTS) {
            promotePending();
          }
        }
      }
    } else {
      // Below threshold
      if (current) {
        current.endedAt = timestamp;
        current.recoveryPrice = price;
        events.push(current);
        current = null;
      }
      // Discard pending — recovered before confirmation
      pending = null;
    }
  }

  // Close any remaining active event
  if (current) {
    const lastTs = prices[prices.length - 1].timestamp;
    const now = Math.floor(Date.now() / 1000);
    if (now - lastTs > 7 * DAY_SECONDS) {
      current.endedAt = lastTs;
    }
    events.push(current);
  }
  // Discard any unconfirmed pending at end of series

  return events;
}
