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
import type { CurvePoolConfig, CurveRouteType } from "@shared/lib/curve-pool-configs";
import { getPricingSourceRegistryEntry } from "@shared/lib/pricing-source-registry";
import { canonicalExitRouteScopedKey } from "@shared/types/exit-route-identity";

/** Maximum accepted block-timestamp staleness for the Curve PriceAggregator EMA oracle (seconds). */
export const CURVE_ORACLE_MAX_STALENESS_SEC = 300;
const CURVE_MAX_QUOTE_IMPACT_RATIO = 0.05;
const CURVE_BALANCES_SELECTOR = "0x4903b0d1";

// get_dy(int128,int128,uint256) selector
const GET_DY_SELECTOR = "0x5e0d443f";
// get_dy_underlying(int128,int128,uint256) selector
const GET_DY_UNDERLYING_SELECTOR = "0x07211ef7";

/**
 * Fetch implied prices via Curve get_dy for a batch of pool configurations.
 * Uses fetchEvmCallHexAtBlock which resolves RPC URLs via chain-registry.ts.
 *
 * Block number + timestamp are fetched once per distinct chain and all
 * get_dy calls are pinned to that block. Each resolved USD quote carries the
 * oldest block or USDC/USD observation on its route.
 */
export interface CurveOnchainBatch {
  prices: Map<string, number>;
  observedAtByCoinId: Map<string, number>;
  pricePoolKeysByCoinId: Map<string, readonly string[]>;
  routeTypeByCoinId: Map<string, CurveRouteType>;
  hopDepthByCoinId: Map<string, number>;
}

export interface UsdcUsdMark {
  price: number;
  observedAt: number;
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

  const rawPrices = new Map<string, number>();
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
        if (config.sellGuard && !await passesSellGuard(config, selector, block.blockNumber, impliedPrice, signal, chainRpcs)) {
          logWorkerEventArgs("lib", "warn", `[curve-onchain] ${config.stablecoinId}: sell-depth-or-impact rejected`);
          continue;
        }
        rawPrices.set(config.stablecoinId, impliedPrice);
      }
    } catch (err) {
      if (signal?.aborted) throw err instanceof Error ? err : new Error(String(err));
      logWorkerEventArgs("lib", "warn", `[curve-onchain] get_dy failed for ${config.stablecoinId}:`, err);
      rpcThrows++;
    }
  }

  // Phase 2: Resolve hop prices, build final results stamped with the pool's
  // chain-block timestamp. Dependencies resolve recursively so explicitly
  // allowed chained hops multiply by the final USD price of the via asset.
  const prices = new Map<string, number>();
  const observedAtByCoinId = new Map<string, number>();
  const pricePoolKeysByCoinId = new Map<string, readonly string[]>();
  const routeTypeByCoinId = new Map<string, CurveRouteType>();
  const hopDepthByCoinId = new Map<string, number>();
  const configById = new Map(configs.map((config) => [config.stablecoinId, config]));
  const resolutionCache = new Map<string, CurveResolvedPrice | null>();
  const resolving = new Set<string>();

  for (const config of configs) {
    const resolved = resolveCurveConfig(config, {
      blockByChain,
      configById,
      rawPrices,
      resolving,
      resolutionCache,
      usdcUsd,
    });
    if (!resolved) continue;
    prices.set(config.stablecoinId, resolved.price);
    observedAtByCoinId.set(config.stablecoinId, resolved.observedAt);
    if (resolved.pricePoolKeys) pricePoolKeysByCoinId.set(config.stablecoinId, resolved.pricePoolKeys);
    routeTypeByCoinId.set(config.stablecoinId, resolved.routeType);
    hopDepthByCoinId.set(config.stablecoinId, resolved.hopDepth);
  }

  const value: CurveOnchainBatch = { prices, observedAtByCoinId, pricePoolKeysByCoinId, routeTypeByCoinId, hopDepthByCoinId };

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

async function passesSellGuard(
  config: CurvePoolConfig,
  selector: string,
  blockNumber: number,
  buyPrice: number,
  signal?: AbortSignal,
  chainRpcs?: Map<string, ChainRpcConfig>,
): Promise<boolean> {
  const guard = config.sellGuard!;
  const inputScale = 10 ** config.inputDecimals;
  const outputScale = 10n ** BigInt(config.outputDecimals);
  const encodeSell = (tokens: number) => encodeGetDy(
    selector, config.outputIndex, config.inputIndex, BigInt(tokens) * outputScale,
  );
  const result = await fetchEvmRpcBatch(config.chain, [
    `${CURVE_BALANCES_SELECTOR}${encodeUint256(config.inputIndex)}`,
    `${CURVE_BALANCES_SELECTOR}${encodeUint256(config.outputIndex)}`,
    encodeSell(guard.smallQuoteTokens),
    encodeSell(guard.impactQuoteTokens),
  ].map((data) => ({
    method: "eth_call",
    params: [{ to: config.poolAddress, data }, `0x${blockNumber.toString(16)}`],
  })), { signal, chainRpcs });
  if (!result || result.length !== 4) return false;
  const [inputBalance, outputBalance, smallOutput, impactOutput] = result.map((word) =>
    typeof word === "string" && /^0x[\da-f]{64}/i.test(word) ? Number(BigInt(word.slice(0, 66))) : 0);
  const smallPrice = smallOutput / inputScale / guard.smallQuoteTokens;
  const impactPrice = impactOutput / inputScale / guard.impactQuoteTokens;
  return inputBalance / inputScale >= guard.minBalanceTokens &&
    outputBalance / Number(outputScale) >= guard.minBalanceTokens &&
    smallOutput <= inputBalance && impactOutput <= inputBalance &&
    smallPrice > 0 && impactPrice > 0 &&
    Math.abs(smallPrice / buyPrice - 1) <= CURVE_MAX_QUOTE_IMPACT_RATIO &&
    Math.abs(impactPrice / smallPrice - 1) <= CURVE_MAX_QUOTE_IMPACT_RATIO;
}

interface CurveResolvedPrice {
  price: number;
  observedAt: number;
  routeType: CurveRouteType;
  hopDepth: number;
  pricePoolKeys: readonly string[] | null;
}

interface CurveResolutionContext {
  blockByChain: Map<string, { blockNumber: number; blockTimestamp: number }>;
  configById: Map<string, CurvePoolConfig>;
  rawPrices: Map<string, number>;
  resolving: Set<string>;
  resolutionCache: Map<string, CurveResolvedPrice | null>;
  usdcUsd: UsdcUsdMark;
}

function resolveCurveConfig(
  config: CurvePoolConfig,
  context: CurveResolutionContext,
): CurveResolvedPrice | null {
  if (context.resolutionCache.has(config.stablecoinId)) {
    return context.resolutionCache.get(config.stablecoinId) ?? null;
  }
  if (context.resolving.has(config.stablecoinId)) {
    context.resolutionCache.set(config.stablecoinId, null);
    return null;
  }

  const routeType = getCurveRouteType(config);
  if (!isCurveRouteShapeAllowed(config, routeType)) {
    context.resolutionCache.set(config.stablecoinId, null);
    return null;
  }

  const raw = context.rawPrices.get(config.stablecoinId);
  const block = context.blockByChain.get(config.chain);
  if (raw == null || !block) {
    context.resolutionCache.set(config.stablecoinId, null);
    return null;
  }

  // An underlying metapool quote depends on its base pool, whose lineage is not configured here.
  const poolKey = config.useUnderlying ? null : canonicalExitRouteScopedKey(config.chain, config.poolAddress);

  if (!config.hop) {
    const resolved = config.terminalQuoteAsset === "USDC" ? normalizeResolvedCurvePrice(
      raw * context.usdcUsd.price, Math.min(block.blockTimestamp, context.usdcUsd.observedAt),
      routeType, 0, poolKey ? [poolKey] : null,
    ) : null;
    context.resolutionCache.set(config.stablecoinId, resolved);
    return resolved;
  }

  const viaConfig = context.configById.get(config.hop.viaStablecoinId);
  if (!viaConfig) {
    context.resolutionCache.set(config.stablecoinId, null);
    return null;
  }

  context.resolving.add(config.stablecoinId);
  const via = resolveCurveConfig(viaConfig, context);
  context.resolving.delete(config.stablecoinId);

  if (!via) {
    context.resolutionCache.set(config.stablecoinId, null);
    return null;
  }

  const hopDepth = via.hopDepth + 1;
  if (hopDepth > getMaxCurveHopDepth(config, routeType)) {
    context.resolutionCache.set(config.stablecoinId, null);
    return null;
  }

  const finalPrice = raw * via.price;
  const observedAt = Math.min(block.blockTimestamp, via.observedAt);
  const pricePoolKeys = poolKey && via.pricePoolKeys ? [poolKey, ...via.pricePoolKeys] : null;
  const resolved = normalizeResolvedCurvePrice(finalPrice, observedAt, routeType, hopDepth, pricePoolKeys);
  context.resolutionCache.set(config.stablecoinId, resolved);
  return resolved;
}

function normalizeResolvedCurvePrice(
  price: number,
  observedAt: number,
  routeType: CurveRouteType,
  hopDepth: number,
  pricePoolKeys: readonly string[] | null,
): CurveResolvedPrice | null {
  if (!Number.isFinite(price) || price <= 0 || price >= 10_000) return null;
  return { price, observedAt, routeType, hopDepth, pricePoolKeys };
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
