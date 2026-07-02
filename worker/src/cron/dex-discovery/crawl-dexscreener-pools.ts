import type { ContractDeployment } from "@shared/types/core";
import { throwIfAborted } from "../../lib/abort";
import { shouldAttemptFetch, recordOutcome } from "../../lib/circuit-breaker";
import { CHAIN_META } from "@shared/lib/chains";
import { CG_CHAIN_MAP, DS_CHAIN_MAP, GT_CHAIN_MAP } from "../../lib/chain-registry";
import { CIRCUIT_SOURCE, DEX_PRICE_OBSERVATION_MIN_TVL_USD } from "../../lib/constants";
import {
  dsRateLimit,
  fetchDsTokenPoolsWithStatus,
  getDsTrackedTokenPriceUsd,
} from "../../lib/dexscreener";
import { getGtDexQuality, normalizeProtocol } from "../dex-liquidity/pool-helpers";
import { isPlausibleDexObservationPrice } from "../dex-liquidity/price-sanity";
import {
  DISCOVERY_STAGE_TIMEOUT_MS,
  type CrawlStageContext,
  toStagedPool,
} from "./staged-pool";

type DexScreenerTarget = readonly [string, string];
const DEXSCREENER_LIQUIDITY_CIRCUIT = CIRCUIT_SOURCE.DEXSCREENER_LIQUIDITY;

export interface DexScreenerPoolsStageResult {
  stoppedEarly: boolean;
}

export interface DexScreenerPoolsStageDependencies {
  shouldAttemptFetch: typeof shouldAttemptFetch;
  recordOutcome: typeof recordOutcome;
  dsRateLimit: typeof dsRateLimit;
  fetchDsTokenPoolsWithStatus: typeof fetchDsTokenPoolsWithStatus;
  getDsTrackedTokenPriceUsd: typeof getDsTrackedTokenPriceUsd;
}

const defaultDexScreenerPoolsStageDependencies: DexScreenerPoolsStageDependencies = {
  shouldAttemptFetch,
  recordOutcome,
  dsRateLimit,
  fetchDsTokenPoolsWithStatus,
  getDsTrackedTokenPriceUsd,
};

interface SelectDexScreenerTargetsOptions {
  coinTargets: ContractDeployment[];
  discoveredPoolCount: number;
}

interface CrawlDexScreenerPoolsStageOptions {
  db: D1Database;
  targets: DexScreenerTarget[];
  context: CrawlStageContext;
  dependencies?: DexScreenerPoolsStageDependencies;
}

export function selectDexScreenerTargets({
  coinTargets,
  discoveredPoolCount,
}: SelectDexScreenerTargetsOptions): DexScreenerTarget[] {
  const uncoveredChains: DexScreenerTarget[] = [];

  for (const { chain, address } of coinTargets) {
    const providers = CHAIN_META[chain]?.providers;
    const hasCg = !!(CG_CHAIN_MAP[chain] ?? providers?.coingecko);
    const hasGt = !!(GT_CHAIN_MAP[chain] ?? providers?.geckoTerminal);
    if (!hasCg && !hasGt) {
      uncoveredChains.push([chain, address]);
    }
  }

  return discoveredPoolCount === 0
    ? coinTargets.map(({ chain, address }) => [chain, address] as const)
    : uncoveredChains;
}

export async function crawlDexScreenerPoolsStage({
  db,
  targets,
  context,
  dependencies = defaultDexScreenerPoolsStageDependencies,
}: CrawlDexScreenerPoolsStageOptions): Promise<DexScreenerPoolsStageResult> {
  if (targets.length === 0 || context.timeExceeded()) {
    return { stoppedEarly: false };
  }

  const dsAllowed = await dependencies.shouldAttemptFetch(db, DEXSCREENER_LIQUIDITY_CIRCUIT);
  if (!dsAllowed) {
    return { stoppedEarly: false };
  }

  let dsRequests = 0;
  let successfulRequests = 0;

  for (const [chain, address] of targets) {
    throwIfAborted(context.signal);
    if (context.timeExceeded()) {
      if (dsRequests > 0) {
        await dependencies.recordOutcome(db, DEXSCREENER_LIQUIDITY_CIRCUIT, successfulRequests > 0);
      }
      return { stoppedEarly: true };
    }

    const dsChain = DS_CHAIN_MAP[chain];
    if (!dsChain) continue;

    if (dsRequests > 0) {
      await dependencies.dsRateLimit(context.signal);
    }
    dsRequests++;

    try {
      const result = await dependencies.fetchDsTokenPoolsWithStatus(
        chain,
        address,
        context.buildStageSignal(DISCOVERY_STAGE_TIMEOUT_MS.dexscreener),
        DISCOVERY_STAGE_TIMEOUT_MS.dexscreener,
        0,
      );
      if (!result.ok) continue;
      successfulRequests++;

      for (const pair of result.pairs) {
        const tvl = pair.liquidity?.usd ?? 0;
        if (tvl < 1_000) continue;

        const vol24h = pair.volume?.h24 ?? 0;
        if (vol24h === 0 && tvl < 10_000) continue;
        if (tvl > 0 && vol24h / tvl > 50) continue;

        const poolAddress = pair.pairAddress?.toLowerCase();
        const dexId = pair.dexId;
        const baseAddr = pair.baseToken?.address?.toLowerCase();
        const quoteAddr = pair.quoteToken?.address?.toLowerCase();
        if (!poolAddress || !dexId || !baseAddr || !quoteAddr) {
          console.warn(`[dex-discovery] dexscreener malformed pair for ${chain}:${address}`, {
            pairAddress: pair.pairAddress ?? null,
            dexId: pair.dexId ?? null,
            baseToken: pair.baseToken?.address ?? null,
            quoteToken: pair.quoteToken?.address ?? null,
          });
          continue;
        }

        const poolId = `${chain.toLowerCase()}:${poolAddress}`;
        if (context.hasKnownPool(poolId)) continue;

        const { side, priceUsd } = dependencies.getDsTrackedTokenPriceUsd(pair, address);
        if (!side) continue;

        context.addPool(toStagedPool(context, {
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
        }));

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
    } catch (err) {
      if (context.signal?.aborted) throw err;
      console.warn(`[dex-discovery] dexscreener error for ${chain}:${address}`, err);
    }
  }

  if (dsRequests > 0) {
    await dependencies.recordOutcome(db, DEXSCREENER_LIQUIDITY_CIRCUIT, successfulRequests > 0);
  }

  return { stoppedEarly: false };
}
