import { logWorkerEventArgs } from "../../lib/structured-log";
import type { ContractDeployment } from "@shared/types/core";
import { getGeckoTerminalDiscoveryNetwork } from "@shared/lib/dex-deployment-coverage";
import { canonicalExitRouteScopedId, canonicalExitRouteScopedKey } from "@shared/types/exit-route-identity";
import { sleepWithSignal, throwIfAborted } from "../../lib/abort";
import { shouldAttemptFetch, recordOutcome } from "../../lib/circuit-breaker";
import { CHAIN_META } from "@shared/types/chain-identity";
import { CG_CHAIN_MAP, DS_CHAIN_MAP } from "../../lib/chain-registry";
import { isBlockedDexId } from "../../lib/dex-cron-constants";
import { CIRCUIT_SOURCE, DEX_PRICE_OBSERVATION_MIN_TVL_USD } from "../../lib/constants";
import {
  cgPoolVolume24hReading,
  fetchCgTokenPoolsWithStatus,
  type CgPool,
  type CgPoolsByAddressResult,
} from "../../lib/coingecko-onchain";
import { RATE_LIMITS } from "../../lib/rate-limit";
import { classifyCgPool, parseCgPool } from "../dex-liquidity/coingecko-onchain-shared";
import type { ParsedPool } from "../dex-liquidity/crawl-helpers";
import { normalizeProtocol } from "../dex-liquidity/pool-normalization";
import { isPlausibleDexObservationPrice } from "../dex-liquidity/price-sanity";
import {
  createPoolPriceCoherenceAdmissionGate,
  type PoolPriceCoherenceAdmissionGate,
} from "../dex-liquidity/pool-price-coherence";
import { buildChainAddressKey } from "../dex-liquidity/token-resolution";
import { DISCOVERY_STAGE_TIMEOUT_MS, type CrawlStageContext, toStagedPool } from "./staged-pool";
import { makeDexDeploymentProviderCheck, type DexDeploymentProviderCheck, type StagedPool } from "./types";

export interface CoinGeckoPoolsStageResult {
  priceObservationTargets: Set<string>;
  unresolvedChains: string[];
  stoppedEarly: boolean;
  providerChecks: DexDeploymentProviderCheck[];
}

export interface CoinGeckoPoolsStageDependencies {
  shouldAttemptFetch: typeof shouldAttemptFetch;
  recordOutcome: typeof recordOutcome;
  fetchCgTokenPoolsWithStatus: typeof fetchCgTokenPoolsWithStatus;
  sleepWithSignal: typeof sleepWithSignal;
}

const defaultCoinGeckoPoolsStageDependencies: CoinGeckoPoolsStageDependencies = {
  shouldAttemptFetch,
  recordOutcome,
  fetchCgTokenPoolsWithStatus,
  sleepWithSignal,
};

interface CrawlCoinGeckoPoolsStageOptions {
  db: D1Database;
  coinTargets: ContractDeployment[];
  cgApiKey: string | null;
  context: CrawlStageContext;
  dependencies?: CoinGeckoPoolsStageDependencies;
}

type CoinGeckoProviderCheck = DexDeploymentProviderCheck & {
  /** Stable provider-local diagnostic class; the shared check type stays unchanged. */
  error?: string;
};

interface CoinGeckoCheckClassification {
  status: DexDeploymentProviderCheck["status"];
  retryable?: true;
  error?: string;
}

function errorName(error: unknown): string {
  if (error && typeof error === "object" && "name" in error) {
    const name = (error as { name?: unknown }).name;
    if (typeof name === "string" && name) return name;
  }
  return typeof error;
}

export function classifyCoinGeckoResult(
  result: Pick<CgPoolsByAddressResult, "transportOk" | "schemaDegraded">,
): CoinGeckoCheckClassification {
  // The helper intentionally separates schema health from transport health.
  // Keep malformed/schema-degraded responses non-retryable even if both flags
  // are ever set on a partial response.
  if (result.schemaDegraded) {
    return {
      status: result.transportOk ? "degraded" : "failure",
      error: "coingecko-malformed-payload",
    };
  }
  if (!result.transportOk) {
    // fetchCgTokenPoolsWithStatus currently collapses HTTP 429/5xx and fetch
    // failures into transportOk=false, so retain that provider-specific class
    // rather than pretending the exact HTTP status is available here.
    return {
      status: "failure",
      retryable: true,
      error: "coingecko-transport-failure",
    };
  }
  return { status: "success" };
}

export function classifyCoinGeckoThrownError(error: unknown): CoinGeckoCheckClassification {
  const name = errorName(error);
  if (name === "SyntaxError") {
    return { status: "degraded", error: "coingecko-malformed-payload" };
  }
  if (name === "TimeoutError" || name === "AbortError") {
    return { status: "failure", retryable: true, error: "coingecko-timeout" };
  }
  return { status: "failure", retryable: true, error: "coingecko-fetch-error" };
}

interface CgOnchainPoolAdmissionInput {
  pool: CgPool;
  parsed: ParsedPool;
  poolId: string;
  chain: string;
  /** Canonical tracked deployment address this row is attributed to. */
  trackedAddress: string;
  context: Pick<CrawlStageContext, "stablecoinId" | "nowSec" | "references">;
  coherence: PoolPriceCoherenceAdmissionGate;
}

/** Why the CG onchain admission policy refused a pool row, in gate order. */
export type CgOnchainPoolRejectReason =
  | "blocked-dex"
  | "untracked-leg"
  | "min-tvl"
  | "incoherent-price"
  | "implausible-price"
  | "turnover-ceiling";

export type CgOnchainPoolAdmission = { pool: StagedPool } | { reason: CgOnchainPoolRejectReason };

/**
 * The single CG onchain row admission policy, shared by the token-pool crawl
 * and the stale-pool refresh pass: the DEX id must not be blocked, the tracked
 * address must be a pool leg, TVL must reach the $1k floor, the pool's own pair
 * ratio must agree with its leg prices, a usable price must be plausible for
 * the stablecoin, and turnover above 50x TVL is rejected as malformed. Volume
 * is stored as `0` only when the provider also reports zero 24h trades;
 * otherwise an unproven zero is `null`. A refusal names the first failing gate.
 */
export function admitCgOnchainPool({
  pool,
  parsed,
  poolId,
  chain,
  trackedAddress,
  context,
  coherence,
}: CgOnchainPoolAdmissionInput): CgOnchainPoolAdmission {
  if (isBlockedDexId(parsed.dexId)) return { reason: "blocked-dex" };
  const side =
    trackedAddress === parsed.baseTokenAddress
      ? "base"
      : trackedAddress === parsed.quoteTokenAddress
        ? "quote"
        : null;
  if (!side) return { reason: "untracked-leg" };
  const priceRaw = side === "base" ? parsed.baseTokenPriceUsd : parsed.quoteTokenPriceUsd;
  const tvlUsd = parsed.tvlUsd;
  if (!Number.isFinite(tvlUsd) || tvlUsd < 1_000) return { reason: "min-tvl" };

  if (!coherence.admits(side, parsed)) return { reason: "incoherent-price" };

  const hasUsablePrice = Number.isFinite(priceRaw) && priceRaw > 0;
  if (hasUsablePrice && !isPlausibleDexObservationPrice(context.stablecoinId, priceRaw, context.references)) {
    return { reason: "implausible-price" };
  }

  const volume24h = cgPoolVolume24hReading(pool.attributes);
  if (volume24h != null && tvlUsd > 0 && volume24h / tvlUsd > 50) return { reason: "turnover-ceiling" };
  const { qualityMultiplier, poolType, feePercentage, lockedLiquidityPct, balanceRatio } = classifyCgPool(
    parsed,
    pool.attributes,
  );
  const dexId = parsed.dexId;
  return {
    pool: toStagedPool(context, {
      poolId,
      source: "cg_onchain",
      chain,
      protocol: normalizeProtocol(dexId),
      dexId,
      symbol: parsed.poolName,
      tvlUsd,
      volume24h,
      qualityMultiplier,
      poolType,
      feeTier: feePercentage != null ? Math.round(feePercentage * 100) : null,
      balanceRatio,
      isStable: null,
      baseToken: parsed.baseTokenAddress,
      quoteToken: parsed.quoteTokenAddress,
      quoteSymbol: null,
      priceUsd: hasUsablePrice ? priceRaw : null,
      lockedLiqPct: lockedLiquidityPct,
      rawJson: null,
    }),
  };
}

export async function crawlCoinGeckoPoolsStage({
  db,
  coinTargets,
  cgApiKey,
  context,
  dependencies = defaultCoinGeckoPoolsStageDependencies,
}: CrawlCoinGeckoPoolsStageOptions): Promise<CoinGeckoPoolsStageResult> {
  const priceObservationTargets = new Set<string>();
  const unresolvedChains: string[] = [];
  const apiKey = cgApiKey?.trim() ? cgApiKey : null;
  const coherenceRejections = createPoolPriceCoherenceAdmissionGate("dex-discovery", "CG onchain");
  const providerChecks: CoinGeckoProviderCheck[] = [];

  if (!apiKey) {
    logWorkerEventArgs("handler", "warn",
      `[dex-discovery] CG API key not configured — Stage 1 (CG onchain) skipped for ${context.stablecoinId}`,
    );
  }

  const cgOnchainAllowed = apiKey ? await dependencies.shouldAttemptFetch(db, CIRCUIT_SOURCE.CG_ONCHAIN) : false;

  if (apiKey && !cgOnchainAllowed) {
    logWorkerEventArgs("handler", "warn", `[dex-discovery] CG onchain circuit open — Stage 1 skipped for ${context.stablecoinId}`);
  }

  if (!apiKey || !cgOnchainAllowed) {
    return { priceObservationTargets, unresolvedChains, stoppedEarly: false, providerChecks };
  }

  let cgRequests = 0;

  for (const { chain, address } of coinTargets) {
    throwIfAborted(context.signal);
    if (context.timeExceeded()) {
      return { priceObservationTargets, unresolvedChains, stoppedEarly: true, providerChecks };
    }

    const providers = CHAIN_META[chain]?.providers;
    const cgNetwork = CG_CHAIN_MAP[chain] ?? providers?.coingecko;
    if (!cgNetwork) {
      const gtNetwork = getGeckoTerminalDiscoveryNetwork(chain, address);
      const dsNetwork = DS_CHAIN_MAP[chain] ?? providers?.dexscreener;
      if (!gtNetwork && !dsNetwork) {
        logWorkerEventArgs("handler", "warn",
          `[dex-discovery] Chain "${chain}" not in discovery provider registry for ${context.stablecoinId}, skipping`,
        );
        unresolvedChains.push(chain);
      }
      continue;
    }

    if (cgRequests > 0) {
      await dependencies.sleepWithSignal(RATE_LIMITS.COINGECKO_ONCHAIN_MS, context.signal);
    }
    cgRequests++;
    const targetKey = buildChainAddressKey(chain, address);

    try {
      const result = await dependencies.fetchCgTokenPoolsWithStatus(
        cgNetwork,
        canonicalExitRouteScopedId(chain, address),
        context.buildStageSignal(DISCOVERY_STAGE_TIMEOUT_MS.cgOnchain),
        apiKey,
        { maxRetries: 0, timeoutMs: DISCOVERY_STAGE_TIMEOUT_MS.cgOnchain },
      );
      const classification = classifyCoinGeckoResult(result);
      await dependencies.recordOutcome(db, CIRCUIT_SOURCE.CG_ONCHAIN, classification.retryable !== true);
      providerChecks.push({
        ...makeDexDeploymentProviderCheck(
          { chain, address },
          "coingecko",
          classification.status,
          { retryable: classification.retryable, paginationComplete: result.complete },
        ),
        ...(classification.error ? { error: classification.error } : {}),
      });

      for (const pool of result.pools) {
        const parsed = parseCgPool(pool, chain);
        if (!parsed) continue;

        const poolId = canonicalExitRouteScopedKey(chain, parsed.poolAddress);
        if (context.hasKnownPool(poolId)) continue;

        const admission = admitCgOnchainPool({
          pool,
          parsed,
          poolId,
          chain,
          trackedAddress: canonicalExitRouteScopedId(chain, address),
          context,
          coherence: coherenceRejections,
        });
        if (!("pool" in admission)) continue;
        const stagedPool = admission.pool;

        context.addPool(stagedPool);

        if (stagedPool.priceUsd != null && parsed.tvlUsd >= DEX_PRICE_OBSERVATION_MIN_TVL_USD) {
          context.addPriceObs({
            stablecoinId: context.stablecoinId,
            price: stagedPool.priceUsd,
            tvl: parsed.tvlUsd,
            chain,
            protocol: parsed.dexId,
          });
          priceObservationTargets.add(targetKey);
        }
      }
    } catch (err) {
      if (context.signal?.aborted) throw err;
      logWorkerEventArgs("handler", "warn", `[dex-discovery] cg_onchain error for ${chain}:${address}`, err);
      const classification = classifyCoinGeckoThrownError(err);
      providerChecks.push({
        ...makeDexDeploymentProviderCheck(
          { chain, address },
          "coingecko",
          classification.status,
          { retryable: classification.retryable },
        ),
        ...(classification.error ? { error: classification.error } : {}),
      });
      await dependencies.recordOutcome(db, CIRCUIT_SOURCE.CG_ONCHAIN, classification.retryable !== true);
    }
  }

  coherenceRejections.flush();

  return { priceObservationTargets, unresolvedChains, stoppedEarly: false, providerChecks };
}
