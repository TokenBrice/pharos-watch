import {
  DIRECT_API_POOL_MIN_TVL_USD,
  makeDexApiFetchResult,
  type DexApiFetchResult,
  type DexApiPool,
} from "../../lib/dex-api-common";
import { isDexApiRecord } from "./direct-api-json";
import { runPaginatedDirectApiFetch } from "./direct-api-paginated";

const RAYDIUM_API = "https://api-v3.raydium.io/pools/info/list";
const PAGE_SIZE = 1000;

interface RaydiumPool {
  type: string;
  id: string;
  mintA: { address: string; symbol: string; decimals: number };
  mintB: { address: string; symbol: string; decimals: number };
  price: number;
  tvl: number;
  mintAmountA: number;
  mintAmountB: number;
  feeRate: number;
  day: { volume: number };
}

type RaydiumResponse = {
  success?: boolean;
  msg?: string;
  data?: { data?: unknown };
};

function isRaydiumToken(value: unknown): value is RaydiumPool["mintA"] {
  return isDexApiRecord(value) &&
    typeof value.address === "string" &&
    typeof value.symbol === "string" &&
    typeof value.decimals === "number" &&
    Number.isFinite(value.decimals);
}

function isRaydiumPool(value: unknown): value is RaydiumPool {
  return isDexApiRecord(value) &&
    typeof value.id === "string" &&
    isRaydiumToken(value.mintA) &&
    isRaydiumToken(value.mintB) &&
    isDexApiRecord(value.day) &&
    typeof value.tvl === "number" &&
    Number.isFinite(value.tvl);
}

async function fetchPoolType(
  poolType: "concentrated" | "standard",
  signal?: AbortSignal,
): Promise<DexApiFetchResult> {
  let consecutiveFullPagesWithoutEligiblePools = 0;
  const pageHasEligiblePool = new Map<number, boolean>();
  const malformedRowsByPage = new Map<number, number>();

  const result = await runPaginatedDirectApiFetch<DexApiPool>({
    source: poolType,
    buildUrl: (page) =>
      `${RAYDIUM_API}?poolType=${poolType}&poolSortField=liquidity&sortType=desc&pageSize=${PAGE_SIZE}&page=${page}`,
    pageSize: PAGE_SIZE,
    signal,
    parsePage: (body, page) => {
      const json = body as RaydiumResponse;
      if (json.success === false) {
        return { error: `${poolType} page ${page} API error: ${json.msg ?? "unsuccessful response"}` };
      }

      const pools = json.data?.data;
      return Array.isArray(pools) ? pools : { error: `${poolType} page ${page} returned malformed body` };
    },
    mapRow: (rawPool, { page }) => {
      if (!isRaydiumPool(rawPool)) {
        malformedRowsByPage.set(page, (malformedRowsByPage.get(page) ?? 0) + 1);
        return null;
      }

      const pool = rawPool;
      if (!Number.isFinite(pool.tvl) || pool.tvl < DIRECT_API_POOL_MIN_TVL_USD) {
        return null;
      }
      pageHasEligiblePool.set(page, true);

      const isConcentrated = poolType === "concentrated";
      return {
        source: "raydium",
        chain: "solana",
        poolAddress: pool.id,
        poolType: isConcentrated ? "raydium-clmm" : "raydium-amm",
        tokens: [
          { address: pool.mintA.address, symbol: pool.mintA.symbol, decimals: pool.mintA.decimals },
          { address: pool.mintB.address, symbol: pool.mintB.symbol, decimals: pool.mintB.decimals },
        ],
        price: Number.isFinite(pool.price) && pool.price > 0 ? pool.price : null,
        tvlUsd: pool.tvl,
        volume24hUsd: Number.isFinite(pool.day?.volume) ? pool.day.volume : 0,
        feeRate: Number.isFinite(pool.feeRate) ? pool.feeRate : null,
        balances: [pool.mintAmountA, pool.mintAmountB].every(Number.isFinite)
          ? [pool.mintAmountA, pool.mintAmountB]
          : null,
      };
    },
    afterPage: ({ errors, page, rawRows }) => {
      const malformedRows = malformedRowsByPage.get(page) ?? 0;
      if (malformedRows > 0) {
        errors.push(`${poolType} page ${page} skipped ${malformedRows} malformed pool rows`);
      }

      if (rawRows.length < PAGE_SIZE) {
        return;
      }
      if (!pageHasEligiblePool.get(page)) {
        consecutiveFullPagesWithoutEligiblePools++;
        if (consecutiveFullPagesWithoutEligiblePools >= 2) {
          console.log(
            `[fetch-raydium] ${poolType} stopped after ${consecutiveFullPagesWithoutEligiblePools} ` +
              `full page(s) below TVL threshold; resumeFromPage=${page + 1}`,
          );
          return "stop";
        }
      } else {
        consecutiveFullPagesWithoutEligiblePools = 0;
      }
    },
  });

  for (const error of result.errors) {
    console.warn("[fetch-raydium]", error);
  }
  return makeDexApiFetchResult(result.rows, {
    ok: result.successfulPages > 0,
    degraded: result.errors.length > 0,
    errors: result.errors,
  });
}

export async function fetchRaydiumPools(signal?: AbortSignal): Promise<DexApiFetchResult> {
  const [concentrated, standard] = await Promise.allSettled([
    fetchPoolType("concentrated", signal),
    fetchPoolType("standard", signal),
  ]);

  const results: DexApiPool[] = [];
  const errors: string[] = [];
  let ok = false;
  let degraded = false;

  for (const [label, settled] of [
    ["concentrated", concentrated],
    ["standard", standard],
  ] as const) {
    if (settled.status === "fulfilled") {
      results.push(...settled.value.pools);
      ok = ok || settled.value.ok;
      degraded = degraded || settled.value.degraded;
      errors.push(...settled.value.errors);
    } else {
      const message = settled.reason instanceof Error ? settled.reason.message : String(settled.reason);
      errors.push(`${label} request failed: ${message}`);
      degraded = true;
    }
  }

  if (results.length > 0) {
    console.log(`[fetch-raydium] Fetched ${results.length} pools`);
  }
  return makeDexApiFetchResult(results, { ok, degraded, errors });
}
