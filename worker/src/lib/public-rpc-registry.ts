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
  sonic: "https://rpc.soniclabs.com",
  celo: "https://forno.celo.org",
  tron: "https://api.trongrid.io",
  blast: "https://rpc.blast.io",
  manta: "https://pacific-rpc.manta.network/http",
  // Plasma Finance L2 — only public RPC; required for syzusd-yuzu ERC-4626 NAV fetch
  plasma: "https://rpc.plasma.to",
  // Required for usdnr-nerona's m0-wrapper-underlying additional-deployment aggregation
  fluent: "https://rpc.fluent.xyz",
  // Required for reviewed CHFAU native supply aggregation.
  tempo: "https://rpc.tempo.xyz",
  movement: "https://mainnet.movementnetwork.xyz/v1",
  // Required for usd1-bundle-oracle multichain totalSupply() supply aggregation.
  plume: "https://rpc.plume.org",
  monad: "https://rpc.monad.xyz",
  mantle: "https://rpc.mantle.xyz",
  "morph-l2": "https://rpc.morphl2.io",
  abcore: "https://rpc.core.ab.org",
  xlayer: "https://rpc.xlayer.tech",
  // Hedera's public read surface is the mirror node REST API (contracts/call
  // for EVM-equivalent view calls, blocks, tokens) — not a JSON-RPC endpoint.
  // Consumed by the hliquity-hedera reserve adapter family.
  hedera: "https://mainnet-public.mirrornode.hedera.com/api/v1",
  // Cardano's public query surface is the Koios REST API (tip, address_info,
  // asset_info) — not a JSON-RPC endpoint. Consumed by the djed-cardano
  // reserve adapter through the koios.ts bounded reader.
  cardano: "https://api.koios.rest/api/v1",
  // Tezos's public query surface is the TzKT indexer REST API (head, contract
  // storage, bigmap keys at a pinned level) — not a JSON-RPC endpoint.
  // Consumed by the youves-tezos reserve adapter through the tzkt.ts bounded
  // reader.
  tezos: "https://api.tzkt.io",
};

const EXTRA_FALLBACK_RPC_URLS: Record<string, string[]> = {
  ethereum: ["https://eth.llamarpc.com"],
  base: ["https://base-rpc.publicnode.com"],
  optimism: ["https://optimism-rpc.publicnode.com"],
  blast: ["https://blast.blockpi.network/v1/rpc/public"],
  manta: ["https://manta-pacific.drpc.org"],
  sonic: ["https://sonic-rpc.publicnode.com"],
  // dRPC as an independent second operator behind publicnode; polygon-rpc.com
  // is deliberately absent (it served zero-valued eth_call results 2026-07-09).
  polygon: ["https://polygon.drpc.org"],
};

export function getPublicRpcUrl(chainId: string): string | undefined {
  return PUBLIC_RPC_URLS[chainId];
}

export function getPublicFallbackRpcUrls(chainId: string): string[] {
  const primary = getPublicRpcUrl(chainId);
  return [...(primary ? [primary] : []), ...(EXTRA_FALLBACK_RPC_URLS[chainId] ?? [])];
}

export function getSecondaryFallbackRpcUrl(chainId: string): string | undefined {
  return EXTRA_FALLBACK_RPC_URLS[chainId]?.[0];
}
