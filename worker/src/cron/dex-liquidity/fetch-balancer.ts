import { makeDexApiFetchResult, type DexApiFetchResult, type DexApiPool } from "../../lib/dex-api-common";
import { USER_AGENT } from "../../lib/constants";

const BALANCER_API = "https://api-v3.balancer.fi/";

/** Balancer chain enum values mapped to our internal chain keys */
const BALANCER_CHAIN_MAP: Record<string, string> = {
  MAINNET: "ethereum",
  ARBITRUM: "arbitrum",
  BASE: "base",
  POLYGON: "polygon",
  OPTIMISM: "optimism",
  GNOSIS: "gnosis",
  AVALANCHE: "avalanche",
  SONIC: "sonic",
  FANTOM: "fantom",
  FRAXTAL: "fraxtal",
  MODE: "mode",
  ZKEVM: "polygon-zkevm",
  PLASMA: "plasma",
  MONAD: "monad",
  HYPEREVM: "hyperevm",
  XLAYER: "xlayer",
};

const STABLE_POOL_TYPES = new Set([
  "STABLE", "COMPOSABLE_STABLE", "META_STABLE", "PHANTOM_STABLE", "GYRO", "GYROE",
]);
const SUPPORTED_POOL_TYPES = new Set([...STABLE_POOL_TYPES, "WEIGHTED"]);

const QUERY = `query($first: Int!, $skip: Int!) {
  poolGetPools(
    first: $first,
    skip: $skip,
    orderBy: totalLiquidity,
    orderDirection: desc,
    where: { minTvl: 10000 }
  ) {
    id
    type
    chain
    dynamicData { totalLiquidity volume24h swapFee }
    poolTokens { address symbol decimals balance balanceUSD weight }
  }
}`;

interface BalancerPool {
  id: string;
  type: string;
  chain: string;
  dynamicData: { totalLiquidity: string; volume24h: string; swapFee: string };
  poolTokens: { address: string; symbol: string; decimals: number; balance: string; balanceUSD: string; weight?: string | null }[];
}

export async function fetchBalancerPools(signal?: AbortSignal): Promise<DexApiFetchResult> {
  const results: DexApiPool[] = [];
  const errors: string[] = [];
  let skip = 0;
  const pageSize = 1000;
  let successfulPages = 0;

  while (true) {
    let res: Response;
    try {
      res = await fetch(BALANCER_API, {
        method: "POST",
        headers: { "Content-Type": "application/json", "User-Agent": USER_AGENT },
        body: JSON.stringify({ query: QUERY, variables: { first: pageSize, skip } }),
        signal,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      errors.push(`request failed on page ${skip / pageSize + 1}: ${message}`);
      break;
    }

    if (!res.ok) {
      errors.push(`API returned ${res.status} on page ${skip / pageSize + 1}`);
      break;
    }

    const json = await res.json() as { data?: { poolGetPools?: BalancerPool[] }; errors?: Array<{ message?: string }> };
    if (Array.isArray(json.errors) && json.errors.length > 0) {
      errors.push(
        `GraphQL errors on page ${skip / pageSize + 1}: ${json.errors.map((entry) => entry.message ?? "unknown").join("; ")}`,
      );
      break;
    }
    const pools = json.data?.poolGetPools;
    if (!Array.isArray(pools)) {
      errors.push(`Malformed response on page ${skip / pageSize + 1}`);
      break;
    }

    successfulPages++;
    if (pools.length === 0) break;

    for (const pool of pools) {
      if (!SUPPORTED_POOL_TYPES.has(pool.type)) continue;

      const chain = BALANCER_CHAIN_MAP[pool.chain];
      if (!chain) continue;

      const tvlUsd = parseFloat(pool.dynamicData.totalLiquidity);
      const volume24h = parseFloat(pool.dynamicData.volume24h);
      const swapFee = parseFloat(pool.dynamicData.swapFee);
      if (!Number.isFinite(tvlUsd) || tvlUsd <= 0) continue;

      const isStable = STABLE_POOL_TYPES.has(pool.type);
      const poolType = isStable ? "balancer-stable" : "balancer-weighted";

      const balances = pool.poolTokens.map((t) => parseFloat(t.balance)).filter(Number.isFinite);

      // Derive price from balanceUSD / balance for each token
      let price: number | null = null;
      for (const t of pool.poolTokens) {
        const bal = parseFloat(t.balance);
        const balUsd = parseFloat(t.balanceUSD);
        if (Number.isFinite(bal) && bal > 0 && Number.isFinite(balUsd) && balUsd > 0) {
          price = balUsd / bal;
          break; // use first token with valid data
        }
      }

      results.push({
        source: "balancer",
        chain,
        poolAddress: pool.id,
        poolType,
        tokens: pool.poolTokens.map((t) => {
          const bal = parseFloat(t.balance);
          const balUsd = parseFloat(t.balanceUSD);
          const weight = t.weight == null ? null : parseFloat(t.weight);
          const tokenPriceUsd = (Number.isFinite(bal) && bal > 0 && Number.isFinite(balUsd) && balUsd > 0)
            ? balUsd / bal : null;
          return {
            address: t.address,
            symbol: t.symbol,
            decimals: t.decimals,
            priceUsd: tokenPriceUsd,
            weight: Number.isFinite(weight) && weight != null && weight > 0 ? weight : null,
          };
        }),
        price,
        tvlUsd,
        volume24hUsd: Number.isFinite(volume24h) ? volume24h : 0,
        feeRate: Number.isFinite(swapFee) ? swapFee : null,
        balances: balances.length === pool.poolTokens.length ? balances : null,
      });
    }

    if (pools.length < pageSize) break;
    skip += pageSize;
  }

  if (results.length > 0) {
    console.log(`[fetch-balancer] Fetched ${results.length} pools`);
  }
  for (const error of errors) {
    console.warn("[fetch-balancer]", error);
  }
  return makeDexApiFetchResult(results, {
    ok: successfulPages > 0,
    degraded: errors.length > 0,
    errors,
  });
}
