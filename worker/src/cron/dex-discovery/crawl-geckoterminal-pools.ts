import type { ContractDeployment } from "@shared/types/core";
import { canonicalExitRouteScopedKey } from "@shared/lib/exit-route-identity";
import { getGeckoTerminalDiscoveryTarget } from "@shared/lib/dex-deployment-coverage";
import { sleepWithSignal } from "../../lib/abort";
import { RATE_LIMITS } from "../../lib/rate-limit";
import { crawlTokenPools, createCrawlStats, type CrawlToken } from "../dex-liquidity/crawl-helpers";
import { fetchGtTokenPools, getGtPoolType, parseGtPool } from "../dex-liquidity/geckoterminal-shared";
import type { GtNewPool, GtPool, DexPriceObs } from "../dex-liquidity/types";
import { getGtDexQuality, normalizeProtocol } from "../dex-liquidity/pool-helpers";
import { buildChainAddressKey } from "../dex-liquidity/token-resolution";
import { DISCOVERY_STAGE_TIMEOUT_MS, buildStageSignal, type CrawlStageContext, toStagedPool } from "./staged-pool";
import type { DexDeploymentProviderCheck } from "./types";

type GeckoTerminalNewPool = GtNewPool & {
  baseToken: string;
  quoteToken: string;
  quoteSymbol: string | null;
};

export interface GeckoTerminalPoolsStageDependencies {
  crawlTokenPools: typeof crawlTokenPools;
  fetchGtTokenPools: typeof fetchGtTokenPools;
  sleepWithSignal: typeof sleepWithSignal;
}

export interface GeckoTerminalPoolsStageResult {
  providerChecks: DexDeploymentProviderCheck[];
}

const defaultGeckoTerminalPoolsStageDependencies: GeckoTerminalPoolsStageDependencies = {
  crawlTokenPools,
  fetchGtTokenPools,
  sleepWithSignal,
};

interface CrawlGeckoTerminalPoolsStageOptions {
  coinTargets: ContractDeployment[];
  cgPriceObservationTargets: Set<string>;
  context: CrawlStageContext;
  dependencies?: GeckoTerminalPoolsStageDependencies;
}

export async function crawlGeckoTerminalPoolsStage({
  coinTargets,
  cgPriceObservationTargets,
  context,
  dependencies = defaultGeckoTerminalPoolsStageDependencies,
}: CrawlGeckoTerminalPoolsStageOptions): Promise<GeckoTerminalPoolsStageResult> {
  const gtTokens: CrawlToken[] = [];
  const gtChainAddressToId = new Map<string, string>();
  const deploymentAddressByQueryKey = new Map<string, string>();
  const providerChecks: DexDeploymentProviderCheck[] = [];

  for (const { chain, address } of coinTargets) {
    const target = getGeckoTerminalDiscoveryTarget(chain, address);
    if (!target) continue;
    if (cgPriceObservationTargets.has(buildChainAddressKey(chain, address))) continue;
    gtTokens.push({
      sourceChain: target.network,
      ourChain: chain,
      address: target.address,
      stablecoinId: context.stablecoinId,
    });
    const queryKey = buildChainAddressKey(chain, target.address);
    gtChainAddressToId.set(queryKey, context.stablecoinId);
    deploymentAddressByQueryKey.set(queryKey, address);
  }

  if (gtTokens.length === 0 || context.timeExceeded()) {
    return { providerChecks };
  }

  const gtNewPools = new Map<string, GeckoTerminalNewPool[]>();
  const gtPriceObs = new Map<string, DexPriceObs[]>();

  await dependencies.crawlTokenPools<GtPool, GeckoTerminalNewPool>({
    sourceLabel: "GT",
    tokens: gtTokens,
    chainAddressToId: gtChainAddressToId,
    knownPoolAddrs: context.knownPoolIdsForStablecoin(),
    protocolTvlCaps: new Map(),
    newPools: gtNewPools,
    priceObs: gtPriceObs,
    references: context.references,
    stats: createCrawlStats(),
    signal: context.signal,
    minTvlUsd: 1_000,
    beforeRequest: async ({ requestCount }) => {
      if (context.timeExceeded()) return false;
      if (requestCount > 0) {
        await dependencies.sleepWithSignal(RATE_LIMITS.GECKO_TERMINAL_MS, context.signal);
      }
      return true;
    },
    fetchPools: (tokenAddress, sourceChain, requestSignal) =>
      dependencies.fetchGtTokenPools(
        tokenAddress,
        sourceChain,
        buildStageSignal(requestSignal, context.deadlineMs, DISCOVERY_STAGE_TIMEOUT_MS.geckoTerminal),
        0,
        DISCOVERY_STAGE_TIMEOUT_MS.geckoTerminal,
      ),
    onRequestResult: (token, status) => {
      providerChecks.push({
        chain: token.ourChain,
        address:
          deploymentAddressByQueryKey.get(buildChainAddressKey(token.ourChain, token.address)) ?? token.address,
        provider: "geckoterminal",
        status,
        ...(status === "failure" ? { retryable: true as const } : {}),
      });
    },
    parsePool: parseGtPool,
    buildNewPool: ({ parsed, chain, price, cappedTvlUsd, maturityDays }) => ({
      address: parsed.poolAddress,
      chain,
      dexId: parsed.dexId,
      name: parsed.poolName,
      tvlUsd: cappedTvlUsd,
      volume24hUsd: parsed.volume24hUsd,
      qualityMultiplier: getGtDexQuality(parsed.dexId),
      maturityDays,
      poolType: getGtPoolType(parsed.dexId),
      price,
      symbol: parsed.poolName,
      baseToken: parsed.baseTokenAddress,
      quoteToken: parsed.quoteTokenAddress,
      quoteSymbol: null,
      sourceFamily: "gecko_terminal",
    }),
  });

  const gtPools = gtNewPools.get(context.stablecoinId) ?? [];
  for (const pool of gtPools) {
    const poolId = canonicalExitRouteScopedKey(pool.chain, pool.address);
    if (context.hasKnownPool(poolId)) continue;
    if (pool.volume24hUsd <= 0 && pool.tvlUsd < 10_000) continue;

    context.addPool(
      toStagedPool(context, {
        poolId,
        source: "gecko_terminal",
        chain: pool.chain,
        protocol: normalizeProtocol(pool.dexId),
        dexId: pool.dexId,
        symbol: pool.name,
        tvlUsd: pool.tvlUsd,
        volume24h: pool.volume24hUsd,
        qualityMultiplier: pool.qualityMultiplier,
        poolType: pool.poolType,
        feeTier: null,
        balanceRatio: null,
        isStable: null,
        baseToken: pool.baseToken || null,
        quoteToken: pool.quoteToken || null,
        quoteSymbol: pool.quoteSymbol,
        priceUsd: pool.price > 0 ? pool.price : null,
        lockedLiqPct: null,
        rawJson: null,
      }),
    );
  }

  const gtObs = gtPriceObs.get(context.stablecoinId) ?? [];
  for (const obs of gtObs) {
    context.addPriceObs({ ...obs, stablecoinId: context.stablecoinId });
  }
  return { providerChecks };
}
