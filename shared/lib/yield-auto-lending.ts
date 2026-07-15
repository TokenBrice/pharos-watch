/**
 * Deterministic auto-discovery overrides for non-yield-bearing coins.
 * Maps Pharos stablecoin ID to a DeFiLlama lending pool UUID.
 *
 * This registry is runtime-neutral because both the Worker yield producer and
 * the static-export route policy need the same durable coverage inventory.
 */
export const AUTO_LENDING_POOL_MAP = {
  "u-united-stables": "d8e9bb79-79d3-4897-8a4f-8d489040097d",
  "usdh-native-markets": "1c9fb97d-f432-44fb-89a0-8120b4cae95c",
  "eurcv-societe-generale-forge": "d3b28212-a46b-4db8-8bb7-2c946b3cbe76",
  "eusd-electronic-usd": "44a4e84a-4ad1-4783-ac83-3d7e432220ea",
  "usdx-hex-trust": "be50b874-8147-440d-b8ca-f2c202e9ed64",
  "usdo-openeden": "f083596e-032d-4d6b-a7a8-1836d3f99bcd",
  "usdm-moneta": "ce3021c9-af52-46b0-a61a-3e92acdfd79b",
  "feusd-felix": "2bae7cf8-d278-4b27-9959-7f5f92c6f14b",
  "dllr-sovryn": "436e4129-667b-44d6-8322-ea59ce9b587c",
  "tgbp-tokenised": "61a6a976-f70f-4f38-b4a4-a5d3fda6832c",
  "reusd-resupply": "02c7722b-dfd6-415b-8292-01dddb88c6fc",
  "xusd-babelfish": "59901fb6-d071-4923-822a-af871670a7fb",
  "usda-anzens": "fa66f3f5-24ba-4929-8549-9b811b68ef48",
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
