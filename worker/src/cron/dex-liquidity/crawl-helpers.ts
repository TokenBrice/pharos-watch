import { logWorkerEventArgs } from "../../lib/structured-log";
import { isBlockedDexId } from "../../lib/dex-cron-constants";
import { canonicalExitRouteScopedId, canonicalExitRouteScopedKey } from "@shared/lib/exit-route-identity";
import { CURVE_NATIVE_DISCOVERY_CHAINS } from "@shared/lib/dex-deployment-coverage";
import { DAY_SECONDS } from "@shared/lib/time-constants";
import { DEX_PRICE_OBSERVATION_MIN_TVL_USD } from "../../lib/constants";
import { throwIfAborted } from "../../lib/abort";
import type { DsPair, DsTrackedTokenPrice } from "../../lib/dexscreener";
import type { PriceValidationReferences } from "../../lib/price-validation";
import type { PagedTokenPoolsResult } from "../../lib/paged-token-pools";
import type { DexPriceObs, GtNewPool } from "./types";
import { buildPoolFingerprint, normalizeProtocol } from "./pool-normalization";
import { isPlausibleDexObservationPrice } from "./price-sanity";
import { evaluatePoolPriceCoherence, type PoolPriceCoherenceRejectReason } from "./pool-price-coherence";
import { buildChainAddressKey } from "./token-resolution";

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
  /** Pair-ratio inputs for the pool-price coherence policy; `undefined` = field absent from the payload, `null` = present but unusable. */
  baseTokenPriceQuoteToken?: number | null;
  quoteTokenPriceBaseToken?: number | null;
  baseTokenPriceNativeCurrency?: number | null;
  quoteTokenPriceNativeCurrency?: number | null;
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
  chainAddressToId: Map<string, string>;
  knownPoolAddrs: Set<string>;
  protocolTvlCaps: Map<string, number>;
  newPools: Map<string, TNewPool[]>;
  priceObs: Map<string, DexPriceObs[]>;
  signal?: AbortSignal;
  references?: PriceValidationReferences;
  /** Minimum TVL (USD) required to consider a pool. Defaults to 10k. */
  minTvlUsd?: number;
  beforeRequest?: (ctx: {
    requestCount: number;
    totalTokens: number;
    startMs: number;
    signal?: AbortSignal;
  }) => Promise<boolean>;
  fetchPools: (
    tokenAddress: string,
    sourceChain: string,
    signal?: AbortSignal,
  ) => Promise<PagedTokenPoolsResult<TRawPool>>;
  /**
   * A crawl that could not read its provider's pages to a short page is not a
   * success: the status is derived from the run's own completeness claim.
   */
  onRequestResult?: (
    token: CrawlToken,
    status: "success" | "degraded" | "failure",
    pagination?: Pick<PagedTokenPoolsResult<TRawPool>, "complete" | "cappedAtMaxPages" | "failedAfterRows">,
  ) => void;
  parsePool: (rawPool: TRawPool, chain: string) => ParsedPool | null;
  buildNewPool: (args: BuildNewPoolArgs<TRawPool>) => TNewPool;
};

export type CrawlTokenPoolsResult = { stoppedEarly: boolean };

const NATIVE_CURVE_API_CHAINS = new Set<string>(CURVE_NATIVE_DISCOVERY_CHAINS);

export function shouldSkipFallbackCurvePool(chain: string, dexId: string): boolean {
  return dexId.startsWith("curve") && NATIVE_CURVE_API_CHAINS.has(chain);
}

export function getChainAwareDsTrackedTokenPriceUsd(
  pair: DsPair,
  trackedAddress: string,
  chain: string,
): DsTrackedTokenPrice {
  const tracked = canonicalExitRouteScopedId(chain, trackedAddress);
  const baseAddress = canonicalExitRouteScopedId(chain, pair.baseToken.address);
  const quoteAddress = canonicalExitRouteScopedId(chain, pair.quoteToken.address);
  const basePriceUsd = Number.parseFloat(pair.priceUsd ?? "");

  if (tracked === baseAddress) {
    return {
      side: "base",
      priceUsd: Number.isFinite(basePriceUsd) && basePriceUsd > 0 ? basePriceUsd : null,
    };
  }
  if (tracked !== quoteAddress) return { side: null, priceUsd: null };

  const priceNative = Number.parseFloat(pair.priceNative ?? "");
  return {
    side: "quote",
    priceUsd:
      Number.isFinite(basePriceUsd) && basePriceUsd > 0 && Number.isFinite(priceNative) && priceNative > 0
        ? basePriceUsd / priceNative
        : null,
  };
}

function resolveStablecoinSide(
  chain: string,
  stablecoinAddress: string,
  stablecoinId: string,
  baseTokenAddress: string,
  quoteTokenAddress: string,
  chainAddressToId: Map<string, string>,
): "base" | "quote" | null {
  const address = canonicalExitRouteScopedId(chain, stablecoinAddress);
  if (canonicalExitRouteScopedId(chain, baseTokenAddress) === address) return "base";
  if (canonicalExitRouteScopedId(chain, quoteTokenAddress) === address) return "quote";

  const baseId = chainAddressToId.get(buildChainAddressKey(chain, baseTokenAddress));
  if (baseId === stablecoinId) return "base";
  const quoteId = chainAddressToId.get(buildChainAddressKey(chain, quoteTokenAddress));
  if (quoteId === stablecoinId) return "quote";
  return null;
}

function toMaturityDays(createdAt: string | null, nowSec: number): number {
  if (!createdAt) return 0;
  const createdSec = new Date(createdAt).getTime() / 1000;
  return createdSec > 0 ? Math.floor((nowSec - createdSec) / DAY_SECONDS) : 0;
}

export async function crawlTokenPools<TRawPool, TNewPool extends GtNewPool>(
  config: CrawlTokenPoolsConfig<TRawPool, TNewPool>,
): Promise<CrawlTokenPoolsResult> {
  const nowSec = Date.now() / 1000;
  const startMs = Date.now();
  const minTvlUsd = config.minTvlUsd ?? 10_000;
  let requestCount = 0;
  const coherenceRejections = new Map<PoolPriceCoherenceRejectReason, number>();
  let stoppedEarly = false;
  for (const token of config.tokens) {
    throwIfAborted(config.signal);

    if (config.beforeRequest) {
      const shouldContinue = await config.beforeRequest({
        requestCount,
        totalTokens: config.tokens.length,
        startMs,
        signal: config.signal,
      });
      if (!shouldContinue) {
        stoppedEarly = true;
        break;
      }
    }
    requestCount++;

    try {
      const page = await config.fetchPools(token.address, token.sourceChain, config.signal);
      config.onRequestResult?.(token, page.complete ? "success" : "degraded", page);
      for (const rawPool of page.rows) {
        let parsed: ParsedPool | null = null;
        try {
          parsed = config.parsePool(rawPool, token.ourChain);
        } catch {
          continue;
        }
        if (!parsed) continue;

        if (!parsed.tvlUsd || parsed.tvlUsd < minTvlUsd || parsed.tvlUsd > 1e12) continue;
        if (isBlockedDexId(parsed.dexId)) continue;

        if (shouldSkipFallbackCurvePool(token.ourChain, parsed.dexId)) {
          continue;
        }

        const side = resolveStablecoinSide(
          token.ourChain,
          token.address,
          token.stablecoinId,
          parsed.baseTokenAddress,
          parsed.quoteTokenAddress,
          config.chainAddressToId,
        );
        if (!side) continue;

        const coherence = evaluatePoolPriceCoherence({
          side,
          baseTokenPriceUsd: parsed.baseTokenPriceUsd,
          quoteTokenPriceUsd: parsed.quoteTokenPriceUsd,
          baseTokenPriceQuoteToken: parsed.baseTokenPriceQuoteToken,
          quoteTokenPriceBaseToken: parsed.quoteTokenPriceBaseToken,
          baseTokenPriceNativeCurrency: parsed.baseTokenPriceNativeCurrency,
          quoteTokenPriceNativeCurrency: parsed.quoteTokenPriceNativeCurrency,
        });
        if (coherence.verdict === "reject") {
          coherenceRejections.set(coherence.reason, (coherenceRejections.get(coherence.reason) ?? 0) + 1);
          continue;
        }

        const price = side === "base" ? parsed.baseTokenPriceUsd : parsed.quoteTokenPriceUsd;
        const hasUsablePrice = Number.isFinite(price) && price > 0;
        if (hasUsablePrice && !isPlausibleDexObservationPrice(token.stablecoinId, price, config.references)) {
          continue;
        }

        if (hasUsablePrice && parsed.tvlUsd >= DEX_PRICE_OBSERVATION_MIN_TVL_USD) {
          const obs = config.priceObs.get(token.stablecoinId) ?? [];
          obs.push({ price, tvl: parsed.tvlUsd, chain: token.ourChain, protocol: parsed.dexId });
          config.priceObs.set(token.stablecoinId, obs);
        }

        const poolKey = canonicalExitRouteScopedKey(token.ourChain, parsed.poolAddress);
        const fpKey = buildPoolFingerprint(token.ourChain, parsed.dexId, [
          parsed.baseTokenAddress,
          parsed.quoteTokenAddress,
        ]);
        if (config.knownPoolAddrs.has(poolKey) || (fpKey != null && config.knownPoolAddrs.has(fpKey))) {
          continue;
        }

        if (parsed.tvlUsd > 0 && parsed.volume24hUsd / parsed.tvlUsd > 50) {
          continue;
        }

        const protoNorm = normalizeProtocol(parsed.dexId);
        const protoCap = config.protocolTvlCaps.get(protoNorm);
        const cappedTvlUsd = protoCap != null && parsed.tvlUsd > protoCap ? protoCap : parsed.tvlUsd;
        const maturityDays = toMaturityDays(parsed.createdAt, nowSec);

        const poolList = config.newPools.get(token.stablecoinId) ?? [];
        poolList.push(
          config.buildNewPool({
            rawPool,
            parsed,
            stablecoinId: token.stablecoinId,
            chain: token.ourChain,
            price,
            cappedTvlUsd,
            maturityDays,
          }),
        );
        config.newPools.set(token.stablecoinId, poolList);
      }
    } catch (err) {
      if (config.signal?.aborted) throw err;
      config.onRequestResult?.(token, "failure");
      logWorkerEventArgs("handler", "warn",
        `[dex-liquidity] ${config.sourceLabel} pool crawl error for ${token.ourChain}:${token.address}:`,
        err,
      );
    }
  }

  if (coherenceRejections.size > 0) {
    logWorkerEventArgs("handler", "warn",
      `[dex-liquidity] ${config.sourceLabel} rejected incoherent pool prices by reason: ${JSON.stringify(Object.fromEntries(coherenceRejections))}`,
    );
  }

  return { stoppedEarly };
}
