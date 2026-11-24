import { logWorkerEventArgs } from "./structured-log";
/**
 * Fetch stablecoin prices via Curve StableSwap get_dy() on-chain calls.
 *
 * get_dy(i, j, dx) simulates swapping dx of token i for token j,
 * returning the output amount. The ratio is input-token units per output token.
 *
 * Uses the existing `fetchEvmCallHexAtBlock()` from `evm-rpc.ts` which handles
 * chain registry resolution and fallback RPCs.
 */

import { fetchEvmBlockNumber, fetchEvmBlockTimestamp, fetchEvmCallHexAtBlock, fetchEvmRpcBatch, fetchEvmUint256AtBlock } from "./evm-rpc";
import type { ChainRpcConfig } from "./chain-registry";
import type { FetcherOutcome } from "./fetcher-result";

import { encodeUint256 } from "./evm-selectors";
import type {
  CurvePoolConfig,
  CurveRouteType,
  CurveSellGuardRejectionReason,
} from "@shared/lib/curve-pool-configs";
import { getPricingSourceRegistryEntry } from "@shared/lib/pricing-source-registry";
import { median, weightedMedian } from "@shared/lib/stats";
import { canonicalExitRouteScopedKey } from "@shared/types/exit-route-identity";

export type { CurveSellGuardRejectionReason };

/** Maximum accepted block-timestamp staleness for the Curve PriceAggregator EMA oracle (seconds). */
export const CURVE_ORACLE_MAX_STALENESS_SEC = 300;
export const CURVE_MAX_QUOTE_IMPACT_RATIO = 0.05;
const CURVE_BALANCES_SELECTOR = "0x4903b0d1";
const HEX_UINT256_PREFIX_RE = /^0x[\da-f]{64}/i;

// get_dy(int128,int128,uint256) selector
const GET_DY_SELECTOR = "0x5e0d443f";
// get_dy_underlying(int128,int128,uint256) selector
const GET_DY_UNDERLYING_SELECTOR = "0x07211ef7";

export interface CurveSellGuardRejection {
  stablecoinId: string;
  chain: string;
  poolAddress: string;
  reason: CurveSellGuardRejectionReason;
  quoteDepthTokens?: number;
  inputBalanceTokens?: number;
}

/**
 * Fetch implied prices via Curve get_dy for a batch of pool configurations.
 * Uses fetchEvmCallHexAtBlock which resolves RPC URLs via chain-registry.ts.
 *
 * Block number + timestamp are fetched once per distinct chain and all
 * get_dy calls are pinned to that block. Each resolved USD quote carries the
 * oldest block or USDC/USD observation on its route; multiple passing routes
 * for one stablecoin combine via USD quote-depth-weighted median into a single
 * `curve-onchain` observation dated by the oldest contributing clock.
 */
export interface CurveOnchainBatch {
  prices: Map<string, number>;
  observedAtByCoinId: Map<string, number>;
  pricePoolKeysByCoinId: Map<string, readonly string[]>;
  routeTypeByCoinId: Map<string, CurveRouteType>;
  hopDepthByCoinId: Map<string, number>;
  sellGuardRejections?: CurveSellGuardRejection[];
}

export interface UsdcUsdMark {
  price: number;
  observedAt: number;
}

interface RawCurveRouteQuote {
  impliedPrice: number;
  quoteDepthTokens?: number;
}

export async function fetchCurveOnchainPrices(
  configs: CurvePoolConfig[],
  usdcUsd: UsdcUsdMark | null,
  signal?: AbortSignal,
  chainRpcs?: Map<string, ChainRpcConfig>,
): Promise<FetcherOutcome<CurveOnchainBatch>> {
  const emptyBatch: CurveOnchainBatch = {
    prices: new Map<string, number>(),
    observedAtByCoinId: new Map<string, number>(),
    pricePoolKeysByCoinId: new Map(),
    routeTypeByCoinId: new Map<string, CurveRouteType>(),
    hopDepthByCoinId: new Map<string, number>(),
    sellGuardRejections: [],
  };

  const nowSec = Math.floor(Date.now() / 1000);
  const maxAgeSec = getPricingSourceRegistryEntry("curve-onchain")!.maxTrustedAgeSec!;
  if (!usdcUsd || !Number.isFinite(usdcUsd.price) || usdcUsd.price <= 0 ||
      !Number.isInteger(usdcUsd.observedAt) || usdcUsd.observedAt <= 0 ||
      usdcUsd.observedAt > nowSec || nowSec - usdcUsd.observedAt > maxAgeSec) {
    return { kind: "upstream-error", value: emptyBatch, reason: "fresh independent USDC/USD mark unavailable" };
  }

  // Phase 0: resolve block number + timestamp per distinct chain in parallel
  // so calls are pinned to a single block and callers can enforce upstream freshness.
  const chains = Array.from(new Set(configs.map((c) => c.chain)));
  const blockByChain = new Map<string, { blockNumber: number; blockTimestamp: number }>();
  type ChainResolution =
    | { chain: string; blockNumber: number; blockTimestamp: number }
    | { chain: string; error: string };
  const chainResolutions: ChainResolution[] = await Promise.all(
    chains.map(async (chain): Promise<ChainResolution> => {
      const blockNumber = await fetchEvmBlockNumber(chain, { chainRpcs, signal });
      if (blockNumber == null) return { chain, error: `eth_blockNumber unavailable for ${chain}` };
      const blockTimestamp = await fetchEvmBlockTimestamp(chain, blockNumber, { chainRpcs, signal });
      if (blockTimestamp == null) return { chain, error: `eth_getBlockByNumber timestamp unavailable for ${chain}` };
      return { chain, blockNumber, blockTimestamp };
    }),
  );
  for (const entry of chainResolutions) {
    if ("error" in entry) {
      return { kind: "upstream-error", value: emptyBatch, reason: entry.error };
    }
    const blockAgeSec = Math.floor(Date.now() / 1000) - entry.blockTimestamp;
    if (blockAgeSec < 0 || blockAgeSec > maxAgeSec) {
      return {
        kind: "upstream-error",
        value: emptyBatch,
        reason: `block outside freshness budget on ${entry.chain}: age ${blockAgeSec}s, budget ${maxAgeSec}s`,
      };
    }
    blockByChain.set(entry.chain, { blockNumber: entry.blockNumber, blockTimestamp: entry.blockTimestamp });
  }

  const configsById = new Map<string, CurvePoolConfig[]>();
  for (const config of configs) {
    const list = configsById.get(config.stablecoinId) ?? [];
    list.push(config);
    configsById.set(config.stablecoinId, list);
  }

  const rawQuotes = new Map<CurvePoolConfig, RawCurveRouteQuote>();
  const sellGuardRejections: CurveSellGuardRejection[] = [];
  let rpcAttempts = 0;
  let rpcThrows = 0;

  for (const config of configs) {
    rpcAttempts++;
    try {
      const inputAmount = getDyQuoteAmount(config);
      const selector = config.useUnderlying ? GET_DY_UNDERLYING_SELECTOR : GET_DY_SELECTOR;
      const calldata = encodeGetDy(selector, config.inputIndex, config.outputIndex, inputAmount);

      // Metapool get_dy_underlying makes cross-pool calls requiring more gas
      const gas = config.useUnderlying ? "0x7A120" : undefined; // 500K gas
      const block = blockByChain.get(config.chain);
      if (!block) continue; // unreachable: chains is built from configs
      const resultHex = await fetchEvmCallHexAtBlock(
        config.chain, config.poolAddress, calldata, block.blockNumber, { signal, gas, chainRpcs },
      );
      if (!resultHex) continue;

      // Vyper contracts (old Curve pools) may return extra memory beyond the
      // uint256 return value.  Truncate to the first 32-byte word to avoid
      // BigInt parsing thousands of trailing bytes.
      const word0 = resultHex.length > 66
        ? `0x${resultHex.slice(2, 66)}` as `0x${string}`
        : resultHex;
      const outputRaw = BigInt(word0);
      const outputFloat = Number(outputRaw) / Math.pow(10, config.outputDecimals);
      const inputFloat = Number(inputAmount) / Math.pow(10, config.inputDecimals);
      const impliedPrice = inputFloat / outputFloat;

      if (impliedPrice > 0 && impliedPrice < 10_000) {
        if (config.sellGuard) {
          const guardResult = await evaluateSellGuard(
            config, selector, block.blockNumber, impliedPrice, signal, chainRpcs,
          );
          if (!guardResult.passed) {
            sellGuardRejections.push({
              stablecoinId: config.stablecoinId,
              chain: config.chain,
              poolAddress: config.poolAddress,
              reason: guardResult.reason,
              ...(guardResult.quoteDepthTokens != null ? { quoteDepthTokens: guardResult.quoteDepthTokens } : {}),
              ...(guardResult.inputBalanceTokens != null ? { inputBalanceTokens: guardResult.inputBalanceTokens } : {}),
            });
            logWorkerEventArgs(
              "lib",
              "warn",
              `[curve-onchain] ${config.stablecoinId} (${config.poolAddress}): sellGuard rejected (${guardResult.reason})`,
            );
            continue;
          }
          rawQuotes.set(config, { impliedPrice, quoteDepthTokens: guardResult.quoteDepthTokens });
        } else {
          const isMultiRoute = (configsById.get(config.stablecoinId)?.length ?? 0) > 1;
          const quoteDepthTokens = isMultiRoute && !config.useUnderlying
            ? await fetchQuoteDepthTokens(config, block.blockNumber, signal, chainRpcs)
            : undefined;
          rawQuotes.set(config, {
            impliedPrice,
            ...(quoteDepthTokens != null ? { quoteDepthTokens } : {}),
          });
        }
      }
    } catch (err) {
      if (signal?.aborted) throw err instanceof Error ? err : new Error(String(err));
      logWorkerEventArgs("lib", "warn", `[curve-onchain] get_dy failed for ${config.stablecoinId}:`, err);
      rpcThrows++;
    }
  }

  // Phase 2: Resolve hop prices, combine multi-route coins via quote-depth-weighted
  // median, and stamp each resolved coin with its oldest contributing observation.
  const prices = new Map<string, number>();
  const observedAtByCoinId = new Map<string, number>();
  const pricePoolKeysByCoinId = new Map<string, readonly string[]>();
  const routeTypeByCoinId = new Map<string, CurveRouteType>();
  const hopDepthByCoinId = new Map<string, number>();
  const resolutionCache = new Map<string, CurveResolvedPrice | null>();
  const resolving = new Set<string>();

  for (const stablecoinId of configsById.keys()) {
    const resolved = resolveCurveStablecoin(stablecoinId, {
      blockByChain,
      configsById,
      rawQuotes,
      resolving,
      resolutionCache,
      usdcUsd,
    });
    if (!resolved) continue;
    prices.set(stablecoinId, resolved.price);
    observedAtByCoinId.set(stablecoinId, resolved.observedAt);
    if (resolved.pricePoolKeys) pricePoolKeysByCoinId.set(stablecoinId, resolved.pricePoolKeys);
    routeTypeByCoinId.set(stablecoinId, resolved.routeType);
    hopDepthByCoinId.set(stablecoinId, resolved.hopDepth);
  }

  const value: CurveOnchainBatch = {
    prices,
    observedAtByCoinId,
    pricePoolKeysByCoinId,
    routeTypeByCoinId,
    hopDepthByCoinId,
    sellGuardRejections,
  };

  if (rpcAttempts > 0 && rpcThrows === rpcAttempts) {
    return { kind: "upstream-error", value, reason: "all Curve pool RPC calls threw" };
  }
  if (prices.size === 0) {
    return { kind: "no-data", value };
  }
  return { kind: "ok", value };
}

// get_dy floors its return value to whole output quanta. A 1-unit quote
// against a low-decimal output token loses up to one quantum per unit — for
// the 2-decimal GUSD metapool output, 1 USDC in quotes exactly 0.99 GUSD out
// (implied price 1/0.99 = 1.0101). Size the quote so the output spans at
// least 10_000 quanta, keeping floor quantization under ~0.01% while the
// trade itself stays negligible against StableSwap pool depth.
const GET_DY_MIN_OUTPUT_QUANTA = 10_000;

function getDyQuoteAmount(config: CurvePoolConfig): bigint {
  const units = Math.max(1, Math.ceil(GET_DY_MIN_OUTPUT_QUANTA / 10 ** config.outputDecimals));
  return BigInt(units) * BigInt(10) ** BigInt(config.inputDecimals);
}

function encodeGetDy(selector: string, i: number, j: number, dx: bigint): string {
  return `${selector}${encodeUint256(i)}${encodeUint256(j)}${encodeUint256(dx)}`;
}

function meetsTokenFloor(rawAmount: bigint, decimals: number, minTokens: number): boolean {
  if (!Number.isFinite(minTokens) || minTokens < 0) return false;
  if (Number.isInteger(minTokens)) {
    return rawAmount >= BigInt(minTokens) * 10n ** BigInt(decimals);
  }
  return Number(rawAmount) / 10 ** decimals >= minTokens;
}

type SellGuardOutcome =
  | { passed: true; quoteDepthTokens: number; inputBalanceTokens: number }
  | {
    passed: false;
    reason: CurveSellGuardRejectionReason;
    quoteDepthTokens?: number;
    inputBalanceTokens?: number;
  };

async function evaluateSellGuard(
  config: CurvePoolConfig,
  selector: string,
  blockNumber: number,
  buyPrice: number,
  signal?: AbortSignal,
  chainRpcs?: Map<string, ChainRpcConfig>,
): Promise<SellGuardOutcome> {
  const guard = config.sellGuard!;
  const inputScale = 10 ** config.inputDecimals;
  const outputScale = 10n ** BigInt(config.outputDecimals);
  const gas = config.useUnderlying ? "0x7A120" : undefined;
  const encodeSell = (tokens: number) => encodeGetDy(
    selector, config.outputIndex, config.inputIndex, BigInt(tokens) * outputScale,
  );
  let result: unknown[] | null;
  try {
    result = await fetchEvmRpcBatch(config.chain, [
      `${CURVE_BALANCES_SELECTOR}${encodeUint256(config.inputIndex)}`,
      `${CURVE_BALANCES_SELECTOR}${encodeUint256(config.outputIndex)}`,
      encodeSell(guard.smallQuoteTokens),
      encodeSell(guard.impactQuoteTokens),
    ].map((data) => ({
      method: "eth_call",
      params: [{ to: config.poolAddress, data, ...(gas ? { gas } : {}) }, `0x${blockNumber.toString(16)}`],
    })), { signal, chainRpcs });
  } catch (err) {
    if (signal?.aborted) throw err instanceof Error ? err : new Error(String(err));
    return { passed: false, reason: "rpc" };
  }
  if (!result || result.length !== 4 || !result.every((word) => typeof word === "string" && HEX_UINT256_PREFIX_RE.test(word))) {
    return { passed: false, reason: "rpc" };
  }
  const [quoteBalanceRaw, sellInputBalanceRaw, smallOutputRaw, impactOutputRaw] = result.map(
    (word) => BigInt((word as string).slice(0, 66)),
  );
  const quoteDepthTokens = Number(quoteBalanceRaw) / inputScale;
  const inputBalanceTokens = Number(sellInputBalanceRaw) / Number(outputScale);
  if (!meetsTokenFloor(quoteBalanceRaw, config.inputDecimals, guard.minSellDepthQuoteTokens)) {
    return { passed: false, reason: "insufficient-sell-depth", quoteDepthTokens, inputBalanceTokens };
  }
  if (!meetsTokenFloor(sellInputBalanceRaw, config.outputDecimals, guard.minSellInputBalanceTokens)) {
    return { passed: false, reason: "input-balance", quoteDepthTokens, inputBalanceTokens };
  }
  const smallPrice = Number(smallOutputRaw) / inputScale / guard.smallQuoteTokens;
  const impactPrice = Number(impactOutputRaw) / inputScale / guard.impactQuoteTokens;
  const impactPassed =
    smallOutputRaw <= quoteBalanceRaw &&
    impactOutputRaw <= quoteBalanceRaw &&
    Number.isFinite(smallPrice) && smallPrice > 0 &&
    Number.isFinite(impactPrice) && impactPrice > 0 &&
    Math.abs(smallPrice / buyPrice - 1) <= CURVE_MAX_QUOTE_IMPACT_RATIO &&
    Math.abs(impactPrice / smallPrice - 1) <= CURVE_MAX_QUOTE_IMPACT_RATIO;
  if (!impactPassed) {
    return { passed: false, reason: "impact", quoteDepthTokens, inputBalanceTokens };
  }
  return { passed: true, quoteDepthTokens, inputBalanceTokens };
}

async function fetchQuoteDepthTokens(
  config: CurvePoolConfig,
  blockNumber: number,
  signal?: AbortSignal,
  chainRpcs?: Map<string, ChainRpcConfig>,
): Promise<number | undefined> {
  try {
    const result = await fetchEvmRpcBatch(config.chain, [{
      method: "eth_call",
      params: [
        { to: config.poolAddress, data: `${CURVE_BALANCES_SELECTOR}${encodeUint256(config.inputIndex)}` },
        `0x${blockNumber.toString(16)}`,
      ],
    }], { signal, chainRpcs });
    const word = result?.[0];
    if (typeof word !== "string" || !HEX_UINT256_PREFIX_RE.test(word)) return undefined;
    const tokens = Number(BigInt(word.slice(0, 66))) / 10 ** config.inputDecimals;
    return Number.isFinite(tokens) && tokens > 0 ? tokens : undefined;
  } catch (err) {
    if (signal?.aborted) throw err instanceof Error ? err : new Error(String(err));
    return undefined;
  }
}

interface CurveResolvedPrice {
  price: number;
  observedAt: number;
  routeType: CurveRouteType;
  hopDepth: number;
  pricePoolKeys: readonly string[] | null;
}

interface CurveResolvedRoute extends CurveResolvedPrice {
  quoteDepthUsd?: number;
}

interface CurveResolutionContext {
  blockByChain: Map<string, { blockNumber: number; blockTimestamp: number }>;
  configsById: Map<string, CurvePoolConfig[]>;
  rawQuotes: Map<CurvePoolConfig, RawCurveRouteQuote>;
  resolving: Set<string>;
  resolutionCache: Map<string, CurveResolvedPrice | null>;
  usdcUsd: UsdcUsdMark;
}

const ROUTE_TYPE_PRIORITY: Record<CurveRouteType, number> = {
  direct: 0,
  "trusted-wrapper": 1,
  "one-hop": 2,
  "chained-hop": 3,
};

function resolveCurveStablecoin(
  stablecoinId: string,
  context: CurveResolutionContext,
): CurveResolvedPrice | null {
  if (context.resolutionCache.has(stablecoinId)) {
    return context.resolutionCache.get(stablecoinId) ?? null;
  }
  if (context.resolving.has(stablecoinId)) {
    return null;
  }

  const configs = context.configsById.get(stablecoinId);
  if (!configs || configs.length === 0) {
    if (context.resolving.size === 0) context.resolutionCache.set(stablecoinId, null);
    return null;
  }

  context.resolving.add(stablecoinId);
  const passing: CurveResolvedRoute[] = [];
  for (const config of configs) {
    const resolved = resolveSingleCurveConfig(config, context);
    if (resolved) passing.push(resolved);
  }
  context.resolving.delete(stablecoinId);

  const combined = combineResolvedCurveRoutes(passing);
  if (combined !== null || context.resolving.size === 0) {
    context.resolutionCache.set(stablecoinId, combined);
  }
  return combined;
}

function resolveSingleCurveConfig(
  config: CurvePoolConfig,
  context: CurveResolutionContext,
): CurveResolvedRoute | null {
  const routeType = getCurveRouteType(config);
  if (!isCurveRouteShapeAllowed(config, routeType)) {
    return null;
  }

  const raw = context.rawQuotes.get(config);
  const block = context.blockByChain.get(config.chain);
  if (raw == null || !block) {
    return null;
  }

  // An underlying metapool quote depends on its base pool, whose lineage is not configured here.
  const poolKey = config.useUnderlying ? null : canonicalExitRouteScopedKey(config.chain, config.poolAddress);

  if (!config.hop) {
    if (config.terminalQuoteAsset !== "USDC") return null;
    const quoteAssetUsdPrice = context.usdcUsd.price;
    const quoteDepthUsd = raw.quoteDepthTokens != null ? raw.quoteDepthTokens * quoteAssetUsdPrice : undefined;
    return normalizeResolvedCurveRoute(
      raw.impliedPrice * quoteAssetUsdPrice,
      Math.min(block.blockTimestamp, context.usdcUsd.observedAt),
      routeType,
      0,
      poolKey ? [poolKey] : null,
      quoteDepthUsd,
    );
  }

  if (!context.configsById.has(config.hop.viaStablecoinId)) {
    return null;
  }

  const via = resolveCurveStablecoin(config.hop.viaStablecoinId, context);
  if (!via) {
    return null;
  }

  const hopDepth = via.hopDepth + 1;
  if (hopDepth > getMaxCurveHopDepth(config, routeType)) {
    return null;
  }

  const quoteAssetUsdPrice = via.price;
  const finalPrice = raw.impliedPrice * quoteAssetUsdPrice;
  const observedAt = Math.min(block.blockTimestamp, via.observedAt);
  const pricePoolKeys = poolKey && via.pricePoolKeys ? [poolKey, ...via.pricePoolKeys] : null;
  const quoteDepthUsd = raw.quoteDepthTokens != null ? raw.quoteDepthTokens * quoteAssetUsdPrice : undefined;
  return normalizeResolvedCurveRoute(finalPrice, observedAt, routeType, hopDepth, pricePoolKeys, quoteDepthUsd);
}

function combineResolvedCurveRoutes(passing: readonly CurveResolvedRoute[]): CurveResolvedPrice | null {
  if (passing.length === 0) return null;
  if (passing.length === 1) {
    const only = passing[0]!;
    return {
      price: only.price,
      observedAt: only.observedAt,
      routeType: only.routeType,
      hopDepth: only.hopDepth,
      pricePoolKeys: only.pricePoolKeys,
    };
  }

  const allHaveDepth = passing.every(
    (route) => route.quoteDepthUsd != null && Number.isFinite(route.quoteDepthUsd) && route.quoteDepthUsd > 0,
  );
  const combinedPrice = allHaveDepth
    ? weightedMedian(passing.map((route) => ({ value: route.price, weight: route.quoteDepthUsd! })))
    : median(passing.map((route) => route.price));
  if (combinedPrice == null || !Number.isFinite(combinedPrice) || combinedPrice <= 0 || combinedPrice >= 10_000) {
    return null;
  }

  const observedAt = Math.min(...passing.map((route) => route.observedAt));
  const pricePoolKeys = passing.every((route) => route.pricePoolKeys != null)
    ? [...new Set(passing.flatMap((route) => route.pricePoolKeys!))]
    : null;
  const hopDepth = Math.max(...passing.map((route) => route.hopDepth));
  const routeType = passing.reduce<CurveRouteType>(
    (mostDependent, route) =>
      ROUTE_TYPE_PRIORITY[route.routeType] > ROUTE_TYPE_PRIORITY[mostDependent] ? route.routeType : mostDependent,
    passing[0]!.routeType,
  );
  return { price: combinedPrice, observedAt, routeType, hopDepth, pricePoolKeys };
}

function normalizeResolvedCurveRoute(
  price: number,
  observedAt: number,
  routeType: CurveRouteType,
  hopDepth: number,
  pricePoolKeys: readonly string[] | null,
  quoteDepthUsd: number | undefined,
): CurveResolvedRoute | null {
  if (!Number.isFinite(price) || price <= 0 || price >= 10_000) return null;
  return {
    price,
    observedAt,
    routeType,
    hopDepth,
    pricePoolKeys,
    ...(quoteDepthUsd != null && Number.isFinite(quoteDepthUsd) && quoteDepthUsd > 0 ? { quoteDepthUsd } : {}),
  };
}

function getCurveRouteType(config: CurvePoolConfig): CurveRouteType {
  if (config.routeType) return config.routeType;
  return config.hop ? "one-hop" : "direct";
}

function isCurveRouteShapeAllowed(config: CurvePoolConfig, routeType: CurveRouteType): boolean {
  if (routeType === "direct" && config.hop) return false;
  if (routeType === "chained-hop" && !config.hop) return false;
  return true;
}

function getMaxCurveHopDepth(config: CurvePoolConfig, routeType: CurveRouteType): number {
  if (!config.hop) return 0;
  if (routeType === "chained-hop") {
    return Number.isInteger(config.maxHopDepth) && config.maxHopDepth != null ? config.maxHopDepth : 1;
  }
  return 1;
}

/**
 * Fetch the Curve PriceAggregator EMA price stamped with the block number and
 * block timestamp it was read at. The block timestamp lets callers enforce
 * freshness against stale-replica RPCs (the aggregator's price is an EMA
 * updated on each pool transaction, not a heartbeat oracle).
 *
 * Returns null if any RPC leg fails or the parsed price falls outside the
 * sanity band `(0, 10)`.
 */
export async function fetchCurveOracleEma(
  chainId: string,
  aggregator: string,
  selector: string,
  chainRpcs: Map<string, ChainRpcConfig>,
  signal?: AbortSignal,
): Promise<{ price: number; blockNumber: number; blockTimestamp: number } | null> {
  const blockNumber = await fetchEvmBlockNumber(chainId, { chainRpcs, signal });
  if (blockNumber == null) return null;
  const [raw, blockTimestamp] = await Promise.all([
    fetchEvmUint256AtBlock(chainId, aggregator, selector, blockNumber, { chainRpcs, signal }),
    fetchEvmBlockTimestamp(chainId, blockNumber, { chainRpcs, signal }),
  ]);
  if (raw == null || blockTimestamp == null) return null;
  const price = Number(raw) / 1e18;
  if (!Number.isFinite(price) || price <= 0 || price >= 10) return null;
  return { price, blockNumber, blockTimestamp };
}
