import { CHAIN_META } from "@shared/types/chain-identity";
import { DWELLIR_CHAINS, dwellirRpcUrl, type DwellirChainEntry } from "@shared/lib/dwellir-chains";
import {
  getPublicRpcUrl,
  getSecondaryFallbackRpcUrl,
} from "./public-rpc-registry";
export {
  CG_CHAIN_MAP,
  DS_CHAIN_MAP,
  GT_CHAIN_MAP,
  GT_ONLY_CHAIN_MAP,
} from "@shared/lib/chains";

/**
 * Unified chain registry — single source of truth for chain name mappings
 * and RPC endpoint resolution.
 */

export type RpcOperator = "alchemy" | "dwellir" | "drpc" | "public";
export type RpcEndpointPosition = "registry" | "supplemental";
/** "archive": any historical block. "recent": latest/safe/finalized tags and near-head only. */
export type RpcStateHistory = DwellirChainEntry["stateHistory"];
export type RpcLogsHistory = DwellirChainEntry["logsHistory"];

export interface RpcEndpoint {
  /** Never contains a key; keys travel as request headers only. */
  readonly url: string;
  readonly operator: RpcOperator;
  readonly keyed: boolean;
  readonly position: RpcEndpointPosition;
  readonly stateHistory: RpcStateHistory;
  readonly logsHistory: RpcLogsHistory;
  /** Maximum inclusive eth_getLogs block span; absence preserves caller defaults. */
  readonly maxLogBlockSpan?: number;
  /** Send JSON-RPC calls as sequential single objects, never batch arrays. */
  readonly noBatch?: boolean;
  /** ISO date of the capability probe (Dwellir entries). */
  readonly verifiedAt?: string;
}

export interface ChainRpcConfig {
  chainId: string;
  chainName: string;
  type: "evm" | "tron" | "other";
  /** Ordered: every "registry" endpoint first (today's rpcUrl then fallbackRpcUrl), then "supplemental". */
  endpoints: readonly RpcEndpoint[];
  explorerUrl: string;
}

export interface BuildChainRpcsOptions {
  dwellirApiKey?: string | null;
}

/** Alchemy chain slugs for their JSON-RPC endpoints */
export const ALCHEMY_CHAINS: Record<string, string> = {
  ethereum: "eth-mainnet",
  arbitrum: "arb-mainnet",
  base: "base-mainnet",
  optimism: "opt-mainnet",
  polygon: "polygon-mainnet",
  avalanche: "avax-mainnet",
  bsc: "bnb-mainnet",
};

/** Numbered supply/decimals probes verified 2026-10-05; state reads only. */
const CENSUS_STATE_ALCHEMY_CHAINS: Record<string, string> = {
  hyperevm: "hyperliquid-mainnet",
  linea: "linea-mainnet",
  scroll: "scroll-mainnet",
  zksync: "zksync-mainnet",
  abstract: "abstract-mainnet",
  unichain: "unichain-mainnet",
  worldchain: "worldchain-mainnet",
  megaeth: "megaeth-mainnet",
  stable: "stable-mainnet",
};

/** Keyless, numbered-state supply readers; deliberately outside log inventories. */
const CENSUS_STATE_PUBLIC_RPCS: Record<string, readonly Pick<RpcEndpoint, "url" | "maxLogBlockSpan" | "noBatch">[]> = {
  pharos: [
    { url: "https://rpc.pharos.xyz", maxLogBlockSpan: 1000, noBatch: true },
    { url: "https://api.zan.top/public/pharos-mainnet", maxLogBlockSpan: 1000, noBatch: true },
  ],
};

/** Finalized, hash-pinned state and historical CCIP logs verified 2026-10-05. */
const CCIP_ARCHIVE_ALCHEMY_CHAINS: Readonly<Record<string, string>> = {
  monad: "monad-mainnet",
  ink: "ink-mainnet",
  berachain: "berachain-mainnet",
};
/** Eligibility is not entitlement proof for susdat's historical EIP-1898 pin.
 * Provision and verify a canonical-hash archive before adding another route;
 * latest or numbered-state fallbacks cannot satisfy this prerequisite. */
export const CCIP_MONAD_CANONICAL_HASH_ARCHIVE_REQUIRED_REASON = "monad-canonical-hash-archive-required" as const;

/** Existing supply-profile RPC; 10,000-block historical ramp logs and canonical
 * hash-pinned pool code verified 2026-10-06. No new credential is required. */
const CCIP_ARCHIVE_PUBLIC_ENDPOINTS: Readonly<Record<string, readonly RpcEndpoint[]>> = {
  berachain: [{
    url: "https://rpc.berachain.com", operator: "public", keyed: false, position: "registry",
    stateHistory: "archive", logsHistory: "full", maxLogBlockSpan: 10_000, verifiedAt: "2026-10-06",
  }],
};

export type RpcAuthProvider = "alchemy" | "dwellir";

// Keep auth separate from the URL so request/log metadata never contains the API key.
const RPC_AUTH_BY_ORIGIN = new Map<
  string,
  { provider: RpcAuthProvider; headers: Readonly<Record<string, string>> }
>();

/**
 * Registers auth headers for the url's origin. Re-registering the same provider
 * replaces the headers (key rotation / tests); a different provider claiming an
 * already-registered origin throws instead of silently rerouting credentials.
 */
export function registerRpcAuth(
  provider: RpcAuthProvider,
  url: string,
  headers: Readonly<Record<string, string>>,
): void {
  const origin = new URL(url).origin;
  const existing = RPC_AUTH_BY_ORIGIN.get(origin);
  if (existing && existing.provider !== provider) {
    throw new Error(`RPC auth origin ${origin} is already registered for provider ${existing.provider}`);
  }
  RPC_AUTH_BY_ORIGIN.set(origin, { provider, headers: { ...headers } });
}

export function getRpcAuth(
  url: string,
): { provider: RpcAuthProvider; headers: Readonly<Record<string, string>> } | undefined {
  return RPC_AUTH_BY_ORIGIN.get(new URL(url).origin);
}

export function getRpcAuthHeaders(url: string): Record<string, string> | undefined {
  const registration = getRpcAuth(url);
  return registration ? { ...registration.headers } : undefined;
}

export function buildAlchemyRpcUrl(slug: string, apiKey?: string): string {
  const url = `https://${slug}.g.alchemy.com/v2/`;
  if (apiKey) {
    registerRpcAuth("alchemy", url, { Authorization: `Bearer ${apiKey}` });
    return url;
  }
  // A keyless build clears a stale Alchemy bearer for this origin. Dwellir registrations
  // are never cleared: a route building without a key must not break a concurrent
  // scheduled slot in the same isolate.
  const origin = new URL(url).origin;
  if (RPC_AUTH_BY_ORIGIN.get(origin)?.provider === "alchemy") {
    RPC_AUTH_BY_ORIGIN.delete(origin);
  }
  return url;
}

/** dRPC chain slugs */
const DRPC_CHAINS: Record<string, string> = {
  gnosis: "gnosis",
  fantom: "fantom",
  celo: "celo",
};

/** dRPC authenticates with a `dkey` query parameter, so its URL is keyed by construction. */
function drpcRpcUrl(slug: string, apiKey: string): string {
  return `https://lb.drpc.org/ogrpc?network=${slug}&dkey=${apiKey}`;
}

type RegistryRpcOperator = "alchemy" | "drpc" | "public";

/** Inclusive CCIP ramp-log ranges probed against the keyed endpoints 2026-10-06.
 * Result/body limits still require the observer to subdivide dense pages. */
const ALCHEMY_LOG_BLOCK_SPANS: Readonly<Record<string, number>> = {
  "eth-mainnet": 10_000,
  "arb-mainnet": 2_000_000,
  "base-mainnet": 100_000,
  "opt-mainnet": 2_000_000,
};

/** Today's registry behaviour: every endpoint is archive-capable with full log history. */
function registryEndpoint(url: string, operator: RegistryRpcOperator): RpcEndpoint {
  const maxLogBlockSpan = operator === "alchemy"
    ? ALCHEMY_LOG_BLOCK_SPANS[new URL(url).hostname.split(".")[0]!]
    : undefined;
  return {
    url,
    operator,
    keyed: operator !== "public",
    position: "registry",
    stateHistory: "archive",
    logsHistory: "full",
    ...(maxLogBlockSpan ? { maxLogBlockSpan } : {}),
  };
}

/** Today's [rpcUrl, fallbackRpcUrl] pair, in order, as registry endpoints. */
function publicRegistryEndpoints(...urls: readonly (string | undefined)[]): RpcEndpoint[] {
  return urls
    .filter((url): url is string => typeof url === "string" && url.length > 0)
    .map((url) => registryEndpoint(url, "public"));
}

// `plasma` is here for the reviewed Curve StableSwap-NG factory capture in
// `cron/dex-liquidity/curve-stableswap-factory.ts`: Curve's own getPools
// endpoint does not serve Plasma, so the factory is the only pool census, and
// it is read over this public RPC.
// `plume`, `monad`, `mantle`, `morph-l2`, `abcore`, and `xlayer` are public-only
// EVM chains required for usd1-bundle-oracle's multichain totalSupply() supply
// aggregation.
// `arc` is public-only for the Dwellir provider-parity observation lane
// (`observe-rpc-provider-parity`), which compares Dwellir against the chain's
// first registry operator.
// `hemi` is public-only for vcred-vcred's reviewed on-chain circulating-supply
// probe over its single tracked Hemi deployment.
const PUBLIC_ONLY_EVM_CHAINS = ["tempo", "plasma", "plume", "monad", "mantle", "morph-l2", "abcore", "xlayer", "sonic", "etherlink", "arc", "hemi", "robinhood"] as const;
const PUBLIC_ONLY_OTHER_CHAINS = ["movement"] as const;
const SOLANA_PUBLIC_RPC_CHAIN_ID = "solana";

/**
 * Appends one supplemental Dwellir endpoint per entry, after every registry
 * endpoint (including coin/curated pins), and creates a supplemental-only config
 * for chains that have no registry config yet.
 */
function appendDwellirEndpoints(configs: Map<string, ChainRpcConfig>, apiKey: string): void {
  for (const entry of DWELLIR_CHAINS) {
    const config = configs.get(entry.chainId);
    const meta = CHAIN_META[entry.chainId];
    // A Dwellir URL is only ever reachable through a config built here, so an
    // entry whose CHAIN_META key is missing is skipped rather than half-wired.
    if (!config && !meta) continue;

    const url = dwellirRpcUrl(entry);
    registerRpcAuth("dwellir", url, { "X-Api-Key": apiKey });
    const endpoint: RpcEndpoint = {
      url,
      operator: "dwellir",
      keyed: true,
      position: "supplemental",
      stateHistory: entry.stateHistory,
      logsHistory: entry.logsHistory,
      verifiedAt: entry.verifiedAt,
    };

    if (config) {
      config.endpoints = [...config.endpoints, endpoint];
      continue;
    }
    configs.set(entry.chainId, {
      chainId: entry.chainId,
      chainName: meta!.name,
      type: "evm",
      endpoints: [endpoint],
      explorerUrl: meta!.explorerUrl,
    });
  }
}

export function buildChainRpcs(
  alchemyApiKey?: string,
  drpcApiKey?: string,
  options?: BuildChainRpcsOptions,
): Map<string, ChainRpcConfig> {
  const configs: ChainRpcConfig[] = [];

  for (const [chainId, slug] of Object.entries(ALCHEMY_CHAINS)) {
    const publicRpc = getPublicRpcUrl(chainId);
    if (!publicRpc) continue;
    const meta = CHAIN_META[chainId]!;
    if (alchemyApiKey) {
      configs.push({
        chainId,
        chainName: meta.name,
        type: "evm",
        endpoints: [
          registryEndpoint(buildAlchemyRpcUrl(slug, alchemyApiKey), "alchemy"),
          registryEndpoint(publicRpc, "public"),
        ],
        explorerUrl: meta.explorerUrl,
      });
    } else {
      configs.push({
        chainId,
        chainName: meta.name,
        type: "evm",
        endpoints: publicRegistryEndpoints(publicRpc, getSecondaryFallbackRpcUrl(chainId)),
        explorerUrl: meta.explorerUrl,
      });
    }
  }

  for (const [chainId, slug] of Object.entries(DRPC_CHAINS)) {
    const publicRpc = getPublicRpcUrl(chainId);
    if (!publicRpc) continue;
    const meta = CHAIN_META[chainId]!;
    if (drpcApiKey) {
      configs.push({
        chainId,
        chainName: meta.name,
        type: "evm",
        endpoints: [
          registryEndpoint(drpcRpcUrl(slug, drpcApiKey), "drpc"),
          registryEndpoint(publicRpc, "public"),
        ],
        explorerUrl: meta.explorerUrl,
      });
    } else {
      configs.push({
        chainId,
        chainName: meta.name,
        type: "evm",
        endpoints: publicRegistryEndpoints(publicRpc),
        explorerUrl: meta.explorerUrl,
      });
    }
  }

  for (const chainId of PUBLIC_ONLY_EVM_CHAINS) {
    if (configs.some((config) => config.chainId === chainId)) continue;
    const meta = CHAIN_META[chainId];
    const publicRpc = getPublicRpcUrl(chainId);
    if (!meta || meta.type !== "evm" || !publicRpc) continue;

    configs.push({
      chainId,
      chainName: meta.name,
      type: "evm",
      endpoints: publicRegistryEndpoints(publicRpc, getSecondaryFallbackRpcUrl(chainId)),
      explorerUrl: meta.explorerUrl,
    });
  }

  for (const chainId of PUBLIC_ONLY_OTHER_CHAINS) {
    const meta = CHAIN_META[chainId];
    const publicRpc = getPublicRpcUrl(chainId);
    if (!meta || !publicRpc) continue;
    configs.push({
      chainId,
      chainName: meta.name,
      type: "other",
      endpoints: publicRegistryEndpoints(publicRpc),
      explorerUrl: meta.explorerUrl,
    });
  }

  const keyedSolanaEndpoints = [
    alchemyApiKey
      ? registryEndpoint(buildAlchemyRpcUrl("solana-mainnet", alchemyApiKey), "alchemy")
      : undefined,
    drpcApiKey ? registryEndpoint(drpcRpcUrl("solana", drpcApiKey), "drpc") : undefined,
  ].filter((endpoint): endpoint is RpcEndpoint => endpoint !== undefined);
  if (keyedSolanaEndpoints.length > 0) {
    configs.push({
      chainId: SOLANA_PUBLIC_RPC_CHAIN_ID,
      chainName: CHAIN_META[SOLANA_PUBLIC_RPC_CHAIN_ID].name,
      type: "other",
      endpoints: keyedSolanaEndpoints,
      explorerUrl: CHAIN_META[SOLANA_PUBLIC_RPC_CHAIN_ID].explorerUrl,
    });
  }

  if (alchemyApiKey) {
    configs.push({
      chainId: "tron",
      chainName: CHAIN_META.tron.name,
      type: "tron",
      endpoints: [
        registryEndpoint(buildAlchemyRpcUrl("tron-mainnet", alchemyApiKey), "alchemy"),
        ...publicRegistryEndpoints(getPublicRpcUrl("tron")),
      ],
      explorerUrl: CHAIN_META.tron.explorerUrl,
    });
  } else {
    const tronRpc = getPublicRpcUrl("tron");
    if (!tronRpc) throw new Error("No public RPC for tron");
    configs.push({
      chainId: "tron",
      chainName: CHAIN_META.tron.name,
      type: "tron",
      endpoints: publicRegistryEndpoints(tronRpc),
      explorerUrl: CHAIN_META.tron.explorerUrl,
    });
  }

  const map = new Map<string, ChainRpcConfig>();
  for (const config of configs) {
    map.set(config.chainId, config);
  }
  if (alchemyApiKey) {
    for (const [chainId, slug] of Object.entries(CCIP_ARCHIVE_ALCHEMY_CHAINS)) {
      const meta = CHAIN_META[chainId]!;
      const endpoint: RpcEndpoint = {
        url: buildAlchemyRpcUrl(slug, alchemyApiKey),
        operator: "alchemy", keyed: true, position: "registry",
        stateHistory: "archive", logsHistory: "full",
        maxLogBlockSpan: 1000, noBatch: false, verifiedAt: "2026-10-05",
      };
      const existing = map.get(chainId);
      map.set(chainId, {
        chainId, chainName: meta.name, type: "evm", explorerUrl: meta.explorerUrl,
        endpoints: [endpoint, ...(existing?.endpoints ?? []), ...(CCIP_ARCHIVE_PUBLIC_ENDPOINTS[chainId] ?? [])],
      });
    }
  }
  for (const [chainId, endpointConfigs] of Object.entries(CENSUS_STATE_PUBLIC_RPCS)) {
    const meta = CHAIN_META[chainId]!;
    const endpoints: RpcEndpoint[] = endpointConfigs.map(endpoint => ({
      ...endpoint, operator: "public", keyed: false, position: "supplemental",
      stateHistory: "archive", logsHistory: "none", verifiedAt: "2026-10-05",
    }));
    const existing = map.get(chainId);
    map.set(chainId, {
      chainId, chainName: meta.name, type: "evm", explorerUrl: meta.explorerUrl,
      endpoints: [...(existing?.endpoints ?? []), ...endpoints],
    });
  }
  if (alchemyApiKey) {
    for (const [chainId, slug] of Object.entries(CENSUS_STATE_ALCHEMY_CHAINS)) {
      const endpoint: RpcEndpoint = {
        url: buildAlchemyRpcUrl(slug, alchemyApiKey),
        operator: "alchemy",
        keyed: true,
        position: "supplemental",
        stateHistory: "archive",
        logsHistory: "none",
        verifiedAt: "2026-10-05",
      };
      const existing = map.get(chainId);
      if (existing) {
        existing.endpoints = [...existing.endpoints, endpoint];
      } else {
        const meta = CHAIN_META[chainId]!;
        map.set(chainId, {
          chainId, chainName: meta.name, type: "evm",
          endpoints: [endpoint], explorerUrl: meta.explorerUrl,
        });
      }
    }
  }


  const dwellirApiKey = options?.dwellirApiKey;
  if (typeof dwellirApiKey === "string" && dwellirApiKey.length > 0) {
    appendDwellirEndpoints(map, dwellirApiKey);
  }
  return map;
}

/** Look up RPC config by chain ID from a pre-built map */
export function getChainRpc(chainRpcs: Map<string, ChainRpcConfig>, chainId: string): ChainRpcConfig | undefined {
  return chainRpcs.get(chainId);
}

export function registryRpcEndpoints(config: ChainRpcConfig | undefined): readonly RpcEndpoint[] {
  return config?.endpoints.filter((endpoint) => endpoint.position === "registry") ?? [];
}

/** Today's [rpcUrl, fallbackRpcUrl] (filtered), in order. */
export function registryRpcUrls(config: ChainRpcConfig | undefined): string[] {
  return registryRpcEndpoints(config).map((endpoint) => endpoint.url);
}

/** Today's rpcUrl. undefined for supplemental-only configs. */
export function primaryRpcUrl(config: ChainRpcConfig | undefined): string | undefined {
  return config?.endpoints.find((endpoint) => endpoint.position === "registry")?.url;
}

/** True when the chain has at least one registry endpoint (it is RPC-readable). */
export function hasRegistryRpc(config: ChainRpcConfig | undefined): boolean {
  return config?.endpoints.some((endpoint) => endpoint.position === "registry") ?? false;
}

/** Supplemental endpoints in order; historicalBlock excludes near-head-only endpoints. */
export function supplementalRpcEndpoints(
  config: ChainRpcConfig | undefined,
  options?: { historicalBlock?: boolean },
): readonly RpcEndpoint[] {
  const supplemental = (config?.endpoints ?? []).filter((endpoint) => endpoint.position === "supplemental");
  if (!options?.historicalBlock) return supplemental;
  return supplemental.filter((endpoint) => endpoint.stateHistory === "archive");
}

/** Registry endpoints whose operator is not "dwellir" — the only endpoints log lanes may use. */
export function logScanRpcEndpoints(config: ChainRpcConfig | undefined): readonly RpcEndpoint[] {
  return (
    config?.endpoints.filter(
      (endpoint) => endpoint.position === "registry" && endpoint.operator !== "dwellir",
    ) ?? []
  );
}
