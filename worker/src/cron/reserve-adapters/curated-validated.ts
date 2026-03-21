import type { LiveReservesConfig, StablecoinMeta } from "@shared/types";
import type { AdapterContext, AdapterResult } from "./index";
import { probeOnchainTotalSupply } from "./helpers";

/**
 * Adapter that validates on-chain supply is non-zero, then returns the
 * coin's curated `reserves` array as live slices.  This gives multi-component
 * reserve visibility for coins that lack a dedicated transparency API but
 * have well-researched curated reserve breakdowns.
 */
export async function fetchCuratedValidatedReserves(
  coin: StablecoinMeta,
  config: LiveReservesConfig,
  signal: AbortSignal,
  ctx?: AdapterContext,
): Promise<AdapterResult> {
  if (!coin.reserves || coin.reserves.length === 0) {
    throw new Error("curated-validated adapter requires coin.reserves to be defined and non-empty");
  }

  const params = (config.params ?? {}) as { rpcUrl?: string; fallbackRpcUrl?: string };
  const totalSupply = await probeOnchainTotalSupply(
    coin, config.inputs.primary, signal, "curated-validated", ctx, params.rpcUrl, params.fallbackRpcUrl,
  );

  return {
    slices: coin.reserves,
    metadata: {
      totalSupplyRaw: totalSupply.toString(),
    },
  };
}
