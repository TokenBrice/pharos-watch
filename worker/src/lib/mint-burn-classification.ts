import { getMintBurnConfigsForStablecoin, type MintBurnContractConfig } from "./mint-burn-contracts";
import { requiresReviewedSupplyBurnProof } from "./mint-burn-conservation";

/** Current producers whose failed classification evidence can leave a standard flow unresolved. */
function mintBurnConfigHasClassificationReview(config: MintBurnContractConfig): boolean {
  return requiresReviewedSupplyBurnProof(config) || config.bridgeDetection?.protocol === "ccip" || config.bridgeDetection?.protocol === "cctp";
}

export function hasMintBurnClassificationReview(stablecoinId: string): boolean {
  return getMintBurnConfigsForStablecoin(stablecoinId).some(mintBurnConfigHasClassificationReview);
}
