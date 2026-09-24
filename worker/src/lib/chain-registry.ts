import { CHAIN_META } from "@shared/lib/chains";
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
export type RpcStateHistory = "archive" | "recent";
export type RpcLogsHistory = "full" | "none" | { readonly retainedBlocks: number };

export interface RpcEndpoint {
  /** Never contains a key; keys travel as request headers only. */
  readonly url: string;
  readonly operator: RpcOperator;
  readonly keyed: boolean;
  readonly position: RpcEndpointPosition;
  readonly stateHistory: RpcStateHistory;
  readonly logsHistory: RpcLogsHistory;
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

/** Today's registry behaviour: every endpoint is archive-capable with full log history. */
function registryEndpoint(url: string, operator: RegistryRpcOperator): RpcEndpoint {
  return {
    url,
    operator,
    keyed: operator !== "public",
    position: "registry",
    stateHistory: "archive",
    logsHistory: "full",
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
const PUBLIC_ONLY_EVM_CHAINS = ["tempo", "plasma", "plume", "monad", "mantle", "morph-l2", "abcore", "xlayer", "sonic", "etherlink", "arc", "hemi"] as const;
const PUBLIC_ONLY_OTHER_CHAINS = ["movement"] as const;
const SOLANA_PUBLIC_RPC_CHAIN_ID = "solana";

export interface DwellirChainEntry {
  /** CHAIN_META key */
  readonly chainId: string;
  /** Dwellir host label, e.g. "api-ethereum-mainnet-erigon" */
  readonly host: string;
  /** Endpoint path on the host, e.g. avalanche's "/ext/bc/C/rpc" */
  readonly pathSuffix?: string;
  /** Must equal CHAIN_META[chainId].evmChainId */
  readonly evmChainId: number;
  readonly stateHistory: RpcStateHistory;
  readonly logsHistory: RpcLogsHistory;
  readonly verifiedAt: string;
}

/** Capability-probe date for every entry below (Dwellir Developer plan). */
const DWELLIR_VERIFIED_AT = "2026-09-23";

/**
 * Dwellir mainnet endpoints verified 2026-09-23. Entries are additive: each one
 * is appended after all registry endpoints and never replaces an operator.
 */
export const DWELLIR_CHAINS: readonly DwellirChainEntry[] = [
  { chainId: "ethereum", host: "api-ethereum-mainnet-erigon", evmChainId: 1, stateHistory: "archive", logsHistory: "full", verifiedAt: DWELLIR_VERIFIED_AT },
  { chainId: "arbitrum", host: "api-arbitrum-mainnet-archive", evmChainId: 42161, stateHistory: "archive", logsHistory: "full", verifiedAt: DWELLIR_VERIFIED_AT },
  { chainId: "base", host: "api-base-mainnet-archive", evmChainId: 8453, stateHistory: "archive", logsHistory: "full", verifiedAt: DWELLIR_VERIFIED_AT },
  { chainId: "optimism", host: "api-optimism-mainnet-archive", evmChainId: 10, stateHistory: "archive", logsHistory: "full", verifiedAt: DWELLIR_VERIFIED_AT },
  { chainId: "polygon", host: "api-polygon-mainnet-full", evmChainId: 137, stateHistory: "recent", logsHistory: "full", verifiedAt: DWELLIR_VERIFIED_AT },
  { chainId: "avalanche", host: "api-avalanche-mainnet-archive", pathSuffix: "/ext/bc/C/rpc", evmChainId: 43114, stateHistory: "archive", logsHistory: "full", verifiedAt: DWELLIR_VERIFIED_AT },
  { chainId: "bsc", host: "api-bsc-mainnet-full", evmChainId: 56, stateHistory: "recent", logsHistory: "full", verifiedAt: DWELLIR_VERIFIED_AT },
  { chainId: "gnosis", host: "api-gnosis-mainnet", evmChainId: 100, stateHistory: "archive", logsHistory: "full", verifiedAt: DWELLIR_VERIFIED_AT },
  { chainId: "celo", host: "api-celo-mainnet-archive", evmChainId: 42220, stateHistory: "archive", logsHistory: "full", verifiedAt: DWELLIR_VERIFIED_AT },
  { chainId: "tempo", host: "api-tempo-mainnet", evmChainId: 4217, stateHistory: "archive", logsHistory: "full", verifiedAt: DWELLIR_VERIFIED_AT },
  { chainId: "plasma", host: "api-plasma-mainnet", evmChainId: 9745, stateHistory: "recent", logsHistory: "full", verifiedAt: DWELLIR_VERIFIED_AT },
  { chainId: "monad", host: "api-monad-mainnet-full", evmChainId: 143, stateHistory: "recent", logsHistory: { retainedBlocks: 10000 }, verifiedAt: DWELLIR_VERIFIED_AT },
  { chainId: "mantle", host: "api-mantle-mainnet", evmChainId: 5000, stateHistory: "archive", logsHistory: "full", verifiedAt: DWELLIR_VERIFIED_AT },
  { chainId: "sonic", host: "api-sonic-mainnet-archive", evmChainId: 146, stateHistory: "archive", logsHistory: "full", verifiedAt: DWELLIR_VERIFIED_AT },
  { chainId: "hyperevm", host: "api-hyperliquid-mainnet-evm", evmChainId: 999, stateHistory: "archive", logsHistory: "full", verifiedAt: DWELLIR_VERIFIED_AT },
  { chainId: "linea", host: "api-linea-mainnet-archive", evmChainId: 59144, stateHistory: "archive", logsHistory: "full", verifiedAt: DWELLIR_VERIFIED_AT },
  { chainId: "berachain", host: "api-berachain-mainnet", evmChainId: 80094, stateHistory: "recent", logsHistory: "full", verifiedAt: DWELLIR_VERIFIED_AT },
  { chainId: "ink", host: "api-ink-mainnet", evmChainId: 57073, stateHistory: "archive", logsHistory: "full", verifiedAt: DWELLIR_VERIFIED_AT },
  { chainId: "zksync", host: "api-zksync-era-mainnet-full", evmChainId: 324, stateHistory: "recent", logsHistory: "none", verifiedAt: DWELLIR_VERIFIED_AT },
  { chainId: "stable", host: "api-stable-mainnet", evmChainId: 988, stateHistory: "archive", logsHistory: "full", verifiedAt: DWELLIR_VERIFIED_AT },
  { chainId: "megaeth", host: "api-megaeth-mainnet", evmChainId: 4326, stateHistory: "archive", logsHistory: "full", verifiedAt: DWELLIR_VERIFIED_AT },
  { chainId: "worldchain", host: "api-worldchain-mainnet", evmChainId: 480, stateHistory: "archive", logsHistory: "full", verifiedAt: DWELLIR_VERIFIED_AT },
  { chainId: "scroll", host: "api-scroll-mainnet", evmChainId: 534352, stateHistory: "archive", logsHistory: "full", verifiedAt: DWELLIR_VERIFIED_AT },
  { chainId: "unichain", host: "api-unichain-mainnet", evmChainId: 130, stateHistory: "archive", logsHistory: "full", verifiedAt: DWELLIR_VERIFIED_AT },
  { chainId: "xdc", host: "api-xdc-mainnet", evmChainId: 50, stateHistory: "archive", logsHistory: "full", verifiedAt: DWELLIR_VERIFIED_AT },
  { chainId: "blast", host: "api-blast-mainnet-archive", evmChainId: 81457, stateHistory: "archive", logsHistory: "full", verifiedAt: DWELLIR_VERIFIED_AT },
  { chainId: "manta", host: "api-manta-pacific-archive", evmChainId: 169, stateHistory: "archive", logsHistory: "full", verifiedAt: DWELLIR_VERIFIED_AT },
  { chainId: "robinhood", host: "api-robinhood-mainnet-archive", evmChainId: 4663, stateHistory: "archive", logsHistory: "full", verifiedAt: DWELLIR_VERIFIED_AT },
  { chainId: "arc", host: "api-arc-mainnet", evmChainId: 5042, stateHistory: "recent", logsHistory: "full", verifiedAt: DWELLIR_VERIFIED_AT },
];

export function dwellirRpcUrl(entry: DwellirChainEntry): string {
  return `https://${entry.host}.n.dwellir.com${entry.pathSuffix ?? ""}`;
}

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
