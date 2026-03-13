import type { ContractDeployment, StablecoinMeta } from "../types";
import {
  TRACKED_META_BY_ID,
  TRACKED_STABLECOINS,
} from "./stablecoins";

export const YIELD_BEARING_STABLECOINS = TRACKED_STABLECOINS.filter(
  (stablecoin) => stablecoin.flags.yieldBearing,
);

export function getTrackedStablecoin(
  stablecoinId: string,
): StablecoinMeta | undefined {
  return TRACKED_META_BY_ID.get(stablecoinId);
}

interface FindTrackedContractOptions {
  source?: "primary" | "traded" | "any";
}

export function findTrackedContract(
  stablecoinOrId: StablecoinMeta | string,
  chainId: string,
  options?: FindTrackedContractOptions,
): ContractDeployment | undefined {
  const stablecoin =
    typeof stablecoinOrId === "string"
      ? TRACKED_META_BY_ID.get(stablecoinOrId)
      : stablecoinOrId;
  if (!stablecoin) return undefined;

  const source = options?.source ?? "primary";
  if (source !== "traded") {
    const contract = stablecoin.contracts?.find(
      (deployment) => deployment.chain === chainId,
    );
    if (contract) return contract;
  }

  if (source === "primary") return undefined;
  return stablecoin.tradedContracts?.find(
    (deployment) => deployment.chain === chainId,
  );
}
