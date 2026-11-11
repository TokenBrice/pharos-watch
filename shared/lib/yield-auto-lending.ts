/**
 * Deterministic auto-discovery overrides for non-yield-bearing coins.
 * Maps Pharos stablecoin ID to a DeFiLlama lending pool UUID.
 *
 * This registry is runtime-neutral because both the Worker yield producer and
 * the static-export route policy need the same durable coverage inventory.
 */
export const AUTO_LENDING_OVERRIDES = {
  "u-united-stables": { poolId: "d8e9bb79-79d3-4897-8a4f-8d489040097d", bypassSafety: true },
  "eurcv-societe-generale-forge": { poolId: "d3b28212-a46b-4db8-8bb7-2c946b3cbe76", bypassSafety: false },
  "usdx-hex-trust": { poolId: "be50b874-8147-440d-b8ca-f2c202e9ed64", bypassSafety: true },
  "usdo-openeden": { poolId: "f083596e-032d-4d6b-a7a8-1836d3f99bcd", bypassSafety: true },
  "usdm-moneta": { poolId: "ce3021c9-af52-46b0-a61a-3e92acdfd79b", bypassSafety: true },
} as const satisfies Readonly<Record<string, { poolId: string; bypassSafety: boolean }>>;

export const AUTO_LENDING_POOL_MAP = Object.fromEntries(
  Object.entries(AUTO_LENDING_OVERRIDES).map(([id, override]) => [id, override.poolId]),
) as {
  [Id in keyof typeof AUTO_LENDING_OVERRIDES]: (typeof AUTO_LENDING_OVERRIDES)[Id]["poolId"];
};

export interface StaticYieldWorkbenchCoin {
  id: string;
  status?: StablecoinStatus;
  flags: {
    yieldBearing?: boolean;
  };
}

export function hasStaticYieldWorkbench(coin: StaticYieldWorkbenchCoin): boolean {
  return isActiveStablecoinMeta(coin) && (
    coin.flags.yieldBearing === true
    || Object.prototype.hasOwnProperty.call(AUTO_LENDING_POOL_MAP, coin.id)
  );
}
import { isActiveStablecoinMeta } from "./stablecoins/status";
import type { StablecoinStatus } from "../types/stablecoin-taxonomy";
