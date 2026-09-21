import type { StablecoinMeta } from "../types";
import {
  ACTIVE_STABLECOINS,
  TRACKED_META_BY_ID,
  TRACKED_STABLECOINS,
} from "./stablecoins/registry";
import { isActiveStablecoinMeta, isPreLaunchStablecoinMeta } from "./stablecoins/status";
import {
  resolveTrackedContractConfigCore,
  type ResolveTrackedContractConfigOptions,
} from "./stablecoins/tracked-contract-selection";

export const YIELD_BEARING_STABLECOINS = TRACKED_STABLECOINS.filter(
  (stablecoin) =>
    stablecoin.flags.yieldBearing
    && (isActiveStablecoinMeta(stablecoin) || isPreLaunchStablecoinMeta(stablecoin)),
);

export const ACTIVE_YIELD_BEARING_STABLECOINS = ACTIVE_STABLECOINS.filter(
  (stablecoin) => stablecoin.flags.yieldBearing,
);

export interface ResolvedTrackedContractConfig {
  stablecoin: StablecoinMeta;
  contractAddress: string;
  decimals: number;
}

export function resolveTrackedContractConfig(
  stablecoinId: string,
  chainId: string,
  options?: ResolveTrackedContractConfigOptions,
): ResolvedTrackedContractConfig | null {
  const stablecoin = TRACKED_META_BY_ID.get(stablecoinId);
  if (!stablecoin) return null;

  const resolved = resolveTrackedContractConfigCore(stablecoin, chainId, options);
  return resolved ? { stablecoin, ...resolved } : null;
}
