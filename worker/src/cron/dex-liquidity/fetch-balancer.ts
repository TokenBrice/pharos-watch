import { makeDexApiFetchResult, type DexApiFetchResult, type DexApiPool } from "../../lib/dex-api-common";
import { USER_AGENT } from "../../lib/constants";
import { cancelResponseBodyQuietly } from "../../lib/response-body";
import { isDexApiRecord, readDexApiJson } from "./direct-api-json";
import {
  DIRECT_API_DEFAULT_MAX_PAGES,
  buildDirectApiRequestSignal,
} from "./direct-api-policy";
import { toErrorMessage } from "../../lib/error-utils";
import { logWorkerEvent } from "../../lib/structured-log";
import { rethrowIfAborted } from "../../lib/abort";

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

// Direct Balancer fetcher sanity cap — protects against upstream-corrupt totalLiquidity
// values (e.g. legacy Fantom multiUSDC/DEI pool reports $337B). Set conservatively below
// the global DIRECT_API_MAX_POOL_TVL_USD ($10B) so obvious garbage is rejected at source.
const BALANCER_MAX_POOL_TVL_USD = 2_000_000_000;

const QUERY = `query($first: Int!, $skip: Int!) {
  poolGetPools(
    first: $first,
    skip: $skip,
    orderBy: totalLiquidity,
    orderDirection: desc,
    where: { minTvl: 10000 }
  ) {
    id
    address
    type
    chain
    dynamicData { totalLiquidity volume24h swapFee }
    poolTokens { address symbol decimals balance balanceUSD weight }
  }
}`;

interface BalancerPool {
  id: string;
  address?: string | null;
  type: string;
  chain: string;
  dynamicData: { totalLiquidity: string; volume24h: string; swapFee: string };
  poolTokens: { address: string; symbol: string; decimals: number; balance: string; balanceUSD: string; weight?: string | null }[];
}

type BalancerResponse = {
  data?: { poolGetPools?: unknown };
  errors?: unknown;
};

function isOptionalString(value: unknown): value is string | null | undefined {
  return value == null || typeof value === "string";
}

function isBalancerDynamicData(value: unknown): value is BalancerPool["dynamicData"] {
  return isDexApiRecord(value) &&
    typeof value.totalLiquidity === "string" &&
    typeof value.volume24h === "string" &&
    typeof value.swapFee === "string";
}

function isBalancerPoolToken(value: unknown): value is BalancerPool["poolTokens"][number] {
  return isDexApiRecord(value) &&
    typeof value.address === "string" &&
    typeof value.symbol === "string" &&
    typeof value.decimals === "number" &&
    Number.isFinite(value.decimals) &&
    typeof value.balance === "string" &&
    typeof value.balanceUSD === "string" &&
    isOptionalString(value.weight);
}

function isBalancerPool(value: unknown): value is BalancerPool {
  return isDexApiRecord(value) &&
    typeof value.id === "string" &&
    isOptionalString(value.address) &&
    typeof value.type === "string" &&
    typeof value.chain === "string" &&
    isBalancerDynamicData(value.dynamicData) &&
    Array.isArray(value.poolTokens) &&
    value.poolTokens.every(isBalancerPoolToken);
}

function formatGraphqlErrors(errors: unknown): string[] {
  if (!Array.isArray(errors)) return [];
  return errors.map((entry) => {
    if (isDexApiRecord(entry) && typeof entry.message === "string") return entry.message;
    return "unknown";
  });
}

function extractBalancerPoolAddress(pool: Pick<BalancerPool, "id" | "address">): string {
  const directAddress = pool.address?.trim();
  if (directAddress && /^0x[a-f0-9]{40}$/i.test(directAddress)) {
    return directAddress.toLowerCase();
  }

  const poolId = pool.id.trim();
  if (/^0x[a-f0-9]{64}$/i.test(poolId)) {
    return poolId.slice(0, 42).toLowerCase();
  }

  return poolId.toLowerCase();
}

export async function fetchBalancerPools(signal?: AbortSignal): Promise<DexApiFetchResult> {
  const results: DexApiPool[] = [];
  const errors: string[] = [];
  const warnings: string[] = [];
  const pageSize = 1000;
  let successfulPages = 0;

  for (let page = 1; page <= DIRECT_API_DEFAULT_MAX_PAGES; page++) {
    const skip = (page - 1) * pageSize;
    let res: Response;
    try {
      res = await fetch(BALANCER_API, {
        method: "POST",
        headers: { "Content-Type": "application/json", "User-Agent": USER_AGENT },
        body: JSON.stringify({ query: QUERY, variables: { first: pageSize, skip } }),
        signal: buildDirectApiRequestSignal(signal),
      });
    } catch (err) {
      rethrowIfAborted(err, signal);
      const message = toErrorMessage(err);
      errors.push(`request failed on page ${page}: ${message}`);
      break;
    }

    if (!res.ok) {
      errors.push(`API returned ${res.status} on page ${page}`);
      await cancelResponseBodyQuietly(res);
      break;
    }

    const parsed = await readDexApiJson<BalancerResponse>(res, `page ${page}`);
    if (!parsed.ok) {
      errors.push(parsed.error);
      break;
    }

    const json = parsed.data;
    const graphqlErrors = formatGraphqlErrors(json.errors);
    if (graphqlErrors.length > 0) {
      errors.push(
        `GraphQL errors on page ${page}: ${graphqlErrors.join("; ")}`,
      );
      break;
    }
    const pools = json.data?.poolGetPools;
    if (!Array.isArray(pools)) {
      errors.push(`Malformed response on page ${page}`);
      break;
    }

    successfulPages++;
    if (pools.length === 0) break;

    let malformedRows = 0;
    for (const rawPool of pools) {
      if (!isBalancerPool(rawPool)) {
        malformedRows++;
        continue;
      }

      const pool = rawPool;
      if (!SUPPORTED_POOL_TYPES.has(pool.type)) continue;

      const chain = BALANCER_CHAIN_MAP[pool.chain];
      if (!chain) {
        logWorkerEvent({
          scope: "lib",
          level: "warn",
          event: "sync-dex-liquidity.unknown-balancer-chain",
          job: "sync-dex-liquidity",
          message: "Unknown Balancer chain enum value; pool skipped",
          metadata: { poolId: pool.id, chain: pool.chain },
        });
        continue;
      }

      const tvlUsd = parseFloat(pool.dynamicData.totalLiquidity);
      const volume24h = parseFloat(pool.dynamicData.volume24h);
      const swapFee = parseFloat(pool.dynamicData.swapFee);
      if (!Number.isFinite(tvlUsd) || tvlUsd <= 0) continue;
      if (tvlUsd > BALANCER_MAX_POOL_TVL_USD) {
        malformedRows++;
        continue;
      }

      const isStable = STABLE_POOL_TYPES.has(pool.type);
      const poolType = isStable ? "balancer-stable" : "balancer-weighted";

      const balances = pool.poolTokens.map((t) => parseFloat(t.balance)).filter(Number.isFinite);

      // Per-token priceUsd is the authoritative price for Balancer rows. The scalar
      // pool.price field is meaningless at pool granularity — drop it to remove a footgun.
      const price: number | null = null;

      results.push({
        source: "balancer",
        chain,
        poolAddress: extractBalancerPoolAddress(pool),
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
        balancesNormalized: true,
      });
    }
    if (malformedRows > 0) {
      warnings.push(`page ${page} skipped ${malformedRows} malformed pool rows`);
    }

    if (pools.length < pageSize) break;
    if (page === DIRECT_API_DEFAULT_MAX_PAGES) {
      errors.push(`pagination cap reached at page ${page}; resumeFromSkip=${skip + pageSize}`);
      break;
    }
  }

  if (results.length > 0) {
    logWorkerEvent({
      scope: "lib",
      level: "info",
      event: "fetch-balancer.fetched",
      job: "sync-dex-liquidity",
      message: "Fetched pools from Balancer",
      metadata: { count: results.length },
    });
  }
  if (errors.length > 0) {
    logWorkerEvent({
      scope: "lib",
      level: "warn",
      event: "fetch-balancer.degraded",
      job: "sync-dex-liquidity",
      message: "Fetcher reported one or more issues",
      metadata: {
        errorCount: errors.length,
        source: "balancer",
        errors,
      },
    });
  }
  if (warnings.length > 0) {
    logWorkerEvent({
      scope: "lib",
      level: "warn",
      event: "fetch-balancer.warnings",
      job: "sync-dex-liquidity",
      message: "Fetcher skipped one or more rows",
      metadata: {
        warningCount: warnings.length,
        source: "balancer",
        warnings,
      },
    });
  }
  return makeDexApiFetchResult(results, {
    ok: successfulPages > 0,
    degraded: errors.length > 0,
    errors,
    warnings,
  });
}
