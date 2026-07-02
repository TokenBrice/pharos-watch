import type { ContractDeployment } from "@shared/types/core";
import { sleepWithSignal } from "../../lib/abort";
import { CHAIN_META } from "@shared/lib/chains";
import { GT_CHAIN_MAP } from "../../lib/chain-registry";
import { RATE_LIMITS } from "../../lib/rate-limit";
import { crawlTokenPools, createCrawlStats, type CrawlToken } from "../dex-liquidity/crawl-helpers";
import { fetchGtTokenPools, getGtPoolType, parseGtPool } from "../dex-liquidity/geckoterminal-shared";
import type { GtNewPool, GtPool, DexPriceObs } from "../dex-liquidity/types";
import { getGtDexQuality, normalizeProtocol } from "../dex-liquidity/pool-helpers";
import { makeChainAddressKey } from "../dex-liquidity/token-resolution";
import {
  DISCOVERY_STAGE_TIMEOUT_MS,
  buildStageSignal,
  type CrawlStageContext,
  toStagedPool,
} from "./staged-pool";

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
}: CrawlGeckoTerminalPoolsStageOptions): Promise<void> {
  const gtTokens: CrawlToken[] = [];
  const gtChainAddressToId = new Map<string, string>();

  for (const { chain, address } of coinTargets) {
    const providers = CHAIN_META[chain]?.providers;
    const gtNetwork = GT_CHAIN_MAP[chain] ?? providers?.geckoTerminal;
    if (!gtNetwork) continue;
    if (cgPriceObservationTargets.has(makeChainAddressKey(chain, address))) continue;
    gtTokens.push({
      sourceChain: gtNetwork,
      ourChain: chain,
      address: address.toLowerCase(),
      stablecoinId: context.stablecoinId,
    });
    gtChainAddressToId.set(makeChainAddressKey(chain, address), context.stablecoinId);
  }

  if (gtTokens.length === 0 || context.timeExceeded()) {
    return;
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
    const poolId = `${pool.chain.toLowerCase()}:${pool.address.toLowerCase()}`;
    if (context.hasKnownPool(poolId)) continue;
    if (pool.volume24hUsd <= 0 && pool.tvlUsd < 10_000) continue;

    context.addPool(toStagedPool(context, {
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
    }));
  }

  const gtObs = gtPriceObs.get(context.stablecoinId) ?? [];
  for (const obs of gtObs) {
    context.addPriceObs({ ...obs, stablecoinId: context.stablecoinId });
  }
}
