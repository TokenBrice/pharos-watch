import type { MintBurnContractConfig } from "./mint-burn-contracts-types";

export function mintBurnConfigKey(config: MintBurnContractConfig): string {
  return `${config.chain.chainId}-${config.contractAddress}`;
}
