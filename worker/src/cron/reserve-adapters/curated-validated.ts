import type { StablecoinMeta } from "@shared/types/core";
import type { LiveReservesConfig } from "@shared/types/live-reserves";
import { parseLiveReserveAdapterParams } from "@shared/lib/live-reserve-adapters";
import type { AdapterContext, AdapterResult } from "./types";
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

  const params = parseLiveReserveAdapterParams("curated-validated", config.params);
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
