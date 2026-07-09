const PUBLIC_RPC_URLS: Record<string, string> = {
  ethereum: "https://ethereum-rpc.publicnode.com",
  arbitrum: "https://arb1.arbitrum.io/rpc",
  base: "https://mainnet.base.org",
  optimism: "https://mainnet.optimism.io",
  // polygon-rpc.com was verified returning well-formed but zero-valued
  // eth_call results on 2026-07-09 (silent bad data, worse than an error);
  // publicnode returned correct values in the same probes.
  polygon: "https://polygon-bor-rpc.publicnode.com",
  avalanche: "https://api.avax.network/ext/bc/C/rpc",
  bsc: "https://bsc-dataseed.binance.org",
  gnosis: "https://rpc.gnosischain.com",
  fantom: "https://rpc.ftm.tools",
  celo: "https://forno.celo.org",
  tron: "https://api.trongrid.io",
  blast: "https://rpc.blast.io",
  manta: "https://pacific-rpc.manta.network/http",
  // Plasma Finance L2 — only public RPC; required for syzusd-yuzu ERC-4626 NAV fetch
  plasma: "https://rpc.plasma.to",
  // Required for usdnr-nerona's m0-wrapper-underlying additional-deployment aggregation
  fluent: "https://rpc.fluent.xyz",
};

const EXTRA_FALLBACK_RPC_URLS: Record<string, string[]> = {
  ethereum: ["https://eth.llamarpc.com"],
  blast: ["https://blast.blockpi.network/v1/rpc/public"],
  manta: ["https://manta-pacific.drpc.org"],
  // dRPC as an independent second operator behind publicnode; polygon-rpc.com
  // is deliberately absent (it served zero-valued eth_call results 2026-07-09).
  polygon: ["https://polygon.drpc.org"],
};

export function getPublicRpcUrl(chainId: string): string | undefined {
  return PUBLIC_RPC_URLS[chainId];
}

export function getPublicFallbackRpcUrls(chainId: string): string[] {
  const primary = getPublicRpcUrl(chainId);
  return primary ? [primary] : [];
}

export function getSecondaryFallbackRpcUrl(chainId: string): string | undefined {
  return EXTRA_FALLBACK_RPC_URLS[chainId]?.[0];
}
