import { canonicalExitRouteScopedKey } from "@shared/lib/exit-route-identity";
import {
  isKavaSwapDiscoveryDeployment,
  KAVA_SWAP_USDX_DISCOVERY_ADDRESS,
} from "@shared/lib/dex-deployment-coverage";
import type { ContractDeployment } from "@shared/types/core";
import { USER_AGENT } from "../../lib/constants";
import { fetchJsonWithRetry } from "../../lib/fetch-retry";
import { type CrawlStageContext, toStagedPool } from "./staged-pool";
import type { DexDeploymentProviderCheck } from "./types";

const KAVA_SWAP_API_BASE = "https://api.data.kava.io";
const KAVA_SWAP_PARAMS_PATH = "/kava/swap/v1beta1/params";
const KAVA_SWAP_POOLS_PATH = "/kava/swap/v1beta1/pools";
const KAVA_SWAP_CHAIN = "kava";
const KAVA_SWAP_USDX_DENOM = KAVA_SWAP_USDX_DISCOVERY_ADDRESS;
const KAVA_SWAP_REQUEST_MAX_RETRIES = 1;
const KAVA_SWAP_MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const KAVA_SWAP_STAGE_TIMEOUT_MS = 8_000;

const KAVA_SWAP_PROVIDER = "kava-swap";
const KAVA_SWAP_SOURCE = "kava-swap";

interface KavaSwapPool {
  name: string;
  denoms: [string, string];
  amounts: [string, string];
  totalShares: string;
  rawJson: string;
}

interface KavaSwapParams {
  allowedPairs: Set<string>;
  feeTierBp: number;
}

interface KavaEndpointSuccess {
  kind: "success";
  body: unknown;
}

interface KavaEndpointFailure {
  kind: "failure";
  retryable?: true;
}

type KavaEndpointResult = KavaEndpointSuccess | KavaEndpointFailure;

export interface KavaSwapPoolsStageResult {
  providerChecks: DexDeploymentProviderCheck[];
  stoppedEarly?: boolean;
}

/** Canonical registry identity served by this adapter: native Kava `usdx`. */
export const KAVA_SWAP_NATIVE_DEPLOYMENT = {
  chain: KAVA_SWAP_CHAIN,
  address: KAVA_SWAP_USDX_DENOM,
} as const;

export { isKavaSwapDiscoveryDeployment };

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

function parseNonNegativeInteger(value: unknown): string | null {
  if (typeof value !== "string" || !/^(?:0|[1-9]\d*)$/u.test(value)) return null;
  return value;
}

function parseSwapFeeBasisPoints(value: unknown): number | null {
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

function pairKey(left: string, right: string): string {
  return left < right ? `${left}\u0000${right}` : `${right}\u0000${left}`;
}

function parseAllowedPairs(value: unknown): Set<string> | null {
  if (!Array.isArray(value)) return null;
  const allowedPairs = new Set<string>();
  for (const item of value) {
    const row = asRecord(item);
    const tokenA = parseDenom(row?.token_a);
    const tokenB = parseDenom(row?.token_b);
    if (tokenA == null || tokenB == null || tokenA === tokenB) return null;
    allowedPairs.add(pairKey(tokenA, tokenB));
  }
  return allowedPairs;
}

function parseKavaSwapParams(body: unknown): KavaSwapParams | null {
  const root = asRecord(body);
  const params = asRecord(root?.params);
  const allowedPairs = parseAllowedPairs(params?.allowed_pools);
  const feeTierBp = parseSwapFeeBasisPoints(params?.swap_fee);
  if (allowedPairs == null || feeTierBp == null) return null;
  return { allowedPairs, feeTierBp };
}

function parseKavaSwapPool(value: unknown): KavaSwapPool | null {
  const row = asRecord(value);
  const name = typeof row?.name === "string" ? row.name.trim() : "";
  const nameParts = name.split(":");
  if (nameParts.length !== 2) return null;
  const nameDenomA = parseDenom(nameParts[0]);
  const nameDenomB = parseDenom(nameParts[1]);
  if (nameDenomA == null || nameDenomB == null || nameDenomA === nameDenomB) return null;

  const coins = row?.coins;
  if (!Array.isArray(coins) || coins.length !== 2) return null;
  const coinA = asRecord(coins[0]);
  const coinB = asRecord(coins[1]);
  const denomA = parseDenom(coinA?.denom);
  const denomB = parseDenom(coinB?.denom);
  const amountA = parseNonNegativeInteger(coinA?.amount);
  const amountB = parseNonNegativeInteger(coinB?.amount);
  const totalShares = parseNonNegativeInteger(row?.total_shares);
  if (
    denomA == null ||
    denomB == null ||
    denomA === denomB ||
    amountA == null ||
    amountB == null ||
    totalShares == null
  ) {
    return null;
  }
  const sameOrder = nameDenomA === denomA && nameDenomB === denomB;
  const reverseOrder = nameDenomA === denomB && nameDenomB === denomA;
  if (!sameOrder && !reverseOrder) return null;

  return {
    name,
    denoms: [denomA, denomB],
    amounts: [amountA, amountB],
    totalShares,
    rawJson: JSON.stringify(row),
  };
}

function parseKavaSwapPools(body: unknown): KavaSwapPool[] | null {
  const root = asRecord(body);
  if (!Array.isArray(root?.pools)) return null;

  const pools: KavaSwapPool[] = [];
  for (const value of root.pools) {
    const parsed = parseKavaSwapPool(value);
    if (parsed == null) return null;
    pools.push(parsed);
  }

  // A non-null pagination key means the response is only a page. Do not turn
  // that partial response into a verified-empty census. The endpoint currently
  // returns `next_key: null`; when pagination is omitted by an older LCD, the
  // pool array itself remains the complete response contract.
  if (root.pagination !== undefined) {
    const pagination = asRecord(root.pagination);
    if (pagination == null || pagination.next_key !== null) return null;
    if (pagination.total !== undefined) {
      const total = parseNonNegativeInteger(pagination.total);
      if (total == null || Number(total) !== pools.length) return null;
    }
  }

  return pools;
}

function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 425 || status === 429 || status >= 500;
}

async function fetchKavaSwapEndpoint(path: string, signal: AbortSignal): Promise<KavaEndpointResult> {
  const result = await fetchJsonWithRetry<unknown>(
    `${KAVA_SWAP_API_BASE}${path}`,
    {
      signal,
      headers: {
        Accept: "application/json",
        "User-Agent": USER_AGENT,
      },
    },
    KAVA_SWAP_REQUEST_MAX_RETRIES,
    {
      maxResponseBytes: KAVA_SWAP_MAX_RESPONSE_BYTES,
      returnFinalResponse: true,
      timeoutMs: KAVA_SWAP_STAGE_TIMEOUT_MS,
    },
  );
  if (result == null) return { kind: "failure", retryable: true };
  if (!result.response.ok) {
    return isRetryableStatus(result.response.status)
      ? { kind: "failure", retryable: true }
      : { kind: "failure" };
  }
  return { kind: "success", body: result.body };
}
function makeProviderCheck(
  target: ContractDeployment,
  status: DexDeploymentProviderCheck["status"],
  options?: { observedPoolCount?: number; retryable?: true },
): DexDeploymentProviderCheck {
  return {
    chain: target.chain,
    address: target.address,
    provider: KAVA_SWAP_PROVIDER,
    status,
    ...(options?.observedPoolCount !== undefined ? { observedPoolCount: options.observedPoolCount } : {}),
    ...(options?.retryable === true ? { retryable: true } : {}),
  };
}

function stageKavaSwapPool(
  pool: KavaSwapPool,
  target: ContractDeployment,
  feeTierBp: number,
  context: CrawlStageContext,
): void {
  if (!pool.denoms.includes(KAVA_SWAP_USDX_DENOM)) return;
  const poolId = canonicalExitRouteScopedKey(target.chain, pool.name);
  if (context.hasKnownPool(poolId)) return;

  context.addPool(
    toStagedPool(context, {
      poolId,
      source: KAVA_SWAP_SOURCE,
      chain: target.chain,
      protocol: "kava-swap",
      dexId: "kava-swap",
      symbol: `${pool.denoms[0]} / ${pool.denoms[1]}`,
      tvlUsd: null,
      volume24h: null,
      qualityMultiplier: null,
      poolType: "kava-constant-product",
      feeTier: feeTierBp,
      balanceRatio: null,
      isStable: null,
      baseToken: pool.denoms[0],
      quoteToken: pool.denoms[1],
      quoteSymbol: pool.denoms[1],
      priceUsd: null,
      lockedLiqPct: null,
      rawJson: pool.rawJson,
    }),
  );
}

export async function crawlKavaSwapPoolsStage(input: {
  coinTargets: ContractDeployment[];
  context: CrawlStageContext;
}): Promise<KavaSwapPoolsStageResult> {
  const targets = input.coinTargets.filter(({ chain, address }) =>
    isKavaSwapDiscoveryDeployment(chain, address),
  );
  if (targets.length === 0) return { providerChecks: [] };
  if (input.context.timeExceeded()) return { providerChecks: [], stoppedEarly: true };

  const target = targets[0]!;
  const paramsResult = await fetchKavaSwapEndpoint(
    KAVA_SWAP_PARAMS_PATH,
    input.context.buildStageSignal(KAVA_SWAP_STAGE_TIMEOUT_MS),
  );
  if (input.context.signal?.aborted) throw input.context.signal.reason;
  if (paramsResult.kind === "failure") {
    return {
      providerChecks: targets.map((target) =>
        makeProviderCheck(target, "failure", { retryable: paramsResult.retryable }),
      ),
    };
  }
  const params = parseKavaSwapParams(paramsResult.body);
  if (params == null) {
    return { providerChecks: targets.map((target) => makeProviderCheck(target, "degraded")) };
  }

  if (input.context.timeExceeded()) return { providerChecks: [], stoppedEarly: true };
  const poolsResult = await fetchKavaSwapEndpoint(
    KAVA_SWAP_POOLS_PATH,
    input.context.buildStageSignal(KAVA_SWAP_STAGE_TIMEOUT_MS),
  );
  if (input.context.signal?.aborted) throw input.context.signal.reason;

  if (input.context.timeExceeded()) return { providerChecks: [], stoppedEarly: true };
  if (poolsResult.kind === "failure") {
    return {
      providerChecks: targets.map((target) =>
        makeProviderCheck(target, "failure", { retryable: poolsResult.retryable }),
      ),
    };
  }
  const pools = parseKavaSwapPools(poolsResult.body);
  if (pools == null) {
    return { providerChecks: targets.map((target) => makeProviderCheck(target, "degraded")) };
  }

  let observedPoolCount = 0;
  for (const pool of pools) {
    if (!pool.denoms.includes(KAVA_SWAP_USDX_DENOM)) continue;
    if (!params.allowedPairs.has(pairKey(pool.denoms[0], pool.denoms[1]))) continue;
    observedPoolCount += 1;
    stageKavaSwapPool(pool, target, params.feeTierBp, input.context);
  }

  return {
    providerChecks: targets.map((target) =>
      makeProviderCheck(target, "success", { observedPoolCount }),
    ),
  };
}
