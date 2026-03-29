const PUBLIC_RPC_URLS: Record<string, string> = {
  ethereum: "https://ethereum-rpc.publicnode.com",
  arbitrum: "https://arb1.arbitrum.io/rpc",
  base: "https://mainnet.base.org",
  optimism: "https://mainnet.optimism.io",
  polygon: "https://polygon-rpc.com",
  avalanche: "https://api.avax.network/ext/bc/C/rpc",
  bsc: "https://bsc-dataseed.binance.org",
  gnosis: "https://rpc.gnosischain.com",
  fantom: "https://rpc.ftm.tools",
  celo: "https://forno.celo.org",
  tron: "https://api.trongrid.io",
};

const EXTRA_FALLBACK_RPC_URLS: Record<string, string[]> = {
  ethereum: ["https://eth.llamarpc.com"],
};

export function getPublicRpcUrl(chainId: string): string | undefined {
  return PUBLIC_RPC_URLS[chainId];
}

export function getArchiveFallbackRpcUrls(chainId: string): string[] {
  const primary = getPublicRpcUrl(chainId);
  return primary ? [primary] : [];
}

export function getSecondaryFallbackRpcUrl(chainId: string): string | undefined {
  return EXTRA_FALLBACK_RPC_URLS[chainId]?.[0];
}
