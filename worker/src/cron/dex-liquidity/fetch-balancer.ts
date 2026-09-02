import { makeDexApiFetchResult, type DexApiFetchResult, type DexApiPool } from "../../lib/dex-api-common";
import { isDexApiRecord } from "./direct-api-json";
import { DIRECT_API_DEFAULT_MAX_PAGES } from "./direct-api-policy";
import { runPaginatedDirectApiFetch } from "./direct-api-paginated";
import { canonicalEvmAddress } from "@shared/lib/evm-address";
import { logWorkerEvent } from "../../lib/structured-log";

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

/**
 * Pool types that use Balancer StableMath (an amplified invariant over
 * rate-scaled balances). Gyro pools price on an elliptic invariant and
 * PHANTOM_STABLE is the deprecated v1 phantom-BPT design; neither may carry
 * an amp into an exact execution model.
 */
const STABLE_MATH_POOL_TYPES = new Set(["STABLE", "COMPOSABLE_STABLE", "META_STABLE"]);
const REVIEWED_CUSTOM_POOL_TYPES = new Set([
  "PHANTOM_STABLE",
  "GYRO",
  "GYROE",
  "COW_AMM",
  "ELEMENT",
  "FIXED_LBP",
  "FX",
  "INVESTMENT",
  "LIQUIDITY_BOOTSTRAPPING",
  "QUANT_AMM_WEIGHTED",
  "RECLAMM",
]);
const STABLE_DISPLAY_POOL_TYPES = new Set([
  ...STABLE_MATH_POOL_TYPES,
  "PHANTOM_STABLE",
  "GYRO",
  "GYROE",
]);
const REVIEWED_POOL_TYPES = new Set([...STABLE_MATH_POOL_TYPES, ...REVIEWED_CUSTOM_POOL_TYPES, "WEIGHTED"]);

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
    dynamicData { totalLiquidity volume24h swapFee isPaused swapEnabled }
    poolTokens { address symbol decimals balance balanceUSD weight priceRate }
  }
}`;

/**
 * Supplemental exact-capability sweep. The list endpoint's pool shape does
 * not expose amp or hook/provider review. Queried without includeHooks, the
 * aggregator endpoint returns only hook-free pools with reviewed rate
 * providers. Stable-math rows also carry amp. Pools missing from this sweep
 * must remain explicit capability gates.
 */
const AMP_QUERY = `query($first: Int!, $skip: Int!) {
  aggregatorPools(
    first: $first,
    skip: $skip,
    orderBy: totalLiquidity,
    orderDirection: desc,
    where: { minTvl: 10000, poolTypeIn: [STABLE, COMPOSABLE_STABLE, META_STABLE, WEIGHTED] }
  ) {
    id
    chain
    amp
  }
}`;

interface BalancerPool {
  id: string;
  address?: string | null;
  type: string;
  chain: string;
  dynamicData: {
    totalLiquidity: string;
    volume24h: string;
    swapFee: string;
    isPaused?: boolean | null;
    swapEnabled?: boolean | null;
  };
  poolTokens: { address: string; symbol: string; decimals: number; balance: string; balanceUSD: string; weight?: string | null; priceRate?: string | null }[];
}

type BalancerResponse = {
  data?: { poolGetPools?: unknown };
  errors?: unknown;
};

interface BalancerAmpRow {
  id: string;
  chain: string;
  amp?: string | null;
}

interface BalancerCapabilitySweep {
  rowsByPoolId: Map<string, number | null>;
  complete: boolean;
}

type BalancerExecutionCapabilityGate = NonNullable<DexApiPool["executionCapabilityGate"]>;

function balancerGate(reason: BalancerExecutionCapabilityGate["reason"]): BalancerExecutionCapabilityGate {
  return { family: "balancer-amm", reason };
}

type BalancerAmpResponse = {
  data?: { aggregatorPools?: unknown };
  errors?: unknown;
};

function isOptionalString(value: unknown): value is string | null | undefined {
  return value == null || typeof value === "string";
}

function isOptionalBoolean(value: unknown): value is boolean | null | undefined {
  return value == null || typeof value === "boolean";
}

/**
 * GraphQL scalar fields arrive as strings. Exact-execution inputs must reject
 * permissive numeric prefixes (for example `250junk`) rather than silently
 * turning them into invariant parameters.
 */
function parseStrictFiniteDecimal(value: string): number | null {
  const normalized = value.trim();
  const unsigned = normalized[0] === "+" || normalized[0] === "-" ? normalized.slice(1) : normalized;
  if (!unsigned || ["0x", "0o", "0b"].includes(unsigned.slice(0, 2).toLowerCase())) return null;
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : null;
}

function isBalancerDynamicData(value: unknown): value is BalancerPool["dynamicData"] {
  return isDexApiRecord(value) &&
    typeof value.totalLiquidity === "string" &&
    typeof value.volume24h === "string" &&
    typeof value.swapFee === "string" &&
    isOptionalBoolean(value.isPaused) &&
    isOptionalBoolean(value.swapEnabled);
}

function isBalancerPoolToken(value: unknown): value is BalancerPool["poolTokens"][number] {
  return isDexApiRecord(value) &&
    typeof value.address === "string" &&
    typeof value.symbol === "string" &&
    typeof value.decimals === "number" &&
    Number.isFinite(value.decimals) &&
    typeof value.balance === "string" &&
    typeof value.balanceUSD === "string" &&
    isOptionalString(value.weight) &&
    isOptionalString(value.priceRate);
}

function isBalancerAmpRow(value: unknown): value is BalancerAmpRow {
  return isDexApiRecord(value) &&
    typeof value.id === "string" &&
    typeof value.chain === "string" &&
    isOptionalString(value.amp);
}

/**
 * Deterministic deployments reuse pool addresses (v3) and can reuse vault ids
 * (v2) across chains, so amp rows must be keyed chain-scoped.
 */
function ampJoinKey(chain: string, poolId: string): string {
  return `${chain.trim().toUpperCase()}:${poolId.trim().toLowerCase()}`;
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

function normalizedAddress(value: string): string {
  return canonicalEvmAddress(value) ?? value.trim().toLowerCase();
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

function isCanonicalEvmAddress(value: string): boolean {
  return /^0x[a-f0-9]{40}$/.test(value.trim().toLowerCase());
}

/** Fetch reviewed exact-capability membership and stable amp without throwing on non-abort errors. */
async function fetchBalancerCapabilities(
  warnings: string[],
  signal?: AbortSignal,
): Promise<BalancerCapabilitySweep> {
  const pageSize = 1000;
  const sweep = await runPaginatedDirectApiFetch<BalancerAmpRow>({
    source: "capability sweep",
    pageSize,
    maxPages: DIRECT_API_DEFAULT_MAX_PAGES,
    signal,
    buildRequest: (page) => ({
      url: BALANCER_API,
      init: {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          query: AMP_QUERY,
          variables: { first: pageSize, skip: (page - 1) * pageSize },
        }),
      },
    }),
    pageContext: (page) => `amp sweep page ${page}`,
    formatRequestError: (page, message) =>
      `capability sweep request failed on page ${page}: ${message}`,
    formatResponseError: (page, status) =>
      `capability sweep returned ${status} on page ${page}`,
    formatPaginationCapError: (page) =>
      `capability sweep pagination cap reached at page ${page}`,
    parsePage: (body, page) => {
      const response = body as BalancerAmpResponse;
      const graphqlErrors = formatGraphqlErrors(response.errors);
      if (graphqlErrors.length > 0) {
        return { error: `capability sweep GraphQL errors on page ${page}: ${graphqlErrors.join("; ")}` };
      }
      const rows = response.data?.aggregatorPools;
      return Array.isArray(rows)
        ? rows
        : { error: `capability sweep malformed response on page ${page}` };
    },
    mapRow: (row) => isBalancerAmpRow(row) ? row : null,
  });

  const rowsByPoolId = new Map<string, number | null>();
  for (const row of sweep.rows) {
    const amp = row.amp == null ? null : parseStrictFiniteDecimal(row.amp);
    rowsByPoolId.set(
      ampJoinKey(row.chain, row.id),
      amp != null && Number.isFinite(amp) && amp > 0 ? amp : null,
    );
  }
  warnings.push(...sweep.errors, ...sweep.warnings);
  return { rowsByPoolId, complete: sweep.completed };
}

function captureGateForPool(
  pool: BalancerPool,
  poolAddress: string,
  parsedBalances: readonly number[],
  parsedFee: number,
): BalancerExecutionCapabilityGate | null {
  if (!isCanonicalEvmAddress(poolAddress)) {
    return balancerGate("incomplete-exact-capture");
  }
  if (pool.dynamicData.isPaused === true || pool.dynamicData.swapEnabled === false) {
    return balancerGate("paused-or-swap-disabled");
  }
  if (pool.dynamicData.isPaused !== false || pool.dynamicData.swapEnabled !== true) {
    return balancerGate("incomplete-exact-capture");
  }
  if (REVIEWED_CUSTOM_POOL_TYPES.has(pool.type)) {
    return balancerGate("unsupported-invariant");
  }
  if (pool.poolTokens.length < 2) return balancerGate("incomplete-exact-capture");

  const modeledTokenEntries = pool.poolTokens
    .map((token, index) => ({ token, balance: parsedBalances[index] }))
    .filter(({ token }) =>
      !STABLE_MATH_POOL_TYPES.has(pool.type) || token.address.trim().toLowerCase() !== poolAddress
    );
  const modeledTokens = modeledTokenEntries.map(({ token }) => token);
  if (modeledTokens.length < 2) return balancerGate("incomplete-exact-capture");
  if (modeledTokens.length > 8) return balancerGate("unsupported-invariant");
  if (modeledTokens.some((token) =>
    !isCanonicalEvmAddress(token.address) ||
    !token.symbol.trim() ||
    !Number.isInteger(token.decimals) ||
    token.decimals < 0 ||
    token.decimals > 255
  )) {
    return balancerGate("incomplete-exact-capture");
  }
  const tokenKeys = modeledTokens.map((token) => token.address.trim().toLowerCase());
  if (new Set(tokenKeys).size !== tokenKeys.length) {
    return balancerGate("ambiguous-token-identity");
  }
  if (parsedBalances.length !== pool.poolTokens.length) {
    return balancerGate("incomplete-exact-capture");
  }
  if (modeledTokenEntries.some(({ balance }) => !Number.isFinite(balance) || balance! <= 0)) {
    return balancerGate("invalid-invariant-parameters");
  }
  if (!Number.isFinite(parsedFee) || parsedFee < 0 || parsedFee >= 1) {
    return balancerGate("invalid-invariant-parameters");
  }

  if (STABLE_MATH_POOL_TYPES.has(pool.type)) {
    const rates = modeledTokens.map((token) => token.priceRate);
    if (rates.some((rate) => rate == null)) return balancerGate("incomplete-exact-capture");
    if (rates.some((rate) => {
      const parsed = parseStrictFiniteDecimal(rate!);
      return parsed == null || parsed <= 0;
    })) {
      return balancerGate("invalid-invariant-parameters");
    }
  }

  if (pool.type === "WEIGHTED") {
    const weights = modeledTokens.map((token) => token.weight);
    if (weights.some((weight) => weight == null)) return balancerGate("incomplete-exact-capture");
    const parsedWeights = weights.map((weight) => parseStrictFiniteDecimal(weight!));
    if (
      parsedWeights.some((weight) => weight == null || weight <= 0) ||
      Math.abs(parsedWeights.reduce<number>((sum, weight) => sum + (weight ?? 0), 0) - 1) > 0.0001
    ) {
      return balancerGate("invalid-invariant-parameters");
    }
  }

  return null;
}

function shapeBalancerPool(
  pool: BalancerPool,
  chain: string,
  priceOverrides: ReadonlyMap<string, number | null> = new Map(),
  priceDependencyOverrides: ReadonlyMap<
    string,
    NonNullable<DexApiPool["tokens"][number]["priceUsdDependency"]>
  > = new Map(),
  gateOverride?: BalancerExecutionCapabilityGate,
): DexApiPool {
  const tvlUsd = parseStrictFiniteDecimal(pool.dynamicData.totalLiquidity) ?? Number.NaN;
  const volume24h = parseStrictFiniteDecimal(pool.dynamicData.volume24h) ?? Number.NaN;
  const swapFee = parseStrictFiniteDecimal(pool.dynamicData.swapFee) ?? Number.NaN;
  const balances = pool.poolTokens.map((token) => parseStrictFiniteDecimal(token.balance) ?? Number.NaN);
  const poolAddress = extractBalancerPoolAddress(pool);
  const executionCapabilityGate = gateOverride ?? captureGateForPool(pool, poolAddress, balances, swapFee);
  const poolType = STABLE_DISPLAY_POOL_TYPES.has(pool.type)
    ? "balancer-stable"
    : pool.type === "WEIGHTED"
      ? "balancer-weighted"
      : "balancer-custom";

  return {
    source: "balancer",
    chain,
    poolAddress,
    poolType,
    tokens: pool.poolTokens.map((token) => {
      const balance = parseStrictFiniteDecimal(token.balance) ?? Number.NaN;
      const balanceUsd = parseStrictFiniteDecimal(token.balanceUSD) ?? Number.NaN;
      const weight = token.weight == null ? null : parseStrictFiniteDecimal(token.weight);
      const priceRate = token.priceRate == null ? null : parseStrictFiniteDecimal(token.priceRate);
      const tokenAddress = normalizedAddress(token.address);
      const sourcePriceUsd = Number.isFinite(balance) && balance > 0 && Number.isFinite(balanceUsd) && balanceUsd > 0
        ? balanceUsd / balance
        : null;
      const priceUsd = priceOverrides.has(tokenAddress)
        ? priceOverrides.get(tokenAddress) ?? null
        : sourcePriceUsd;
      const priceUsdDependency = priceDependencyOverrides.get(tokenAddress);
      return {
        address: token.address,
        symbol: token.symbol,
        decimals: token.decimals,
        priceUsd,
        ...(priceUsdDependency ? { priceUsdDependency } : {}),
        weight: Number.isFinite(weight) && weight != null && weight > 0 ? weight : null,
        priceRate: Number.isFinite(priceRate) && priceRate != null && priceRate > 0 ? priceRate : null,
      };
    }),
    // Per-token priceUsd is authoritative. A scalar pool ratio is ambiguous
    // unless its direction and reference token are captured explicitly.
    price: null,
    tvlUsd,
    volume24hUsd: Number.isFinite(volume24h) ? volume24h : 0,
    feeRate: Number.isFinite(swapFee) ? swapFee : null,
    balances: balances.every(Number.isFinite) ? balances : null,
    balancesNormalized: true,
    ...(executionCapabilityGate ? { executionCapabilityGate } : {}),
  };
}

export async function fetchBalancerPools(signal?: AbortSignal): Promise<DexApiFetchResult> {
  const pageSize = 1000;
  const malformedRowsByPage = new Map<number, number>();
  const fetchResult = await runPaginatedDirectApiFetch<{
    pool: DexApiPool;
    exactCandidate?: { poolId: string; stableMath: boolean };
  }>({
    source: "balancer",
    pageSize,
    maxPages: DIRECT_API_DEFAULT_MAX_PAGES,
    signal,
    buildRequest: (page) => ({
      url: BALANCER_API,
      init: {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          query: QUERY,
          variables: { first: pageSize, skip: (page - 1) * pageSize },
        }),
      },
    }),
    pageContext: (page) => `page ${page}`,
    formatRequestError: (page, message) => `request failed on page ${page}: ${message}`,
    formatResponseError: (page, status) => `API returned ${status} on page ${page}`,
    formatPaginationCapError: (page, nextPage) =>
      `pagination cap reached at page ${page}; resumeFromSkip=${(nextPage - 1) * pageSize}`,
    parsePage: (body, page) => {
      const response = body as BalancerResponse;
      const graphqlErrors = formatGraphqlErrors(response.errors);
      if (graphqlErrors.length > 0) {
        return { error: `GraphQL errors on page ${page}: ${graphqlErrors.join("; ")}` };
      }
      const pools = response.data?.poolGetPools;
      return Array.isArray(pools)
        ? pools
        : { error: `Malformed response on page ${page}` };
    },
    mapRow: (rawPool, { page }) => {
      if (!isBalancerPool(rawPool)) {
        malformedRowsByPage.set(page, (malformedRowsByPage.get(page) ?? 0) + 1);
        return null;
      }

      const pool = rawPool;
      if (!REVIEWED_POOL_TYPES.has(pool.type)) return null;

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
        return null;
      }

      const tvlUsd = parseStrictFiniteDecimal(pool.dynamicData.totalLiquidity);
      if (tvlUsd == null || tvlUsd <= 0) return null;
      if (tvlUsd > BALANCER_MAX_POOL_TVL_USD) {
        malformedRowsByPage.set(page, (malformedRowsByPage.get(page) ?? 0) + 1);
        return null;
      }

      const shapedPool = shapeBalancerPool(pool, chain);
      return {
        pool: shapedPool,
        ...(shapedPool.executionCapabilityGate == null &&
        (STABLE_MATH_POOL_TYPES.has(pool.type) || pool.type === "WEIGHTED")
          ? {
              exactCandidate: {
                poolId: ampJoinKey(pool.chain, pool.id),
                stableMath: STABLE_MATH_POOL_TYPES.has(pool.type),
              },
            }
          : {}),
      };
    },
    afterPage: ({ page, warnings }) => {
      const malformedRows = malformedRowsByPage.get(page) ?? 0;
      if (malformedRows > 0) {
        warnings.push(`page ${page} skipped ${malformedRows} malformed pool rows`);
      }
    },
  });

  const results = fetchResult.rows.map(({ pool }) => pool);
  const errors = fetchResult.errors;
  const warnings = fetchResult.warnings;
  const successfulPages = fetchResult.successfulPages;
  const exactCandidatePoolIdsByIndex = new Map<number, { poolId: string; stableMath: boolean }>();
  for (const [index, row] of fetchResult.rows.entries()) {
    if (row.exactCandidate) exactCandidatePoolIdsByIndex.set(index, row.exactCandidate);
  }

  if (exactCandidatePoolIdsByIndex.size > 0) {
    const capabilitySweep = await fetchBalancerCapabilities(warnings, signal);
    let ampAttached = 0;
    let capabilityGated = 0;
    for (const [index, candidate] of exactCandidatePoolIdsByIndex) {
      const result = results[index]!;
      if (!capabilitySweep.rowsByPoolId.has(candidate.poolId)) {
        result.executionCapabilityGate = balancerGate(
          capabilitySweep.complete && candidate.stableMath
            ? "rate-bearing-inputs"
            : "incomplete-exact-capture",
        );
        capabilityGated++;
        continue;
      }
      if (candidate.stableMath) {
        const amp = capabilitySweep.rowsByPoolId.get(candidate.poolId);
        if (amp == null) {
          result.executionCapabilityGate = balancerGate("invalid-invariant-parameters");
          capabilityGated++;
          continue;
        }
        result.amp = amp;
        ampAttached++;
      }
    }
    logWorkerEvent({
      scope: "lib",
      level: "info",
      event: "fetch-balancer.capability-sweep",
      job: "sync-dex-liquidity",
      message: "Joined Balancer exact-capability review and stable-math amp",
      metadata: {
        exactCandidates: exactCandidatePoolIdsByIndex.size,
        reviewedRows: capabilitySweep.rowsByPoolId.size,
        sweepComplete: capabilitySweep.complete,
        ampAttached,
        capabilityGated,
      },
    });
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
