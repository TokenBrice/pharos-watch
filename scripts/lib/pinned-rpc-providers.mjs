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
    if (evm) return { endpoint: dwellirRpcUrl(evm), protocol: "evm", credential: "DWELLIR_API_KEY" };
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
    const { PUBLIC_RPC_URLS, SUPPLY_RPC_DEFAULTS } = await import("../../shared/lib/chain-rpc-registry.ts");
    const endpoint = PUBLIC_RPC_URLS[canonicalChain] ?? SUPPLY_RPC_DEFAULTS[canonicalChain]?.rpcUrl;
    if (endpoint && meta?.type === "evm") return { endpoint, protocol: "evm" };
    if (endpoint && ["aptos", "movement"].includes(canonicalChain)) return { endpoint, protocol: "aptos-rest" };
    if (endpoint && canonicalChain === "hedera") return { endpoint, protocol: "hedera-rest" };
    return null;
  }
  if (provider === "alchemy") {
    // Reuse the chain identity's provider slug; BSC and Solana are established
    // runtime endpoints but BSC has no identity-provider annotation yet.
    // Additional slugs: https://www.alchemy.com/docs/reference/node-supported-chains
    // Fraxtal: https://www.alchemy.com/docs/reference/frax-api-quickstart
    const slug = meta?.providers?.alchemy ?? ({
      bsc: "bnb-mainnet", solana: "solana-mainnet", fraxtal: "frax-mainnet",
      rootstock: "rootstock-mainnet", arc: "arc-mainnet", tempo: "tempo-mainnet",
    })[canonicalChain];
    if (!slug || (meta?.type !== "evm" && canonicalChain !== "solana")) return null;
    return { endpoint: `https://${slug}.g.alchemy.com/v2/`, protocol: canonicalChain === "solana" ? "solana-jsonrpc" : "evm", credential: "ALCHEMY_API_KEY" };
  }
  if (provider === "drpc") {
    // https://drpc.org/chainlist documents these exact direct public hosts,
    // not the paid network= aliases. Do not invent paid-route slugs or send
    // credentials to the public endpoints.
    const directHost = ({
      fraxtal: "fraxtal", klaytn: "klaytn", hemi: "hemi", plume: "plume",
      filecoin: "filecoin", rootstock: "rootstock", etherlink: "etherlink",
      arc: "arc", tempo: "tempo-mainnet",
    })[canonicalChain];
    if (directHost && meta?.type === "evm") return { endpoint: `https://${directHost}.drpc.org`, protocol: "evm" };
    const { DRPC_NETWORK } = await import("../../worker/src/lib/drpc.ts");
    const network = DRPC_NETWORK[canonicalChain] ?? (canonicalChain === "solana" ? "solana" : undefined);
    if (!network || (meta?.type !== "evm" && canonicalChain !== "solana")) return null;
    return { endpoint: `https://lb.drpc.org/ogrpc?network=${network}`, protocol: canonicalChain === "solana" ? "solana-jsonrpc" : "evm", credential: "DRPC_API_KEY" };
  }
  return null;
}
