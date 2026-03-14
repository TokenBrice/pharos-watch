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

import { fetchEvmCallHexAtBlock } from "./evm-rpc";

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
        config.chain, config.poolAddress, calldata, "latest", { signal, gas },
      );
      if (!resultHex) continue;

      const outputRaw = BigInt(resultHex);
      const outputFloat = Number(outputRaw) / Math.pow(10, config.outputDecimals);
      const inputFloat = Number(inputAmount) / Math.pow(10, config.inputDecimals);
      const impliedPrice = inputFloat / outputFloat;

      if (impliedPrice > 0 && impliedPrice < 100) {
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
      if (finalPrice > 0 && finalPrice < 100) {
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
