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
const REVIEWED_ROUTE_MIN_TVL_USD = 50_000;

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

const REVIEWED_POOL_QUERY = `query($id: String!, $chain: GqlChain!) {
  poolGetPool(id: $id, chain: $chain) {
    id
    address
    type
    chain
    dynamicData { totalLiquidity volume24h swapFee isPaused swapEnabled }
    poolTokens {
      index
      address
      symbol
      decimals
      balance
      balanceUSD
      weight
      priceRate
      priceRateProvider
      isErc4626
      isAllowed
      underlyingToken { address symbol decimals }
    }
    ... on GqlPoolStable {
      amp
      protocolVersion
      hasErc4626
      hasAnyAllowedBuffer
      hook {
        address
        type
        config {
          enableHookAdjustedAmounts
          shouldCallAfterSwap
          shouldCallBeforeSwap
          shouldCallComputeDynamicSwapFee
        }
        reviewData { summary warnings }
      }
    }
  }
}`;

const REVIEWED_QUOTE_QUERY = `query(
  $tokenIn: String!,
  $tokenOut: String!,
  $swapAmount: AmountHumanReadable!,
  $chain: GqlChain!,
  $poolIds: [String!]
) {
  sorGetSwapPaths(
    tokenIn: $tokenIn,
    tokenOut: $tokenOut,
    swapAmount: $swapAmount,
    swapType: EXACT_IN,
    chain: $chain,
    poolIds: $poolIds,
    useProtocolVersion: 3,
    considerPoolsWithHooks: true
  ) {
    tokenIn
    tokenOut
    swapAmount
    returnAmount
    protocolVersion
    tokenAddresses
    priceImpact { priceImpact error }
    paths { pools isBuffer protocolVersion }
  }
}`;

interface ReviewedBalancerRoute {
  chain: string;
  internalChain: string;
  poolId: string;
  poolAddress: string;
  poolType: "STABLE";
  protocolVersion: 3;
  targetToken: { index: number; address: string; decimals: number };
  quoteToken: {
    index: number;
    address: string;
    decimals: number;
    rateProvider: string;
    underlyingAddress: string;
    underlyingDecimals: number;
  };
  hook: { address: string; type: "STABLE_SURGE" };
  boundedSwapAmount: string;
  maxQuoteTvlShare: number;
  maxReportedPriceImpactRatio: number;
}

/** Reviewed against the Balancer primary API on 2026-07-16. The SOR quote is
 * constrained to this pool and exits through the waEthUSDC buffer to canonical
 * USDC, so the wrapper rate is part of the executable path rather than a par
 * assumption about USP. */
const REVIEWED_BALANCER_ROUTES: readonly ReviewedBalancerRoute[] = [{
  chain: "MAINNET",
  internalChain: "ethereum",
  poolId: "0x114907c2a07978c38ebb9f9f6a5261a846b79521",
  poolAddress: "0x114907c2a07978c38ebb9f9f6a5261a846b79521",
  poolType: "STABLE",
  protocolVersion: 3,
  targetToken: {
    index: 0,
    address: "0x97ccc1c046d067ab945d3cf3cc6920d3b1e54c88",
    decimals: 18,
  },
  quoteToken: {
    index: 1,
    address: "0xd4fa2d31b7968e448877f69a96de69f5de8cd23e",
    decimals: 6,
    rateProvider: "0x8f4e8439b970363648421c692dd897fb9c0bd1d9",
    underlyingAddress: "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
    underlyingDecimals: 6,
  },
  hook: {
    address: "0xbdbadc891bb95dee80ebc491699228ef0f7d6ff1",
    type: "STABLE_SURGE",
  },
  boundedSwapAmount: "1000",
  maxQuoteTvlShare: 0.05,
  maxReportedPriceImpactRatio: 0.02,
}];

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

type ReviewedBalancerPoolToken = BalancerPool["poolTokens"][number] & {
  index: number;
  priceRateProvider?: string | null;
  isErc4626: boolean;
  isAllowed: boolean;
  underlyingToken?: {
    address: string;
    symbol: string;
    decimals: number;
  } | null;
};

interface ReviewedBalancerPool extends Omit<BalancerPool, "poolTokens"> {
  amp: string;
  protocolVersion: number;
  hasErc4626: boolean;
  hasAnyAllowedBuffer: boolean;
  hook?: {
    address: string;
    type: string;
    config: {
      enableHookAdjustedAmounts: boolean;
      shouldCallAfterSwap: boolean;
      shouldCallBeforeSwap: boolean;
      shouldCallComputeDynamicSwapFee: boolean;
    };
    reviewData: { summary: string; warnings: unknown[] };
  } | null;
  poolTokens: ReviewedBalancerPoolToken[];
}

interface ReviewedBalancerQuote {
  tokenIn: string;
  tokenOut: string;
  swapAmount: string;
  returnAmount: string;
  protocolVersion: number;
  tokenAddresses: string[];
  priceImpact?: {
    priceImpact?: string | null;
    error?: string | null;
  } | null;
  paths: Array<{
    pools: string[];
    isBuffer: boolean[];
    protocolVersion: number;
  }>;
}

type ReviewedBalancerPoolResponse = {
  data?: { poolGetPool?: unknown };
  errors?: unknown;
};

type ReviewedBalancerQuoteResponse = {
  data?: { sorGetSwapPaths?: unknown };
  errors?: unknown;
};

interface ReviewedBalancerRouteResult {
  pool: ReviewedBalancerPool;
  targetPriceInUsdc: number;
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
  return value.trim().toLowerCase();
}

function isReviewedBalancerPoolToken(value: unknown): value is ReviewedBalancerPoolToken {
  if (!isBalancerPoolToken(value) || !isDexApiRecord(value)) return false;
  const record = value as Record<string, unknown>;
  const underlying = record.underlyingToken;
  return Number.isInteger(record.index) &&
    typeof record.isErc4626 === "boolean" &&
    typeof record.isAllowed === "boolean" &&
    isOptionalString(record.priceRateProvider) &&
    (
      underlying == null ||
      (
        isDexApiRecord(underlying) &&
        typeof underlying.address === "string" &&
        typeof underlying.symbol === "string" &&
        typeof underlying.decimals === "number" &&
        Number.isInteger(underlying.decimals)
      )
    );
}

function isReviewedBalancerPool(value: unknown): value is ReviewedBalancerPool {
  if (!isBalancerPool(value) || !isDexApiRecord(value)) return false;
  const hook = value.hook;
  return typeof value.amp === "string" &&
    typeof value.protocolVersion === "number" &&
    Number.isInteger(value.protocolVersion) &&
    typeof value.hasErc4626 === "boolean" &&
    typeof value.hasAnyAllowedBuffer === "boolean" &&
    value.poolTokens.every(isReviewedBalancerPoolToken) &&
    (
      hook == null ||
      (
        isDexApiRecord(hook) &&
        typeof hook.address === "string" &&
        typeof hook.type === "string" &&
        isDexApiRecord(hook.config) &&
        typeof hook.config.enableHookAdjustedAmounts === "boolean" &&
        typeof hook.config.shouldCallAfterSwap === "boolean" &&
        typeof hook.config.shouldCallBeforeSwap === "boolean" &&
        typeof hook.config.shouldCallComputeDynamicSwapFee === "boolean" &&
        isDexApiRecord(hook.reviewData) &&
        typeof hook.reviewData.summary === "string" &&
        Array.isArray(hook.reviewData.warnings)
      )
    );
}

function isReviewedBalancerQuote(value: unknown): value is ReviewedBalancerQuote {
  if (!isDexApiRecord(value) || !Array.isArray(value.tokenAddresses) || !Array.isArray(value.paths)) return false;
  return typeof value.tokenIn === "string" &&
    typeof value.tokenOut === "string" &&
    typeof value.swapAmount === "string" &&
    typeof value.returnAmount === "string" &&
    typeof value.protocolVersion === "number" &&
    value.tokenAddresses.every((address) => typeof address === "string") &&
    (
      value.priceImpact == null ||
      (
        isDexApiRecord(value.priceImpact) &&
        isOptionalString(value.priceImpact.priceImpact) &&
        isOptionalString(value.priceImpact.error)
      )
    ) &&
    value.paths.every((path) =>
      isDexApiRecord(path) &&
      Array.isArray(path.pools) &&
      path.pools.every((pool) => typeof pool === "string") &&
      Array.isArray(path.isBuffer) &&
      path.isBuffer.every((entry) => typeof entry === "boolean") &&
      typeof path.protocolVersion === "number"
    );
}

function reviewedRouteForPool(pool: Pick<BalancerPool, "id" | "address" | "chain">): ReviewedBalancerRoute | null {
  const poolAddress = extractBalancerPoolAddress(pool);
  return REVIEWED_BALANCER_ROUTES.find((route) =>
    route.chain === pool.chain &&
    normalizedAddress(route.poolId) === normalizedAddress(pool.id) &&
    normalizedAddress(route.poolAddress) === poolAddress
  ) ?? null;
}

function quoteMatchesReviewedRoute(
  quote: ReviewedBalancerQuote,
  route: ReviewedBalancerRoute,
  expectedAmount: string,
): boolean {
  const expectedTokenAddresses = [
    route.targetToken.address,
    route.quoteToken.address,
    route.quoteToken.underlyingAddress,
  ].map(normalizedAddress);
  const path = quote.paths[0];
  return normalizedAddress(quote.tokenIn) === normalizedAddress(route.targetToken.address) &&
    normalizedAddress(quote.tokenOut) === normalizedAddress(route.quoteToken.underlyingAddress) &&
    parseFloat(quote.swapAmount) === parseFloat(expectedAmount) &&
    quote.protocolVersion === route.protocolVersion &&
    quote.tokenAddresses.map(normalizedAddress).join(":") === expectedTokenAddresses.join(":") &&
    quote.paths.length === 1 &&
    path != null &&
    path.protocolVersion === route.protocolVersion &&
    path.pools.map(normalizedAddress).join(":") === [route.poolId, route.quoteToken.address].map(normalizedAddress).join(":") &&
    path.isBuffer.length === 2 &&
    path.isBuffer[0] === false &&
    path.isBuffer[1] === true;
}

function resolveReviewedBalancerRoute(
  route: ReviewedBalancerRoute,
  poolValue: unknown,
  boundedQuoteValue: unknown,
): ReviewedBalancerRouteResult | null {
  if (
    !isReviewedBalancerPool(poolValue) ||
    !isReviewedBalancerQuote(boundedQuoteValue)
  ) return null;

  const pool = poolValue;
  if (
    normalizedAddress(pool.id) !== normalizedAddress(route.poolId) ||
    normalizedAddress(extractBalancerPoolAddress(pool)) !== normalizedAddress(route.poolAddress) ||
    pool.chain !== route.chain ||
    pool.type !== route.poolType ||
    pool.protocolVersion !== route.protocolVersion ||
    pool.dynamicData.isPaused !== false ||
    pool.dynamicData.swapEnabled !== true ||
    pool.hasErc4626 !== true ||
    pool.hasAnyAllowedBuffer !== true ||
    pool.poolTokens.length !== 2
  ) return null;

  const amp = parseFloat(pool.amp);
  const tvlUsd = parseFloat(pool.dynamicData.totalLiquidity);
  const swapFee = parseFloat(pool.dynamicData.swapFee);
  const balances = pool.poolTokens.map((token) => parseFloat(token.balance));
  if (
    !Number.isFinite(amp) ||
    amp <= 0 ||
    !Number.isFinite(tvlUsd) ||
    tvlUsd < REVIEWED_ROUTE_MIN_TVL_USD ||
    tvlUsd > BALANCER_MAX_POOL_TVL_USD ||
    !Number.isFinite(swapFee) ||
    swapFee < 0 ||
    swapFee >= 1 ||
    balances.some((balance) => !Number.isFinite(balance) || balance <= 0)
  ) return null;

  const target = pool.poolTokens.find((token) => token.index === route.targetToken.index);
  const quoteToken = pool.poolTokens.find((token) => token.index === route.quoteToken.index);
  if (!target || !quoteToken) return null;
  if (
    normalizedAddress(target.address) !== normalizedAddress(route.targetToken.address) ||
    target.decimals !== route.targetToken.decimals ||
    target.isErc4626 !== false ||
    target.isAllowed !== true ||
    normalizedAddress(quoteToken.address) !== normalizedAddress(route.quoteToken.address) ||
    quoteToken.decimals !== route.quoteToken.decimals ||
    quoteToken.isErc4626 !== true ||
    quoteToken.isAllowed !== true ||
    normalizedAddress(quoteToken.priceRateProvider ?? "") !== normalizedAddress(route.quoteToken.rateProvider) ||
    normalizedAddress(quoteToken.underlyingToken?.address ?? "") !== normalizedAddress(route.quoteToken.underlyingAddress) ||
    quoteToken.underlyingToken?.decimals !== route.quoteToken.underlyingDecimals
  ) return null;

  const priceRate = parseFloat(quoteToken.priceRate ?? "");
  if (!Number.isFinite(priceRate) || priceRate <= 0) return null;
  const hook = pool.hook;
  if (
    !hook ||
    normalizedAddress(hook.address) !== normalizedAddress(route.hook.address) ||
    hook.type !== route.hook.type ||
    hook.config.enableHookAdjustedAmounts !== false ||
    hook.config.shouldCallAfterSwap !== false ||
    hook.config.shouldCallBeforeSwap !== false ||
    hook.config.shouldCallComputeDynamicSwapFee !== true ||
    hook.reviewData.summary.trim().toLowerCase() !== "safe" ||
    hook.reviewData.warnings.length !== 0
  ) return null;

  if (!quoteMatchesReviewedRoute(boundedQuoteValue, route, route.boundedSwapAmount)) return null;

  const boundedInput = parseFloat(boundedQuoteValue.swapAmount);
  const boundedOutput = parseFloat(boundedQuoteValue.returnAmount);
  const boundedPrice = boundedOutput / boundedInput;
  const reportedPriceImpact = boundedQuoteValue.priceImpact?.priceImpact == null
    ? null
    : parseFloat(boundedQuoteValue.priceImpact.priceImpact);
  const quoteTvlShare = boundedOutput / tvlUsd;
  if (
    !Number.isFinite(boundedPrice) ||
    boundedPrice <= 0 ||
    !Number.isFinite(quoteTvlShare) ||
    quoteTvlShare <= 0 ||
    quoteTvlShare > route.maxQuoteTvlShare ||
    (
      reportedPriceImpact != null &&
      (
        !Number.isFinite(reportedPriceImpact) ||
        reportedPriceImpact < 0 ||
        reportedPriceImpact > route.maxReportedPriceImpactRatio
      )
    )
  ) return null;

  return {
    pool,
    targetPriceInUsdc: boundedPrice,
  };
}

async function fetchReviewedBalancerQuery<T extends object>(
  query: string,
  variables: Record<string, unknown>,
  label: string,
  warnings: string[],
  signal?: AbortSignal,
): Promise<T | null> {
  try {
    const res = await fetch(BALANCER_API, {
      method: "POST",
      headers: { "Content-Type": "application/json", "User-Agent": USER_AGENT },
      body: JSON.stringify({ query, variables }),
      signal: buildDirectApiRequestSignal(signal),
    });
    if (!res.ok) {
      warnings.push(`${label} returned ${res.status}`);
      await cancelResponseBodyQuietly(res);
      return null;
    }

    const parsed = await readDexApiJson<{ data?: T; errors?: unknown }>(res, label);
    if (!parsed.ok) {
      warnings.push(parsed.error);
      return null;
    }
    const graphqlErrors = formatGraphqlErrors(parsed.data.errors);
    if (graphqlErrors.length > 0) {
      warnings.push(`${label} GraphQL errors: ${graphqlErrors.join("; ")}`);
      return null;
    }
    return parsed.data.data ?? null;
  } catch (err) {
    rethrowIfAborted(err, signal);
    warnings.push(`${label} request failed: ${toErrorMessage(err)}`);
    return null;
  }
}

async function fetchReviewedBalancerRoute(
  route: ReviewedBalancerRoute,
  warnings: string[],
  signal?: AbortSignal,
): Promise<ReviewedBalancerRouteResult | null> {
  const label = `reviewed route ${route.poolId}`;
  // This pool response is an identity/admission gate only. Price evidence comes
  // entirely from the single SOR response that quotes the full route to USDC.
  const poolResponse = await fetchReviewedBalancerQuery<NonNullable<ReviewedBalancerPoolResponse["data"]>>(
    REVIEWED_POOL_QUERY,
    { id: route.poolId, chain: route.chain },
    `${label} pool`,
    warnings,
    signal,
  );
  if (!poolResponse) return null;

  const quoteVariables = {
    tokenIn: route.targetToken.address,
    tokenOut: route.quoteToken.underlyingAddress,
    chain: route.chain,
    poolIds: [route.poolId],
  };
  const boundedResponse = await fetchReviewedBalancerQuery<NonNullable<ReviewedBalancerQuoteResponse["data"]>>(
    REVIEWED_QUOTE_QUERY,
    { ...quoteVariables, swapAmount: route.boundedSwapAmount },
    `${label} bounded quote`,
    warnings,
    signal,
  );
  if (!boundedResponse) return null;

  const resolved = resolveReviewedBalancerRoute(
    route,
    poolResponse.poolGetPool,
    boundedResponse.sorGetSwapPaths,
  );
  if (!resolved) warnings.push(`${label} failed identity or quote validation`);
  return resolved;
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
  const rowsByPoolId = new Map<string, number | null>();
  const pageSize = 1000;
  for (let page = 1; page <= DIRECT_API_DEFAULT_MAX_PAGES; page++) {
    const skip = (page - 1) * pageSize;
    let res: Response;
    try {
      res = await fetch(BALANCER_API, {
        method: "POST",
        headers: { "Content-Type": "application/json", "User-Agent": USER_AGENT },
        body: JSON.stringify({ query: AMP_QUERY, variables: { first: pageSize, skip } }),
        signal: buildDirectApiRequestSignal(signal),
      });
    } catch (err) {
      rethrowIfAborted(err, signal);
      warnings.push(`capability sweep request failed on page ${page}: ${toErrorMessage(err)}`);
      return { rowsByPoolId, complete: false };
    }

    if (!res.ok) {
      warnings.push(`capability sweep returned ${res.status} on page ${page}`);
      await cancelResponseBodyQuietly(res);
      return { rowsByPoolId, complete: false };
    }

    const parsed = await readDexApiJson<BalancerAmpResponse>(res, `amp sweep page ${page}`);
    if (!parsed.ok) {
      warnings.push(parsed.error);
      return { rowsByPoolId, complete: false };
    }
    const graphqlErrors = formatGraphqlErrors(parsed.data.errors);
    if (graphqlErrors.length > 0) {
      warnings.push(`capability sweep GraphQL errors on page ${page}: ${graphqlErrors.join("; ")}`);
      return { rowsByPoolId, complete: false };
    }
    const rows = parsed.data.data?.aggregatorPools;
    if (!Array.isArray(rows)) {
      warnings.push(`capability sweep malformed response on page ${page}`);
      return { rowsByPoolId, complete: false };
    }

    for (const row of rows) {
      if (!isBalancerAmpRow(row)) continue;
      const amp = row.amp == null ? null : parseFloat(row.amp);
      rowsByPoolId.set(
        ampJoinKey(row.chain, row.id),
        amp != null && Number.isFinite(amp) && amp > 0 ? amp : null,
      );
    }

    if (rows.length < pageSize) return { rowsByPoolId, complete: true };
    if (page === DIRECT_API_DEFAULT_MAX_PAGES) {
      warnings.push(`capability sweep pagination cap reached at page ${page}`);
    }
  }
  return { rowsByPoolId, complete: false };
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
      const parsed = parseFloat(rate!);
      return !Number.isFinite(parsed) || parsed <= 0;
    })) {
      return balancerGate("invalid-invariant-parameters");
    }
  }

  if (pool.type === "WEIGHTED") {
    const weights = modeledTokens.map((token) => token.weight);
    if (weights.some((weight) => weight == null)) return balancerGate("incomplete-exact-capture");
    const parsedWeights = weights.map((weight) => parseFloat(weight!));
    if (
      parsedWeights.some((weight) => !Number.isFinite(weight) || weight <= 0) ||
      Math.abs(parsedWeights.reduce((sum, weight) => sum + weight, 0) - 1) > 0.0001
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
  const tvlUsd = parseFloat(pool.dynamicData.totalLiquidity);
  const volume24h = parseFloat(pool.dynamicData.volume24h);
  const swapFee = parseFloat(pool.dynamicData.swapFee);
  const balances = pool.poolTokens.map((token) => parseFloat(token.balance));
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
      const balance = parseFloat(token.balance);
      const balanceUsd = parseFloat(token.balanceUSD);
      const weight = token.weight == null ? null : parseFloat(token.weight);
      const priceRate = token.priceRate == null ? null : parseFloat(token.priceRate);
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
  const results: DexApiPool[] = [];
  const errors: string[] = [];
  const warnings: string[] = [];
  const pageSize = 1000;
  let successfulPages = 0;
  const exactCandidatePoolIdsByIndex = new Map<number, { poolId: string; stableMath: boolean }>();

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
      if (!REVIEWED_POOL_TYPES.has(pool.type)) continue;

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
      if (!Number.isFinite(tvlUsd) || tvlUsd <= 0) continue;
      if (tvlUsd > BALANCER_MAX_POOL_TVL_USD) {
        malformedRows++;
        continue;
      }

      const reviewedRoute = reviewedRouteForPool(pool);
      const genericPriceOverrides = new Map<string, number | null>();
      if (reviewedRoute) {
        // The aggregate balanceUSD field can collapse USP to issuer par. This
        // reviewed route is priceable only through its bounded executable quote.
        genericPriceOverrides.set(normalizedAddress(reviewedRoute.targetToken.address), null);
      }
      const shapedPool = shapeBalancerPool(pool, chain, genericPriceOverrides);
      results.push(shapedPool);
      const executionCapabilityGate = shapedPool.executionCapabilityGate;
      if (executionCapabilityGate == null && (STABLE_MATH_POOL_TYPES.has(pool.type) || pool.type === "WEIGHTED")) {
        exactCandidatePoolIdsByIndex.set(results.length - 1, {
          poolId: ampJoinKey(pool.chain, pool.id),
          stableMath: STABLE_MATH_POOL_TYPES.has(pool.type),
        });
      }
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

  let reviewedRouteCount = 0;
  for (const route of REVIEWED_BALANCER_ROUTES) {
    const reviewed = await fetchReviewedBalancerRoute(route, warnings, signal);
    if (!reviewed) continue;

    const priceOverrides = new Map<string, number | null>([
      [normalizedAddress(route.targetToken.address), null],
      [normalizedAddress(route.quoteToken.address), null],
    ]);
    const priceDependencyOverrides = new Map<string, NonNullable<DexApiPool["tokens"][number]["priceUsdDependency"]>>([
      [normalizedAddress(route.targetToken.address), {
        stablecoinId: "usdc-circle",
        multiplier: reviewed.targetPriceInUsdc,
      }],
    ]);
    // Stable Surge computes a dynamic fee and the buffer unwrap is a separate
    // hop. The bounded SOR quote is valid price evidence, but the generic
    // invariant model must remain gated until it models both behaviors.
    const shapedPool = shapeBalancerPool(
      reviewed.pool,
      route.internalChain,
      priceOverrides,
      priceDependencyOverrides,
      balancerGate("unsupported-invariant"),
    );
    shapedPool.amp = parseFloat(reviewed.pool.amp);

    const existingIndex = results.findIndex((pool) =>
      pool.chain === route.internalChain &&
      normalizedAddress(pool.poolAddress) === normalizedAddress(route.poolAddress)
    );
    if (existingIndex >= 0) results[existingIndex] = shapedPool;
    else results.push(shapedPool);
    reviewedRouteCount++;
  }
  if (reviewedRouteCount > 0) {
    logWorkerEvent({
      scope: "lib",
      level: "info",
      event: "fetch-balancer.reviewed-routes",
      job: "sync-dex-liquidity",
      message: "Resolved reviewed Balancer routes through a bounded executable quote",
      metadata: { resolved: reviewedRouteCount, configured: REVIEWED_BALANCER_ROUTES.length },
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
