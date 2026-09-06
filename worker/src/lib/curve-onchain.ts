import { logWorkerEventArgs } from "./structured-log";
/**
 * Fetch stablecoin prices via Curve StableSwap get_dy() on-chain calls.
 *
 * get_dy(i, j, dx) simulates swapping dx of token i for token j,
 * returning the output amount. The implied price = inputUsd / outputTokens.
 *
 * Curve StableSwap amplification factor (A=500-5000) makes manipulation
 * extremely expensive — these prices are among the most reliable on-chain signals.
 *
 * Uses the existing `fetchEvmCallHexAtBlock()` from `evm-rpc.ts` which handles
 * chain registry resolution and fallback RPCs.
 */

import { fetchEvmBlockNumber, fetchEvmBlockTimestamp, fetchEvmCallHexAtBlock, fetchEvmUint256AtBlock } from "./evm-rpc";
import type { ChainRpcConfig } from "./chain-registry";
import type { FetcherOutcome } from "./fetcher-result";
import { CURVE_ORACLE_MAX_STALENESS_SEC } from "./constants";
import { encodeUint256 } from "./evm-selectors";
import type { CurvePoolConfig, CurveRouteType } from "@shared/lib/curve-pool-configs";

// get_dy(int128,int128,uint256) selector
const GET_DY_SELECTOR = "0x5e0d443f";
// get_dy_underlying(int128,int128,uint256) selector
const GET_DY_UNDERLYING_SELECTOR = "0x07211ef7";

/**
 * Fetch implied prices via Curve get_dy for a batch of pool configurations.
 * Uses fetchEvmCallHexAtBlock which resolves RPC URLs via chain-registry.ts.
 *
 * Block number + timestamp are fetched once per distinct chain and all
 * get_dy calls are pinned to that block, then hop dependencies are resolved
 * in a second pass and the block timestamp is surfaced as upstream observedAt.
 */
export interface CurveOnchainBatch {
  prices: Map<string, number>;
  observedAtByCoinId: Map<string, number>;
  routeTypeByCoinId: Map<string, CurveRouteType>;
  hopDepthByCoinId: Map<string, number>;
}

export async function fetchCurveOnchainPrices(
  configs: CurvePoolConfig[],
  signal?: AbortSignal,
  chainRpcs?: Map<string, ChainRpcConfig>,
): Promise<FetcherOutcome<CurveOnchainBatch>> {
  const emptyBatch: CurveOnchainBatch = {
    prices: new Map<string, number>(),
    observedAtByCoinId: new Map<string, number>(),
    routeTypeByCoinId: new Map<string, CurveRouteType>(),
    hopDepthByCoinId: new Map<string, number>(),
  };

  // Phase 0: resolve block number + timestamp per distinct chain in parallel
  // so calls are pinned to a single block and callers can enforce upstream freshness.
  const chains = Array.from(new Set(configs.map((c) => c.chain)));
  const blockByChain = new Map<string, { blockNumber: number; blockTimestamp: number }>();
  const nowSec = Math.floor(Date.now() / 1000);
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
    if (nowSec - entry.blockTimestamp > CURVE_ORACLE_MAX_STALENESS_SEC) {
      return {
        kind: "upstream-error",
        value: emptyBatch,
        reason: `stale block on ${entry.chain}: ${nowSec - entry.blockTimestamp}s > ${CURVE_ORACLE_MAX_STALENESS_SEC}s`,
      };
    }
    blockByChain.set(entry.chain, { blockNumber: entry.blockNumber, blockTimestamp: entry.blockTimestamp });
  }

  // Phase 1: Execute all RPC calls at the pinned block, store raw implied prices
  const rawPrices = new Map<string, number>();
  let rpcAttempts = 0;
  let rpcThrows = 0;

  for (const config of configs) {
    rpcAttempts++;
    try {
      const inputAmount = BigInt(10) ** BigInt(config.inputDecimals); // 1 unit
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
    });
    if (!resolved) continue;
    prices.set(config.stablecoinId, resolved.price);
    observedAtByCoinId.set(config.stablecoinId, resolved.observedAt);
    routeTypeByCoinId.set(config.stablecoinId, resolved.routeType);
    hopDepthByCoinId.set(config.stablecoinId, resolved.hopDepth);
  }

  const value: CurveOnchainBatch = { prices, observedAtByCoinId, routeTypeByCoinId, hopDepthByCoinId };

  if (rpcAttempts > 0 && rpcThrows === rpcAttempts) {
    return { kind: "upstream-error", value, reason: "all Curve pool RPC calls threw" };
  }
  if (prices.size === 0) {
    return { kind: "no-data", value };
  }
  return { kind: "ok", value };
}

function encodeGetDy(selector: string, i: number, j: number, dx: bigint): string {
  return `${selector}${encodeUint256(i)}${encodeUint256(j)}${encodeUint256(dx)}`;
}

interface CurveResolvedPrice {
  price: number;
  observedAt: number;
  routeType: CurveRouteType;
  hopDepth: number;
}

interface CurveResolutionContext {
  blockByChain: Map<string, { blockNumber: number; blockTimestamp: number }>;
  configById: Map<string, CurvePoolConfig>;
  rawPrices: Map<string, number>;
  resolving: Set<string>;
  resolutionCache: Map<string, CurveResolvedPrice | null>;
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

  if (!config.hop) {
    const resolved = normalizeResolvedCurvePrice(raw, block.blockTimestamp, routeType, 0);
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
  const resolved = normalizeResolvedCurvePrice(finalPrice, observedAt, routeType, hopDepth);
  context.resolutionCache.set(config.stablecoinId, resolved);
  return resolved;
}

function normalizeResolvedCurvePrice(
  price: number,
  observedAt: number,
  routeType: CurveRouteType,
  hopDepth: number,
): CurveResolvedPrice | null {
  if (!Number.isFinite(price) || price <= 0 || price >= 10_000) return null;
  return { price, observedAt, routeType, hopDepth };
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
