import { fetchWithRetry } from "../../lib/fetch-retry";
import { USER_AGENT } from "../../lib/constants";
import { makeDexApiFetchResult, type DexApiFetchResult, type DexApiPool } from "../../lib/dex-api-common";
import { classifyClPoolType } from "./direct-source-helpers";

const PAGE_SIZE = 250;
const MAX_PAGES = 8;
const DAY_DATA_BATCH_SIZE = 50;
const SUBGRAPH_TIMEOUT_MS = 15_000;

const PANCAKESWAP_V3_SUBGRAPHS: Record<string, { chain: string; subgraphId: string }> = {
  bsc: { chain: "bsc", subgraphId: "Hv1GncLY5docZoGtXjo4kwbTvxm3MAhVZqBZE4sUT9eZ" },
  ethereum: { chain: "ethereum", subgraphId: "CJYGNhb7RvnhfBDjqpRnD3oxgyhibzc7fkAMa38YV3oS" },
  arbitrum: { chain: "arbitrum", subgraphId: "251MHFNN1rwjErXD2efWMpNS73SANZN8Ua192zw6iXve" },
  base: { chain: "base", subgraphId: "BHWNsedAHtmTCzXxCCDfhPmm6iN9rxUhoRHdHKyujic3" },
};

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

type PoolDayData = {
  date: number;
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

function buildPoolDayDataQuery(poolIds: string[], cutoff: number): string {
  const ids = poolIds.map((id) => `"${id.toLowerCase()}"`).join(",");
  return `{
    poolDayDatas(
      first: 1000,
      orderBy: date,
      orderDirection: desc,
      where: { pool_in: [${ids}], date_gte: ${cutoff} }
    ) {
      date
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

async function fetchSubgraphJson<T>(subgraphUrl: string, query: string, signal?: AbortSignal): Promise<T> {
  const res = await fetchWithRetry(subgraphUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json", "User-Agent": USER_AGENT },
    body: JSON.stringify({ query }),
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(SUBGRAPH_TIMEOUT_MS)]) : AbortSignal.timeout(SUBGRAPH_TIMEOUT_MS),
  });
  if (!res?.ok) throw new Error(`returned ${res?.status ?? "unknown"}`);
  const json = await res.json() as { data?: T; errors?: Array<{ message?: string }> };
  if (json.errors?.length) {
    throw new Error(json.errors.map((entry) => entry.message ?? "unknown").join("; "));
  }
  if (!json.data) throw new Error("missing data");
  return json.data;
}

export async function fetchPancakeSwapPools(
  graphApiKey: string | null,
  signal?: AbortSignal,
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
  let successfulChains = 0;

  for (const { chain, subgraphId } of Object.values(PANCAKESWAP_V3_SUBGRAPHS)) {
    const subgraphUrl = `https://gateway.thegraph.com/api/${graphApiKey}/subgraphs/id/${subgraphId}`;
    try {
      let chainPoolCount = 0;
      for (let page = 0; page < MAX_PAGES; page++) {
        const data = await fetchSubgraphJson<{ pools?: V3Pool[] }>(subgraphUrl, buildPoolsQuery(page * PAGE_SIZE), signal);
        const pagePools = data.pools ?? [];
        if (pagePools.length === 0) break;

        const latestVolumeByPool = new Map<string, number>();
        const cutoff = Math.floor(Date.now() / 1000) - 86400;
        const dayDataPoolIdBatches = chunkPoolIds(pagePools.map((pool) => pool.id), DAY_DATA_BATCH_SIZE);
        let failedDayDataBatches = 0;
        for (let batchIndex = 0; batchIndex < dayDataPoolIdBatches.length; batchIndex++) {
          const poolIdBatch = dayDataPoolIdBatches[batchIndex]!;
          try {
            const dayData = await fetchSubgraphJson<{ poolDayDatas?: PoolDayData[] }>(
              subgraphUrl,
              buildPoolDayDataQuery(poolIdBatch, cutoff),
              signal,
            );

            for (const row of dayData.poolDayDatas ?? []) {
              const poolId = row.pool.id.toLowerCase();
              if (latestVolumeByPool.has(poolId)) continue;
              const volume = parseFloat(row.volumeUSD);
              latestVolumeByPool.set(poolId, Number.isFinite(volume) ? volume : 0);
            }
          } catch (error) {
            failedDayDataBatches++;
            const message = error instanceof Error ? error.message : String(error);
            console.warn(
              "[fetch-pancakeswap]",
              chain,
              "poolDayDatas",
              `page ${page + 1} batch ${batchIndex + 1}/${dayDataPoolIdBatches.length}`,
              message,
            );
          }
        }
        if (failedDayDataBatches > 0) {
          console.warn(
            "[fetch-pancakeswap]",
            chain,
            `page ${page + 1} completed with ${failedDayDataBatches}/${dayDataPoolIdBatches.length} dayData batch failures`,
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
            volume24hUsd: latestVolumeByPool.get(pool.id.toLowerCase()) ?? 0,
            feeRate: Number.isFinite(feeTier) && feeTier > 0 ? feeTier / 1_000_000 : null,
            balances: Number.isFinite(reserve0) && Number.isFinite(reserve1) ? [reserve0, reserve1] : null,
          });
          chainPoolCount++;
        }

        if (pagePools.length < PAGE_SIZE) break;
      }
      if (chainPoolCount > 0) {
        successfulChains++;
      }
    } catch (error) {
      errors.push(`${chain}: ${error instanceof Error ? error.message : String(error)}`);
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
  });
}
