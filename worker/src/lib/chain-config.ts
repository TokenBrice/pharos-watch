import { CHAIN_META } from "@shared/lib/chains";

export interface ChainConfig {
  chainId: string;          // Internal identifier (e.g. "ethereum")
  chainName: string;
  evmChainId: number | null; // Numeric EVM chain ID for Etherscan v2 API (null for non-EVM)
  explorerUrl: string;       // Block explorer for tx/address links
  type: "evm" | "tron" | "other";
}

// --- Chain configurations (derived from shared CHAIN_META) ---

export function chainConfig(chainId: string): ChainConfig {
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
