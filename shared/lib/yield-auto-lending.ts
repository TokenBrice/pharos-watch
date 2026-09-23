/**
 * Deterministic auto-discovery overrides for non-yield-bearing coins.
 * Maps Pharos stablecoin ID to a DeFiLlama lending pool UUID.
 *
 * This registry is runtime-neutral because both the Worker yield producer and
 * the static-export route policy need the same durable coverage inventory.
 */
export const AUTO_LENDING_POOL_MAP = {
  "u-united-stables": "d8e9bb79-79d3-4897-8a4f-8d489040097d",
  "eurcv-societe-generale-forge": "d3b28212-a46b-4db8-8bb7-2c946b3cbe76",
  "usdx-hex-trust": "be50b874-8147-440d-b8ca-f2c202e9ed64",
  "usdo-openeden": "f083596e-032d-4d6b-a7a8-1836d3f99bcd",
  "usdm-moneta": "ce3021c9-af52-46b0-a61a-3e92acdfd79b",
} as const satisfies Readonly<Record<string, string>>;

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
import type { StablecoinStatus } from "../types";
