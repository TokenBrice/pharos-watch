import { logWorkerEventArgs } from "../../lib/structured-log";
import type { ContractDeployment } from "@shared/types/core";
import { getGeckoTerminalDiscoveryNetwork } from "@shared/lib/dex-deployment-coverage";
import { canonicalExitRouteScopedId, canonicalExitRouteScopedKey } from "@shared/lib/exit-route-identity";
import { sleepWithSignal, throwIfAborted } from "../../lib/abort";
import { shouldAttemptFetch, recordOutcome } from "../../lib/circuit-breaker";
import { CHAIN_META } from "@shared/lib/chains";
import { CG_CHAIN_MAP, DS_CHAIN_MAP } from "../../lib/chain-registry";
import { CIRCUIT_SOURCE, DEX_PRICE_OBSERVATION_MIN_TVL_USD } from "../../lib/constants";
import { fetchCgTokenPoolsWithStatus } from "../../lib/coingecko-onchain";
import { RATE_LIMITS } from "../../lib/rate-limit";
import { classifyCgPool, parseCgPool } from "../dex-liquidity/coingecko-onchain-shared";
import { normalizeProtocol } from "../dex-liquidity/pool-normalization";
import { isPlausibleDexObservationPrice } from "../dex-liquidity/price-sanity";
import { buildChainAddressKey } from "../dex-liquidity/token-resolution";
import { DISCOVERY_STAGE_TIMEOUT_MS, type CrawlStageContext, toStagedPool } from "./staged-pool";
import { makeDexDeploymentProviderCheck, type DexDeploymentProviderCheck } from "./types";

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

function classifyCoinGeckoResult(
  result: Awaited<ReturnType<typeof fetchCgTokenPoolsWithStatus>>,
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

function classifyCoinGeckoThrownError(error: unknown): CoinGeckoCheckClassification {
  const name = errorName(error);
  if (name === "SyntaxError") {
    return { status: "degraded", error: "coingecko-malformed-payload" };
  }
  if (name === "TimeoutError" || name === "AbortError") {
    return { status: "failure", retryable: true, error: "coingecko-timeout" };
  }
  return { status: "failure", retryable: true, error: "coingecko-fetch-error" };
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
          { retryable: classification.retryable },
        ),
        ...(classification.error ? { error: classification.error } : {}),
      });

      for (const pool of result.pools) {
        const parsed = parseCgPool(pool, chain);
        if (!parsed) continue;

        const poolId = canonicalExitRouteScopedKey(chain, parsed.poolAddress);
        if (context.hasKnownPool(poolId)) continue;

        const canonicalAddress = canonicalExitRouteScopedId(chain, address);
        const side =
          canonicalAddress === parsed.baseTokenAddress
            ? "base"
            : canonicalAddress === parsed.quoteTokenAddress
              ? "quote"
              : null;
        if (!side) continue;

        const priceRaw = side === "base" ? parsed.baseTokenPriceUsd : parsed.quoteTokenPriceUsd;
        const tvlUsd = parsed.tvlUsd;
        if (!Number.isFinite(tvlUsd) || tvlUsd < 1_000) continue;
        const hasUsablePrice = Number.isFinite(priceRaw) && priceRaw > 0;
        if (hasUsablePrice && !isPlausibleDexObservationPrice(context.stablecoinId, priceRaw, context.references)) {
          continue;
        }

        const volume24h = parsed.volume24hUsd;
        if (tvlUsd > 0 && volume24h / tvlUsd > 50) continue;

        const { qualityMultiplier, poolType, feePercentage, lockedLiquidityPct, balanceRatio } = classifyCgPool(
          parsed,
          pool.attributes,
        );
        const dexId = parsed.dexId;
        const protocol = normalizeProtocol(dexId);
        const stagedPool = toStagedPool(context, {
          poolId,
          source: "cg_onchain",
          chain,
          protocol,
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
          priceUsd: Number.isFinite(priceRaw) && priceRaw > 0 ? priceRaw : null,
          lockedLiqPct: lockedLiquidityPct,
          rawJson: null,
        });

        context.addPool(stagedPool);

        if (stagedPool.priceUsd != null && tvlUsd >= DEX_PRICE_OBSERVATION_MIN_TVL_USD) {
          context.addPriceObs({
            stablecoinId: context.stablecoinId,
            price: stagedPool.priceUsd,
            tvl: tvlUsd,
            chain,
            protocol: dexId,
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

  return { priceObservationTargets, unresolvedChains, stoppedEarly: false, providerChecks };
}
