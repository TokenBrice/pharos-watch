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

import { fetchEvmBlockNumber, fetchEvmBlockTimestamp, fetchEvmCallHexAtBlock } from "./evm-rpc";
import type { ChainRpcConfig } from "./chain-registry";

export interface CurvePoolConfig {
  stablecoinId: string;
  poolAddress: string;
  inputIndex: number;    // coin index of the reference asset (e.g., USDC=1 in 3pool)
  outputIndex: number;   // coin index of the target stablecoin
  inputDecimals: number;
  outputDecimals: number;
  chain: string;
  /** Use get_dy_underlying selector for metapools (e.g., LUSD/3Crv) */
  useUnderlying?: boolean;
  /** Two-hop pricing: raw price is in intermediate token, multiply by via-token's USD price */
  hop?: { viaStablecoinId: string };
}

// get_dy(int128,int128,uint256) selector
const GET_DY_SELECTOR = "0x5e0d443f";
// get_dy_underlying(int128,int128,uint256) selector
const GET_DY_UNDERLYING_SELECTOR = "0x07211ef7";

/**
 * Fetch implied prices via Curve get_dy for a batch of pool configurations.
 * Uses fetchEvmCallHexAtBlock which resolves RPC URLs via chain-registry.ts.
 *
 * Two-phase processing:
 * Phase 1: Execute all RPC calls, store raw implied prices
 * Phase 2: Resolve hop dependencies, build final results
 */
export async function fetchCurveOnchainPrices(
  configs: CurvePoolConfig[],
  signal?: AbortSignal,
  chainRpcs?: Map<string, ChainRpcConfig>,
): Promise<Map<string, number>> {
  // Validate: no chained hops (hop referencing another hop)
  const hopIds = new Set(configs.filter((c) => c.hop).map((c) => c.stablecoinId));
  for (const config of configs) {
    if (config.hop && hopIds.has(config.hop.viaStablecoinId)) {
      throw new Error(
        `[curve-onchain] Chained hop detected: ${config.stablecoinId} hops via ${config.hop.viaStablecoinId} which is also a hop`,
      );
    }
  }

  // Phase 1: Execute all RPC calls, store raw implied prices
  const rawPrices = new Map<string, number>();

  for (const config of configs) {
    try {
      const inputAmount = BigInt(10) ** BigInt(config.inputDecimals); // 1 unit
      const selector = config.useUnderlying ? GET_DY_UNDERLYING_SELECTOR : GET_DY_SELECTOR;
      const calldata = encodeGetDy(selector, config.inputIndex, config.outputIndex, inputAmount);

      // Metapool get_dy_underlying makes cross-pool calls requiring more gas
      const gas = config.useUnderlying ? "0x7A120" : undefined; // 500K gas
      const resultHex = await fetchEvmCallHexAtBlock(
        config.chain, config.poolAddress, calldata, "latest", { signal, gas, chainRpcs },
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
      console.warn(`[curve-onchain] get_dy failed for ${config.stablecoinId}:`, err);
    }
  }

  // Phase 2: Resolve hop prices, build final results
  const results = new Map<string, number>();

  for (const config of configs) {
    const raw = rawPrices.get(config.stablecoinId);
    if (raw == null) continue;

    if (config.hop) {
      const viaPrice = rawPrices.get(config.hop.viaStablecoinId);
      if (viaPrice == null) continue; // dependency missing
      const finalPrice = raw * viaPrice;
      if (finalPrice > 0 && finalPrice < 10_000) {
        results.set(config.stablecoinId, finalPrice);
      }
    } else {
      results.set(config.stablecoinId, raw);
    }
  }

  return results;
}

function encodeGetDy(selector: string, i: number, j: number, dx: bigint): string {
  const iHex = BigInt(i).toString(16).padStart(64, "0");
  const jHex = BigInt(j).toString(16).padStart(64, "0");
  const dxHex = dx.toString(16).padStart(64, "0");
  return `${selector}${iHex}${jHex}${dxHex}`;
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
  const [callHex, blockTimestamp] = await Promise.all([
    fetchEvmCallHexAtBlock(chainId, aggregator, selector, blockNumber, { chainRpcs, signal }),
    fetchEvmBlockTimestamp(chainId, blockNumber, { chainRpcs, signal }),
  ]);
  if (!callHex || blockTimestamp == null) return null;
  const word = callHex.startsWith("0x") ? callHex.slice(0, 66) : "0x" + callHex.slice(0, 64);
  const price = Number(BigInt(word)) / 1e18;
  if (!Number.isFinite(price) || price <= 0 || price >= 10) return null;
  return { price, blockNumber, blockTimestamp };
}
