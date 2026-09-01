import { canonicalExitRouteScopedKey } from "@shared/lib/exit-route-identity";
import {
  isNobleSwapDiscoveryDeployment,
  isOsmosisSqsDiscoveryDeployment,
} from "@shared/lib/dex-deployment-coverage";
import type { ContractDeployment } from "@shared/types/core";
import { sleepWithSignal } from "../../lib/abort";
import { IsolateLocalState } from "../../lib/isolate-local-state";
import { DEX_LIQUIDITY_POOL_MIN_TVL_USD } from "../dex-liquidity/constants";
import { type CrawlStageContext, toStagedPool } from "./staged-pool";
import { fetchDexDiscoveryJsonEndpoint } from "./fetch-json-endpoint";
import { STAGED_POOL_MAX_TVL_USD, type DexDeploymentProviderCheck } from "./types";

/**
 * Osmosis' sidecar query server. `GET /pools?filter[denom]=<denom>` is the only
 * public Osmosis surface that answers "which pools hold this denom" without
 * downloading the whole 3.5k-pool book: the poolmanager LCD has no denom
 * filter (`/osmosis/gamm/v1beta1/pools_with_filter` answers 501 Not
 * Implemented) and `all-pools` is ~2.4 MB per call. The sidecar indexes every
 * pool module on the chain, so a completed response is an exhaustive census
 * for that denom.
 */
const OSMOSIS_SQS_API_BASE = "https://sqsprod.osmosis.zone";
const OSMOSIS_SQS_POOLS_PATH = "/pools";

/** Noble's first-party LCD. The `swap` module is the app-chain's whole DEX surface. */
const NOBLE_LCD_API_BASE = "https://api.noble.xyz";
const NOBLE_SWAP_POOLS_PATH = "/noble/swap/v1/pools";

const COSMOS_REQUEST_MAX_RETRIES = 1;
const COSMOS_STAGE_TIMEOUT_MS = 8_000;
/** The largest observed denom-filtered response is ~0.95 MB (Osmosis USDC, 814 pools). */
const OSMOSIS_MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
const NOBLE_MAX_RESPONSE_BYTES = 512 * 1024;
/** Neither endpoint documents a rate limit; pace serial calls anyway. */
const COSMOS_REQUEST_PACING_MS = 400;

const OSMOSIS_PROVIDER = "osmosis-sqs";
const OSMOSIS_SOURCE = "osmosis-sqs";
const NOBLE_PROVIDER = "noble-swap";
const NOBLE_SOURCE = "noble-swap";

const cosmosRequestState = new IsolateLocalState(() => ({ lastStartedAtMs: 0 }));

/** Test-only reset for the isolate-local request pacing clock. */
export function resetCosmosDiscoveryStateForTests(): void {
  cosmosRequestState.reset();
}

export interface CosmosPoolsStageResult {
  providerChecks: DexDeploymentProviderCheck[];
  stoppedEarly?: boolean;
}

export { isNobleSwapDiscoveryDeployment, isOsmosisSqsDiscoveryDeployment };

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function parseDenom(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const denom = value.trim();
  if (denom.length === 0 || denom.length > 128 || /[\s:]/u.test(denom)) return null;
  return denom;
}

async function paceCosmosRequest(signal?: AbortSignal): Promise<void> {
  const elapsedMs = Date.now() - cosmosRequestState.state.lastStartedAtMs;
  if (cosmosRequestState.state.lastStartedAtMs > 0 && elapsedMs < COSMOS_REQUEST_PACING_MS) {
    await sleepWithSignal(COSMOS_REQUEST_PACING_MS - elapsedMs, signal);
  }
  cosmosRequestState.state.lastStartedAtMs = Date.now();
}

async function fetchCosmosEndpoint(
  url: string,
  maxResponseBytes: number,
  context: CrawlStageContext,
): ReturnType<typeof fetchDexDiscoveryJsonEndpoint> {
  await paceCosmosRequest(context.signal);
  return fetchDexDiscoveryJsonEndpoint({
    url,
    signal: context.buildStageSignal(COSMOS_STAGE_TIMEOUT_MS),
    maxRetries: COSMOS_REQUEST_MAX_RETRIES,
    maxResponseBytes,
    timeoutMs: COSMOS_STAGE_TIMEOUT_MS,
  });
}

function makeProviderCheck(
  target: ContractDeployment,
  provider: DexDeploymentProviderCheck["provider"],
  status: DexDeploymentProviderCheck["status"],
  options?: { observedPoolCount?: number; retryable?: true },
): DexDeploymentProviderCheck {
  return {
    chain: target.chain,
    address: target.address,
    provider,
    status,
    ...(options?.observedPoolCount !== undefined ? { observedPoolCount: options.observedPoolCount } : {}),
    ...(options?.retryable === true ? { retryable: true } : {}),
  };
}

// ---------------------------------------------------------------------------
// Osmosis
// ---------------------------------------------------------------------------

interface OsmosisPool {
  poolId: string;
  poolType: string;
  isStable: boolean | null;
  feeTierBp: number | null;
  tvlUsd: number;
  denoms: string[];
  raw: unknown;
}

/** Osmosis pool-module discriminator carried in the sidecar's `type` field. */
function osmosisPoolType(value: unknown): { poolType: string; isStable: boolean | null } {
  switch (value) {
    case 0:
      return { poolType: "osmosis-balancer", isStable: null };
    case 1:
      return { poolType: "osmosis-stableswap", isStable: true };
    case 2:
      return { poolType: "osmosis-concentrated", isStable: null };
    case 3:
      return { poolType: "osmosis-cosmwasm", isStable: null };
    default:
      return { poolType: "osmosis-pool", isStable: null };
  }
}

function parseSpreadFactorBasisPoints(value: unknown): number | null {
  if (
    typeof value !== "string" ||
    // eslint-disable-next-line security/detect-unsafe-regex -- anchored fixed-shape decimal check; finite quantifiers, no backtracking ambiguity.
    !/^(?:0|[1-9]\d*)(?:\.\d+)?$/u.test(value)
  ) {
    return null;
  }
  const fee = Number(value);
  if (!Number.isFinite(fee) || fee < 0 || fee >= 1) return null;
  const feeTierBp = Math.round(fee * 10_000);
  return Number.isSafeInteger(feeTierBp) ? feeTierBp : null;
}

/**
 * `liquidity_cap` is the sidecar's own USD valuation of the pool. When
 * `liquidity_cap_error` names a leg the indexer cannot price, the cap still
 * counts every priceable leg — and the tracked stablecoin is always priceable —
 * so it stays a usable lower bound rather than an unknown. A pool that clears
 * the retained-pool floor on that bound is staged; one that does not is a real
 * below-floor venue, which the census treats as completed-empty (the same
 * choice the TzKT adapter documents) rather than as a degraded response.
 */
function parseLiquidityCapUsd(value: unknown): number | null {
  if (typeof value !== "string" && typeof value !== "number") return null;
  const cap = Number(value);
  if (!Number.isFinite(cap) || cap < 0 || cap > STAGED_POOL_MAX_TVL_USD) return null;
  return cap;
}

function collectOsmosisPoolDenoms(pool: Record<string, unknown>): string[] {
  const denoms = new Set<string>();
  const balances = pool.balances;
  if (Array.isArray(balances)) {
    for (const balance of balances) {
      const denom = parseDenom(asRecord(balance)?.denom);
      if (denom) denoms.add(denom);
    }
  }
  const chainModel = asRecord(pool.chain_model);
  for (const key of ["token0", "token1"] as const) {
    const denom = parseDenom(chainModel?.[key]);
    if (denom) denoms.add(denom);
  }
  const poolAssets = chainModel?.pool_assets;
  if (Array.isArray(poolAssets)) {
    for (const asset of poolAssets) {
      const denom = parseDenom(asRecord(asRecord(asset)?.token)?.denom);
      if (denom) denoms.add(denom);
    }
  }
  return [...denoms];
}

function parseOsmosisPoolId(pool: Record<string, unknown>): string | null {
  const chainModel = asRecord(pool.chain_model);
  // Concentrated and balancer/stableswap pools carry `id`; CosmWasm pools carry
  // `pool_id` beside their contract address.
  const raw = chainModel?.id ?? chainModel?.pool_id;
  if (typeof raw === "number" && Number.isSafeInteger(raw) && raw >= 0) return String(raw);
  if (typeof raw === "string" && /^\d{1,19}$/u.test(raw)) return raw;
  return null;
}

function parseOsmosisPool(value: unknown): OsmosisPool | null {
  const pool = asRecord(value);
  if (!pool) return null;
  const poolId = parseOsmosisPoolId(pool);
  const tvlUsd = parseLiquidityCapUsd(pool.liquidity_cap);
  if (poolId == null || tvlUsd == null) return null;
  const denoms = collectOsmosisPoolDenoms(pool);
  if (denoms.length === 0) return null;
  const { poolType, isStable } = osmosisPoolType(pool.type);
  return {
    poolId,
    poolType,
    isStable,
    feeTierBp: parseSpreadFactorBasisPoints(pool.spread_factor),
    tvlUsd,
    denoms,
    raw: value,
  };
}

function parseOsmosisPools(body: unknown): OsmosisPool[] | null {
  const root = asRecord(body);
  if (!Array.isArray(root?.data)) return null;
  const pools: OsmosisPool[] = [];
  for (const value of root.data) {
    const parsed = parseOsmosisPool(value);
    if (parsed == null) return null;
    pools.push(parsed);
  }
  return pools;
}

function shortDenom(denom: string): string {
  return denom.startsWith("ibc/") ? `ibc/${denom.slice(4, 12)}` : denom;
}

function stageOsmosisPool(pool: OsmosisPool, target: ContractDeployment, context: CrawlStageContext): void {
  const poolId = canonicalExitRouteScopedKey(target.chain, pool.poolId);
  if (context.hasKnownPool(poolId)) return;
  const counterparts = pool.denoms.filter((denom) => denom !== target.address);
  const quoteToken = counterparts.length === 1 ? counterparts[0]! : null;
  context.addPool(
    toStagedPool(context, {
      poolId,
      source: OSMOSIS_SOURCE,
      chain: target.chain,
      protocol: "osmosis",
      dexId: "osmosis",
      symbol: quoteToken
        ? `${shortDenom(target.address)} / ${shortDenom(quoteToken)}`
        : `${shortDenom(target.address)} / multi-asset(${counterparts.length})`,
      tvlUsd: pool.tvlUsd,
      volume24h: null,
      qualityMultiplier: null,
      poolType: pool.poolType,
      feeTier: pool.feeTierBp,
      balanceRatio: null,
      isStable: pool.isStable,
      baseToken: target.address,
      quoteToken,
      quoteSymbol: quoteToken ? shortDenom(quoteToken) : null,
      // The sidecar prices the pool, not the leg, and a Cosmos denom carries no
      // decimals in the response — deriving a per-token USD price from raw
      // balances would publish an unscaled number.
      priceUsd: null,
      lockedLiqPct: null,
      rawJson: JSON.stringify(pool.raw),
    }),
  );
}

function buildOsmosisPoolsUrl(denom: string): string {
  const url = new URL(OSMOSIS_SQS_POOLS_PATH, OSMOSIS_SQS_API_BASE);
  url.searchParams.set("filter[denom]", denom);
  return url.toString();
}

async function crawlOsmosisTargets(
  targets: readonly ContractDeployment[],
  context: CrawlStageContext,
): Promise<CosmosPoolsStageResult> {
  const providerChecks: DexDeploymentProviderCheck[] = [];
  for (const target of targets) {
    if (context.timeExceeded()) return { providerChecks, stoppedEarly: true };
    const result = await fetchCosmosEndpoint(
      buildOsmosisPoolsUrl(target.address),
      OSMOSIS_MAX_RESPONSE_BYTES,
      context,
    );
    if (context.signal?.aborted) throw context.signal.reason;
    if (result.kind === "failure") {
      providerChecks.push(
        makeProviderCheck(target, OSMOSIS_PROVIDER, "failure", { retryable: result.retryable }),
      );
      continue;
    }
    const pools = parseOsmosisPools(result.body);
    if (pools == null) {
      providerChecks.push(makeProviderCheck(target, OSMOSIS_PROVIDER, "degraded"));
      continue;
    }

    let observedPoolCount = 0;
    let unresolvedPoolCount = 0;
    for (const pool of pools) {
      // The filter is the server's claim; the pool's own denom list is the
      // evidence. A pool that cannot corroborate membership is not silently
      // dropped into a verified-empty census.
      if (!pool.denoms.includes(target.address)) {
        unresolvedPoolCount += 1;
        continue;
      }
      if (pool.tvlUsd < DEX_LIQUIDITY_POOL_MIN_TVL_USD) continue;
      observedPoolCount += 1;
      stageOsmosisPool(pool, target, context);
    }

    providerChecks.push(
      unresolvedPoolCount > 0
        ? makeProviderCheck(target, OSMOSIS_PROVIDER, "degraded")
        : makeProviderCheck(target, OSMOSIS_PROVIDER, "success", { observedPoolCount }),
    );
  }
  return { providerChecks };
}

// ---------------------------------------------------------------------------
// Noble
// ---------------------------------------------------------------------------

interface NoblePool {
  poolId: string;
  algorithm: string;
  liquidity: Array<{ denom: string; amount: string }>;
  raw: unknown;
}

function parseNobleLiquidity(value: unknown): Array<{ denom: string; amount: string }> | null {
  if (!Array.isArray(value)) return null;
  const liquidity: Array<{ denom: string; amount: string }> = [];
  for (const item of value) {
    const row = asRecord(item);
    const denom = parseDenom(row?.denom);
    const amount = typeof row?.amount === "string" && /^(?:0|[1-9]\d*)$/u.test(row.amount) ? row.amount : null;
    if (denom == null || amount == null) return null;
    liquidity.push({ denom, amount });
  }
  return liquidity;
}

function parseNoblePool(value: unknown): NoblePool | null {
  const pool = asRecord(value);
  if (!pool) return null;
  const id = pool.id;
  const poolId =
    typeof id === "string" && /^\d{1,19}$/u.test(id)
      ? id
      : typeof id === "number" && Number.isSafeInteger(id) && id >= 0
        ? String(id)
        : null;
  const algorithm = typeof pool.algorithm === "string" && pool.algorithm.trim() ? pool.algorithm.trim() : null;
  const liquidity = parseNobleLiquidity(pool.liquidity);
  if (poolId == null || algorithm == null || liquidity == null) return null;
  return { poolId, algorithm, liquidity, raw: value };
}

function parseNoblePools(body: unknown): NoblePool[] | null {
  const root = asRecord(body);
  if (!Array.isArray(root?.pools)) return null;
  const pools: NoblePool[] = [];
  for (const value of root.pools) {
    const parsed = parseNoblePool(value);
    if (parsed == null) return null;
    pools.push(parsed);
  }
  return pools;
}

/**
 * Noble reports pool reserves in base units with no decimals and prices
 * nothing, so the census records the venue without inventing a USD size. The
 * pool is staged with a null TVL, exactly as the Kava `x/swap` adapter does.
 */
function stageNoblePool(pool: NoblePool, target: ContractDeployment, context: CrawlStageContext): void {
  const poolId = canonicalExitRouteScopedKey(target.chain, pool.poolId);
  if (context.hasKnownPool(poolId)) return;
  const counterparts = pool.liquidity.map(({ denom }) => denom).filter((denom) => denom !== target.address);
  const quoteToken = counterparts.length === 1 ? counterparts[0]! : null;
  context.addPool(
    toStagedPool(context, {
      poolId,
      source: NOBLE_SOURCE,
      chain: target.chain,
      protocol: "noble-swap",
      dexId: "noble-swap",
      symbol: quoteToken
        ? `${target.address} / ${quoteToken}`
        : `${target.address} / multi-asset(${counterparts.length})`,
      tvlUsd: null,
      volume24h: null,
      qualityMultiplier: null,
      poolType: `noble-${pool.algorithm.toLowerCase()}`,
      feeTier: null,
      balanceRatio: null,
      isStable: pool.algorithm.toUpperCase() === "STABLESWAP" ? true : null,
      baseToken: target.address,
      quoteToken,
      quoteSymbol: quoteToken,
      priceUsd: null,
      lockedLiqPct: null,
      rawJson: JSON.stringify(pool.raw),
    }),
  );
}

async function crawlNobleTargets(
  targets: readonly ContractDeployment[],
  context: CrawlStageContext,
): Promise<CosmosPoolsStageResult> {
  if (context.timeExceeded()) return { providerChecks: [], stoppedEarly: true };
  const result = await fetchCosmosEndpoint(
    `${NOBLE_LCD_API_BASE}${NOBLE_SWAP_POOLS_PATH}`,
    NOBLE_MAX_RESPONSE_BYTES,
    context,
  );
  if (context.signal?.aborted) throw context.signal.reason;
  if (result.kind === "failure") {
    return {
      providerChecks: targets.map((target) =>
        makeProviderCheck(target, NOBLE_PROVIDER, "failure", { retryable: result.retryable }),
      ),
    };
  }
  const pools = parseNoblePools(result.body);
  if (pools == null) {
    return { providerChecks: targets.map((target) => makeProviderCheck(target, NOBLE_PROVIDER, "degraded")) };
  }

  return {
    providerChecks: targets.map((target) => {
      let observedPoolCount = 0;
      for (const pool of pools) {
        if (!pool.liquidity.some(({ denom }) => denom === target.address)) continue;
        observedPoolCount += 1;
        stageNoblePool(pool, target, context);
      }
      return makeProviderCheck(target, NOBLE_PROVIDER, "success", { observedPoolCount });
    }),
  };
}

/**
 * Cosmos deployment census. Two chains, one serial stage:
 *  - Osmosis, one denom-filtered sidecar read per tracked deployment;
 *  - Noble, one `swap` module read per coin covering every Noble deployment.
 *
 * Both are plain public HTTPS GETs on port 443 with no key. The stage issues at
 * most one in-flight request at a time, so it cannot crowd the six-connection
 * per-trigger pool, and every response body is consumed by `fetchJsonWithRetry`
 * before the next request opens.
 */
export async function crawlCosmosPoolsStage(input: {
  coinTargets: ContractDeployment[];
  context: CrawlStageContext;
}): Promise<CosmosPoolsStageResult> {
  const osmosisTargets = input.coinTargets.filter(({ chain, address }) =>
    isOsmosisSqsDiscoveryDeployment(chain, address),
  );
  const nobleTargets = input.coinTargets.filter(({ chain, address }) =>
    isNobleSwapDiscoveryDeployment(chain, address),
  );
  if (osmosisTargets.length === 0 && nobleTargets.length === 0) return { providerChecks: [] };
  if (input.context.timeExceeded()) return { providerChecks: [], stoppedEarly: true };

  const providerChecks: DexDeploymentProviderCheck[] = [];
  if (osmosisTargets.length > 0) {
    const osmosis = await crawlOsmosisTargets(osmosisTargets, input.context);
    providerChecks.push(...osmosis.providerChecks);
    if (osmosis.stoppedEarly) return { providerChecks, stoppedEarly: true };
  }
  if (nobleTargets.length > 0) {
    const noble = await crawlNobleTargets(nobleTargets, input.context);
    providerChecks.push(...noble.providerChecks);
    if (noble.stoppedEarly) return { providerChecks, stoppedEarly: true };
  }
  return { providerChecks };
}
