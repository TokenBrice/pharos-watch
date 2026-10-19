/** Runtime-neutral Dwellir endpoint capabilities; credentials are never part of this registry. */
type RpcStateHistory = "archive" | "recent";
type RpcLogsHistory = "full" | "none" | { readonly retainedBlocks: number };

export const DWELLIR_HOST_SUFFIX = ".n.dwellir.com";

export interface DwellirChainEntry {
  /** CHAIN_META key */
  readonly chainId: string;
  /** Dwellir host label, e.g. "api-ethereum-mainnet" */
  readonly host: string;
  /** Endpoint path on the host, e.g. avalanche's "/ext/bc/C/rpc" */
  readonly pathSuffix?: string;
  /** Must equal CHAIN_META[chainId].evmChainId */
  readonly evmChainId: number;
  readonly stateHistory: RpcStateHistory;
  readonly logsHistory: RpcLogsHistory;
  /** Maximum inclusive block count for one eth_getLogs request, separate from retention. */
  readonly maxLogBlockSpan?: number;
  /** Explicit negative capability; numbered success does not establish finalized-tag support. */
  readonly finalizedTagUnsupported?: boolean;
  readonly verifiedAt: string;
}

/** Capability-probe date for the original 29 entries (Dwellir Developer plan). */
export const DWELLIR_VERIFIED_AT = "2026-09-23";

/**
 * Verified Dwellir mainnet endpoints. Scheduled routing owns provider placement;
 * these capabilities do not themselves authorize primary or log-lane admission.
 */
export const DWELLIR_CHAINS: readonly DwellirChainEntry[] = [
  // 2026-10-11 Growth probes: inclusive mint-filtered ranges and gateway/node
  // boundary checks; archive corrections use non-zero year-old token state.
  // 2026-10-13: new Ethereum host's archive state, 10k logs and hash pins verified.
  { chainId: "ethereum", host: "api-ethereum-mainnet", evmChainId: 1, stateHistory: "archive", logsHistory: "full", maxLogBlockSpan: 10_000, verifiedAt: "2026-10-13" },
  { chainId: "arbitrum", host: "api-arbitrum-mainnet-archive", evmChainId: 42161, stateHistory: "archive", logsHistory: "full", maxLogBlockSpan: 10_000, verifiedAt: "2026-10-11" },
  { chainId: "base", host: "api-base-mainnet-archive", evmChainId: 8453, stateHistory: "archive", logsHistory: "full", maxLogBlockSpan: 10_000, verifiedAt: "2026-10-11" },
  { chainId: "optimism", host: "api-optimism-mainnet-archive", evmChainId: 10, stateHistory: "archive", logsHistory: "full", maxLogBlockSpan: 10_000, verifiedAt: "2026-10-11" },
  { chainId: "polygon", host: "api-polygon-mainnet", evmChainId: 137, stateHistory: "archive", logsHistory: "full", maxLogBlockSpan: 10_000, verifiedAt: "2026-10-11" },
  { chainId: "avalanche", host: "api-avalanche-mainnet-archive", pathSuffix: "/ext/bc/C/rpc", evmChainId: 43114, stateHistory: "archive", logsHistory: "full", maxLogBlockSpan: 10_000, verifiedAt: "2026-10-11" },
  { chainId: "bsc", host: "api-bsc-mainnet-full", evmChainId: 56, stateHistory: "recent", logsHistory: "full", maxLogBlockSpan: 10_000, verifiedAt: "2026-10-11" },
  { chainId: "gnosis", host: "api-gnosis-mainnet", evmChainId: 100, stateHistory: "archive", logsHistory: "full", maxLogBlockSpan: 10_000, verifiedAt: "2026-10-11" },
  { chainId: "celo", host: "api-celo-mainnet-archive", evmChainId: 42220, stateHistory: "archive", logsHistory: "full", maxLogBlockSpan: 10_000, verifiedAt: "2026-10-11" },
  { chainId: "tempo", host: "api-tempo-mainnet", evmChainId: 4217, stateHistory: "archive", logsHistory: "full", maxLogBlockSpan: 10_000, verifiedAt: "2026-10-11" },
  // Plasma archive history is currently observed; the vendor does not yet guarantee it.
  { chainId: "plasma", host: "api-plasma-mainnet", evmChainId: 9745, stateHistory: "archive", logsHistory: "full", maxLogBlockSpan: 10_000, verifiedAt: "2026-10-11" },
  // Monad's ~5-day retention is a moving estimate, not a guaranteed history floor.
  // Retained log span re-probed 2026-10-19; larger ranges explicitly refuse at 10k.
  { chainId: "monad", host: "api-monad-mainnet-full", evmChainId: 143, stateHistory: "recent", logsHistory: { retainedBlocks: 1_400_000 }, maxLogBlockSpan: 10_000, verifiedAt: "2026-10-11" },
  { chainId: "mantle", host: "api-mantle-mainnet", evmChainId: 5000, stateHistory: "archive", logsHistory: "full", maxLogBlockSpan: 10_000, verifiedAt: "2026-10-11" },
  // Vendor: 5,000-log result cap; 100 blocks without an address or topic filter.
  { chainId: "sonic", host: "api-sonic-mainnet-archive", evmChainId: 146, stateHistory: "archive", logsHistory: "full", maxLogBlockSpan: 10_000, verifiedAt: "2026-10-11" },
  { chainId: "hyperevm", host: "api-hyperliquid-mainnet-evm", evmChainId: 999, stateHistory: "archive", logsHistory: "full", maxLogBlockSpan: 10_000, verifiedAt: "2026-10-11" },
  { chainId: "linea", host: "api-linea-mainnet-archive", evmChainId: 59144, stateHistory: "archive", logsHistory: "full", maxLogBlockSpan: 10_000, verifiedAt: "2026-10-11" },
  { chainId: "berachain", host: "api-berachain-mainnet", evmChainId: 80094, stateHistory: "archive", logsHistory: "full", maxLogBlockSpan: 10_000, verifiedAt: "2026-10-11" },
  { chainId: "ink", host: "api-ink-mainnet", evmChainId: 57073, stateHistory: "archive", logsHistory: "full", maxLogBlockSpan: 10_000, verifiedAt: "2026-10-11" },
  { chainId: "zksync", host: "api-zksync-era-mainnet-full", evmChainId: 324, stateHistory: "recent", logsHistory: "none", verifiedAt: DWELLIR_VERIFIED_AT },
  { chainId: "stable", host: "api-stable-mainnet", evmChainId: 988, stateHistory: "archive", logsHistory: "full", maxLogBlockSpan: 10_000, verifiedAt: "2026-10-11" },
  { chainId: "megaeth", host: "api-megaeth-mainnet", evmChainId: 4326, stateHistory: "archive", logsHistory: "full", maxLogBlockSpan: 10_000, verifiedAt: "2026-10-11" },
  { chainId: "worldchain", host: "api-worldchain-mainnet", evmChainId: 480, stateHistory: "archive", logsHistory: "full", maxLogBlockSpan: 10_000, verifiedAt: "2026-10-11" },
  { chainId: "scroll", host: "api-scroll-mainnet", evmChainId: 534352, stateHistory: "archive", logsHistory: "full", maxLogBlockSpan: 10_000, verifiedAt: "2026-10-11" },
  { chainId: "unichain", host: "api-unichain-mainnet", evmChainId: 130, stateHistory: "archive", logsHistory: "full", maxLogBlockSpan: 10_000, verifiedAt: "2026-10-11" },
  { chainId: "xdc", host: "api-xdc-mainnet", evmChainId: 50, stateHistory: "archive", logsHistory: "full", maxLogBlockSpan: 10_000, verifiedAt: "2026-10-11" },
  { chainId: "blast", host: "api-blast-mainnet-archive", evmChainId: 81457, stateHistory: "archive", logsHistory: "full", maxLogBlockSpan: 10_000, verifiedAt: "2026-10-11" },
  { chainId: "manta", host: "api-manta-pacific-archive", evmChainId: 169, stateHistory: "archive", logsHistory: "full", maxLogBlockSpan: 10_000, verifiedAt: "2026-10-11" },
  { chainId: "robinhood", host: "api-robinhood-mainnet-archive", evmChainId: 4663, stateHistory: "archive", logsHistory: "full", maxLogBlockSpan: 10_000, verifiedAt: "2026-10-11" },
  // 2026-10-13: vendor's all-region history fix + old-block state/hash-pin/log probes.
  { chainId: "arc", host: "api-arc-mainnet", evmChainId: 5042, stateHistory: "archive", logsHistory: "full", maxLogBlockSpan: 10_000, verifiedAt: "2026-10-13" },
  // Verified 2026-10-05: year-old or deployment-block USDC state; full logs only
  // after a non-empty near-deployment Transfer window. Unproven logs stay none.
  { chainId: "etherlink", host: "api-etherlink-mainnet", evmChainId: 42793, stateHistory: "archive", logsHistory: "none", verifiedAt: "2026-10-05" },
  // Proven to USDC deployment block 76694534 (2026-06-12), not >=366 days:
  // the year-old eth_call returned 0x because it predates this contract.
  { chainId: "cronos", host: "api-cronos-mainnet-archive", evmChainId: 25, stateHistory: "archive", logsHistory: "none", verifiedAt: "2026-10-05" },
  { chainId: "flow", host: "api-flow-evm-gateway-mainnet", evmChainId: 747, stateHistory: "archive", logsHistory: "none", verifiedAt: "2026-10-05" },
  { chainId: "pulsechain", host: "api-pulse-mainnet", evmChainId: 369, stateHistory: "archive", logsHistory: "full", maxLogBlockSpan: 10_000, verifiedAt: "2026-10-11" },
  // Vendor: 5,000-block node cap; logs remain unproven and are not admitted.
  { chainId: "immutable-zkevm", host: "api-immutable-zkevm-mainnet", evmChainId: 13371, stateHistory: "archive", logsHistory: "none", finalizedTagUnsupported: true, verifiedAt: "2026-10-05" },
  { chainId: "boba", host: "api-boba-mainnet", evmChainId: 288, stateHistory: "archive", logsHistory: "none", verifiedAt: "2026-10-05" },
  { chainId: "astar", host: "api-astar", evmChainId: 592, stateHistory: "archive", logsHistory: "full", maxLogBlockSpan: 1_024, verifiedAt: "2026-10-11" },
  { chainId: "taiko", host: "api-taiko-mainnet", evmChainId: 167000, stateHistory: "archive", logsHistory: "full", maxLogBlockSpan: 10_000, verifiedAt: "2026-10-11" },
];

export function dwellirRpcUrl(entry: DwellirChainEntry): string {
  return `https://${entry.host}${DWELLIR_HOST_SUFFIX}${entry.pathSuffix ?? ""}`;
}
