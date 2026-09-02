import { logWorkerEventArgs } from "../lib/structured-log";
import { SUPPLY_HISTORY_UPSERT_SQL } from "../lib/supply-history-db";
import { PSI_ELIGIBLE_STABLECOINS, PSI_ELIGIBLE_META_BY_ID } from "@shared/lib/psi-eligible";
import { DAY_SECONDS } from "@shared/lib/time-constants";
import { bucketUnixMillisecondsToUtcDay, bucketUnixSecondsToUtcDay } from "@shared/lib/time-buckets";
import { getCirculatingRaw } from "@shared/lib/supply";
import type { ContractDeployment } from "@shared/types/core";
import { DEFILLAMA_BASE, DEFILLAMA_API, DEFILLAMA_COINS, USER_AGENT } from "../lib/constants";
import { fetchCoinGeckoMarketHistory } from "../lib/coingecko-market-history";
import type { ChainRpcConfig } from "../lib/chain-registry";
import { batchExecute } from "../lib/db";
import { encodeJsonCursor, parseIntParam, parseJsonCursorParam } from "../lib/api-params";
import { jsonResponse } from "../lib/api-response";
import { binarySearchNearest } from "../lib/binary-search";
import { resolveMarketCap } from "../lib/resolve-market-cap";
import { selectBackfillCoins } from "../lib/backfill-query";
import { buildAdminJobSummary, noAdminTargetsResponse } from "../lib/admin-job";
import { fetchJsonWithRetry } from "../lib/fetch-retry";
import { rethrowIfAborted, throwIfAborted } from "../lib/abort";
import {
  fetchEvmUint256AtBlock,
  resolveClosestBlockAtOrBeforeTimestamp,
  type EvmBlockSearchCache,
} from "../lib/evm-rpc";
import { encodeBalanceOfCallData, TOTAL_SUPPLY_SELECTOR } from "../lib/evm-selectors";
import {
  computeExcludedBalanceAdjustedSupplyRaw,
  getOnChainSupplyExclusionConfig,
} from "../lib/onchain-supply-exclusions";
import { getPublicFallbackRpcUrls } from "../lib/public-rpc-registry";
import { extractDefiLlamaCoinChartPrices } from "./stablecoin-detail/shared";
import { fetchMarketBackfillPriceSeries } from "./backfill-price-sources";
import { parseOptionalDayWindow } from "./backfill-depegs-window";
import { interpolateRateAtTimestamp, type TimestampedRatePoint } from "@shared/lib/rate-series";
import {
  fetchHistoricalFxRates,
  fetchHistoricalSecondaryFxRates,
  OTHER_COIN_FX,
  PEG_TO_FX,
  SECONDARY_PEG_TO_FX,
} from "../lib/backfill-fx";

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

function pushSupplyUpsert(
  statements: D1PreparedStatement[],
  db: D1Database,
  stablecoinId: string,
  snapshotDate: number,
  circulating: number,
  price: number | null,
): void {
  statements.push(
    db
      .prepare(SUPPLY_HISTORY_UPSERT_SQL)
      .bind(stablecoinId, snapshotDate, circulating, price),
  );
}

interface TokenEntry {
  date: number; // unix seconds
  circulating?: Record<string, number>;
}

interface StablecoinDetail {
  price?: number;
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
}

interface ResolvedSupplyBackfillWindow extends SupplyBackfillWindow {
  requestedStartDay: number | null;
  requestedEndDay: number | null;
  windowDays: number | null;
  continuationCursor: string | null;
  done: boolean;
}

type EvmBlockSearchCacheByChain = Map<string, EvmBlockSearchCache>;

function validateSupplyBackfillCursor(payload: unknown): SupplyBackfillContinuationCursor | null {
  if (payload == null || typeof payload !== "object" || Array.isArray(payload)) return null;
  const record = payload as Record<string, unknown>;
  const nextStartDay = record.nextStartDay;
  const requestedStartDay = record.requestedStartDay;
  const requestedEndDay = record.requestedEndDay;
  const windowDays = record.windowDays;
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
  return {
    nextStartDay,
    requestedStartDay,
    requestedEndDay,
    windowDays,
  };
}

function tokenHistoryDateRange(tokens: TokenEntry[]): { startDate: string; endDate: string } | null {
  const dates = tokens
    .map((entry) => entry.date)
    .filter((date) => Number.isFinite(date) && date > 0)
    .sort((a, b) => a - b);
  if (dates.length === 0) return null;
  return {
    startDate: new Date(dates[0] * 1000).toISOString().slice(0, 10),
    endDate: new Date(dates[dates.length - 1] * 1000).toISOString().slice(0, 10),
  };
}

async function fetchHistoricalPegFxPrices(
  db: D1Database,
  meta: (typeof PSI_ELIGIBLE_STABLECOINS)[number],
  tokens: TokenEntry[],
  signal?: AbortSignal,
): Promise<TimestampedRatePoint[]> {
  const range = tokenHistoryDateRange(tokens);
  if (!range) return [];

  const peg = meta.flags.pegCurrency;
  const primaryFx = PEG_TO_FX[peg] ?? OTHER_COIN_FX[meta.id];
  if (primaryFx) {
    const series = await fetchHistoricalFxRates([primaryFx], range.startDate, range.endDate, signal);
    return series[primaryFx] ?? [];
  }

  const secondaryFx = SECONDARY_PEG_TO_FX[peg];
  if (secondaryFx) {
    const series = await fetchHistoricalSecondaryFxRates(db, [secondaryFx], range.startDate, range.endDate, signal);
    return series[secondaryFx] ?? [];
  }

  return [];
}

// Commodity tokens: use CoinGecko market_chart (historical market caps) as primary source.
// Protocol TVL from DefiLlama can diverge from token market cap (e.g. XAUT TVL includes
// multi-chain reserves that far exceed the token's market cap).

function selectSingleHistoricalEvmContract(contracts?: ContractDeployment[]): ContractDeployment | null {
  const supportedContracts = contracts?.filter((c) =>
    c.chain !== "solana" && c.chain !== "stellar" && c.chain !== "tron"
  ) ?? [];
  return supportedContracts.length === 1 ? supportedContracts[0] : null;
}

function isWithinBackfillWindow(snapshotDate: number, window?: SupplyBackfillWindow): boolean {
  if (window?.startDay != null && snapshotDate < window.startDay) return false;
  if (window?.endDay != null && snapshotDate > window.endDay) return false;
  return true;
}

function backfillWindowToFetchRange(
  window: SupplyBackfillWindow,
): { startSec?: number | null; endSec?: number | null } | undefined {
  if (window.startDay == null && window.endDay == null) return undefined;
  return {
    startSec: window.startDay,
    endSec: window.endDay != null ? window.endDay + DAY_SECONDS - 1 : null,
  };
}

function getLastCompletedUtcDay(nowSec = Math.floor(Date.now() / 1000)): number {
  return bucketUnixSecondsToUtcDay(nowSec - DAY_SECONDS);
}

function normalizeCoinGeckoDailyPrices(prices: [number, number][]): TimestampedRatePoint[] {
  const priceBySnapshotDate = new Map<number, number>();
  for (const [timestampMs, price] of prices) {
    if (!Number.isFinite(timestampMs) || !Number.isFinite(price) || price <= 0) continue;
    const snapshotDate = bucketUnixMillisecondsToUtcDay(timestampMs) / 1000;
    if (!priceBySnapshotDate.has(snapshotDate)) {
      priceBySnapshotDate.set(snapshotDate, price);
    }
  }

  return Array.from(priceBySnapshotDate.entries())
    .sort(([a], [b]) => a - b)
    .map(([timestamp, rate]) => ({ timestamp, rate }));
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
    };
  }

  const requestedStartDay = dayWindow.startDay ?? parsedCursor?.requestedStartDay ?? null;
  const requestedEndDay = Math.min(
    dayWindow.endDay ?? parsedCursor?.requestedEndDay ?? lastCompletedDay,
    lastCompletedDay,
  );
  const windowDays = parsedWindowDays;

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
        }),
    done: nextStartDay == null,
  };
}

function selectConfiguredHistoricalOnChainContract(
  contracts: ContractDeployment[] | undefined,
  chain: string,
): ContractDeployment | null {
  return contracts?.find((contract) => contract.chain === chain) ?? null;
}

function rawTokenAmountToNumber(raw: bigint, decimals: number): number | null {
  const amount = Number(raw) / 10 ** decimals;
  return Number.isFinite(amount) && amount > 0 ? amount : null;
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

interface HistoricalEvmSupplyOptions {
  priceSeries?: TimestampedRatePoint[];
  parPrice?: number | null;
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

  function findHistoricalPrice(snapshotDate: number): number | null {
    if (!firstPrice || !lastPrice || snapshotDate < firstPrice.timestamp || snapshotDate > lastPrice.timestamp) {
      return null;
    }
    const exact = priceSeries.find((point) => point.timestamp === snapshotDate);
    if (exact) return exact.rate;
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

    const price = findHistoricalPrice(snapshotDate) ?? options.parPrice ?? null;
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
    if (raw == null || raw <= 0n) {
      supplyMisses += 1;
      continue;
    }

    const supply = rawTokenAmountToNumber(raw, decimals);
    if (supply == null) {
      supplyMisses += 1;
      continue;
    }

    const circulatingUsd = supply * price;
    if (!Number.isFinite(circulatingUsd) || circulatingUsd <= 0) {
      supplyMisses += 1;
      continue;
    }

    pushSupplyUpsert(stmts, db, stablecoinId, snapshotDate, circulatingUsd, price);
  }

  return { stmts, blockMisses, supplyMisses, priceMisses };
}

async function backfillHistoricalOnChainSupply(
  db: D1Database,
  meta: (typeof PSI_ELIGIBLE_STABLECOINS)[number],
  options: HistoricalEvmSupplyOptions,
): Promise<{ rows: number; error?: string; skippedDays?: number } | null> {
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

  await batchExecute(db, stmts);
  if (blockMisses > 0 || supplyMisses > 0 || priceMisses > 0) {
    logWorkerEventArgs("api", "warn",
      `[backfill-supply] ${meta.symbol}: historical on-chain supply skipped ${blockMisses} block lookup(s), ${supplyMisses} supply read(s), and ${priceMisses} price day(s)`,
    );
  }
  return { rows: stmts.length, skippedDays: priceMisses };
}

async function backfillHistoricalTotalSupply(
  db: D1Database,
  meta: (typeof PSI_ELIGIBLE_STABLECOINS)[number],
  options: HistoricalEvmSupplyOptions & {
    requirePrice: boolean;
    skipSnapshotDates?: ReadonlySet<number>;
  },
): Promise<{ rows: number; error?: string; skippedDays?: number }> {
  if (meta.flags.pegCurrency !== "USD" && !options.requirePrice) {
    return { rows: 0, error: "historical totalSupply backfill for non-USD assets requires historical prices" };
  }

  const contract = selectSingleHistoricalEvmContract(meta.contracts);
  if (!contract) {
    return { rows: 0, error: "historical totalSupply backfill requires exactly one supported EVM contract" };
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
      isWithinBackfillWindow(snapshotDate, options.window) && !options.skipSnapshotDates?.has(snapshotDate),
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

  await batchExecute(db, stmts);
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
  return { rows: stmts.length, skippedDays: priceMisses };
}

async function backfillCommodity(
  db: D1Database,
  meta: (typeof PSI_ELIGIBLE_STABLECOINS)[number],
  config: {
    geckoId: string;
    protocolSlug?: string;
    cgApiKey?: string | null;
    chainRpcs?: Map<string, ChainRpcConfig>;
    blockSearchCachesByChain?: EvmBlockSearchCacheByChain;
    window?: SupplyBackfillWindow;
    signal?: AbortSignal;
  },
): Promise<{ rows: number; error?: string; skippedDays?: number }> {
  const id = meta.id;
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
    // Build a date-keyed map of cgMcap so we can pair each price point with its matching cap.
    const cgMcapByDate = new Map<string, number>();
    for (const [ts, mcap] of marketHistory.marketCaps) {
      if (Number.isFinite(mcap)) {
        cgMcapByDate.set(new Date(ts).toISOString().slice(0, 10), mcap);
      }
    }

    const stmts: D1PreparedStatement[] = [];
    const seenSnapshotDates = new Set<number>();
    let missingMarketCapDays = 0;

    for (const [ts, price] of marketHistory.prices) {
      if (!Number.isFinite(price) || price <= 0) continue;
      const snapshotDate = bucketUnixMillisecondsToUtcDay(ts) / 1000;
      if (seenSnapshotDates.has(snapshotDate)) continue;
      if (!isWithinBackfillWindow(snapshotDate, config.window)) continue;
      const cgMcap = cgMcapByDate.get(new Date(ts).toISOString().slice(0, 10));
      const resolvedMcap = resolveMarketCap(cgMcap, undefined, price);
      if (!Number.isFinite(resolvedMcap) || resolvedMcap <= 0) {
        missingMarketCapDays += 1;
        continue;
      }

      seenSnapshotDates.add(snapshotDate);
      pushSupplyUpsert(stmts, db, id, snapshotDate, resolvedMcap, price);
    }

    if (stmts.length > 0) {
      await batchExecute(db, stmts);
      if (missingMarketCapDays > 0) {
        const historicalTotalSupply = await backfillHistoricalTotalSupply(db, meta, {
          chainRpcs: config.chainRpcs,
          blockSearchCachesByChain: config.blockSearchCachesByChain,
          priceSeries: normalizeCoinGeckoDailyPrices(marketHistory.prices),
          requirePrice: true,
          skipSnapshotDates: seenSnapshotDates,
          window: config.window,
          signal: config.signal,
        });
        if (!historicalTotalSupply.error) {
          return {
            rows: stmts.length + historicalTotalSupply.rows,
            skippedDays: historicalTotalSupply.skippedDays,
          };
        }
        logWorkerEventArgs("api", "warn",
          `[backfill-commodity] ${id}: skipped ${missingMarketCapDays} day(s) without CoinGecko market caps; historical totalSupply fallback failed (${historicalTotalSupply.error})`,
        );
      }
      return { rows: stmts.length };
    }

    const historicalTotalSupply = await backfillHistoricalTotalSupply(db, meta, {
      chainRpcs: config.chainRpcs,
      blockSearchCachesByChain: config.blockSearchCachesByChain,
      priceSeries: normalizeCoinGeckoDailyPrices(marketHistory.prices),
      requirePrice: true,
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

  // Skip TVL if it diverges from mcap (same 15% threshold as sync code)
  const currentMcap = protocolData.mcap;
  if (currentMcap && tvlHistory.length > 0) {
    const latestTvl = tvlHistory[tvlHistory.length - 1].totalLiquidityUSD;
    const ratio = currentMcap / latestTvl;
    if (ratio < 0.85 || ratio > 1.15) {
      return { rows: 0, error: `TVL/mcap divergence (ratio=${ratio.toFixed(3)}), CoinGecko also unavailable` };
    }
  }

  let prices: { timestamp: number; price: number }[] = [];
  if (priceResult?.response.ok) {
    prices = extractDefiLlamaCoinChartPrices(priceResult.body, config.geckoId);
  }

  function findPrice(date: number): number | null {
    if (prices.length === 0) return null;
    const first = prices[0];
    const last = prices[prices.length - 1];
    if (date < first.timestamp || date > last.timestamp) return null;
    return binarySearchNearest(prices, date, (p) => p.timestamp)?.price ?? null;
  }

  const stmts: D1PreparedStatement[] = [];
  for (const point of tvlHistory) {
    const mcap = point.totalLiquidityUSD;
    if (mcap <= 0) continue;
    const snapshotDate = bucketUnixSecondsToUtcDay(point.date);
    const price = findPrice(point.date);
    if (!isWithinBackfillWindow(snapshotDate, config.window)) continue;
    pushSupplyUpsert(stmts, db, id, snapshotDate, mcap, price);
  }

  if (stmts.length > 0) {
    await batchExecute(db, stmts);
  }
  return { rows: stmts.length };
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
  const allowConstantPriceFallback = url.searchParams.get("allow-constant-price-fallback") === "true";
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
        ?.map((point) => ({ timestamp: bucketUnixSecondsToUtcDay(point.timestamp), rate: point.price })) ?? [],
      parPrice: getParPolicyPrice(meta),
      window: supplyBackfillWindow,
      signal,
    });
    if (historicalOnChainResult) {
      if (historicalOnChainResult.error) {
        errors.push(`${meta.symbol}: ${historicalOnChainResult.error}`);
        skippedDays += historicalOnChainResult.skippedDays ?? 0;
      } else {
        totalRows += historicalOnChainResult.rows;
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
          priceSeries: marketHistory ? normalizeCoinGeckoDailyPrices(marketHistory.prices) : [],
          requirePrice: true,
          parPrice: getParPolicyPrice(meta),
          window: supplyBackfillWindow,
          signal,
        });
        if (result.error) {
          errors.push(`${meta.symbol}: ${result.error}`);
          skippedDays += result.skippedDays ?? 0;
        } else {
          totalRows += result.rows;
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
      }
    } catch (err) {
      rethrowIfAborted(err, signal);
      errors.push(`${meta.symbol}: ${failureLabel} — ${err}`);
    }
  };

  for (const meta of coins) {
    throwIfAborted(signal);
    // Commodity tokens: backfill from CoinGecko market_chart (primary) or protocol TVL (fallback)
    const isCommodity = meta.flags.pegCurrency === "GOLD" || meta.flags.pegCurrency === "SILVER";
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

    // Determine if this coin needs native→USD conversion
    const isUsd = meta.flags.pegCurrency === "USD";
    const needsConversion = !isUsd;
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
              range: backfillWindowToFetchRange(supplyBackfillWindow),
              signal,
            })
          : Promise.resolve(null),
      ]);
      if (!detailResult?.response.ok) {
        errors.push(`${meta.symbol}: DL returned ${detailResult?.response.status ?? "no response"}`);
        continue;
      }
      detail = detailResult.body;

      historicalPrices = priceSeries?.prices ?? [];
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

    if (needsConversion && historicalPrices.length === 0) {
      const windowedTokens = tokens.filter((entry) =>
        isWithinBackfillWindow(bucketUnixSecondsToUtcDay(entry.date), supplyBackfillWindow),
      );
      const fxPrices = await fetchHistoricalPegFxPrices(db, meta, windowedTokens, signal);
      historicalPrices = fxPrices.map((point) => ({
        timestamp: point.timestamp,
        price: point.rate,
      }));
    }

    // For non-USD coins: require historical price data by default.
    // Optional emergency fallback can use current price for only a short recent window.
    const fallbackPrice = needsConversion && detail?.price ? detail.price : null;
    if (needsConversion && historicalPrices.length === 0) {
      if (!allowConstantPriceFallback) {
        errors.push(
          `${meta.symbol}: non-USD coin missing historical prices (set allow-constant-price-fallback=true for emergency short-window fallback)`,
        );
        continue;
      }
      if (!fallbackPrice) {
        errors.push(`${meta.symbol}: non-USD coin missing historical prices and fallback price`);
        continue;
      }
      const reason = !geckoId ? "no geckoId" : "price API returned no data";
      logWorkerEventArgs("api", "warn",
        `[backfill] ${meta.symbol}: ${reason}, using emergency constant fallback price $${fallbackPrice} for recent window only`,
      );
    }

    const priceBySnapshotDate = new Map<number, number>();
    const historicalRateSeries = historicalPrices.map((point) => ({
      timestamp: point.timestamp,
      rate: point.price,
    }));
    for (const point of historicalPrices) {
      const snapshotDate = bucketUnixSecondsToUtcDay(point.timestamp);
      priceBySnapshotDate.set(snapshotDate, point.price);
    }

    function findHistoricalPrice(snapshotDate: number): number | null {
      const exact = priceBySnapshotDate.get(snapshotDate);
      if (exact != null) return exact;
      if (needsConversion && historicalPrices.length > 0) {
        const first = historicalRateSeries[0];
        const last = historicalRateSeries[historicalRateSeries.length - 1];
        if (snapshotDate < first.timestamp || snapshotDate > last.timestamp) return null;
        const interpolated = interpolateRateAtTimestamp(historicalRateSeries, snapshotDate);
        return interpolated && interpolated > 0 ? interpolated : null;
      }
      return null;
    }

    const stmts: D1PreparedStatement[] = [];

    const fallbackWindowStart = Math.floor(Date.now() / 1000) - 7 * DAY_SECONDS;
    for (const entry of tokens) {
      throwIfAborted(signal);
      const circ = entry.circulating;
      if (!circ) continue;

      // This is the per-coin detail history payload, not the list cache: its
      // non-USD token history is native units, so the conversion below remains
      // intentional. List-endpoint circulating values are already USD.
      const rawSum = getCirculatingRaw(entry);
      if (rawSum <= 0) continue;

      // Floor to UTC midnight
      const snapshotDate = bucketUnixSecondsToUtcDay(entry.date);
      if (!isWithinBackfillWindow(snapshotDate, supplyBackfillWindow)) continue;
      let marketCapUsd: number;
      let price = findHistoricalPrice(snapshotDate);

      if (needsConversion) {
        // Non-USD: multiply native supply by USD price to get market cap
        if (price == null && allowConstantPriceFallback && fallbackPrice && entry.date >= fallbackWindowStart) {
          price = fallbackPrice;
        }
        if (!price || price <= 0) continue;
        marketCapUsd = rawSum * price;
      } else {
        // USD: rawSum is already in USD
        marketCapUsd = rawSum;
      }

      pushSupplyUpsert(stmts, db, meta.id, snapshotDate, marketCapUsd, price);
    }

    if (stmts.length > 0) {
      await batchExecute(db, stmts);
      totalRows += stmts.length;
    }
  }

  return jsonResponse(
    buildAdminJobSummary({
      coinsProcessed: coins.length,
      rowsInserted: totalRows,
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
