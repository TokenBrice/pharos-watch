import { logWorkerEventArgs } from "../../lib/structured-log";
import { canonicalExitRouteScopedId, canonicalExitRouteScopedKey } from "@shared/lib/exit-route-identity";
import { throwIfAborted } from "../../lib/abort";
import { shouldAttemptFetch, recordOutcome } from "../../lib/circuit-breaker";
import { DS_CHAIN_MAP } from "../../lib/chain-registry";
import { CIRCUIT_SOURCE, DEX_PRICE_OBSERVATION_MIN_TVL_USD } from "../../lib/constants";
import { dsRateLimit, fetchDsTokenPairsWithStatus } from "../../lib/dexscreener";
import { logWorkerEvent } from "../../lib/structured-log";
import { getGtDexQuality, normalizeProtocol } from "../dex-liquidity/pool-normalization";
import { getChainAwareDsTrackedTokenPriceUsd } from "../dex-liquidity/crawl-helpers";
import { isPlausibleDexObservationPrice } from "../dex-liquidity/price-sanity";
import { DISCOVERY_STAGE_TIMEOUT_MS, type CrawlStageContext, toStagedPool } from "./staged-pool";
import { makeDexDeploymentProviderCheck, type DexDeploymentProviderCheck } from "./types";

type DexScreenerTarget = readonly [string, string];
const DEXSCREENER_LIQUIDITY_CIRCUIT = CIRCUIT_SOURCE.DEXSCREENER_LIQUIDITY;

export interface DexScreenerPoolsStageResult {
  stoppedEarly: boolean;
  providerChecks: DexDeploymentProviderCheck[];
}

export interface DexScreenerDiscoveryRunState {
  allowed: boolean | null;
  attemptedRequests: number;
  successfulRequests: number;
  hardRefusal: {
    status: number | null;
    contentType: string | null;
    error: string | null;
  } | null;
  outcomeRecorded: boolean;
}

export interface DexScreenerPoolsStageDependencies {
  shouldAttemptFetch: typeof shouldAttemptFetch;
  recordOutcome: typeof recordOutcome;
  dsRateLimit: typeof dsRateLimit;
  fetchDsTokenPairsWithStatus: typeof fetchDsTokenPairsWithStatus;
}

const defaultDexScreenerPoolsStageDependencies: DexScreenerPoolsStageDependencies = {
  shouldAttemptFetch,
  recordOutcome,
  dsRateLimit,
  fetchDsTokenPairsWithStatus,
};

interface CrawlDexScreenerPoolsStageOptions {
  db: D1Database;
  targets: DexScreenerTarget[];
  context: CrawlStageContext;
  runState: DexScreenerDiscoveryRunState;
  dependencies?: DexScreenerPoolsStageDependencies;
}

export function createDexScreenerDiscoveryRunState(): DexScreenerDiscoveryRunState {
  return {
    allowed: null,
    attemptedRequests: 0,
    successfulRequests: 0,
    hardRefusal: null,
    outcomeRecorded: false,
  };
}

export async function finalizeDexScreenerDiscoveryRun(
  db: D1Database,
  runState: DexScreenerDiscoveryRunState,
  dependencies = defaultDexScreenerPoolsStageDependencies,
): Promise<void> {
  if (runState.outcomeRecorded || runState.attemptedRequests === 0) return;
  await dependencies.recordOutcome(
    db,
    DEXSCREENER_LIQUIDITY_CIRCUIT,
    runState.successfulRequests > 0,
  );
  runState.outcomeRecorded = true;
}

export async function crawlDexScreenerPoolsStage({
  db,
  targets,
  context,
  runState,
  dependencies = defaultDexScreenerPoolsStageDependencies,
}: CrawlDexScreenerPoolsStageOptions): Promise<DexScreenerPoolsStageResult> {
  if (targets.length === 0 || context.timeExceeded() || runState.hardRefusal != null) {
    return { stoppedEarly: false, providerChecks: [] };
  }

  if (runState.allowed == null) {
    runState.allowed = await dependencies.shouldAttemptFetch(db, DEXSCREENER_LIQUIDITY_CIRCUIT);
  }
  if (!runState.allowed) {
    return { stoppedEarly: false, providerChecks: [] };
  }

  const providerChecks: DexDeploymentProviderCheck[] = [];

  for (const [chain, address] of targets) {
    throwIfAborted(context.signal);
    if (context.timeExceeded()) {
      return { stoppedEarly: true, providerChecks };
    }

    const dsChain = DS_CHAIN_MAP[chain];
    if (!dsChain) continue;

    // Pace the first request too so consecutive one-target coin crawls retain a
    // delay at their shared run boundary.
    await dependencies.dsRateLimit(context.signal);
    runState.attemptedRequests++;

    try {
      const result = await dependencies.fetchDsTokenPairsWithStatus(
        chain,
        address,
        context.buildStageSignal(DISCOVERY_STAGE_TIMEOUT_MS.dexscreener),
        DISCOVERY_STAGE_TIMEOUT_MS.dexscreener,
        0,
      );
      if (!result.ok) {
        providerChecks.push(makeDexDeploymentProviderCheck(
          { chain, address },
          "dexscreener",
          "failure",
          { retryable: true },
        ));
        if (result.hardRefusal) {
          runState.hardRefusal = {
            status: result.status ?? null,
            contentType: result.contentType ?? null,
            error: result.error ?? null,
          };
          logWorkerEvent({
            scope: "lib",
            level: "warn",
            event: "dex_discovery.dexscreener_hard_refusal",
            job: "sync-dex-discovery",
            provider: "dexscreener",
            status: result.status ?? null,
            message: "DexScreener hard refusal; suppressing requests for the rest of the run",
            metadata: {
              contentType: result.contentType ?? null,
              error: result.error ?? null,
            },
          });
          try {
            // Finalize immediately so a zero-success refusal protects the
            // overlapping scoring fallback. Earlier successful requests still
            // prove provider reachability and heal the aggregate circuit.
            await finalizeDexScreenerDiscoveryRun(db, runState, dependencies);
          } catch (err) {
            logWorkerEvent({
              scope: "lib",
              level: "warn",
              event: "dex_discovery.dexscreener_hard_refusal_outcome_failed",
              job: "sync-dex-discovery",
              provider: "dexscreener",
              message: "Failed to record DexScreener hard-refusal outcome",
              error: err,
            });
          }
          break;
        }
        continue;
      }
      runState.successfulRequests++;
      let observedPoolCount = 0;

      for (const pair of result.pairs) {
        const tvl = pair.liquidity?.usd ?? 0;
        if (tvl < 1_000) continue;

        const vol24h = pair.volume?.h24 ?? 0;
        if (vol24h === 0 && tvl < 10_000) continue;
        if (tvl > 0 && vol24h / tvl > 50) continue;

        const poolAddress = canonicalExitRouteScopedId(chain, pair.pairAddress ?? "");
        const dexId = pair.dexId;
        const baseAddr = canonicalExitRouteScopedId(chain, pair.baseToken?.address ?? "");
        const quoteAddr = canonicalExitRouteScopedId(chain, pair.quoteToken?.address ?? "");
        if (!poolAddress || !dexId || !baseAddr || !quoteAddr) {
          logWorkerEventArgs("handler", "warn", `[dex-discovery] dexscreener malformed pair for ${chain}:${address}`, {
            pairAddress: pair.pairAddress ?? null,
            dexId: pair.dexId ?? null,
            baseToken: pair.baseToken?.address ?? null,
            quoteToken: pair.quoteToken?.address ?? null,
          });
          continue;
        }

        const poolId = canonicalExitRouteScopedKey(chain, poolAddress);
        const { side, priceUsd } = getChainAwareDsTrackedTokenPriceUsd(pair, address, chain);
        if (!side) continue;
        observedPoolCount++;
        if (context.hasKnownPool(poolId)) continue;

        context.addPool(
          toStagedPool(context, {
            poolId,
            source: "dexscreener",
            chain,
            protocol: normalizeProtocol(dexId),
            dexId,
            symbol: `${pair.baseToken.symbol ?? context.stablecoinId} / ${pair.quoteToken.symbol ?? "UNKNOWN"}`,
            tvlUsd: tvl,
            volume24h: vol24h,
            qualityMultiplier: getGtDexQuality(dexId),
            poolType:
              pair.labels?.includes("CLMM") || pair.labels?.includes("V3")
                ? "ds-concentrated"
                : pair.labels?.includes("StableSwap")
                  ? "ds-stableswap"
                  : "ds-amm",
            feeTier: null,
            balanceRatio: null,
            isStable: null,
            baseToken: baseAddr,
            quoteToken: quoteAddr,
            quoteSymbol: pair.quoteToken?.symbol ?? null,
            priceUsd,
            lockedLiqPct: null,
            rawJson: null,
          }),
        );

        if (
          priceUsd != null &&
          tvl >= DEX_PRICE_OBSERVATION_MIN_TVL_USD &&
          isPlausibleDexObservationPrice(context.stablecoinId, priceUsd, context.references)
        ) {
          context.addPriceObs({
            stablecoinId: context.stablecoinId,
            price: priceUsd,
            tvl,
            chain,
            protocol: `dexscreener-${dexId}`,
          });
        }
      }
      providerChecks.push(makeDexDeploymentProviderCheck(
        { chain, address },
        "dexscreener",
        "success",
        { observedPoolCount },
      ));
    } catch (err) {
      if (context.signal?.aborted) throw err;
      logWorkerEventArgs("handler", "warn", `[dex-discovery] dexscreener error for ${chain}:${address}`, err);
      providerChecks.push(makeDexDeploymentProviderCheck(
        { chain, address },
        "dexscreener",
        "failure",
        { retryable: true },
      ));
    }
  }

  return { stoppedEarly: false, providerChecks };
}
