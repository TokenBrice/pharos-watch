import { fetchTextWithRetry } from "../../lib/fetch-retry";
import { rethrowIfAborted, throwIfAborted } from "../../lib/abort";
import { DAY_SECONDS } from "@shared/lib/time-constants";
import { USER_AGENT } from "../../lib/constants";
import { makeDexApiFetchResult, type DexApiFetchResult, type DexApiPool } from "../../lib/dex-api-common";
import { classifyClPoolType } from "./direct-source-helpers";
import { toErrorMessage } from "../../lib/error-utils";
import {
  DIRECT_API_REQUEST_TIMEOUT_MS,
  buildDirectApiRequestSignal,
} from "./direct-api-policy";
import {
  readDexSourcePaginationState,
  writeDexSourcePaginationState,
} from "./source-pagination-state";

const PAGE_SIZE = 250;
const TAIL_PAGES_PER_RUN = 2;
// `poolHourDatas(first: 1000)` can safely cover 40 pools over 24 hourly buckets (40 * 24 = 960 rows max).
const HOUR_DATA_BATCH_SIZE = 40;
const SUBGRAPH_TIMEOUT_MS = DIRECT_API_REQUEST_TIMEOUT_MS;

// Keep Pancake coverage on the subgraphs that stay within the worker cron budget reliably.
const PANCAKESWAP_V3_SUBGRAPHS: Record<string, { chain: string; subgraphId: string }> = {
  bsc: { chain: "bsc", subgraphId: "Hv1GncLY5docZoGtXjo4kwbTvxm3MAhVZqBZE4sUT9eZ" },
  ethereum: { chain: "ethereum", subgraphId: "CJYGNhb7RvnhfBDjqpRnD3oxgyhibzc7fkAMa38YV3oS" },
  base: { chain: "base", subgraphId: "BHWNsedAHtmTCzXxCCDfhPmm6iN9rxUhoRHdHKyujic3" },
};

export function buildPancakePageSkips(cursor: string | null): number[] {
  const storedSkip = Number.parseInt(cursor ?? "", 10);
  const tailStartSkip = Number.isFinite(storedSkip) && storedSkip >= PAGE_SIZE ? storedSkip : PAGE_SIZE;
  return [
    0,
    ...Array.from({ length: TAIL_PAGES_PER_RUN }, (_, index) => tailStartSkip + index * PAGE_SIZE),
  ];
}

type V3Pool = {
  id: string;
  feeTier: string;
  totalValueLockedUSD: string;
  totalValueLockedToken0: string;
  totalValueLockedToken1: string;
  token0Price: string;
  token1Price: string;
  token0: { id: string; symbol: string; decimals: string };
  token1: { id: string; symbol: string; decimals: string };
};

type PoolHourData = {
  periodStartUnix: number;
  volumeUSD: string;
  pool: { id: string };
};

function buildPoolsQuery(skip: number): string {
  return `{
    pools(
      first: ${PAGE_SIZE},
      skip: ${skip},
      orderBy: totalValueLockedUSD,
      orderDirection: desc,
      where: { totalValueLockedUSD_gt: "10000" }
    ) {
      id
      feeTier
      totalValueLockedUSD
      totalValueLockedToken0
      totalValueLockedToken1
      token0Price
      token1Price
      token0 { id symbol decimals }
      token1 { id symbol decimals }
    }
  }`;
}

function buildPoolHourDataQuery(poolIds: string[], oldestIncludedHourStart: number, currentHourStart: number): string {
  const ids = poolIds.map((id) => `"${id.toLowerCase()}"`).join(",");
  return `{
    poolHourDatas(
      first: 1000,
      orderBy: periodStartUnix,
      orderDirection: desc,
      where: {
        pool_in: [${ids}],
        periodStartUnix_gt: ${oldestIncludedHourStart},
        periodStartUnix_lte: ${currentHourStart}
      }
    ) {
      periodStartUnix
      volumeUSD
      pool { id }
    }
  }`;
}

function chunkPoolIds(poolIds: string[], chunkSize: number): string[][] {
  const chunks: string[][] = [];
  for (let index = 0; index < poolIds.length; index += chunkSize) {
    chunks.push(poolIds.slice(index, index + chunkSize));
  }
  return chunks;
}

function summarizeBodySnippet(body: string): string {
  return body
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120);
}

async function fetchSubgraphJson<T>(subgraphUrl: string, query: string, signal?: AbortSignal): Promise<T> {
  const result = await fetchTextWithRetry(subgraphUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json", "User-Agent": USER_AGENT },
    body: JSON.stringify({ query }),
    signal: buildDirectApiRequestSignal(signal, SUBGRAPH_TIMEOUT_MS),
  });
  if (!result?.response.ok) throw new Error(`returned ${result?.response.status ?? "unknown"}`);

  const rawBody = result.body;
  let json: { data?: T; errors?: Array<{ message?: string }> };
  try {
    json = JSON.parse(rawBody) as { data?: T; errors?: Array<{ message?: string }> };
  } catch (error) {
    throw new Error(
      `invalid-json: ${
        toErrorMessage(error)
      }; body=${summarizeBodySnippet(rawBody)}`,
    );
  }

  if (json.errors?.length) {
    throw new Error(json.errors.map((entry) => entry.message ?? "unknown").join("; "));
  }
  if (!json.data) throw new Error("missing data");
  return json.data;
}

export async function fetchPancakeSwapPools(
  graphApiKey: string | null,
  signal?: AbortSignal,
  db?: D1Database,
): Promise<DexApiFetchResult> {
  if (!graphApiKey) {
    return makeDexApiFetchResult([], {
      ok: false,
      degraded: true,
      errors: ["missing GRAPH_API_KEY"],
    });
  }

  const pools: DexApiPool[] = [];
  const errors: string[] = [];
  const warnings: string[] = [];
  let successfulChains = 0;
  let pagesFetched = 0;
  let partialChains = 0;
  const currentHourStart = Math.floor(Date.now() / 1000 / 3600) * 3600;
  const oldestIncludedHourStart = currentHourStart - DAY_SECONDS;

  for (const { chain, subgraphId } of Object.values(PANCAKESWAP_V3_SUBGRAPHS)) {
    throwIfAborted(signal);
    const subgraphUrl = `https://gateway.thegraph.com/api/${graphApiKey}/subgraphs/id/${subgraphId}`;
    const sourceKey = `pancakeswap-v3:${chain}`;
    const nowSec = Math.floor(Date.now() / 1000);
    const paginationState = await readDexSourcePaginationState(db, sourceKey);
    const pageSkips = buildPancakePageSkips(paginationState.cursor);
    const tailStartSkip = pageSkips[1] ?? PAGE_SIZE;
    let nextCursor: number | null = tailStartSkip;
    let cycleCompleted = false;
    let chainPagesFetched = 0;
    try {
      for (let pageIndex = 0; pageIndex < pageSkips.length; pageIndex++) {
        const skip = pageSkips[pageIndex]!;
        const displayPage = skip / PAGE_SIZE + 1;
        throwIfAborted(signal);
        const data = await fetchSubgraphJson<{ pools?: V3Pool[] }>(subgraphUrl, buildPoolsQuery(skip), signal);
        chainPagesFetched++;
        pagesFetched++;
        const pagePools = data.pools ?? [];
        if (pagePools.length === 0) {
          cycleCompleted = true;
          nextCursor = PAGE_SIZE;
          break;
        }

        const volume24hByPool = new Map<string, number>();
        const hourDataPoolIdBatches = chunkPoolIds(pagePools.map((pool) => pool.id), HOUR_DATA_BATCH_SIZE);
        let failedHourDataBatches = 0;
        for (let batchIndex = 0; batchIndex < hourDataPoolIdBatches.length; batchIndex++) {
          throwIfAborted(signal);
          const poolIdBatch = hourDataPoolIdBatches[batchIndex]!;
          try {
            const hourData = await fetchSubgraphJson<{ poolHourDatas?: PoolHourData[] }>(
              subgraphUrl,
              buildPoolHourDataQuery(poolIdBatch, oldestIncludedHourStart, currentHourStart),
              signal,
            );

            for (const row of hourData.poolHourDatas ?? []) {
              const poolId = row.pool.id.toLowerCase();
              const volume = parseFloat(row.volumeUSD);
              const validVolume = Number.isFinite(volume) ? volume : 0;
              volume24hByPool.set(poolId, (volume24hByPool.get(poolId) ?? 0) + validVolume);
            }
          } catch (error) {
            rethrowIfAborted(error, signal);
            failedHourDataBatches++;
            const message = toErrorMessage(error);
            console.warn(
              "[fetch-pancakeswap]",
              chain,
              "poolHourDatas",
              `page ${displayPage} batch ${batchIndex + 1}/${hourDataPoolIdBatches.length}`,
              message,
            );
          }
        }
        if (failedHourDataBatches > 0) {
          console.warn(
            "[fetch-pancakeswap]",
            chain,
            `page ${displayPage} completed with ${failedHourDataBatches}/${hourDataPoolIdBatches.length} hourData batch failures`,
          );
          warnings.push(
            `${chain} page ${displayPage} had ${failedHourDataBatches}/${hourDataPoolIdBatches.length} volume batch failures`,
          );
        }

        for (const pool of pagePools) {
          const tvlUsd = parseFloat(pool.totalValueLockedUSD);
          if (!Number.isFinite(tvlUsd) || tvlUsd <= 0) continue;

          const feeTier = parseInt(pool.feeTier, 10);
          const feeBps = Number.isFinite(feeTier) ? feeTier / 100 : 5;
          const reserve0 = parseFloat(pool.totalValueLockedToken0);
          const reserve1 = parseFloat(pool.totalValueLockedToken1);
          const token0Price = parseFloat(pool.token0Price);

          pools.push({
            source: "pancakeswap",
            chain,
            poolAddress: pool.id,
            poolType: classifyClPoolType("pancakeswap", feeBps),
            tokens: [
              {
                address: pool.token0.id,
                symbol: pool.token0.symbol,
                decimals: parseInt(pool.token0.decimals, 10) || 18,
              },
              {
                address: pool.token1.id,
                symbol: pool.token1.symbol,
                decimals: parseInt(pool.token1.decimals, 10) || 18,
              },
            ],
            price: Number.isFinite(token0Price) && token0Price > 0 ? token0Price : null,
            tvlUsd,
            volume24hUsd: volume24hByPool.get(pool.id.toLowerCase()) ?? 0,
            feeRate: Number.isFinite(feeTier) && feeTier > 0 ? feeTier / 1_000_000 : null,
            balances: Number.isFinite(reserve0) && Number.isFinite(reserve1) ? [reserve0, reserve1] : null,
          });
        }

        if (pagePools.length < PAGE_SIZE) {
          cycleCompleted = true;
          nextCursor = PAGE_SIZE;
          break;
        }
        if (skip > 0) nextCursor = skip + PAGE_SIZE;
      }
      if (chainPagesFetched > 0) {
        successfulChains++;
        if (!cycleCompleted) {
          partialChains++;
          warnings.push(`${chain}: pagination partial; resumeFromSkip=${nextCursor}`);
        }
        await writeDexSourcePaginationState({
          db,
          sourceKey,
          cursor: String(nextCursor ?? PAGE_SIZE),
          cycleStartedAt: cycleCompleted ? nowSec : (paginationState.cycleStartedAt ?? nowSec),
          nowSec,
          completed: cycleCompleted,
          pagesFetched: chainPagesFetched,
          diagnostics: warnings.filter((warning) => warning.startsWith(`${chain}:`) || warning.startsWith(`${chain} page`)),
        });
      }
    } catch (error) {
      rethrowIfAborted(error, signal);
      errors.push(`${chain}: ${toErrorMessage(error)}`);
      console.warn("[fetch-pancakeswap]", chain, error);
    }
  }

  if (pools.length > 0) {
    console.log(`[fetch-pancakeswap] Fetched ${pools.length} pools`);
  }

  return makeDexApiFetchResult(pools, {
    ok: successfulChains > 0,
    degraded: errors.length > 0,
    errors,
    warnings,
    pagination: {
      state: partialChains > 0 ? "partial" : "complete",
      headRefreshed: successfulChains === Object.keys(PANCAKESWAP_V3_SUBGRAPHS).length,
      pagesFetched,
      cursor: partialChains > 0 ? `${partialChains}-chain-tail(s)` : null,
      cycleCompleted: partialChains === 0,
    },
  });
}
