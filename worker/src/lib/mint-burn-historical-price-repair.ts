import { TRACKED_META_BY_ID } from "@shared/lib/stablecoins/registry";
import { DAY_SECONDS } from "@shared/lib/time-constants";
import type { StablecoinMeta } from "@shared/types/core";
import { batchExecute, buildInClause } from "./db";
import { cgHeaders, cgUrl } from "./coingecko";
import { DEFILLAMA_COINS, USER_AGENT } from "./constants";
import { fetchJsonWithRetry } from "./fetch-retry";
import { buildPriceValidationContext, validatePriceCandidate } from "./price-validation";
import { recalcAffectedHours } from "./mint-burn-pipeline/persistence";
import type { MintBurnAffectedHour } from "./mint-burn-pipeline/types";

export const DEFAULT_HISTORICAL_MINT_PRICE_REPAIR_LIMIT = 100;
export const MAX_HISTORICAL_MINT_PRICE_REPAIR_LIMIT = 500;

const COINGECKO_SOURCE = "repair:coingecko-market-chart-event-day";
const DEFILLAMA_GECKO_SOURCE = "repair:defillama-gecko-chart-event-day";
const DEFILLAMA_CONTRACT_SOURCE = "repair:defillama-contract-chart-event-day";
const SUPPLY_HISTORY_SOURCE = "repair:supply-history-event-day";
const DEFILLAMA_CHART_MAX_SPAN_DAYS = 800;
const DEFILLAMA_CHART_MAX_WINDOWS_PER_SOURCE = 8;

interface MintBurnHistoricalRepairRow {
  id: string;
  stablecoin_id: string;
  chain_id: string;
  amount: number;
  timestamp: number;
  price_repair_status: "pending_aggregate" | "recovered" | "irreducible" | null;
}

export interface HistoricalPricePoint {
  timestamp: number;
  price: number;
}

export interface HistoricalPriceSeriesResult {
  source: string;
  status: "available" | "empty" | "unavailable";
  points: HistoricalPricePoint[];
  detail?: string;
}

export interface HistoricalMintPriceResolution {
  price: number;
  priceTimestamp: number;
  priceSource: string;
}

type HistoricalMintPriceResolutionOutcome =
  | {
      resolution: HistoricalMintPriceResolution;
      disposition: "recover";
      reason: null;
    }
  | {
      resolution: null;
      disposition: "irreducible" | "retry";
      reason: string;
    };

export interface HistoricalMintPriceRepairDisposition {
  eventId: string;
  stablecoinId: string;
  chainId: string;
  timestamp: number;
  disposition: "recover" | "irreducible" | "retry";
  price: number | null;
  priceTimestamp: number | null;
  priceSource: string | null;
  reason: string | null;
}

export interface HistoricalMintPriceRepairBacklog {
  unclassified: number;
  irreducible: number;
  pendingAggregate: number;
  totalNullUsd: number;
}

export interface HistoricalMintPriceRepairResult {
  dryRun: boolean;
  limit: number;
  selected: number;
  recovered: number;
  classifiedIrreducible: number;
  deferredForRetry: number;
  aggregateCoinsRebuilt: string[];
  aggregateVerificationPassed: boolean | null;
  dispositions: HistoricalMintPriceRepairDisposition[];
  backlog: HistoricalMintPriceRepairBacklog;
}

export interface HistoricalMintPriceRepairOptions {
  dryRun: boolean;
  limit?: number;
  stablecoinId?: string | null;
  retryIrreducible?: boolean;
  coingeckoApiKey?: string | null;
  operatorRunId?: string | null;
  timeTravelBookmark?: string | null;
  nowSec?: number;
  sourceLoader?: HistoricalMintPriceSourceLoader;
}

export interface HistoricalMintPriceSourceLoader {
  loadCoinGecko(input: {
    meta: StablecoinMeta;
    startSec: number;
    endSec: number;
    coingeckoApiKey: string | null;
  }): Promise<HistoricalPriceSeriesResult>;
  loadDefiLlama(input: {
    coinId: string;
    source: string;
    startSec: number;
    endSec: number;
  }): Promise<HistoricalPriceSeriesResult>;
}

interface CoinRepairContext {
  meta: StablecoinMeta | null;
  events: MintBurnHistoricalRepairRow[];
  supplyHistory: Map<number, number>;
  sourceResults: HistoricalPriceSeriesResult[];
}

function normalizePricePoints(points: unknown): HistoricalPricePoint[] {
  if (!Array.isArray(points)) return [];
  const normalized: HistoricalPricePoint[] = [];
  for (const point of points) {
    if (!Array.isArray(point) || point.length < 2) continue;
    const timestampMs = point[0];
    const price = point[1];
    if (
      typeof timestampMs !== "number" ||
      !Number.isFinite(timestampMs) ||
      typeof price !== "number" ||
      !Number.isFinite(price) ||
      price <= 0
    ) {
      continue;
    }
    normalized.push({ timestamp: Math.floor(timestampMs / 1000), price });
  }
  return normalized.sort((left, right) => left.timestamp - right.timestamp);
}

function normalizeDefiLlamaPoints(points: unknown): HistoricalPricePoint[] {
  if (!Array.isArray(points)) return [];
  const normalized: HistoricalPricePoint[] = [];
  for (const point of points) {
    if (!point || typeof point !== "object") continue;
    const timestamp = Reflect.get(point, "timestamp");
    const price = Reflect.get(point, "price");
    if (
      typeof timestamp !== "number" ||
      !Number.isFinite(timestamp) ||
      typeof price !== "number" ||
      !Number.isFinite(price) ||
      price <= 0
    ) {
      continue;
    }
    normalized.push({ timestamp: Math.floor(timestamp), price });
  }
  return normalized.sort((left, right) => left.timestamp - right.timestamp);
}

interface DefiLlamaChartWindow {
  startSec: number;
  spanDays: number;
}

function buildDefiLlamaChartWindows(
  startSec: number,
  endSec: number,
): DefiLlamaChartWindow[] | null {
  if (!Number.isFinite(startSec) || !Number.isFinite(endSec) || endSec < startSec) return null;
  const requestedSpanDays = Math.max(1, Math.ceil((endSec - startSec) / DAY_SECONDS) + 1);
  const windowCount = Math.ceil(requestedSpanDays / DEFILLAMA_CHART_MAX_SPAN_DAYS);
  if (windowCount > DEFILLAMA_CHART_MAX_WINDOWS_PER_SOURCE) return null;

  const windows: DefiLlamaChartWindow[] = [];
  let coveredDays = 0;
  while (coveredDays < requestedSpanDays) {
    const spanDays = Math.min(
      DEFILLAMA_CHART_MAX_SPAN_DAYS,
      requestedSpanDays - coveredDays,
    );
    windows.push({
      startSec: startSec + coveredDays * DAY_SECONDS,
      spanDays,
    });
    coveredDays += spanDays;
  }
  return windows;
}

async function loadDefiLlamaChartWindow(input: {
  coinId: string;
  source: string;
  window: DefiLlamaChartWindow;
}): Promise<HistoricalPriceSeriesResult> {
  const result = await fetchJsonWithRetry<{ coins?: Record<string, { prices?: unknown }> }>(
    `${DEFILLAMA_COINS}/chart/${input.coinId}?start=${input.window.startSec}&span=${input.window.spanDays}&period=1d`,
    { headers: { "User-Agent": USER_AGENT } },
    1,
    { timeoutMs: 20_000, returnFinalResponse: true },
  );
  if (!result) {
    return { source: input.source, status: "unavailable", points: [], detail: "no-response" };
  }
  if (!result.response.ok) {
    const definitiveEmpty = result.response.status === 404;
    return {
      source: input.source,
      status: definitiveEmpty ? "empty" : "unavailable",
      points: [],
      detail: `http-${result.response.status}`,
    };
  }
  if (!result.body || typeof result.body !== "object") {
    return { source: input.source, status: "unavailable", points: [], detail: "invalid-payload" };
  }
  const points = normalizeDefiLlamaPoints(result.body.coins?.[input.coinId]?.prices);
  return { source: input.source, status: points.length > 0 ? "available" : "empty", points };
}

export const productionHistoricalMintPriceSourceLoader: HistoricalMintPriceSourceLoader = {
  async loadCoinGecko({ meta, startSec, endSec, coingeckoApiKey }) {
    const source = meta.geckoId ? `${COINGECKO_SOURCE}:${meta.geckoId}` : COINGECKO_SOURCE;
    if (!meta.geckoId) {
      return { source, status: "empty", points: [], detail: "missing-gecko-id" };
    }
    const result = await fetchJsonWithRetry<{ prices?: unknown }>(
      cgUrl(
        `/coins/${meta.geckoId}/market_chart/range?vs_currency=usd&from=${startSec}&to=${endSec}&precision=full`,
        coingeckoApiKey,
      ),
      { headers: cgHeaders({ "User-Agent": USER_AGENT }, coingeckoApiKey) },
      2,
      { timeoutMs: 30_000, returnFinalResponse: true },
    );
    if (!result) {
      return { source, status: "unavailable", points: [], detail: "no-response" };
    }
    if (!result.response.ok) {
      const definitiveEmpty = result.response.status === 404;
      return {
        source,
        status: definitiveEmpty ? "empty" : "unavailable",
        points: [],
        detail: `http-${result.response.status}`,
      };
    }
    if (!result.body || typeof result.body !== "object") {
      return { source, status: "unavailable", points: [], detail: "invalid-payload" };
    }
    const points = normalizePricePoints(result.body.prices);
    return {
      source,
      status: points.length > 0 ? "available" : "empty",
      points,
    };
  },

  async loadDefiLlama({ coinId, source, startSec, endSec }) {
    const windows = buildDefiLlamaChartWindows(startSec, endSec);
    if (!windows) {
      return {
        source,
        status: "unavailable",
        points: [],
        detail: `range-exceeds-window-budget:${DEFILLAMA_CHART_MAX_WINDOWS_PER_SOURCE}x${DEFILLAMA_CHART_MAX_SPAN_DAYS}d`,
      };
    }

    const points: HistoricalPricePoint[] = [];
    const unavailableDetails: string[] = [];
    for (const window of windows) {
      const windowResult = await loadDefiLlamaChartWindow({ coinId, source, window });
      points.push(...windowResult.points);
      if (windowResult.status === "unavailable") {
        unavailableDetails.push(`${window.startSec}:${windowResult.detail ?? "unavailable"}`);
      }
    }
    points.sort((left, right) => left.timestamp - right.timestamp);
    if (unavailableDetails.length > 0) {
      return {
        source,
        status: "unavailable",
        points,
        detail: unavailableDetails.join(",").slice(0, 500),
      };
    }
    return { source, status: points.length > 0 ? "available" : "empty", points };
  },
};

function eventDay(timestamp: number): number {
  return Math.floor(timestamp / DAY_SECONDS) * DAY_SECONDS;
}

function isValidHistoricalPrice(meta: StablecoinMeta, price: number): boolean {
  return validatePriceCandidate(price, buildPriceValidationContext({ stablecoinId: meta.id }), "historical_backfill")
    .accepted;
}

function selectNearestEventDayPrice(
  meta: StablecoinMeta,
  eventTimestamp: number,
  series: HistoricalPriceSeriesResult,
): HistoricalMintPriceResolution | null {
  const dayStart = eventDay(eventTimestamp);
  const dayEnd = dayStart + DAY_SECONDS;
  const candidates = series.points.filter(
    (point) => point.timestamp >= dayStart && point.timestamp < dayEnd && isValidHistoricalPrice(meta, point.price),
  );
  if (candidates.length === 0) return null;
  const nearest = candidates.reduce((best, candidate) => {
    const bestDelta = Math.abs(best.timestamp - eventTimestamp);
    const candidateDelta = Math.abs(candidate.timestamp - eventTimestamp);
    if (candidateDelta !== bestDelta) return candidateDelta < bestDelta ? candidate : best;
    return candidate.timestamp < best.timestamp ? candidate : best;
  });
  return {
    price: nearest.price,
    priceTimestamp: nearest.timestamp,
    priceSource: series.source,
  };
}

export function resolveHistoricalMintPrice(input: {
  meta: StablecoinMeta;
  eventTimestamp: number;
  supplyHistoryPrice?: number | null;
  sourceResults: HistoricalPriceSeriesResult[];
}): HistoricalMintPriceResolutionOutcome {
  const { meta, eventTimestamp, supplyHistoryPrice, sourceResults } = input;
  if (typeof supplyHistoryPrice === "number" && isValidHistoricalPrice(meta, supplyHistoryPrice)) {
    return {
      resolution: {
        price: supplyHistoryPrice,
        priceTimestamp: eventDay(eventTimestamp),
        priceSource: SUPPLY_HISTORY_SOURCE,
      },
      disposition: "recover",
      reason: null,
    };
  }

  for (const series of sourceResults) {
    const resolution = selectNearestEventDayPrice(meta, eventTimestamp, series);
    if (resolution) {
      return { resolution, disposition: "recover", reason: null };
    }
  }

  if (sourceResults.some((result) => result.status === "unavailable")) {
    const unavailable = sourceResults
      .filter((result) => result.status === "unavailable")
      .map((result) => `${result.source}:${result.detail ?? "unavailable"}`)
      .join(",");
    return {
      resolution: null,
      disposition: "retry",
      reason: `event-day-source-temporarily-unavailable:${unavailable}`,
    };
  }

  const attempted = sourceResults.map((result) => result.source).join(",") || "none-configured";
  return {
    resolution: null,
    disposition: "irreducible",
    reason: `no-valid-event-day-price:${attempted}`,
  };
}

function normalizeLimit(limit: number | undefined): number {
  if (limit == null) return DEFAULT_HISTORICAL_MINT_PRICE_REPAIR_LIMIT;
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_HISTORICAL_MINT_PRICE_REPAIR_LIMIT) {
    throw new Error(`limit must be an integer from 1 to ${MAX_HISTORICAL_MINT_PRICE_REPAIR_LIMIT}`);
  }
  return limit;
}

async function loadRepairRows(
  db: D1Database,
  options: HistoricalMintPriceRepairOptions,
  limit: number,
): Promise<MintBurnHistoricalRepairRow[]> {
  const stablecoinFilter = options.stablecoinId ? "AND stablecoin_id = ?" : "";
  const retryFilter = options.retryIrreducible
    ? "AND (price_repair_status IS NULL OR price_repair_status = 'irreducible')"
    : "AND price_repair_status IS NULL";
  const binds: unknown[] = [];
  if (options.stablecoinId) binds.push(options.stablecoinId);
  binds.push(limit);
  const result = await db
    .prepare(
      `SELECT id, stablecoin_id, chain_id, amount, timestamp, price_repair_status
       FROM mint_burn_events
       WHERE amount_usd IS NULL
         ${retryFilter}
         ${stablecoinFilter}
       ORDER BY price_repair_attempted_at ASC, timestamp ASC, id ASC
       LIMIT ?`,
    )
    .bind(...binds)
    .all<MintBurnHistoricalRepairRow>();
  return result.results ?? [];
}

async function loadSupplyHistory(
  db: D1Database,
  rows: MintBurnHistoricalRepairRow[],
): Promise<Map<string, Map<number, number>>> {
  const ids = [...new Set(rows.map((row) => row.stablecoin_id))];
  const result = new Map<string, Map<number, number>>();
  if (ids.length === 0) return result;
  const minDay = Math.min(...rows.map((row) => eventDay(row.timestamp)));
  const maxDay = Math.max(...rows.map((row) => eventDay(row.timestamp)));
  const inClause = buildInClause(ids);
  const history = await db
    .prepare(
      `SELECT stablecoin_id, snapshot_date, price
       FROM supply_history
       WHERE stablecoin_id IN (${inClause.sql})
         AND snapshot_date >= ?
         AND snapshot_date <= ?
         AND price IS NOT NULL
       ORDER BY stablecoin_id ASC, snapshot_date ASC`,
    )
    .bind(...inClause.binds, minDay, maxDay)
    .all<{ stablecoin_id: string; snapshot_date: number; price: number }>();
  for (const row of history.results ?? []) {
    const byDay = result.get(row.stablecoin_id) ?? new Map<number, number>();
    byDay.set(row.snapshot_date, row.price);
    result.set(row.stablecoin_id, byDay);
  }
  return result;
}

function contractCoinIds(meta: StablecoinMeta, chainIds: Set<string>): string[] {
  const ids = new Set<string>();
  for (const contract of meta.contracts ?? []) {
    if (!chainIds.has(contract.chain)) continue;
    const address = contract.address.trim();
    if (!address || !address.startsWith("0x")) continue;
    ids.add(`${contract.chain}:${address}`);
  }
  return [...ids];
}

async function buildCoinRepairContexts(
  db: D1Database,
  rows: MintBurnHistoricalRepairRow[],
  options: HistoricalMintPriceRepairOptions,
): Promise<Map<string, CoinRepairContext>> {
  const supplyHistory = await loadSupplyHistory(db, rows);
  const contexts = new Map<string, CoinRepairContext>();
  for (const event of rows) {
    const existing = contexts.get(event.stablecoin_id);
    if (existing) {
      existing.events.push(event);
      continue;
    }
    contexts.set(event.stablecoin_id, {
      meta: TRACKED_META_BY_ID.get(event.stablecoin_id) ?? null,
      events: [event],
      supplyHistory: supplyHistory.get(event.stablecoin_id) ?? new Map(),
      sourceResults: [],
    });
  }

  const sourceLoader = options.sourceLoader ?? productionHistoricalMintPriceSourceLoader;
  for (const context of contexts.values()) {
    if (!context.meta) continue;
    const unresolved = context.events.filter((event) => context.supplyHistory.get(eventDay(event.timestamp)) == null);
    if (unresolved.length === 0) continue;
    let remaining = unresolved;

    const removeResolvedEvents = (): void => {
      remaining = remaining.filter((event) =>
        context.sourceResults.every(
          (series) => selectNearestEventDayPrice(context.meta!, event.timestamp, series) == null,
        ),
      );
    };

    const sourceRange = (): { startSec: number; endSec: number } => ({
      startSec: Math.min(...remaining.map((event) => eventDay(event.timestamp))),
      endSec: Math.max(...remaining.map((event) => eventDay(event.timestamp))) + DAY_SECONDS,
    });

    if (context.meta.geckoId) {
      const coinGeckoRange = sourceRange();
      context.sourceResults.push(
        await sourceLoader.loadCoinGecko({
          meta: context.meta,
          ...coinGeckoRange,
          coingeckoApiKey: options.coingeckoApiKey ?? null,
        }),
      );
      removeResolvedEvents();
      if (remaining.length > 0) {
        const defiLlamaRange = sourceRange();
        context.sourceResults.push(
          await sourceLoader.loadDefiLlama({
            coinId: `coingecko:${context.meta.geckoId}`,
            source: `${DEFILLAMA_GECKO_SOURCE}:${context.meta.geckoId}`,
            ...defiLlamaRange,
          }),
        );
        removeResolvedEvents();
      }
    }

    if (remaining.length === 0) continue;
    const chainIds = new Set(remaining.map((event) => event.chain_id));
    for (const coinId of contractCoinIds(context.meta, chainIds)) {
      const contractRange = sourceRange();
      context.sourceResults.push(
        await sourceLoader.loadDefiLlama({
          coinId,
          source: `${DEFILLAMA_CONTRACT_SOURCE}:${coinId}`,
          ...contractRange,
        }),
      );
      removeResolvedEvents();
      if (remaining.length === 0) break;
    }
  }
  return contexts;
}

async function loadBacklog(db: D1Database): Promise<HistoricalMintPriceRepairBacklog> {
  const row = await db
    .prepare(
      `SELECT
         SUM(CASE WHEN amount_usd IS NULL AND price_repair_status IS NULL THEN 1 ELSE 0 END) AS unclassified,
         SUM(CASE WHEN amount_usd IS NULL AND price_repair_status = 'irreducible' THEN 1 ELSE 0 END) AS irreducible,
         SUM(CASE WHEN price_repair_status = 'pending_aggregate' THEN 1 ELSE 0 END) AS pending_aggregate,
         SUM(CASE WHEN amount_usd IS NULL THEN 1 ELSE 0 END) AS total_null_usd
       FROM mint_burn_events
       WHERE amount_usd IS NULL OR price_repair_status = 'pending_aggregate'`,
    )
    .first<{
      unclassified: number | null;
      irreducible: number | null;
      pending_aggregate: number | null;
      total_null_usd: number | null;
    }>();
  return {
    unclassified: row?.unclassified ?? 0,
    irreducible: row?.irreducible ?? 0,
    pendingAggregate: row?.pending_aggregate ?? 0,
    totalNullUsd: row?.total_null_usd ?? 0,
  };
}

async function loadPendingAggregateHours(
  db: D1Database,
  stablecoinIds?: string[],
): Promise<MintBurnAffectedHour[]> {
  const ids = [...new Set(stablecoinIds ?? [])].sort();
  if (stablecoinIds && ids.length === 0) return [];
  const filter = ids.length > 0 ? buildInClause(ids) : null;
  const rows = await db
    .prepare(
      `SELECT
         stablecoin_id,
         chain_id,
         (timestamp / 3600) * 3600 AS hour_ts
       FROM mint_burn_events
       WHERE price_repair_status = 'pending_aggregate'
         ${filter ? `AND stablecoin_id IN (${filter.sql})` : ""}
       GROUP BY stablecoin_id, chain_id, hour_ts
       ORDER BY stablecoin_id ASC, chain_id ASC, hour_ts ASC
       LIMIT 500`,
    )
    .bind(...(filter?.binds ?? []))
    .all<{ stablecoin_id: string; chain_id: string; hour_ts: number }>();
  return (rows.results ?? []).map((row) => ({
    stablecoinId: row.stablecoin_id,
    chainId: row.chain_id,
    hourTs: row.hour_ts,
  }));
}

async function verifyHourlyAggregateForHour(
  db: D1Database,
  hour: MintBurnAffectedHour,
): Promise<void> {
  const row = await db
    .prepare(
      `WITH expected AS (
         SELECT
           SUM(CASE WHEN direction = 'mint' AND flow_type = 'standard' THEN 1 ELSE 0 END) AS mint_count,
           SUM(CASE WHEN direction = 'burn' AND burn_type = 'effective_burn' AND flow_type = 'standard' THEN 1 ELSE 0 END) AS burn_count,
           COALESCE(SUM(CASE WHEN direction = 'mint' AND flow_type = 'standard' THEN amount_usd ELSE 0 END), 0) AS mint_volume_usd,
           COALESCE(SUM(CASE WHEN direction = 'burn' AND burn_type = 'effective_burn' AND flow_type = 'standard' THEN amount_usd ELSE 0 END), 0) AS burn_volume_usd,
           COALESCE(SUM(CASE
             WHEN direction = 'mint' AND flow_type = 'standard' THEN amount_usd
             WHEN direction = 'burn' AND burn_type = 'effective_burn' AND flow_type = 'standard' THEN -amount_usd
             ELSE 0
           END), 0) AS net_flow_usd
         FROM mint_burn_events
         WHERE stablecoin_id = ?
           AND chain_id = ?
           AND timestamp >= ?
           AND timestamp < ?
       )
       SELECT COUNT(*) AS mismatch_count
         FROM expected e
         LEFT JOIN mint_burn_hourly a
           ON a.stablecoin_id = ?
          AND a.chain_id = ?
          AND a.hour_ts = ?
        WHERE a.stablecoin_id IS NULL
           OR a.mint_count != e.mint_count
           OR a.burn_count != e.burn_count
           OR ABS(a.mint_volume_usd - e.mint_volume_usd) > MAX(0.000001, ABS(e.mint_volume_usd) * 0.000000001)
           OR ABS(a.burn_volume_usd - e.burn_volume_usd) > MAX(0.000001, ABS(e.burn_volume_usd) * 0.000000001)
           OR ABS(a.net_flow_usd - e.net_flow_usd) > MAX(0.000001, ABS(e.net_flow_usd) * 0.000000001)`,
    )
    .bind(
      hour.stablecoinId,
      hour.chainId,
      hour.hourTs,
      hour.hourTs + 3600,
      hour.stablecoinId,
      hour.chainId,
      hour.hourTs,
    )
    .first<{ mismatch_count: number }>();
  if ((row?.mismatch_count ?? 0) !== 0) {
    throw new Error(
      `mint/burn aggregate verification failed for ${hour.stablecoinId}/${hour.chainId}/${hour.hourTs}`,
    );
  }
}

async function rebuildAndFinalizeAggregates(
  db: D1Database,
  hours: MintBurnAffectedHour[],
): Promise<string[]> {
  if (hours.length === 0) return [];
  const affectedHours = new Map<string, MintBurnAffectedHour>();
  for (const hour of hours) {
    affectedHours.set(`${hour.stablecoinId}-${hour.chainId}-${hour.hourTs}`, hour);
  }
  await recalcAffectedHours(db, affectedHours);
  for (const hour of affectedHours.values()) {
    await verifyHourlyAggregateForHour(db, hour);
  }
  await batchExecute(
    db,
    [...affectedHours.values()].map((hour) =>
      db
        .prepare(
          `UPDATE mint_burn_events
           SET price_repair_status = 'recovered', price_repair_reason = NULL
           WHERE stablecoin_id = ?
             AND chain_id = ?
             AND timestamp >= ?
             AND timestamp < ?
             AND price_repair_status = 'pending_aggregate'
             AND amount_usd IS NOT NULL`,
        )
        .bind(hour.stablecoinId, hour.chainId, hour.hourTs, hour.hourTs + 3600),
    ),
  );
  return [...new Set([...affectedHours.values()].map((hour) => hour.stablecoinId))].sort();
}

export async function repairHistoricalMintBurnPrices(
  db: D1Database,
  options: HistoricalMintPriceRepairOptions,
): Promise<HistoricalMintPriceRepairResult> {
  const limit = normalizeLimit(options.limit);
  if (!options.dryRun && (!options.operatorRunId?.trim() || !options.timeTravelBookmark?.trim())) {
    throw new Error("operatorRunId and timeTravelBookmark must be provided for mutation");
  }
  if (options.stablecoinId && !TRACKED_META_BY_ID.has(options.stablecoinId)) {
    throw new Error(`unknown stablecoinId: ${options.stablecoinId}`);
  }
  const nowSec = options.nowSec ?? Math.floor(Date.now() / 1000);
  const existingPendingAggregateHours = await loadPendingAggregateHours(db);
  const existingPendingAggregateCoins = [
    ...new Set(existingPendingAggregateHours.map((hour) => hour.stablecoinId)),
  ].sort();
  let aggregateCoinsRebuilt: string[] = [];
  if (!options.dryRun && existingPendingAggregateHours.length > 0) {
    aggregateCoinsRebuilt = await rebuildAndFinalizeAggregates(db, existingPendingAggregateHours);
  }

  const rows = await loadRepairRows(db, options, limit);
  const contexts = await buildCoinRepairContexts(db, rows, options);
  const dispositions: HistoricalMintPriceRepairDisposition[] = [];
  for (const row of rows) {
    const context = contexts.get(row.stablecoin_id);
    if (!context?.meta) {
      dispositions.push({
        eventId: row.id,
        stablecoinId: row.stablecoin_id,
        chainId: row.chain_id,
        timestamp: row.timestamp,
        disposition: "irreducible",
        price: null,
        priceTimestamp: null,
        priceSource: null,
        reason: "stablecoin-metadata-unavailable",
      });
      continue;
    }
    const outcome = resolveHistoricalMintPrice({
      meta: context.meta,
      eventTimestamp: row.timestamp,
      supplyHistoryPrice: context.supplyHistory.get(eventDay(row.timestamp)),
      sourceResults: context.sourceResults,
    });
    dispositions.push({
      eventId: row.id,
      stablecoinId: row.stablecoin_id,
      chainId: row.chain_id,
      timestamp: row.timestamp,
      disposition: outcome.disposition,
      price: outcome.resolution?.price ?? null,
      priceTimestamp: outcome.resolution?.priceTimestamp ?? null,
      priceSource: outcome.resolution?.priceSource ?? null,
      reason: outcome.reason,
    });
  }

  if (!options.dryRun && dispositions.length > 0) {
    const statements: D1PreparedStatement[] = [];
    for (const disposition of dispositions) {
      const row = rows.find((candidate) => candidate.id === disposition.eventId);
      if (!row) continue;
      if (disposition.disposition === "recover") {
        statements.push(
          db
            .prepare(
              `UPDATE mint_burn_events
               SET amount_usd = ?,
                   price_used = ?,
                   price_timestamp = ?,
                   price_source = ?,
                   price_repair_status = 'pending_aggregate',
                   price_repair_reason = NULL,
                   price_repair_attempted_at = ?,
                   price_repair_run_id = ?,
                   price_repair_bookmark = ?
               WHERE id = ? AND amount_usd IS NULL`,
            )
            .bind(
              row.amount * (disposition.price as number),
              disposition.price,
              disposition.priceTimestamp,
              disposition.priceSource,
              nowSec,
              options.operatorRunId ?? null,
              options.timeTravelBookmark ?? null,
              disposition.eventId,
            ),
        );
      } else if (disposition.disposition === "irreducible") {
        statements.push(
          db
            .prepare(
              `UPDATE mint_burn_events
               SET price_repair_status = 'irreducible',
                   price_repair_reason = ?,
                   price_repair_attempted_at = ?,
                   price_repair_run_id = ?,
                   price_repair_bookmark = ?
               WHERE id = ? AND amount_usd IS NULL`,
            )
            .bind(
              disposition.reason,
              nowSec,
              options.operatorRunId ?? null,
              options.timeTravelBookmark ?? null,
              disposition.eventId,
            ),
        );
      } else {
        statements.push(
          db
            .prepare(
              `UPDATE mint_burn_events
               SET price_repair_reason = ?,
                   price_repair_attempted_at = ?,
                   price_repair_run_id = ?,
                   price_repair_bookmark = ?
               WHERE id = ? AND amount_usd IS NULL AND price_repair_status IS NULL`,
            )
            .bind(
              disposition.reason,
              nowSec,
              options.operatorRunId ?? null,
              options.timeTravelBookmark ?? null,
              disposition.eventId,
            ),
        );
      }
    }
    await batchExecute(db, statements);

    const newlyRecoveredCoins = dispositions
      .filter((disposition) => disposition.disposition === "recover")
      .map((disposition) => disposition.stablecoinId);
    const newlyRecoveredHours = await loadPendingAggregateHours(db, newlyRecoveredCoins);
    const rebuilt = await rebuildAndFinalizeAggregates(db, newlyRecoveredHours);
    aggregateCoinsRebuilt = [...new Set([...aggregateCoinsRebuilt, ...rebuilt])].sort();
  }

  const backlog = await loadBacklog(db);
  return {
    dryRun: options.dryRun,
    limit,
    selected: dispositions.length,
    recovered: dispositions.filter((entry) => entry.disposition === "recover").length,
    classifiedIrreducible: dispositions.filter((entry) => entry.disposition === "irreducible").length,
    deferredForRetry: dispositions.filter((entry) => entry.disposition === "retry").length,
    aggregateCoinsRebuilt: options.dryRun
      ? [
          ...new Set([
            ...existingPendingAggregateCoins,
            ...dispositions.filter((entry) => entry.disposition === "recover").map((entry) => entry.stablecoinId),
          ]),
        ].sort()
      : aggregateCoinsRebuilt,
    aggregateVerificationPassed: options.dryRun ? null : backlog.pendingAggregate === 0,
    dispositions,
    backlog,
  };
}
