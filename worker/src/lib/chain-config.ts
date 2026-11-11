import { CHAIN_META, type ChainMeta } from "@shared/types/chain-identity";

export interface ChainConfig extends Pick<ChainMeta, "evmChainId" | "explorerUrl" | "type"> {
  chainId: string;
  chainName: string;
}

export function requireChainConfig(chainId: string): ChainConfig {
  const meta = CHAIN_META[chainId];
  if (!meta) throw new Error(`Unknown chain: ${chainId}`);
  return {
    chainId,
    chainName: meta.name,
    evmChainId: meta.evmChainId,
    explorerUrl: meta.explorerUrl,
    type: meta.type,
  };
}
