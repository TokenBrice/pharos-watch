import { PSI_ELIGIBLE_STABLECOINS, PSI_ELIGIBLE_META_BY_ID } from "@shared/lib/psi-eligible";
import { DAY_SECONDS } from "@shared/lib/time-constants";
import { sumPegBuckets } from "@shared/lib/supply";
import type { ContractDeployment } from "@shared/types/core";
import { DEFILLAMA_BASE, DEFILLAMA_API, DEFILLAMA_COINS, USER_AGENT } from "../lib/constants";
import { fetchCoinGeckoMarketHistory } from "../lib/coingecko-market-history";
import type { ChainRpcConfig } from "../lib/chain-registry";
import { batchExecute } from "../lib/db";
import { jsonResponse } from "../lib/api-utils";
import { binarySearchNearest } from "../lib/binary-search";
import { resolveMarketCap } from "../lib/resolve-market-cap";
import { selectBackfillCoins } from "../lib/backfill-query";
import { buildAdminJobSummary, noAdminTargetsResponse, runAdminJob } from "../lib/admin-job";
import { fetchWithRetry } from "../lib/fetch-retry";
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
import { getArchiveFallbackRpcUrls } from "../lib/public-rpc-registry";
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
} from "./backfill-fx";

const DEFAULT_BATCH_SIZE = 10;

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
): Promise<TimestampedRatePoint[]> {
  const range = tokenHistoryDateRange(tokens);
  if (!range) return [];

  const peg = meta.flags.pegCurrency;
  const primaryFx = PEG_TO_FX[peg] ?? OTHER_COIN_FX[meta.id];
  if (primaryFx) {
    const series = await fetchHistoricalFxRates([primaryFx], range.startDate, range.endDate);
    return series[primaryFx] ?? [];
  }

  const secondaryFx = SECONDARY_PEG_TO_FX[peg];
  if (secondaryFx) {
    const series = await fetchHistoricalSecondaryFxRates(db, [secondaryFx], range.startDate, range.endDate);
    return series[secondaryFx] ?? [];
  }

  return [];
}

// Commodity tokens: use CoinGecko market_chart (historical market caps) as primary source.
// Protocol TVL from DefiLlama can diverge from token market cap (e.g. XAUT TVL includes
// multi-chain reserves that far exceed the token's market cap).

function firstEvmContract(contracts?: ContractDeployment[]): ContractDeployment | null {
  return contracts?.find((c) => c.chain !== "solana" && c.chain !== "stellar" && c.chain !== "tron") ?? null;
}

function isWithinBackfillWindow(snapshotDate: number, window?: SupplyBackfillWindow): boolean {
  if (window?.startDay != null && snapshotDate < window.startDay) return false;
  if (window?.endDay != null && snapshotDate > window.endDay) return false;
  return true;
}

function getLastCompletedUtcDay(nowSec = Math.floor(Date.now() / 1000)): number {
  return Math.floor((nowSec - DAY_SECONDS) / DAY_SECONDS) * DAY_SECONDS;
}

async function fetchOnChainTotalSupply(
  contracts: ContractDeployment[] | undefined,
  chainRpcs: Map<string, ChainRpcConfig> | undefined,
  logLabel: string,
): Promise<number | null> {
  const contract = firstEvmContract(contracts);
  if (!contract || !chainRpcs) return null;

  try {
    const raw = await fetchEvmUint256AtBlock(contract.chain, contract.address, TOTAL_SUPPLY_SELECTOR, "latest", {
      chainRpcs,
      timeoutMs: 10_000,
    });
    if (raw == null || raw <= 0n) return null;
    const supply = Number(raw) / 10 ** (contract.decimals ?? 18);
    if (!Number.isFinite(supply) || supply <= 0) return null;
    console.log(`[backfill-commodity] ${logLabel}: on-chain totalSupply fallback = ${supply.toFixed(2)} units`);
    return supply;
  } catch (err) {
    console.warn(`[backfill-commodity] ${logLabel}: on-chain totalSupply probe failed — ${String(err).slice(0, 200)}`);
    return null;
  }
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

async function fetchHistoricalAdjustedSupplyRaw(input: {
  contract: ContractDeployment;
  holderAddresses: readonly string[];
  blockNumber: number;
  chainRpcs?: Map<string, ChainRpcConfig>;
}): Promise<bigint | null> {
  const rpcOptions = {
    chainRpcs: input.chainRpcs,
    extraRpcUrls: getArchiveFallbackRpcUrls(input.contract.chain),
    timeoutMs: 15_000,
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

async function backfillHistoricalOnChainSupply(
  db: D1Database,
  meta: (typeof PSI_ELIGIBLE_STABLECOINS)[number],
  options: {
    chainRpcs?: Map<string, ChainRpcConfig>;
    window?: SupplyBackfillWindow;
  },
): Promise<{ rows: number; error?: string } | null> {
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

  const blockSearchCache: EvmBlockSearchCache = { blockTimestampByNumber: new Map() };
  const stmts: D1PreparedStatement[] = [];
  let blockMisses = 0;
  let supplyMisses = 0;

  for (let snapshotDate = startDay; snapshotDate <= endDay; snapshotDate += DAY_SECONDS) {
    if (!isWithinBackfillWindow(snapshotDate, options.window)) continue;

    const targetTimestamp = snapshotDate + DAY_SECONDS - 1;
    const blockNumber = await resolveClosestBlockAtOrBeforeTimestamp(
      contract.chain,
      targetTimestamp,
      blockSearchCache,
      {
        chainRpcs: options.chainRpcs,
        extraRpcUrls: getArchiveFallbackRpcUrls(contract.chain),
        timeoutMs: 15_000,
      },
    );
    if (blockNumber == null) {
      blockMisses += 1;
      continue;
    }

    const adjustedRaw = await fetchHistoricalAdjustedSupplyRaw({
      contract,
      holderAddresses: exclusionConfig.holderAddresses,
      blockNumber,
      chainRpcs: options.chainRpcs,
    });
    if (adjustedRaw == null) {
      supplyMisses += 1;
      continue;
    }

    const supply = rawTokenAmountToNumber(adjustedRaw, contract.decimals ?? 18);
    if (supply == null) {
      supplyMisses += 1;
      continue;
    }

    stmts.push(
      db
        .prepare(
          "INSERT OR REPLACE INTO supply_history (stablecoin_id, snapshot_date, circulating_usd, price) VALUES (?, ?, ?, ?)",
        )
        .bind(meta.id, snapshotDate, supply, null),
    );
  }

  if (stmts.length === 0) {
    return {
      rows: 0,
      error: `historical on-chain supply backfill wrote 0 rows (blockMisses=${blockMisses}, supplyMisses=${supplyMisses})`,
    };
  }

  await batchExecute(db, stmts);
  if (blockMisses > 0 || supplyMisses > 0) {
    console.warn(
      `[backfill-supply] ${meta.symbol}: historical on-chain supply skipped ${blockMisses} block lookup(s) and ${supplyMisses} supply read(s)`,
    );
  }
  return { rows: stmts.length };
}

async function backfillCommodity(
  db: D1Database,
  id: string,
  config: {
    geckoId: string;
    protocolSlug?: string;
    cgApiKey?: string | null;
    contracts?: ContractDeployment[];
    chainRpcs?: Map<string, ChainRpcConfig>;
    window?: SupplyBackfillWindow;
  },
): Promise<{ rows: number; error?: string }> {
  const marketHistory = await fetchCoinGeckoMarketHistory(config.geckoId, {
    apiKey: config.cgApiKey ?? null,
    onCoinDetailFailure: (status) => {
      console.warn(
        `[backfill-commodity] ${config.geckoId}: coin detail fetch failed (${status}), sanity check skipped`,
      );
    },
  });

  let fallthroughReason = "CoinGecko market_chart returned no data";
  if (marketHistory?.prices.length) {
    fallthroughReason =
      "CoinGecko market caps all zero and on-chain totalSupply unavailable (no EVM contract or chainRpcs)";
    // Build a date-keyed map of cgMcap so we can pair each price point with its matching cap.
    const cgMcapByDate = new Map<string, number>();
    for (const [ts, mcap] of marketHistory.marketCaps) {
      if (Number.isFinite(mcap)) {
        cgMcapByDate.set(new Date(ts).toISOString().slice(0, 10), mcap);
      }
    }

    // CoinGecko's circulating_supply is often 0 for brand-new coins until its data
    // ingestion catches up. Fall back to on-chain totalSupply (same strategy the live
    // sync uses via fetchFiatCoinGeckoTokens) so `resolveMarketCap` can compute
    // supply × price when the CG market_cap series is all zeros.
    let effectiveSupply = marketHistory.circulatingSupply;
    if (!effectiveSupply || effectiveSupply <= 0) {
      const onChain = await fetchOnChainTotalSupply(config.contracts, config.chainRpcs, `${id} (${config.geckoId})`);
      if (onChain != null) effectiveSupply = onChain;
    }

    const stmts: D1PreparedStatement[] = [];
    const seenSnapshotDates = new Set<number>();

    for (const [ts, price] of marketHistory.prices) {
      if (!Number.isFinite(price) || price <= 0) continue;
      const snapshotDate = Math.floor(ts / 1000 / DAY_SECONDS) * DAY_SECONDS;
      if (seenSnapshotDates.has(snapshotDate)) continue;
      if (!isWithinBackfillWindow(snapshotDate, config.window)) continue;
      const cgMcap = cgMcapByDate.get(new Date(ts).toISOString().slice(0, 10));
      const resolvedMcap = resolveMarketCap(cgMcap, effectiveSupply, price);
      if (!Number.isFinite(resolvedMcap) || resolvedMcap <= 0) continue;

      seenSnapshotDates.add(snapshotDate);
      stmts.push(
        db
          .prepare(
            "INSERT OR REPLACE INTO supply_history (stablecoin_id, snapshot_date, circulating_usd, price) VALUES (?, ?, ?, ?)",
          )
          .bind(id, snapshotDate, resolvedMcap, price),
      );
    }

    if (stmts.length > 0) {
      await batchExecute(db, stmts);
      return { rows: stmts.length };
    }
    // Fell through: CG had prices but no usable mcap (all zero) and on-chain supply unavailable.
    // Fall back to the protocol-TVL path below when possible, otherwise return a clear error.
  }

  // Fallback: protocol TVL (only if TVL ≈ mcap)
  if (!config.protocolSlug) {
    return { rows: 0, error: `${fallthroughReason}; no protocolSlug for TVL fallback` };
  }

  const [protocolRes, priceRes] = await Promise.all([
    fetchWithRetry(`${DEFILLAMA_API}/protocol/${config.protocolSlug}`, {
      headers: { "User-Agent": USER_AGENT },
    }),
    fetchWithRetry(`${DEFILLAMA_COINS}/chart/coingecko:${config.geckoId}?start=0&span=500`, {
      headers: { "User-Agent": USER_AGENT },
    }),
  ]);

  if (!protocolRes?.ok) {
    return { rows: 0, error: `protocol API returned ${protocolRes?.status ?? "no response"}` };
  }

  const protocolData = (await protocolRes.json()) as {
    mcap?: number;
    tvl?: { date: number; totalLiquidityUSD: number }[];
  };
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
  if (priceRes?.ok) {
    prices = extractDefiLlamaCoinChartPrices(await priceRes.json(), config.geckoId);
  }

  function findPrice(date: number): number | null {
    return binarySearchNearest(prices, date, (p) => p.timestamp)?.price ?? null;
  }

  const stmts: D1PreparedStatement[] = [];
  for (const point of tvlHistory) {
    const mcap = point.totalLiquidityUSD;
    if (mcap <= 0) continue;
    const snapshotDate = Math.floor(point.date / DAY_SECONDS) * DAY_SECONDS;
    const price = findPrice(point.date);
    if (!isWithinBackfillWindow(snapshotDate, config.window)) continue;
    stmts.push(
      db
        .prepare(
          "INSERT OR REPLACE INTO supply_history (stablecoin_id, snapshot_date, circulating_usd, price) VALUES (?, ?, ?, ?)",
        )
        .bind(id, snapshotDate, mcap, price),
    );
  }

  if (stmts.length > 0) {
    await batchExecute(db, stmts);
  }
  return { rows: stmts.length };
}

export interface BackfillSupplyHistoryRouteContext {
  db: D1Database;
  url: URL;
  coingeckoApiKey?: string | null;
  chainRpcs?: Map<string, ChainRpcConfig>;
}

async function executeBackfillSupplyHistory(
  db: D1Database,
  url: URL,
  cgApiKey?: string | null,
  chainRpcs?: Map<string, ChainRpcConfig>,
): Promise<Response> {
  const allowConstantPriceFallback = url.searchParams.get("allow-constant-price-fallback") === "true";
  const dayWindow = parseOptionalDayWindow(url, {
    maxEndDay: getLastCompletedUtcDay(),
    invalidDayMessage: "Invalid startDay/endDay. Use Unix seconds/milliseconds or YYYY-MM-DD.",
  });
  if (dayWindow instanceof Response) return dayWindow;
  const supplyBackfillWindow: SupplyBackfillWindow = {
    startDay: dayWindow.startDay,
    endDay: dayWindow.endDay,
  };

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
  const errors: string[] = [];
  const skipped: string[] = [];

  const runCoinGeckoMarketChartBackfill = async (meta: (typeof coins)[number], failureLabel: string): Promise<void> => {
    const historicalOnChainResult = await backfillHistoricalOnChainSupply(db, meta, {
      chainRpcs,
      window: supplyBackfillWindow,
    });
    if (historicalOnChainResult) {
      if (historicalOnChainResult.error) {
        errors.push(`${meta.symbol}: ${historicalOnChainResult.error}`);
      } else {
        totalRows += historicalOnChainResult.rows;
      }
      return;
    }

    if (!meta.geckoId) {
      skipped.push(meta.symbol);
      return;
    }

    try {
      const result = await backfillCommodity(db, meta.id, {
        geckoId: meta.geckoId,
        protocolSlug: meta.protocolSlug ?? undefined,
        cgApiKey,
        contracts: meta.contracts,
        chainRpcs,
        window: supplyBackfillWindow,
      });
      if (result.error) {
        errors.push(`${meta.symbol}: ${result.error}`);
      } else {
        totalRows += result.rows;
      }
    } catch (err) {
      errors.push(`${meta.symbol}: ${failureLabel} — ${err}`);
    }
  };

  for (const meta of coins) {
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
      const [detailRes, priceSeries] = await Promise.all([
        fetchWithRetry(`${DEFILLAMA_BASE}/stablecoin/${encodeURIComponent(dlId)}`, {
          headers: { "User-Agent": USER_AGENT },
        }),
        geckoId
          ? fetchMarketBackfillPriceSeries(meta, geckoId, {
              granularity: "daily",
              coingeckoApiKey: cgApiKey ?? null,
            })
          : Promise.resolve(null),
      ]);
      if (!detailRes?.ok) {
        errors.push(`${meta.symbol}: DL returned ${detailRes?.status ?? "no response"}`);
        continue;
      }
      detail = (await detailRes.json()) as StablecoinDetail;

      historicalPrices = priceSeries?.prices ?? [];
    } catch (err) {
      errors.push(`${meta.symbol}: fetch failed — ${err}`);
      continue;
    }

    const tokens = detail?.tokens;
    if (!tokens || tokens.length === 0) {
      skipped.push(meta.symbol);
      continue;
    }

    if (needsConversion && historicalPrices.length === 0) {
      const fxPrices = await fetchHistoricalPegFxPrices(db, meta, tokens);
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
      console.warn(
        `[backfill] ${meta.symbol}: ${reason}, using emergency constant fallback price $${fallbackPrice} for recent window only`,
      );
    }

    const priceBySnapshotDate = new Map<number, number>();
    const historicalRateSeries = historicalPrices.map((point) => ({
      timestamp: point.timestamp,
      rate: point.price,
    }));
    for (const point of historicalPrices) {
      const snapshotDate = Math.floor(point.timestamp / DAY_SECONDS) * DAY_SECONDS;
      priceBySnapshotDate.set(snapshotDate, point.price);
    }

    function findHistoricalPrice(snapshotDate: number): number | null {
      const exact = priceBySnapshotDate.get(snapshotDate);
      if (exact != null) return exact;
      if (needsConversion && historicalPrices.length > 0) {
        const interpolated = interpolateRateAtTimestamp(historicalRateSeries, snapshotDate);
        return interpolated && interpolated > 0 ? interpolated : null;
      }
      return null;
    }

    const stmts: D1PreparedStatement[] = [];

    const fallbackWindowStart = Math.floor(Date.now() / 1000) - 7 * DAY_SECONDS;
    for (const entry of tokens) {
      const circ = entry.circulating;
      if (!circ) continue;

      // Sum across all peg buckets (native currency for non-USD, USD for USD coins)
      const rawSum = sumPegBuckets(circ);
      if (rawSum <= 0) continue;

      // Floor to UTC midnight
      const snapshotDate = Math.floor(entry.date / DAY_SECONDS) * DAY_SECONDS;
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

      stmts.push(
        db
          .prepare(
            "INSERT OR REPLACE INTO supply_history (stablecoin_id, snapshot_date, circulating_usd, price) VALUES (?, ?, ?, ?)",
          )
          .bind(meta.id, snapshotDate, marketCapUsd, price),
      );
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
      skipped,
      errors,
    }),
  );
}

export function handleBackfillSupplyHistoryTrusted({
  db,
  url,
  coingeckoApiKey,
  chainRpcs,
}: BackfillSupplyHistoryRouteContext): Promise<Response> {
  return executeBackfillSupplyHistory(db, url, coingeckoApiKey, chainRpcs);
}

export async function handleBackfillSupplyHistory(
  db: D1Database,
  url: URL,
  trustedAdmin?: boolean,
  request?: Request,
  cgApiKey?: string | null,
  chainRpcs?: Map<string, ChainRpcConfig>,
): Promise<Response> {
  return runAdminJob({ request, trustedAdmin, url }, () => executeBackfillSupplyHistory(db, url, cgApiKey, chainRpcs));
}
