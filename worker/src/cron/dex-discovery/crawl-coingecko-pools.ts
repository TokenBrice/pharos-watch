import type { ContractDeployment } from "@shared/types/core";
import { sleepWithSignal, throwIfAborted } from "../../lib/abort";
import { shouldAttemptFetch, recordOutcome } from "../../lib/circuit-breaker";
import { CHAIN_META } from "@shared/lib/chains";
import { CG_CHAIN_MAP, DS_CHAIN_MAP, GT_CHAIN_MAP } from "../../lib/chain-registry";
import { CIRCUIT_SOURCE, DEX_PRICE_OBSERVATION_MIN_TVL_USD } from "../../lib/constants";
import { fetchCgTokenPoolsWithStatus } from "../../lib/coingecko-onchain";
import { RATE_LIMITS } from "../../lib/rate-limit";
import { classifyCgPool, parseCgPool } from "../dex-liquidity/coingecko-onchain-shared";
import { normalizeProtocol } from "../dex-liquidity/pool-helpers";
import { isPlausibleDexObservationPrice } from "../dex-liquidity/price-sanity";
import { makeChainAddressKey } from "../dex-liquidity/token-resolution";
import {
  DISCOVERY_STAGE_TIMEOUT_MS,
  type CrawlStageContext,
  toStagedPool,
} from "./staged-pool";

export interface CoinGeckoPoolsStageResult {
  queriedChains: Set<string>;
  priceObservationTargets: Set<string>;
  unresolvedChains: string[];
  stoppedEarly: boolean;
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

export async function crawlCoinGeckoPoolsStage({
  db,
  coinTargets,
  cgApiKey,
  context,
  dependencies = defaultCoinGeckoPoolsStageDependencies,
}: CrawlCoinGeckoPoolsStageOptions): Promise<CoinGeckoPoolsStageResult> {
  const queriedChains = new Set<string>();
  const priceObservationTargets = new Set<string>();
  const unresolvedChains: string[] = [];
  const apiKey = cgApiKey?.trim() ? cgApiKey : null;

  if (!apiKey) {
    console.warn(`[dex-discovery] CG API key not configured — Stage 1 (CG onchain) skipped for ${context.stablecoinId}`);
  }

  const cgOnchainAllowed = apiKey
    ? await dependencies.shouldAttemptFetch(db, CIRCUIT_SOURCE.CG_ONCHAIN)
    : false;

  if (apiKey && !cgOnchainAllowed) {
    console.warn(`[dex-discovery] CG onchain circuit open — Stage 1 skipped for ${context.stablecoinId}`);
  }

  if (!apiKey || !cgOnchainAllowed) {
    return { queriedChains, priceObservationTargets, unresolvedChains, stoppedEarly: false };
  }

  let cgRequests = 0;

  for (const { chain, address } of coinTargets) {
    throwIfAborted(context.signal);
    if (context.timeExceeded()) {
      return { queriedChains, priceObservationTargets, unresolvedChains, stoppedEarly: true };
    }

    const providers = CHAIN_META[chain]?.providers;
    const cgNetwork = CG_CHAIN_MAP[chain] ?? providers?.coingecko;
    if (!cgNetwork) {
      const gtNetwork = GT_CHAIN_MAP[chain] ?? providers?.geckoTerminal;
      const dsNetwork = DS_CHAIN_MAP[chain] ?? providers?.dexscreener;
      if (!gtNetwork && !dsNetwork) {
        console.warn(`[dex-discovery] Chain "${chain}" not in discovery provider registry for ${context.stablecoinId}, skipping`);
        unresolvedChains.push(chain);
      }
      continue;
    }

    if (cgRequests > 0) {
      await dependencies.sleepWithSignal(RATE_LIMITS.COINGECKO_ONCHAIN_MS, context.signal);
    }
    cgRequests++;
    queriedChains.add(chain);
    const targetKey = makeChainAddressKey(chain, address);

    try {
      const result = await dependencies.fetchCgTokenPoolsWithStatus(
        cgNetwork,
        address.toLowerCase(),
        context.buildStageSignal(DISCOVERY_STAGE_TIMEOUT_MS.cgOnchain),
        apiKey,
        { maxRetries: 0, timeoutMs: DISCOVERY_STAGE_TIMEOUT_MS.cgOnchain },
      );
      await dependencies.recordOutcome(db, CIRCUIT_SOURCE.CG_ONCHAIN, result.ok);

      for (const pool of result.pools) {
        const parsed = parseCgPool(pool);
        if (!parsed) continue;

        const poolId = `${chain.toLowerCase()}:${parsed.poolAddress}`;
        if (context.hasKnownPool(poolId)) continue;

        const addressLower = address.toLowerCase();
        const side =
          addressLower === parsed.baseTokenAddress
            ? "base"
            : addressLower === parsed.quoteTokenAddress
              ? "quote"
              : null;
        if (!side) continue;

        const priceRaw = side === "base" ? parsed.baseTokenPriceUsd : parsed.quoteTokenPriceUsd;
        const tvlUsd = parsed.tvlUsd;
        if (!Number.isFinite(tvlUsd) || tvlUsd < 1_000) continue;
        const hasUsablePrice = Number.isFinite(priceRaw) && priceRaw > 0;
        if (
          hasUsablePrice &&
          !isPlausibleDexObservationPrice(context.stablecoinId, priceRaw, context.references)
        ) {
          continue;
        }

        const volume24h = parsed.volume24hUsd;
        if (tvlUsd > 0 && volume24h / tvlUsd > 50) continue;

        const {
          qualityMultiplier,
          poolType,
          feePercentage,
          lockedLiquidityPct,
          balanceRatio,
        } = classifyCgPool(parsed, pool.attributes);
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

        if (
          stagedPool.priceUsd != null &&
          tvlUsd >= DEX_PRICE_OBSERVATION_MIN_TVL_USD
        ) {
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
      console.warn(`[dex-discovery] cg_onchain error for ${chain}:${address}`, err);
      await dependencies.recordOutcome(db, CIRCUIT_SOURCE.CG_ONCHAIN, false);
    }
  }

  return { queriedChains, priceObservationTargets, unresolvedChains, stoppedEarly: false };
}
