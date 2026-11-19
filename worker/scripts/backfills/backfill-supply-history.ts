import { isDailyStockObservation } from "../../src/lib/dews/native-quantity";
import { logWorkerEventArgs } from "../../src/lib/structured-log";
import {
  SUPPLY_HISTORY_INSERT_MISSING_SQL,
  SUPPLY_HISTORY_UPSERT_SQL,
  writeSupplyHistoryBatch,
} from "../../src/lib/supply-history-db";
import { PSI_ELIGIBLE_STABLECOINS, PSI_ELIGIBLE_META_BY_ID } from "@shared/lib/psi-eligible";
import { DAY_SECONDS } from "@shared/lib/time-constants";
import { bucketUnixMillisecondsToUtcDay, bucketUnixSecondsToUtcDay } from "@shared/lib/time-buckets";
import { admitSupplyBuckets } from "@shared/lib/supply";
import { isAmbiguousSupplyPerimeterDay, isEarlierSupplyPerimeter, isKinesisWrapperSupplyCutoverActive } from "@shared/lib/supply-perimeter-changes";
import { isCommodityPeg } from "@shared/lib/filter-tags";
import { isDedicatedSingleTokenGoldProtocolSlug } from "@shared/lib/commodity-protocols";
import { toTokenUnits } from "@shared/lib/math";
import type { ContractDeployment } from "@shared/types/stablecoin-meta-primitives";
import type { SupplyObservationProvenance } from "@shared/types/supply";
import { isKinesisWrapperSupplyId, onchainSupplyProbeFamily } from "@shared/lib/onchain-supply-probe";
import { D1_BATCH_SIZE, DEFILLAMA_BASE, DEFILLAMA_API, DEFILLAMA_COINS, USER_AGENT } from "../../src/lib/constants";
import { chunkArray } from "@shared/lib/collections";
import { fetchCoinGeckoMarketHistory } from "../../src/lib/coingecko-market-history";
import type { ChainRpcConfig } from "../../src/lib/chain-registry";
import { encodeJsonCursor, parseIntParam, parseJsonCursorParam } from "../../src/lib/api-params";
import { jsonResponse } from "../../src/lib/api-response";
import { resolveMarketCap } from "../../src/lib/resolve-market-cap";
import { selectBackfillCoins } from "../../src/lib/backfill-query";
import { buildAdminJobSummary, noAdminTargetsResponse } from "../../src/lib/admin-job";
import { fetchJsonWithRetry } from "../../src/lib/fetch-retry";
import { rethrowIfAborted, throwIfAborted } from "../../src/lib/abort";
import {
  fetchEvmUint256AtBlock,
  resolveClosestBlockAtOrBeforeTimestamp,
  type EvmBlockSearchCache,
} from "../../src/lib/evm-rpc";
import { encodeBalanceOfCallData, TOTAL_SUPPLY_SELECTOR } from "../../src/lib/evm-selectors";
import {
  computeExcludedBalanceAdjustedSupplyRaw,
  getOnChainSupplyExclusionConfig,
} from "../../src/lib/onchain-supply-exclusions";
import { getPublicFallbackRpcUrls } from "../../src/lib/public-rpc-registry";
import { extractDefiLlamaCoinChartPrices } from "../../src/api/stablecoin-detail/shared";
import { fetchMarketBackfillPriceSeries, screenDailyPriceOutliers } from "../../src/lib/historical-market-prices";
import { parseOptionalDayWindow } from "../../src/lib/backfill-day-window";
import { findAsOfSnapshot, interpolateRateAtTimestamp, type TimestampedRatePoint } from "@shared/lib/rate-series";

const DEFAULT_BATCH_SIZE = 10;
const DEFAULT_BACKFILL_WINDOW_DAYS = 30;
const MAX_BACKFILL_WINDOW_DAYS = 90;
const HISTORICAL_ONCHAIN_TOTAL_SUPPLY_IDS = new Set([
  "autousd-auto-finance",
  "bd-basedollar",
  "eearn-ember",
]);
// Base Dollar documents direct $1 redemption, so its native supply may use the
// explicit par policy when no replay-safe historical market price exists.
const PAR_REDEEMABLE_USD_ASSET_IDS = new Set(["bd-basedollar"]);

function getParPolicyPrice(meta: (typeof PSI_ELIGIBLE_STABLECOINS)[number]): number | null {
  return meta.flags.pegCurrency === "USD" && PAR_REDEEMABLE_USD_ASSET_IDS.has(meta.id) ? 1 : null;
}

type SupplyBackfillMode = "insert-missing" | "overwrite" | "quantity-only" | "price-clock-only";
type SupplyWriteOptions = { mode: SupplyBackfillMode; dryRun: boolean };
const HISTORICAL_VALUATION_MAX_AGE_SEC = DAY_SECONDS - 1;

function pushSupplyUpsert(
  statements: D1PreparedStatement[],
  db: D1Database,
  stablecoinId: string,
  snapshotDate: number,
  circulating: number,
  price: number | null,
  quoteObservedAt: number | null,
  { mode, dryRun }: SupplyWriteOptions,
  quantity?: { native: number | null; nativeQuantityUnavailable?: boolean; valuationPrice: number | null; valuationAt: number | null; supplySource: string; stockObservedAt: number | undefined },
): void {
  const now = Math.floor(Date.now() / 1000);
  const priceObservedAt = quoteObservedAt != null && Number.isSafeInteger(quoteObservedAt) &&
    quoteObservedAt > 0 && quoteObservedAt <= now ? quoteObservedAt : null;
  const stockObservedAt = quantity?.stockObservedAt;
  const supplyObservedAt = stockObservedAt != null && isDailyStockObservation(stablecoinId, snapshotDate, stockObservedAt, now)
    ? stockObservedAt : null;
  const nativeQuantityUnavailable = quantity?.nativeQuantityUnavailable === true;
  const evidence: SupplyObservationProvenance | null = quantity &&
    (nativeQuantityUnavailable || (quantity.native != null && supplyObservedAt != null))
    ? { supplySource: quantity.supplySource, supplyObservedAt, supplyChainGuard: null } : null;
  if (evidence && nativeQuantityUnavailable) {
    evidence.nativeQuantityUnavailable = true;
    if (price != null) evidence.marketQuote = { price, observedAt: priceObservedAt };
  }
  const provenance = evidence == null ? null : JSON.stringify(evidence);
  if (mode === "price-clock-only") {
    if (nativeQuantityUnavailable || price == null || priceObservedAt == null) return;
    // A re-fetched quote and the retained valuation must identify the same price and instant.
    const match = `stablecoin_id = ? AND snapshot_date = ? AND price_observed_at IS NULL
      AND price = ? AND valuation_price_usd = ? AND valuation_observed_at_sec = ?`;
    const binds = [stablecoinId, snapshotDate, price, price, priceObservedAt];
    statements.push(dryRun
      ? db.prepare(`SELECT snapshot_date FROM supply_history WHERE ${match}`).bind(...binds)
      : db.prepare(`UPDATE supply_history SET price_observed_at = ? WHERE ${match}`).bind(priceObservedAt, ...binds));
    return;
  }
  if (mode === "quantity-only") {
    if (!provenance || quantity?.native == null || quantity.valuationAt == null || price == null || isEarlierSupplyPerimeter(stablecoinId, snapshotDate)) return;
    // Match the persisted valuation before attaching evidence to an existing row.
    const match = "stablecoin_id = ? AND snapshot_date = ? AND circulating_native IS NULL AND circulating_usd = ? AND price = ? AND (price_observed_at IS NULL OR price_observed_at = ?)" +
      " AND (supply_provenance IS NULL OR CASE WHEN json_valid(supply_provenance) THEN" +
      " json_extract(supply_provenance, '$.supplySource') = ? AND json_extract(supply_provenance, '$.supplyObservedAt') = ?" +
      " AND json_type(supply_provenance, '$.supplyChainGuard') = 'null' END)";
    const binds = [stablecoinId, snapshotDate, circulating, price, quantity.valuationAt, quantity.supplySource, stockObservedAt];
    if (isKinesisWrapperSupplyId(stablecoinId)) {
      // Equal price and quantity alone cannot identify a historical program row as wrapper stock.
      return;
    }
    statements.push(dryRun
      ? db.prepare(`SELECT snapshot_date FROM supply_history WHERE ${match}`).bind(...binds)
      : db.prepare(`UPDATE supply_history SET circulating_native = ?, valuation_price_usd = ?, valuation_observed_at_sec = ?, supply_provenance = COALESCE(supply_provenance, ?) WHERE ${match}`)
        .bind(quantity.native, quantity.valuationPrice, quantity.valuationAt, provenance, ...binds));
    return;
  }
  if (dryRun) {
    statements.push(mode === "overwrite"
      ? db.prepare("SELECT ? AS snapshot_date").bind(snapshotDate)
      : db.prepare("SELECT ? AS snapshot_date WHERE NOT EXISTS (SELECT 1 FROM supply_history WHERE stablecoin_id = ? AND snapshot_date = ?)")
        .bind(snapshotDate, stablecoinId, snapshotDate));
    return;
  }
  if (quantity || priceObservedAt != null) {
    const conflict = mode === "overwrite" ? "" : " ON CONFLICT (stablecoin_id, snapshot_date) DO NOTHING";
    const verb = mode === "overwrite" ? "INSERT OR REPLACE" : "INSERT";
    statements.push(db.prepare(
      `${verb} INTO supply_history (stablecoin_id, snapshot_date, circulating_usd, price,
        circulating_native, valuation_price_usd, valuation_observed_at_sec, supply_provenance, price_observed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)${conflict}`,
    ).bind(stablecoinId, snapshotDate, circulating, nativeQuantityUnavailable ? null : price,
      quantity?.native ?? null, quantity?.valuationPrice ?? null, quantity?.valuationAt ?? null,
      provenance, nativeQuantityUnavailable ? null : priceObservedAt));
    return;
  }
  statements.push(
    db
      .prepare(mode === "overwrite" ? SUPPLY_HISTORY_UPSERT_SQL : SUPPLY_HISTORY_INSERT_MISSING_SQL)
      .bind(stablecoinId, snapshotDate, circulating, price),
  );
}

async function countEligibleSupplyRows(db: D1Database, statements: D1PreparedStatement[]): Promise<number> {
  const dates = new Set<number>();
  for (const chunk of chunkArray(statements, D1_BATCH_SIZE)) {
    const results = await db.batch<{ snapshot_date: number }>(chunk);
    for (const { results: rows } of results) for (const row of rows ?? []) dates.add(row.snapshot_date);
  }
  return dates.size;
}

interface TokenEntry {
  date: number; // unix seconds
  totalCirculating?: Record<string, number>;
  circulating?: Record<string, number>;
  totalCirculatingUSD?: Record<string, number>;
}

interface StablecoinDetail {
  tokens?: TokenEntry[];
}

interface SupplyBackfillWindow {
  startDay: number | null;
  endDay: number | null;
}

interface SupplyBackfillContinuationCursor {
  nextStartDay: number;
  requestedStartDay: number | null;
  requestedEndDay: number;
  windowDays: number;
  dryRun?: boolean;
  mode?: SupplyBackfillMode;
}

interface ResolvedSupplyBackfillWindow extends SupplyBackfillWindow {
  requestedStartDay: number | null;
  requestedEndDay: number | null;
  windowDays: number | null;
  continuationCursor: string | null;
  done: boolean;
  dryRun: boolean;
  mode: SupplyBackfillMode;
}

type EvmBlockSearchCacheByChain = Map<string, EvmBlockSearchCache>;

function validateSupplyBackfillCursor(payload: unknown): SupplyBackfillContinuationCursor | null {
  if (payload == null || typeof payload !== "object" || Array.isArray(payload)) return null;
  const record = payload as Record<string, unknown>;
  const nextStartDay = record.nextStartDay;
  const requestedStartDay = record.requestedStartDay;
  const requestedEndDay = record.requestedEndDay;
  const windowDays = record.windowDays;
  const dryRun = record.dryRun;
  const mode = record.mode;
  if (typeof nextStartDay !== "number" || !Number.isSafeInteger(nextStartDay) || nextStartDay <= 0) return null;
  if (!(requestedStartDay === null || (typeof requestedStartDay === "number" && Number.isSafeInteger(requestedStartDay)))) return null;
  if (typeof requestedEndDay !== "number" || !Number.isSafeInteger(requestedEndDay) || requestedEndDay <= 0) return null;
  if (
    typeof windowDays !== "number" ||
    !Number.isSafeInteger(windowDays) ||
    windowDays <= 0 ||
    windowDays > MAX_BACKFILL_WINDOW_DAYS
  ) {
    return null;
  }
  if (dryRun !== undefined && typeof dryRun !== "boolean") return null;
  if (mode !== undefined && mode !== "insert-missing" && mode !== "overwrite" && mode !== "quantity-only" && mode !== "price-clock-only") return null;
  return {
    nextStartDay,
    requestedStartDay,
    requestedEndDay,
    windowDays,
    dryRun,
    mode,
  };
}

// Commodity tokens: use CoinGecko market_chart (historical market caps) as primary source.
// Protocol TVL from DefiLlama can diverge from token market cap (e.g. XAUT TVL includes
// multi-chain reserves that far exceed the token's market cap).

function selectSingleHistoricalEvmContract(contracts?: ContractDeployment[]): ContractDeployment | null {
  if (contracts?.length !== 1) return null;
  const [contract] = contracts;
  return onchainSupplyProbeFamily(contract) === "evm" ? contract : null;
}

function isWithinBackfillWindow(snapshotDate: number, window?: SupplyBackfillWindow): boolean {
  if (window?.startDay != null && snapshotDate < window.startDay) return false;
  if (window?.endDay != null && snapshotDate > window.endDay) return false;
  return true;
}

function backfillWindowToFetchRange(
  window: SupplyBackfillWindow,
  lookbackSec = 0,
): { startSec?: number | null; endSec?: number | null } | undefined {
  if (window.startDay == null && window.endDay == null) return undefined;
  return {
    startSec: window.startDay == null ? null : Math.max(0, window.startDay - lookbackSec),
    endSec: window.endDay != null ? window.endDay + DAY_SECONDS - 1 : null,
  };
}

function getLastCompletedUtcDay(nowSec = Math.floor(Date.now() / 1000)): number {
  return bucketUnixSecondsToUtcDay(nowSec - DAY_SECONDS);
}

/** CoinGecko milliseconds pairs minus isolated daily scale excursions. */
function screenCoinGeckoDailyPrices(prices: [number, number][]): [number, number][] {
  return screenDailyPriceOutliers(
    prices
      .filter(([ts, price]) => Number.isFinite(ts) && Number.isFinite(price) && price > 0)
      .map(([timestamp, price]) => ({ timestamp, price }))
      .sort((left, right) => left.timestamp - right.timestamp),
  ).prices.map((point) => [point.timestamp, point.price]);
}

type SupplyPricePoint = TimestampedRatePoint & { observedAt: number };

function normalizeCoinGeckoDailyPrices(prices: [number, number][]): SupplyPricePoint[] {
  const priceBySnapshotDate = new Map<number, SupplyPricePoint>();
  for (const [timestampMs, price] of prices) {
    if (!Number.isFinite(timestampMs) || !Number.isFinite(price) || price <= 0) continue;
    const snapshotDate = bucketUnixMillisecondsToUtcDay(timestampMs) / 1000;
    if (!priceBySnapshotDate.has(snapshotDate)) {
      priceBySnapshotDate.set(snapshotDate, { timestamp: snapshotDate, rate: price, observedAt: Math.floor(timestampMs / 1000) });
    }
  }

  return [...priceBySnapshotDate.values()].sort((a, b) => a.timestamp - b.timestamp);
}

function buildSupplyBackfillCursor(cursor: SupplyBackfillContinuationCursor): string {
  return encodeJsonCursor(cursor);
}

function resolveSupplyBackfillWindow(
  url: URL,
  dayWindow: SupplyBackfillWindow,
): ResolvedSupplyBackfillWindow | Response {
  const parsedWindowDays = parseIntParam(
    url.searchParams.get("windowDays"),
    DEFAULT_BACKFILL_WINDOW_DAYS,
    1,
    MAX_BACKFILL_WINDOW_DAYS,
    "windowDays",
    { rangePolicy: "reject" },
  );
  if (parsedWindowDays instanceof Response) return parsedWindowDays;

  const parsedCursor = parseJsonCursorParam(
    url.searchParams.get("cursor"),
    validateSupplyBackfillCursor,
    "Invalid cursor: malformed supply backfill cursor",
  );
  if (parsedCursor instanceof Response) return parsedCursor;

  const dryRun = parsedCursor?.dryRun === true || url.searchParams.get("dry-run") === "true";
  const mode = parsedCursor?.mode ?? (url.searchParams.get("price-clock-only") === "true" ? "price-clock-only"
    : url.searchParams.get("quantity-only") === "true" ? "quantity-only"
    : url.searchParams.get("overwrite") === "true" ? "overwrite" : "insert-missing");
  const lastCompletedDay = getLastCompletedUtcDay();
  const hasWindowingParam = parsedCursor != null ||
    url.searchParams.has("windowDays") ||
    dayWindow.startDay != null ||
    dayWindow.endDay != null;

  if (!hasWindowingParam) {
    return {
      startDay: null,
      endDay: null,
      requestedStartDay: null,
      requestedEndDay: null,
      windowDays: null,
      continuationCursor: null,
      done: true,
      dryRun,
      mode,
    };
  }

  const requestedStartDay = dayWindow.startDay ?? parsedCursor?.requestedStartDay ?? null;
  const requestedEndDay = Math.min(
    dayWindow.endDay ?? parsedCursor?.requestedEndDay ?? lastCompletedDay,
    lastCompletedDay,
  );
  const windowDays = url.searchParams.has("windowDays")
    ? parsedWindowDays
    : parsedCursor?.windowDays ?? parsedWindowDays;

  if (requestedStartDay != null && requestedStartDay > requestedEndDay) {
    return jsonResponse({ error: "Invalid cursor: requested range is exhausted" }, { status: 400 });
  }

  const cursorStart = parsedCursor?.nextStartDay ?? null;
  const defaultStartDay = Math.max(0, requestedEndDay - (windowDays - 1) * DAY_SECONDS);
  const unclampedStartDay = cursorStart ?? requestedStartDay ?? defaultStartDay;
  const startDay = requestedStartDay != null
    ? Math.max(unclampedStartDay, requestedStartDay)
    : unclampedStartDay;
  const endDay = Math.min(requestedEndDay, startDay + (windowDays - 1) * DAY_SECONDS);
  const nextStartDay = endDay + DAY_SECONDS <= requestedEndDay ? endDay + DAY_SECONDS : null;

  return {
    startDay,
    endDay,
    requestedStartDay,
    requestedEndDay,
    windowDays,
    continuationCursor: nextStartDay == null
      ? null
      : buildSupplyBackfillCursor({
          nextStartDay,
          requestedStartDay,
          requestedEndDay,
          windowDays,
          dryRun,
          mode,
        }),
    done: nextStartDay == null,
    dryRun,
    mode,
  };
}

function selectConfiguredHistoricalOnChainContract(
  contracts: ContractDeployment[] | undefined,
  chain: string,
): ContractDeployment | null {
  return contracts?.find((contract) => contract.chain === chain) ?? null;
}

function getBlockSearchCacheForChain(
  cachesByChain: EvmBlockSearchCacheByChain | undefined,
  chain: string,
): EvmBlockSearchCache {
  if (!cachesByChain) return { blockTimestampByNumber: new Map() };
  const existing = cachesByChain.get(chain);
  if (existing) return existing;
  const next: EvmBlockSearchCache = { blockTimestampByNumber: new Map() };
  cachesByChain.set(chain, next);
  return next;
}

async function fetchHistoricalAdjustedSupplyRaw(input: {
  contract: ContractDeployment;
  holderAddresses: readonly string[];
  blockNumber: number;
  chainRpcs?: Map<string, ChainRpcConfig>;
  signal?: AbortSignal;
}): Promise<bigint | null> {
  const rpcOptions = {
    chainRpcs: input.chainRpcs,
    extraRpcUrls: getPublicFallbackRpcUrls(input.contract.chain),
    timeoutMs: 15_000,
    signal: input.signal,
  };
  const totalSupplyRaw = await fetchEvmUint256AtBlock(
    input.contract.chain,
    input.contract.address,
    TOTAL_SUPPLY_SELECTOR,
    input.blockNumber,
    rpcOptions,
  );
  if (totalSupplyRaw == null || totalSupplyRaw <= 0n) return null;

  const excludedBalancesRaw: bigint[] = [];
  for (const holderAddress of input.holderAddresses) {
    const balanceRaw = await fetchEvmUint256AtBlock(
      input.contract.chain,
      input.contract.address,
      encodeBalanceOfCallData(holderAddress),
      input.blockNumber,
      rpcOptions,
    );
    if (balanceRaw == null) return null;
    excludedBalancesRaw.push(balanceRaw);
  }

  return computeExcludedBalanceAdjustedSupplyRaw(totalSupplyRaw, excludedBalancesRaw);
}

interface HistoricalEvmSupplyOptions extends SupplyWriteOptions {
  priceSeries?: SupplyPricePoint[];
  parPrice?: number | null;
  write: typeof writeSupplyHistoryBatch;
  chainRpcs?: Map<string, ChainRpcConfig>;
  blockSearchCachesByChain?: EvmBlockSearchCacheByChain;
  window?: SupplyBackfillWindow;
  signal?: AbortSignal;
}

async function runHistoricalEvmSupplyDays(
  db: D1Database,
  stablecoinId: string,
  contract: ContractDeployment,
  decimals: number,
  range: { startDay: number; endDay: number },
  options: HistoricalEvmSupplyOptions,
  includeSnapshotDate: (snapshotDate: number) => boolean,
  loadRawSupply?: (blockNumber: number) => Promise<bigint | null>,
): Promise<{
  stmts: D1PreparedStatement[];
  blockMisses: number;
  supplyMisses: number;
  priceMisses: number;
}> {
  const priceSeries = options.priceSeries ?? [];
  const firstPrice = priceSeries[0];
  const lastPrice = priceSeries[priceSeries.length - 1];

  function findInterpolatedPrice(snapshotDate: number): number | null {
    if (!firstPrice || !lastPrice || snapshotDate < firstPrice.timestamp || snapshotDate > lastPrice.timestamp) {
      return null;
    }
    const interpolated = interpolateRateAtTimestamp(priceSeries, snapshotDate);
    return interpolated && interpolated > 0 ? interpolated : null;
  }

  const blockSearchCache = getBlockSearchCacheForChain(options.blockSearchCachesByChain, contract.chain);
  const stmts: D1PreparedStatement[] = [];
  let blockMisses = 0;
  let supplyMisses = 0;
  let priceMisses = 0;
  const rpcOptions = {
    chainRpcs: options.chainRpcs,
    extraRpcUrls: getPublicFallbackRpcUrls(contract.chain),
    timeoutMs: 15_000,
    signal: options.signal,
  };

  for (let snapshotDate = range.startDay; snapshotDate <= range.endDay; snapshotDate += DAY_SECONDS) {
    throwIfAborted(options.signal);
    if (!includeSnapshotDate(snapshotDate)) continue;

    const quote = priceSeries.find((point) => point.timestamp === snapshotDate);
    const price = quote?.rate ?? findInterpolatedPrice(snapshotDate) ?? options.parPrice ?? null;
    if (price == null) {
      priceMisses += 1;
      continue;
    }

    const targetTimestamp = snapshotDate + DAY_SECONDS - 1;
    const blockNumber = await resolveClosestBlockAtOrBeforeTimestamp(
      contract.chain,
      targetTimestamp,
      blockSearchCache,
      rpcOptions,
    );
    if (blockNumber == null) {
      blockMisses += 1;
      continue;
    }

    const raw = loadRawSupply
      ? await loadRawSupply(blockNumber)
      : await fetchEvmUint256AtBlock(
          contract.chain,
          contract.address,
          TOTAL_SUPPLY_SELECTOR,
          blockNumber,
          rpcOptions,
        );
    const wrapper = isKinesisWrapperSupplyId(stablecoinId);
    if (raw == null || raw < 0n || (raw === 0n && !wrapper)) {
      supplyMisses += 1;
      continue;
    }

    const supply = wrapper && raw === 0n ? 0 : toTokenUnits(raw, decimals);
    if (supply == null) {
      supplyMisses += 1;
      continue;
    }

    const circulatingUsd = supply * price;
    if (!Number.isFinite(circulatingUsd) || (circulatingUsd === 0 && !wrapper) || circulatingUsd < 0) {
      supplyMisses += 1;
      continue;
    }

    const blockObservedAt = blockSearchCache.blockTimestampByNumber.get(blockNumber);
    if (wrapper && (!quote || blockObservedAt == null || blockObservedAt < snapshotDate || blockObservedAt > targetTimestamp)) {
      supplyMisses += 1;
      continue;
    }
    pushSupplyUpsert(stmts, db, stablecoinId, snapshotDate, circulatingUsd, price, quote?.observedAt ?? null, options, quote ? {
      native: supply, valuationPrice: quote.rate, valuationAt: quote.observedAt, stockObservedAt: blockObservedAt,
      supplySource: loadRawSupply ? "onchain-circulating-supply" : "onchain-total-supply",
    } : undefined);
  }

  return { stmts, blockMisses, supplyMisses, priceMisses };
}

async function backfillHistoricalOnChainSupply(
  db: D1Database,
  meta: (typeof PSI_ELIGIBLE_STABLECOINS)[number],
  options: HistoricalEvmSupplyOptions,
): Promise<{ rows: number; error?: string; skippedDays?: number; skippedExisting?: number } | null> {
  const exclusionConfig = getOnChainSupplyExclusionConfig(meta.id);
  if (!exclusionConfig?.historicalBackfillStartDay) return null;
  if (meta.flags.pegCurrency !== "USD") {
    return { rows: 0, error: "historical on-chain supply backfill currently supports USD-pegged assets only" };
  }

  const contract = selectConfiguredHistoricalOnChainContract(meta.contracts, exclusionConfig.chain);
  if (!contract || contract.chain === "solana" || contract.chain === "stellar" || contract.chain === "tron") {
    return { rows: 0, error: `no supported ${exclusionConfig.chain} contract for historical on-chain supply backfill` };
  }

  const endDay = Math.min(options.window?.endDay ?? getLastCompletedUtcDay(), getLastCompletedUtcDay());
  const startDay = Math.max(exclusionConfig.historicalBackfillStartDay, options.window?.startDay ?? 0);
  if (startDay > endDay) {
    return { rows: 0, error: "no completed UTC days in historical on-chain supply backfill window" };
  }

  const decimals = contract.decimals;
  if (decimals == null) {
    logWorkerEventArgs("api", "warn",
      `[backfill-supply] ${meta.symbol}: skipping historical on-chain supply backfill because contract decimals are missing`,
    );
    return { rows: 0, error: "historical on-chain supply backfill requires contract decimals" };
  }

  const { stmts, blockMisses, supplyMisses, priceMisses } = await runHistoricalEvmSupplyDays(
    db,
    meta.id,
    contract,
    decimals,
    { startDay, endDay },
    options,
    (snapshotDate) => isWithinBackfillWindow(snapshotDate, options.window),
    (blockNumber) => fetchHistoricalAdjustedSupplyRaw({
      contract,
      holderAddresses: exclusionConfig.holderAddresses,
      blockNumber,
      chainRpcs: options.chainRpcs,
      signal: options.signal,
    }),
  );

  if (stmts.length === 0) {
    if (priceMisses > 0) {
      logWorkerEventArgs("api", "warn",
        `[backfill-supply] ${meta.symbol}: historical on-chain supply skipped ${priceMisses} day(s) without a historical price`,
      );
    }
    return {
      rows: 0,
      error: `historical on-chain supply backfill wrote 0 rows (blockMisses=${blockMisses}, supplyMisses=${supplyMisses}, priceMisses=${priceMisses})`,
      skippedDays: priceMisses,
    };
  }

  const inserted = await options.write(db, stmts);
  if (blockMisses > 0 || supplyMisses > 0 || priceMisses > 0) {
    logWorkerEventArgs("api", "warn",
      `[backfill-supply] ${meta.symbol}: historical on-chain supply skipped ${blockMisses} block lookup(s), ${supplyMisses} supply read(s), and ${priceMisses} price day(s)`,
    );
  }
  return { rows: inserted, skippedExisting: stmts.length - inserted, skippedDays: priceMisses };
}

async function backfillHistoricalTotalSupply(
  db: D1Database,
  meta: (typeof PSI_ELIGIBLE_STABLECOINS)[number],
  options: HistoricalEvmSupplyOptions & {
    requirePrice: boolean;
    skipSnapshotDates?: ReadonlySet<number>;
  },
): Promise<{ rows: number; error?: string; skippedDays?: number; skippedExisting?: number }> {
  if (meta.flags.pegCurrency !== "USD" && !options.requirePrice) {
    return { rows: 0, error: "historical totalSupply backfill for non-USD assets requires historical prices" };
  }

  const wrapper = isKinesisWrapperSupplyId(meta.id);
  const contract = selectSingleHistoricalEvmContract(wrapper ? meta.contracts?.filter(({ chain }) => chain === "ethereum") : meta.contracts);
  if (!contract) {
    return { rows: 0, error: "unsupported-complete-roster: historical totalSupply backfill requires exactly one supported EVM deployment in the complete roster" };
  }

  const decimals = contract.decimals;
  if (decimals == null) {
    logWorkerEventArgs("api", "warn",
      `[backfill-supply] ${meta.symbol}: skipping historical totalSupply backfill because contract decimals are missing`,
    );
    return { rows: 0, error: "historical totalSupply backfill requires contract decimals" };
  }

  const priceSeries = options.priceSeries ?? [];

  const lastCompletedDay = getLastCompletedUtcDay();
  const firstPriceDay = priceSeries[0]?.timestamp ?? null;
  const lastPriceDay = priceSeries[priceSeries.length - 1]?.timestamp ?? null;
  const endDay = Math.min(options.window?.endDay ?? lastPriceDay ?? lastCompletedDay, lastCompletedDay);
  const defaultStartDay = Math.max(0, endDay - (DEFAULT_BACKFILL_WINDOW_DAYS - 1) * DAY_SECONDS);
  const startDay = options.window?.startDay ?? firstPriceDay ?? defaultStartDay;
  if (startDay > endDay) {
    return { rows: 0, error: "no completed UTC days in historical totalSupply backfill window" };
  }

  const { stmts, blockMisses, supplyMisses, priceMisses } = await runHistoricalEvmSupplyDays(
    db,
    meta.id,
    contract,
    decimals,
    { startDay, endDay },
    options,
    (snapshotDate) =>
      isWithinBackfillWindow(snapshotDate, options.window) && !options.skipSnapshotDates?.has(snapshotDate) &&
      (!wrapper || (isKinesisWrapperSupplyCutoverActive(meta.id, snapshotDate) && !isAmbiguousSupplyPerimeterDay(meta.id, snapshotDate))),
  );

  if (stmts.length === 0) {
    if (priceMisses > 0) {
      logWorkerEventArgs("api", "warn",
        `[backfill-supply] ${meta.symbol}: historical totalSupply skipped ${priceMisses} day(s) without a historical price`,
      );
    }
    return {
      rows: 0,
      error: `historical totalSupply backfill wrote 0 rows (blockMisses=${blockMisses}, supplyMisses=${supplyMisses}, priceMisses=${priceMisses})`,
      skippedDays: priceMisses,
    };
  }

  const inserted = await options.write(db, stmts);
  if (blockMisses > 0 || supplyMisses > 0 || priceMisses > 0) {
    logWorkerEventArgs("api", "warn",
      JSON.stringify({
        scope: "backfill-supply",
        message: "historical totalSupply backfill skipped partial reads",
        stablecoinId: meta.id,
        symbol: meta.symbol,
        blockMisses,
        supplyMisses,
        priceMisses,
      }),
    );
  }
  return { rows: inserted, skippedExisting: stmts.length - inserted, skippedDays: priceMisses };
}

async function backfillCommodity(
  db: D1Database,
  meta: (typeof PSI_ELIGIBLE_STABLECOINS)[number],
  config: SupplyWriteOptions & {
    geckoId: string;
    protocolSlug?: string;
    write: typeof writeSupplyHistoryBatch;
    cgApiKey?: string | null;
    chainRpcs?: Map<string, ChainRpcConfig>;
    blockSearchCachesByChain?: EvmBlockSearchCacheByChain;
    window?: SupplyBackfillWindow;
    signal?: AbortSignal;
  },
): Promise<{ rows: number; error?: string; skippedDays?: number; skippedExisting?: number }> {
  const id = meta.id;
  const kinesis = isKinesisWrapperSupplyId(id);
  const marketHistory = await fetchCoinGeckoMarketHistory(config.geckoId, {
    apiKey: config.cgApiKey ?? null,
    signal: config.signal,
    range: config.window ? backfillWindowToFetchRange(config.window) : undefined,
    onCoinDetailFailure: (status) => {
      logWorkerEventArgs("api", "warn",
        `[backfill-commodity] ${config.geckoId}: coin detail fetch failed (${status}), sanity check skipped`,
      );
    },
  });

  let fallthroughReason = "CoinGecko market_chart returned no data";
  if (marketHistory?.prices.length) {
    fallthroughReason =
      "CoinGecko market caps all zero and historical on-chain totalSupply unavailable";
    // Use the first valid exact-timestamp cap/price pair per UTC day.
    // A price without a matching cap remains eligible for historical on-chain replay.
    const cgMcapByTimestamp = new Map<number, number>();
    for (const [ts, mcap] of marketHistory.marketCaps) {
      if (Number.isFinite(ts) && Number.isFinite(mcap)) {
        cgMcapByTimestamp.set(ts, mcap);
      }
    }
    const screenedPricePairs = screenCoinGeckoDailyPrices(marketHistory.prices);

    const stmts: D1PreparedStatement[] = [];
    const seenSnapshotDates = new Set<number>();
    let missingMarketCapDays = 0;

    for (const [ts, price] of screenedPricePairs) {
      const snapshotDate = bucketUnixMillisecondsToUtcDay(ts) / 1000;
      if (seenSnapshotDates.has(snapshotDate)) continue;
      if (!isWithinBackfillWindow(snapshotDate, config.window)) continue;
      if (kinesis && (isAmbiguousSupplyPerimeterDay(id, snapshotDate) || isKinesisWrapperSupplyCutoverActive(id, snapshotDate))) continue;
      const cgMcap = cgMcapByTimestamp.get(ts);
      const resolvedMcap = resolveMarketCap(cgMcap, undefined, price);
      if (!Number.isFinite(resolvedMcap) || resolvedMcap <= 0) {
        missingMarketCapDays += 1;
        continue;
      }

      seenSnapshotDates.add(snapshotDate);
      const native = resolvedMcap / price;
      const observedAt = Math.floor(ts / 1000);
      pushSupplyUpsert(stmts, db, id, snapshotDate, resolvedMcap, price, observedAt, config, kinesis ? undefined : {
        native: Number.isFinite(native) ? native : null,
        valuationPrice: price,
        valuationAt: observedAt,
        supplySource: "coingecko", stockObservedAt: observedAt,
      });
    }

    if (kinesis) {
      const programRows = stmts.length ? await config.write(db, stmts) : 0;
      const lastDay = Math.min(config.window?.endDay ?? getLastCompletedUtcDay(), getLastCompletedUtcDay());
      const wrapper = isKinesisWrapperSupplyCutoverActive(id, lastDay)
        ? await backfillHistoricalTotalSupply(db, meta, { ...config, requirePrice: true,
            priceSeries: normalizeCoinGeckoDailyPrices(screenedPricePairs) }) : null;
      return { rows: programRows + (wrapper?.rows ?? 0), skippedExisting: stmts.length - programRows + (wrapper?.skippedExisting ?? 0),
        skippedDays: missingMarketCapDays + (wrapper?.skippedDays ?? 0), ...(wrapper?.error ? { error: wrapper.error } : {}) };
    }

    if (stmts.length > 0) {
      const inserted = await config.write(db, stmts);
      if (missingMarketCapDays > 0) {
        const historicalTotalSupply = await backfillHistoricalTotalSupply(db, meta, {
          chainRpcs: config.chainRpcs,
          blockSearchCachesByChain: config.blockSearchCachesByChain,
          priceSeries: normalizeCoinGeckoDailyPrices(screenedPricePairs),
          requirePrice: true,
          mode: config.mode, dryRun: config.dryRun,
          write: config.write,
          skipSnapshotDates: seenSnapshotDates,
          window: config.window,
          signal: config.signal,
        });
        if (!historicalTotalSupply.error) {
          return {
            rows: inserted + historicalTotalSupply.rows,
            skippedExisting: (stmts.length - inserted) + (historicalTotalSupply.skippedExisting ?? 0),
            skippedDays: historicalTotalSupply.skippedDays,
          };
        }
        logWorkerEventArgs("api", "warn",
          `[backfill-commodity] ${id}: skipped ${missingMarketCapDays} day(s) without CoinGecko market caps; historical totalSupply fallback failed (${historicalTotalSupply.error})`,
        );
      }
      return { rows: inserted, skippedExisting: stmts.length - inserted };
    }

    const historicalTotalSupply = await backfillHistoricalTotalSupply(db, meta, {
      chainRpcs: config.chainRpcs,
      blockSearchCachesByChain: config.blockSearchCachesByChain,
      priceSeries: normalizeCoinGeckoDailyPrices(screenedPricePairs),
      requirePrice: true,
      mode: config.mode, dryRun: config.dryRun,
      write: config.write,
      window: config.window,
      signal: config.signal,
    });
    if (!historicalTotalSupply.error) {
      return historicalTotalSupply;
    }
    fallthroughReason = `${fallthroughReason} (${historicalTotalSupply.error})`;
    // Fell through: CG had prices but no usable mcap and historical on-chain supply
    // could not be replayed. Fall back to the protocol-TVL path below when possible,
    // otherwise return a clear error.
  }

  // Fallback: protocol TVL (only if TVL ≈ mcap)
  if (!config.protocolSlug) {
    return { rows: 0, error: `${fallthroughReason}; no protocolSlug for TVL fallback` };
  }
  if (!isCommodityPeg(meta.flags.pegCurrency) || !isDedicatedSingleTokenGoldProtocolSlug(config.protocolSlug)) {
    return { rows: 0, error: `${fallthroughReason}; protocol TVL fallback requires a dedicated commodity-token mapping` };
  }

  const priceRange = config.window ? backfillWindowToFetchRange(config.window) : null;
  const priceStart = priceRange?.startSec ?? 0;
  const priceSpan = priceRange?.endSec != null
    ? Math.max(1, Math.ceil((priceRange.endSec - priceStart) / DAY_SECONDS) + 1)
    : 500;
  const [protocolResult, priceResult] = await Promise.all([
    fetchJsonWithRetry<{
      mcap?: number;
      tvl?: { date: number; totalLiquidityUSD: number }[];
    }>(`${DEFILLAMA_API}/protocol/${config.protocolSlug}`, {
      headers: { "User-Agent": USER_AGENT },
      signal: config.signal,
    }),
    fetchJsonWithRetry(`${DEFILLAMA_COINS}/chart/coingecko:${config.geckoId}?start=${priceStart}&span=${Math.min(500, priceSpan)}`, {
      headers: { "User-Agent": USER_AGENT },
      signal: config.signal,
    }),
  ]);

  if (!protocolResult?.response.ok) {
    return { rows: 0, error: `protocol API returned ${protocolResult?.response.status ?? "no response"}` };
  }

  const protocolData = protocolResult.body;
  const tvlHistory = protocolData.tvl ?? [];
  if (tvlHistory.length === 0) {
    return { rows: 0, error: "no TVL history and CoinGecko unavailable" };
  }

  // Require usable equivalence evidence before admitting any protocol-TVL history.
  const currentMcap = protocolData.mcap;
  const latestTvl = tvlHistory[tvlHistory.length - 1].totalLiquidityUSD;
  if (typeof currentMcap !== "number" || !Number.isFinite(currentMcap) || currentMcap <= 0 ||
      !Number.isFinite(latestTvl) || latestTvl <= 0) {
    return { rows: 0, error: "TVL/mcap equivalence unavailable, CoinGecko also unavailable" };
  }
  const ratio = currentMcap / latestTvl;
  if (ratio < 0.85 || ratio > 1.15) {
    return { rows: 0, error: `TVL/mcap divergence (ratio=${ratio.toFixed(3)}), CoinGecko also unavailable` };
  }

  const prices = priceResult?.response.ok
    ? extractDefiLlamaCoinChartPrices(priceResult.body, config.geckoId)
      .filter(({ timestamp, price }) => Number.isSafeInteger(timestamp) && timestamp > 0 && price > 0)
    : [];

  const stmts: D1PreparedStatement[] = [];
  for (const point of tvlHistory) {
    const mcap = point.totalLiquidityUSD;
    if (!Number.isFinite(mcap) || mcap <= 0) continue;
    const snapshotDate = bucketUnixSecondsToUtcDay(point.date);
    if (!isWithinBackfillWindow(snapshotDate, config.window)) continue;
    const quote = findAsOfSnapshot(prices, point.date, (point) => point.timestamp, point.date - snapshotDate);
    pushSupplyUpsert(stmts, db, id, snapshotDate, mcap, quote?.price ?? null, quote?.timestamp ?? null, config);
  }

  if (stmts.length === 0) {
    return { rows: 0 };
  }
  const inserted = await config.write(db, stmts);
  return { rows: inserted, skippedExisting: stmts.length - inserted };
}

export interface BackfillSupplyHistoryRouteContext {
  db: D1Database;
  url: URL;
  request: Request;
  coingeckoApiKey?: string | null;
  chainRpcs?: Map<string, ChainRpcConfig>;
}

async function executeBackfillSupplyHistory(
  db: D1Database,
  url: URL,
  cgApiKey?: string | null,
  chainRpcs?: Map<string, ChainRpcConfig>,
  signal?: AbortSignal,
): Promise<Response> {
  throwIfAborted(signal);
  const dayWindow = parseOptionalDayWindow(url, {
    maxEndDay: getLastCompletedUtcDay(),
    invalidDayMessage: "Invalid startDay/endDay. Use Unix seconds/milliseconds or YYYY-MM-DD.",
  });
  if (dayWindow instanceof Response) return dayWindow;
  const resolvedWindow = resolveSupplyBackfillWindow(url, {
    startDay: dayWindow.startDay,
    endDay: dayWindow.endDay,
  });
  if (resolvedWindow instanceof Response) return resolvedWindow;
  const supplyBackfillWindow: ResolvedSupplyBackfillWindow = resolvedWindow;
  const { dryRun, mode } = supplyBackfillWindow;
  const write: typeof writeSupplyHistoryBatch = dryRun
    ? countEligibleSupplyRows
    : writeSupplyHistoryBatch;

  const selection = selectBackfillCoins(url, PSI_ELIGIBLE_STABLECOINS, {
    defaultBatchSize: DEFAULT_BATCH_SIZE,
  });
  if ("response" in selection) {
    return selection.response;
  }
  const coins = selection.coins;

  if (coins.length === 0) {
    return noAdminTargetsResponse();
  }

  let totalRows = 0;
  let rowsSkippedExisting = 0;
  let skippedDays = 0;
  const errors: string[] = [];
  const skipped: string[] = [];
  const blockSearchCachesByChain: EvmBlockSearchCacheByChain = new Map();

  const runCoinGeckoMarketChartBackfill = async (meta: (typeof coins)[number], failureLabel: string): Promise<void> => {
    const exclusionPriceSeries = getOnChainSupplyExclusionConfig(meta.id) && meta.geckoId
      ? await fetchMarketBackfillPriceSeries(meta, meta.geckoId, {
          granularity: "daily",
          coingeckoApiKey: cgApiKey ?? null,
          range: supplyBackfillWindow ? backfillWindowToFetchRange(supplyBackfillWindow) : undefined,
          signal,
        })
      : null;
    const historicalOnChainResult = await backfillHistoricalOnChainSupply(db, meta, {
      chainRpcs,
      blockSearchCachesByChain,
      priceSeries: exclusionPriceSeries?.prices
        ?.map((point) => ({ timestamp: bucketUnixSecondsToUtcDay(point.timestamp), rate: point.price, observedAt: point.timestamp })) ?? [],
      parPrice: getParPolicyPrice(meta),
      mode, dryRun,
      write,
      window: supplyBackfillWindow,
      signal,
    });
    if (historicalOnChainResult) {
      if (historicalOnChainResult.error) {
        errors.push(`${meta.symbol}: ${historicalOnChainResult.error}`);
        skippedDays += historicalOnChainResult.skippedDays ?? 0;
      } else {
        totalRows += historicalOnChainResult.rows;
        rowsSkippedExisting += historicalOnChainResult.skippedExisting ?? 0;
        skippedDays += historicalOnChainResult.skippedDays ?? 0;
      }
      return;
    }

    if (HISTORICAL_ONCHAIN_TOTAL_SUPPLY_IDS.has(meta.id)) {
      try {
        const marketHistory = meta.geckoId
          ? await fetchCoinGeckoMarketHistory(meta.geckoId, {
              apiKey: cgApiKey ?? null,
              signal,
              range: supplyBackfillWindow ? backfillWindowToFetchRange(supplyBackfillWindow) : undefined,
              onCoinDetailFailure: (status) => {
                logWorkerEventArgs("api", "warn",
                  JSON.stringify({
                    scope: "backfill-supply",
                    message: "CoinGecko coin detail fetch failed; using market_chart prices only",
                    stablecoinId: meta.id,
                    geckoId: meta.geckoId,
                    status,
                  }),
                );
              },
            })
          : null;
        const result = await backfillHistoricalTotalSupply(db, meta, {
          chainRpcs,
          blockSearchCachesByChain,
          priceSeries: marketHistory
            ? normalizeCoinGeckoDailyPrices(screenCoinGeckoDailyPrices(marketHistory.prices))
            : [],
          requirePrice: true,
          parPrice: getParPolicyPrice(meta),
          mode, dryRun,
          write,
          window: supplyBackfillWindow,
          signal,
        });
        if (result.error) {
          errors.push(`${meta.symbol}: ${result.error}`);
          skippedDays += result.skippedDays ?? 0;
        } else {
          totalRows += result.rows;
          rowsSkippedExisting += result.skippedExisting ?? 0;
          skippedDays += result.skippedDays ?? 0;
        }
      } catch (err) {
        rethrowIfAborted(err, signal);
        errors.push(`${meta.symbol}: historical totalSupply backfill failed — ${err}`);
      }
      return;
    }

    if (!meta.geckoId) {
      skipped.push(meta.symbol);
      return;
    }

    try {
      const result = await backfillCommodity(db, meta, {
        geckoId: meta.geckoId,
        protocolSlug: meta.protocolSlug ?? undefined,
        mode, dryRun,
        write,
        cgApiKey,
        chainRpcs,
        blockSearchCachesByChain,
        window: supplyBackfillWindow,
        signal,
      });
      if (result.error) {
        errors.push(`${meta.symbol}: ${result.error}`);
        skippedDays += result.skippedDays ?? 0;
      } else {
        totalRows += result.rows;
        rowsSkippedExisting += result.skippedExisting ?? 0;
      }
    } catch (err) {
      rethrowIfAborted(err, signal);
      errors.push(`${meta.symbol}: ${failureLabel} — ${err}`);
    }
  };

  for (const meta of coins) {
    throwIfAborted(signal);
    // Historical totalSupply eligibility is independent of the configured detail
    // provider. Keep this path ahead of provider dispatch so correcting an asset's
    // provider does not silently remove its on-chain supply fallback.
    if (HISTORICAL_ONCHAIN_TOTAL_SUPPLY_IDS.has(meta.id)) {
      await runCoinGeckoMarketChartBackfill(meta, "CoinGecko backfill failed");
      continue;
    }

    // Commodity tokens: backfill from CoinGecko market_chart (primary) or protocol TVL (fallback)
    const isCommodity = isCommodityPeg(meta.flags.pegCurrency);
    if (isCommodity && meta.geckoId) {
      await runCoinGeckoMarketChartBackfill(meta, "commodity backfill failed");
      continue;
    }

    // CoinGecko-only and non-gold/silver commodity coins: backfill via CoinGecko market_chart
    // (same path as commodity tokens — market_cap from CG is accurate for USD stablecoins too)
    if (meta.detailProvider === "coingecko" || meta.detailProvider === "commodity") {
      await runCoinGeckoMarketChartBackfill(meta, "CoinGecko backfill failed");
      continue;
    }

    const geckoId = meta.geckoId ?? PSI_ELIGIBLE_META_BY_ID.get(meta.id)?.geckoId;
    const dlId = meta.llamaId ?? meta.id;

    let detail: StablecoinDetail | null = null;
    let historicalPrices: { timestamp: number; price: number }[] = [];
    try {
      const [detailResult, priceSeries] = await Promise.all([
        fetchJsonWithRetry<StablecoinDetail>(`${DEFILLAMA_BASE}/stablecoin/${encodeURIComponent(dlId)}`, {
          headers: { "User-Agent": USER_AGENT },
          signal,
        }),
        geckoId
          ? fetchMarketBackfillPriceSeries(meta, geckoId, {
              granularity: "daily",
              coingeckoApiKey: cgApiKey ?? null,
              range: backfillWindowToFetchRange(supplyBackfillWindow, HISTORICAL_VALUATION_MAX_AGE_SEC),
              signal,
            })
          : Promise.resolve(null),
      ]);
      if (!detailResult?.response.ok) {
        errors.push(`${meta.symbol}: DL returned ${detailResult?.response.status ?? "no response"}`);
        continue;
      }
      detail = detailResult.body;

      historicalPrices = priceSeries?.diagnostics.quoteMode === "usd" ? priceSeries.prices ?? [] : [];
    } catch (err) {
      rethrowIfAborted(err, signal);
      errors.push(`${meta.symbol}: fetch failed — ${err}`);
      continue;
    }

    const tokens = detail?.tokens;
    if (!tokens || tokens.length === 0) {
      skipped.push(meta.symbol);
      continue;
    }
    const screenedPrices = screenDailyPriceOutliers(historicalPrices
      .filter(({ timestamp, price }) => Number.isSafeInteger(timestamp) && timestamp > 0 && Number.isFinite(price) && price > 0)
      .sort((a, b) => a.timestamp - b.timestamp)).prices;
    const stmts: D1PreparedStatement[] = [];

    for (const entry of tokens) {
      throwIfAborted(signal);
      if (!Number.isSafeInteger(entry.date) || entry.date <= 0) continue;
      const snapshotDate = bucketUnixSecondsToUtcDay(entry.date);
      if (!isWithinBackfillWindow(snapshotDate, supplyBackfillWindow)) continue;
      const usdBuckets = admitSupplyBuckets(entry.totalCirculatingUSD);
      if (usdBuckets.status === "invalid") {
        skippedDays++;
        continue;
      }
      const canonical = admitSupplyBuckets(entry.totalCirculating);
      const buckets = canonical.status === "absent" ? admitSupplyBuckets(entry.circulating) : canonical;
      const native = buckets.status === "observed" ? buckets.total : null;
      const usd = usdBuckets.status === "observed" ? usdBuckets.total : null;
      if (native == null && usd == null) continue;
      const quote = findAsOfSnapshot(screenedPrices, entry.date, (point) => point.timestamp, HISTORICAL_VALUATION_MAX_AGE_SEC);
      const marketCapUsd = usd ?? (native === 0 ? 0 : native != null && quote ? native * quote.price : null);
      if (marketCapUsd == null || !Number.isFinite(marketCapUsd)) {
        skippedDays++;
        continue;
      }
      const valuation = native != null && quote && (usd == null || usd === native * quote.price) ? quote : null;
      const dailyQuote = quote && bucketUnixSecondsToUtcDay(quote.timestamp) === snapshotDate ? quote : null;
      pushSupplyUpsert(stmts, db, meta.id, snapshotDate, marketCapUsd, dailyQuote?.price ?? null, dailyQuote?.timestamp ?? null, { mode, dryRun }, {
        native,
        nativeQuantityUnavailable: buckets.status === "invalid",
        valuationPrice: valuation?.price ?? null,
        valuationAt: valuation?.timestamp ?? null,
        supplySource: "defillama", stockObservedAt: entry.date,
      });
    }

    if (stmts.length > 0) {
      const inserted = await write(db, stmts);
      totalRows += inserted;
      rowsSkippedExisting += stmts.length - inserted;
    }
  }

  return jsonResponse(
    buildAdminJobSummary({
      coinsProcessed: coins.length,
      rowsInserted: !dryRun && (mode === "insert-missing" || mode === "overwrite") ? totalRows : 0,
      ...(mode === "price-clock-only" ? { rowsPriceClockUpdated: dryRun ? 0 : totalRows } : {}),
      ...(mode === "quantity-only" ? { rowsQuantityUpdated: dryRun ? 0 : totalRows } : {}),
      ...(dryRun ? { dryRun: true, candidateRows: totalRows } : {}),
      ...(rowsSkippedExisting > 0 ? { rowsSkippedExisting } : {}),
      ...(skippedDays > 0 ? { skippedDays } : {}),
      skipped,
      errors,
      window: {
        startDay: supplyBackfillWindow.startDay,
        endDay: supplyBackfillWindow.endDay,
        requestedStartDay: supplyBackfillWindow.requestedStartDay,
        requestedEndDay: supplyBackfillWindow.requestedEndDay,
        windowDays: supplyBackfillWindow.windowDays,
      },
      done: supplyBackfillWindow.done,
      continuationCursor: supplyBackfillWindow.continuationCursor,
    }),
  );
}

export function handleBackfillSupplyHistoryTrusted({
  db,
  url,
  coingeckoApiKey,
  chainRpcs,
  request,
}: BackfillSupplyHistoryRouteContext): Promise<Response> {
  return executeBackfillSupplyHistory(db, url, coingeckoApiKey, chainRpcs, request.signal);
}
