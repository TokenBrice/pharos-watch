import { BLOCKED_DEX_IDS } from "../../lib/dex-constants";
import { throwIfAborted } from "../../lib/abort";
import type { DexPriceObs, GtNewPool } from "./types";
import { normalizeProtocol } from "./pool-helpers";
import { isPlausibleDexObservationPrice } from "./price-sanity";

export type CrawlStats = {
  requests: number;
  poolsSeen: number;
  poolsNew: number;
  poolsSkippedCurve: number;
  poolsSkippedKnown: number;
  poolsSkippedRatio: number;
};

export type CrawlToken = {
  sourceChain: string;
  ourChain: string;
  address: string;
  stablecoinId: string;
};

export type ParsedPool = {
  dexId: string;
  poolAddress: string;
  tvlUsd: number;
  volume24hUsd: number;
  baseTokenAddress: string;
  quoteTokenAddress: string;
  baseTokenPriceUsd: number;
  quoteTokenPriceUsd: number;
  createdAt: string | null;
  poolName: string;
};

export type BuildNewPoolArgs<TRawPool> = {
  rawPool: TRawPool;
  parsed: ParsedPool;
  stablecoinId: string;
  chain: string;
  price: number;
  cappedTvlUsd: number;
  maturityDays: number;
};

export type CrawlTokenPoolsConfig<TRawPool, TNewPool extends GtNewPool> = {
  sourceLabel: string;
  tokens: CrawlToken[];
  addressToId: Map<string, string>;
  knownPoolAddrs: Set<string>;
  protocolTvlCaps: Map<string, number>;
  newPools: Map<string, TNewPool[]>;
  priceObs: Map<string, DexPriceObs[]>;
  stats: CrawlStats;
  signal?: AbortSignal;
  beforeRequest?: (ctx: {
    requestCount: number;
    totalTokens: number;
    startMs: number;
    signal?: AbortSignal;
  }) => Promise<boolean>;
  fetchPools: (tokenAddress: string, sourceChain: string, signal?: AbortSignal) => Promise<TRawPool[]>;
  parsePool: (rawPool: TRawPool) => ParsedPool | null;
  buildNewPool: (args: BuildNewPoolArgs<TRawPool>) => TNewPool;
};

export type CrawlTokenPoolsResult = { stoppedEarly: boolean };

function resolveStablecoinSide(
  stablecoinAddress: string,
  stablecoinId: string,
  baseTokenAddress: string,
  quoteTokenAddress: string,
  addressToId: Map<string, string>,
): "base" | "quote" | null {
  const addressLower = stablecoinAddress.toLowerCase();
  if (baseTokenAddress === addressLower) return "base";
  if (quoteTokenAddress === addressLower) return "quote";

  const baseId = addressToId.get(baseTokenAddress);
  if (baseId === stablecoinId) return "base";
  const quoteId = addressToId.get(quoteTokenAddress);
  if (quoteId === stablecoinId) return "quote";
  return null;
}

function toMaturityDays(createdAt: string | null, nowSec: number): number {
  if (!createdAt) return 0;
  const createdSec = new Date(createdAt).getTime() / 1000;
  return createdSec > 0 ? Math.floor((nowSec - createdSec) / 86400) : 0;
}

export async function crawlTokenPools<TRawPool, TNewPool extends GtNewPool>(
  config: CrawlTokenPoolsConfig<TRawPool, TNewPool>,
): Promise<CrawlTokenPoolsResult> {
  const nowSec = Date.now() / 1000;
  const startMs = Date.now();

  for (const token of config.tokens) {
    throwIfAborted(config.signal);

    if (config.beforeRequest) {
      const shouldContinue = await config.beforeRequest({
        requestCount: config.stats.requests,
        totalTokens: config.tokens.length,
        startMs,
        signal: config.signal,
      });
      if (!shouldContinue) {
        return { stoppedEarly: true };
      }
    }
    config.stats.requests++;

    try {
      const pools = await config.fetchPools(token.address, token.sourceChain, config.signal);
      for (const rawPool of pools) {
        const parsed = config.parsePool(rawPool);
        if (!parsed) continue;

        config.stats.poolsSeen++;
        if (!parsed.tvlUsd || parsed.tvlUsd < 10_000 || parsed.tvlUsd > 1e12) continue;
        if (BLOCKED_DEX_IDS.has(parsed.dexId)) continue;

        if (parsed.dexId.startsWith("curve")) {
          config.stats.poolsSkippedCurve++;
          continue;
        }

        const side = resolveStablecoinSide(
          token.address,
          token.stablecoinId,
          parsed.baseTokenAddress,
          parsed.quoteTokenAddress,
          config.addressToId,
        );
        if (!side) continue;

        const price = side === "base" ? parsed.baseTokenPriceUsd : parsed.quoteTokenPriceUsd;

        if (isPlausibleDexObservationPrice(token.stablecoinId, price) && parsed.tvlUsd >= 50_000) {
          const obs = config.priceObs.get(token.stablecoinId) ?? [];
          obs.push({ price, tvl: parsed.tvlUsd, chain: token.ourChain, protocol: parsed.dexId });
          config.priceObs.set(token.stablecoinId, obs);
        }

        const poolKey = `${token.ourChain}:${parsed.poolAddress}`;
        const sortedTokens = [parsed.baseTokenAddress, parsed.quoteTokenAddress].sort().join(":");
        const fpKey = `fp:${token.ourChain}:${normalizeProtocol(parsed.dexId)}:${sortedTokens}`;
        if (config.knownPoolAddrs.has(poolKey) || config.knownPoolAddrs.has(fpKey)) {
          config.stats.poolsSkippedKnown++;
          continue;
        }

        if (parsed.tvlUsd > 0 && parsed.volume24hUsd / parsed.tvlUsd > 50) {
          config.stats.poolsSkippedRatio++;
          continue;
        }

        const protoNorm = normalizeProtocol(parsed.dexId);
        const protoCap = config.protocolTvlCaps.get(protoNorm);
        const cappedTvlUsd = protoCap != null && parsed.tvlUsd > protoCap ? protoCap : parsed.tvlUsd;
        const maturityDays = toMaturityDays(parsed.createdAt, nowSec);

        const poolList = config.newPools.get(token.stablecoinId) ?? [];
        poolList.push(config.buildNewPool({
          rawPool,
          parsed,
          stablecoinId: token.stablecoinId,
          chain: token.ourChain,
          price,
          cappedTvlUsd,
          maturityDays,
        }));
        config.newPools.set(token.stablecoinId, poolList);
        config.stats.poolsNew++;
      }
    } catch (err) {
      if (config.signal?.aborted) throw err;
      console.warn(`[dex-liquidity] ${config.sourceLabel} pool crawl error for ${token.ourChain}:${token.address}:`, err);
    }
  }

  return { stoppedEarly: false };
}
