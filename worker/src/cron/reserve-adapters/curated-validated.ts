import type { StablecoinMeta } from "@shared/types/core";
import type { LiveReservesConfig, LiveReserveRedemptionRouteStatus } from "@shared/types/live-reserves";
import { parseLiveReserveAdapterParams } from "@shared/lib/live-reserve-adapters";
import { REDEMPTION_BACKSTOP_CONFIGS } from "@shared/lib/redemption-backstop-configs";
import type { AdapterContext, AdapterResult } from "./types";
import { probeTrackedTokenSupply } from "./helpers";

/**
 * Resolve the route-status signal for a curated-validated reserve entry by
 * consulting the coin's redemption-backstop config. Backstop configs express
 * the current rail availability (open/unknown) via `routeStatus`; anything
 * else falls back to "unknown" because this adapter has no live proof.
 */
function resolveCuratedRouteStatus(coin: StablecoinMeta): LiveReserveRedemptionRouteStatus {
  const backstop = REDEMPTION_BACKSTOP_CONFIGS[coin.id];
  return backstop?.routeStatus ?? "unknown";
}

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
  const totalSupply = await probeTrackedTokenSupply(
    coin, config.inputs.primary, signal, "curated-validated", ctx, params.rpcUrl, params.fallbackRpcUrl,
  );
  const routeStatus = resolveCuratedRouteStatus(coin);

  return {
    slices: coin.reserves,
    metadata: {
      totalSupplyRaw: totalSupply.toString(),
      redemption: {
        capacityKind: "documented-eventual" as const,
        freshnessKind: "same-run-onchain" as const,
        routeStatus,
        routeStatusSource: "static-config" as const,
      },
    },
  };
}
