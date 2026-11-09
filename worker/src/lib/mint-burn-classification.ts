import { getMintBurnConfigsForStablecoin, type MintBurnContractConfig } from "./mint-burn-contracts";
import { requiresReviewedSupplyBurnProof } from "./mint-burn-conservation";

/**
 * Producers that could leave a standard flow unresolved before hourly buckets recorded it
 * (pre-v6.38). Later hours carry explicit counts, so newer producers need no entry here.
 */
function mintBurnConfigHasClassificationReview(config: MintBurnContractConfig): boolean {
  return requiresReviewedSupplyBurnProof(config) || config.bridgeDetection?.protocol === "ccip" || config.bridgeDetection?.protocol === "cctp";
}

export function hasMintBurnClassificationReview(stablecoinId: string): boolean {
  return getMintBurnConfigsForStablecoin(stablecoinId).some(mintBurnConfigHasClassificationReview);
}
