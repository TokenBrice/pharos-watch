// Research-only resolution. Never widens runtime archive/log capabilities or provider priority.
// Endpoint registration is a read surface, not proof of historical retention or parity.
export async function resolvePinnedProvider(chain, provider) {
  const canonicalChain = chain === "kaia" ? "klaytn" : chain;
  const { DWELLIR_CHAINS, dwellirRpcUrl } = await import("../../shared/lib/dwellir-chains.ts");
  const { DWELLIR_NATIVE_ENDPOINTS } = await import("../../shared/lib/dwellir-native-endpoints.ts");
  const { CHAIN_META } = await import("../../shared/types/chain-identity.ts");
  const meta = CHAIN_META[canonicalChain];
  if (provider === "dwellir") {
    const evm = DWELLIR_CHAINS.find((entry) => entry.chainId === canonicalChain);
    if (evm) return { endpoint: dwellirRpcUrl(evm), protocol: "evm", credential: "DWELLIR_API_KEY", maxLogBlockSpan: evm.maxLogBlockSpan };
    const native = DWELLIR_NATIVE_ENDPOINTS.find((entry) => entry.network === canonicalChain);
    if (native) return { endpoint: native.baseUrl, protocol: native.protocol, credential: "DWELLIR_API_KEY" };
    // https://www.dwellir.com/networks/sui — checkpoint/execution only,
    // not a promise of arbitrary historical object-state retention.
    if (canonicalChain === "sui") return { endpoint: "https://api-sui-mainnet-full.n.dwellir.com", protocol: "sui-jsonrpc", credential: "DWELLIR_API_KEY" };
    return null;
  }
  if (provider === "public") {
    // https://docs.sui.io/develop/accessing-data/graphql/query-with-graphql
    if (canonicalChain === "sui") return { endpoint: "https://graphql.mainnet.sui.io/graphql", protocol: "sui-graphql" };
    // https://docs.usecorn.com/docs/developers/Network/Run_a_Node — Maizenet 21000000.
    if (canonicalChain === "corn") return { endpoint: "https://maizenet-rpc.usecorn.com", protocol: "evm" };
    // https://docs.abs.xyz/connect-to-abstract — mainnet 2741.
    if (canonicalChain === "abstract") return { endpoint: "https://api.mainnet.abs.xyz", protocol: "evm" };
    // https://doc.aurora.dev/dev-reference/network-endpoints/ — mainnet 1313161554.
    if (canonicalChain === "aurora") return { endpoint: "https://mainnet.aurora.dev", protocol: "evm" };
    // https://docs.citrea.xyz/developer-documentation/chain-information — mainnet 4114.
    if (canonicalChain === "citrea") return { endpoint: "https://rpc.mainnet.citrea.xyz", protocol: "evm" };
    // https://docs.soneium.org/docs/builders/overview — mainnet 1868.
    if (canonicalChain === "soneium") return { endpoint: "https://rpc.soneium.org", protocol: "evm" };
    // https://mezo.org/docs/users/getting-started/connect — mainnet 31612.
    if (canonicalChain === "mezo") return { endpoint: "https://mezo-mainnet.boar.network", protocol: "evm" };
    // https://docs.redbelly.network/pages/eligibility-sdk/backend/ — mainnet 151.
    if (canonicalChain === "redbelly") return { endpoint: "https://governors.mainnet.redbelly.network", protocol: "evm" };
    // https://dev.flare.network/network/overview — mainnet 14.
    if (canonicalChain === "flare") return { endpoint: "https://flare-api.flare.network/ext/C/rpc", protocol: "evm" };
    // https://docs.exsat.network/user-guides/wallet-setup — mainnet 7200.
    if (canonicalChain === "exsat") return { endpoint: "https://evm.exsat.network", protocol: "evm" };
    // https://docs.lisk.com/guides/connecting-to-a-wallet/ — mainnet 1135.
    if (canonicalChain === "lisk") return { endpoint: "https://rpc.api.lisk.com", protocol: "evm" };
    // https://docs.assetchain.org/general-info/network-details — mainnet 42420.
    if (canonicalChain === "assetchain") return { endpoint: "https://mainnet-rpc.assetchain.org", protocol: "evm" };
    const { PUBLIC_RPC_URLS, SUPPLY_RPC_DEFAULTS } = await import("../../shared/lib/chain-rpc-registry.ts");
    const endpoint = PUBLIC_RPC_URLS[canonicalChain] ?? SUPPLY_RPC_DEFAULTS[canonicalChain]?.rpcUrl;
    if (endpoint && meta?.type === "evm") return { endpoint, protocol: "evm" };
    if (endpoint && ["aptos", "movement"].includes(canonicalChain)) return { endpoint, protocol: "aptos-rest" };
    if (endpoint && canonicalChain === "hedera") return { endpoint, protocol: "hedera-rest" };
    return null;
  }
  if (provider === "alchemy") {
    // Account Archive documents solana-mainnet; the shared runtime annotation
    // uses sol-mainnet and must not override this research-specific surface.
    // https://www.alchemy.com/docs/solana/account-archive
    if (canonicalChain === "solana") return { endpoint: "https://solana-mainnet.g.alchemy.com/v2/", protocol: "solana-jsonrpc", credential: "ALCHEMY_API_KEY" };
    // Reuse EVM chain identity provider slugs; BSC's established runtime
    // endpoint has no identity-provider annotation yet.
    // Additional slugs: https://www.alchemy.com/docs/reference/node-supported-chains
    // Fraxtal: https://www.alchemy.com/docs/reference/frax-api-quickstart
    const slug = meta?.providers?.alchemy ?? ({
      bsc: "bnb-mainnet", fraxtal: "frax-mainnet",
      rootstock: "rootstock-mainnet", arc: "arc-mainnet", tempo: "tempo-mainnet",
    })[canonicalChain];
    if (!slug || meta?.type !== "evm") return null;
    return { endpoint: `https://${slug}.g.alchemy.com/v2/`, protocol: "evm", credential: "ALCHEMY_API_KEY" };
  }
  if (provider === "drpc") {
    // https://drpc.org/docs/solana-api/blocksinfo/getBlock and header auth:
    // https://drpc.org/docs/gettingstarted/firstrequest
    if (canonicalChain === "solana") return { endpoint: "https://lb.drpc.live/solana", protocol: "solana-jsonrpc", credential: "DRPC_API_KEY" };
    // https://drpc.org/chainlist documents these exact direct public hosts,
    // not the paid network= aliases. Do not invent paid-route slugs or send
    // credentials to the public endpoints.
    const directHost = ({
      fraxtal: "fraxtal", klaytn: "klaytn", hemi: "hemi", plume: "plume",
      filecoin: "filecoin", rootstock: "rootstock", etherlink: "etherlink",
      arc: "arc", tempo: "tempo-mainnet",
    })[canonicalChain];
    if (directHost && meta?.type === "evm") return { endpoint: `https://${directHost}.drpc.org`, protocol: "evm" };
    const { DRPC_NETWORK } = await import("../../shared/lib/drpc.ts");
    const network = DRPC_NETWORK[canonicalChain];
    if (!network || meta?.type !== "evm") return null;
    return { endpoint: `https://lb.drpc.org/ogrpc?network=${network}`, protocol: "evm", credential: "DRPC_API_KEY" };
  }
  return null;
}
