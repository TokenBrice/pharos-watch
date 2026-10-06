import { DWELLIR_CHAINS } from "@shared/lib/dwellir-chains";
import {
  getChainRpc,
  getRpcAuth,
  registryRpcEndpoints,
  type ChainRpcConfig,
} from "../chain-registry";
import { getPublicRpcUrl } from "../public-rpc-registry";
import type {
  RpcParityComparatorOperator,
  RpcParityComparatorRef,
  RpcParityComparatorSource,
  RpcParityLatestProbeMethod,
} from "./types";

/**
 * The tracked contract and comparator for every chain Dwellir serves.
 *
 * One target per `DWELLIR_CHAINS` entry, in registry order: the contract is the
 * chain's own deployment of a coin this repo already tracks (so a parity
 * mismatch is a real read disagreement, not a wrong address), and the
 * comparator is either the chain's first registry operator or a reviewed
 * operator pin. Paid pins require that operator's configured header auth.
 *
 * `blockTimeSec` is nominal: it sets the common-block margin and the shared
 * head-lag/served-block freshness budget
 * (`max(3, ceil(6 / blockTimeSec))` blocks ≈ six seconds of chain time). It is
 * deliberately coarse — a chain's real block time drifts, and the gate tolerates
 * that by never dropping below three blocks.
 */
export interface RpcParityTarget {
  readonly chainId: string;
  /** Stablecoin id whose `contracts[]` carries the tracked address. */
  readonly coinId: string;
  /** Tracked ERC-20 address, lowercase, as listed in the coin registry. */
  readonly contract: string;
  /** Nominal seconds per block. */
  readonly blockTimeSec: number;
  /**
   * Proxy for the log window below the common block. Defaults to
   * `RPC_PARITY_LOG_WINDOW_BLOCKS` (10); high-volume chains narrow it so the
   * address-filtered `eth_getLogs` answer stays inside the lane's bounded
   * response size and both operators are genuinely compared.
   */
  readonly logWindowBlocks?: number;
  readonly comparator: RpcParityComparatorPlan;
  /** Explicit per-step pin when state correctness and log representation diverge. */
  readonly logsComparator?: RpcParityComparatorPlan;
  /** Reviewed chain-local block-number domain; never inferred at runtime. */
  readonly latestStateProbe: RpcParityLatestProbeMethod;
}

export type RpcParityComparatorPlan =
  | { readonly source: "registry" }
  | { readonly source: "pin"; readonly url: string; readonly operator?: RpcParityComparatorOperator };

export const RPC_PARITY_MULTICALL3_ADDRESS = "0xca11bde05977b3631167028862be2a173976ca11";
export const RPC_PARITY_MULTICALL3_BLOCK_SELECTOR = "0x42cbb15c";
/** Nitro/Orbit's block.number is L1-numbered; ArbSys returns the local L2 height. */
export const RPC_PARITY_ARBSYS_ADDRESS = "0x0000000000000000000000000000000000000064";
export const RPC_PARITY_ARBSYS_BLOCK_SELECTOR = "0xa3b1b31d";
/**
 * Log window for chains whose tracked token emits enough logs per block that a
 * 10-block window no longer fits the lane's response bound (production
 * 2026-09-24: ethereum/base/optimism USDC windows exceeded it and were stored
 * unchecked). Two blocks still compare both operators on the same range, and
 * still expose shifted/missing log sets.
 */
const HIGH_VOLUME_LOG_WINDOW_BLOCKS = 2;

/**
 * Address provenance: `shared/data/stablecoins/coins/usdc-circle.json`,
 * `usdt-tether.json` (plasma, megaeth), and `usde-ethena.json` (blast,
 * robinhood). Public pin provenance: onchain-supply-probe.ts and
 * public-rpc-registry.ts. HyperEVM's Alchemy pin is live-verified below.
 * XDC is an exception in its source, not its role: `rpc.xinfin.network` now
 * answers Cloudflare error 1010 for some user agents, so the pin is
 * `rpc.xdcrpc.com` (verified eth_chainId 0x32 with and without a User-Agent).
 */
/** 2026-10-05T19:15Z: every target's H1/Multicall3/ArbSys/H2 domain was probed.
 * Only arbitrum/robinhood returned L1-numbered Multicall3 and local ArbSys
 * heights. The other 34 deployed Multicall3 views returned local block heights;
 * XDC returned 0x. New chains require explicit reviewed sentinel selection.
 */
export const RPC_PARITY_TARGETS: readonly RpcParityTarget[] = [
  { chainId: "ethereum", latestStateProbe: "multicall3-block-number", logWindowBlocks: HIGH_VOLUME_LOG_WINDOW_BLOCKS, coinId: "usdc-circle", contract: "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48", blockTimeSec: 12, comparator: { source: "registry" } },
  { chainId: "arbitrum", latestStateProbe: "arbsys-block-number", coinId: "usdc-circle", contract: "0xaf88d065e77c8cc2239327c5edb3a432268e5831", blockTimeSec: 0.25, comparator: { source: "registry" } },
  { chainId: "base", latestStateProbe: "multicall3-block-number", logWindowBlocks: HIGH_VOLUME_LOG_WINDOW_BLOCKS, coinId: "usdc-circle", contract: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913", blockTimeSec: 2, comparator: { source: "registry" } },
  { chainId: "optimism", latestStateProbe: "multicall3-block-number", logWindowBlocks: HIGH_VOLUME_LOG_WINDOW_BLOCKS, coinId: "usdc-circle", contract: "0x0b2c639c533813f4aa9d7837caf62653d097ff85", blockTimeSec: 2, comparator: { source: "registry" } },
  { chainId: "polygon", latestStateProbe: "multicall3-block-number", coinId: "usdc-circle", contract: "0x3c499c542cef5e3811e1192ce70d8cc03d5c3359", blockTimeSec: 2, comparator: { source: "registry" } },
  { chainId: "avalanche", latestStateProbe: "multicall3-block-number", coinId: "usdc-circle", contract: "0xb97ef9ef8734c71904d8002f8b6bc66dd9c48a6e", blockTimeSec: 2, comparator: { source: "registry" } },
  { chainId: "bsc", latestStateProbe: "multicall3-block-number", coinId: "usdc-circle", contract: "0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d", blockTimeSec: 0.75, comparator: { source: "registry" } },
  { chainId: "gnosis", latestStateProbe: "multicall3-block-number", coinId: "usdc-circle", contract: "0xddafbb505ad214d7b80b1f830fccc89b60fb7a83", blockTimeSec: 5, comparator: { source: "registry" } },
  { chainId: "celo", latestStateProbe: "multicall3-block-number", coinId: "usdc-circle", contract: "0xceba9300f2b948710d2653dd7b07f33a8b32118c", blockTimeSec: 1, comparator: { source: "registry" } },
  { chainId: "tempo", latestStateProbe: "multicall3-block-number", coinId: "usdc-circle", contract: "0x20c000000000000000000000b9537d11c60e8b50", blockTimeSec: 1, comparator: { source: "registry" } },
  { chainId: "plasma", latestStateProbe: "multicall3-block-number", coinId: "usdt-tether", contract: "0xb8ce59fc3717ada4c02eadf9682a9e934f625ebb", blockTimeSec: 1, comparator: { source: "registry" } },
  { chainId: "monad", latestStateProbe: "multicall3-block-number", coinId: "usdc-circle", contract: "0x754704bc059f8c67012fed69bc8a327a5aafb603", blockTimeSec: 0.4, comparator: { source: "registry" } },
  { chainId: "mantle", latestStateProbe: "multicall3-block-number", coinId: "usdc-circle", contract: "0x09bc4e0d864854c6afb6eb9a9cdf58ac190d0df9", blockTimeSec: 2, comparator: { source: "registry" } },
  { chainId: "sonic", latestStateProbe: "multicall3-block-number", coinId: "usdc-circle", contract: "0x29219dd400f2bf60e5a23d13be72b486d4038894", blockTimeSec: 1, comparator: { source: "registry" } },
  // agents/dwellir-switch/raw/orch-hyperevm-alchemy-state.txt (19:50Z):
  // dRPC/Dwellir agree at recent numeric tags; Alchemy serves later state.
  // Alchemy/Dwellir share reth log indices; dRPC's native logs shift indices
  // around a synthetic transaction (same block hash, 8 vs 7 transactions).
  { chainId: "hyperevm", latestStateProbe: "multicall3-block-number", coinId: "usdc-circle", contract: "0xb88339cb7199b77e23db6e890353e22632ba630f", blockTimeSec: 1, comparator: { source: "pin", url: "https://hyperliquid.drpc.org" }, logsComparator: { source: "pin", operator: "alchemy", url: "https://hyperliquid-mainnet.g.alchemy.com/v2/" } },
  { chainId: "linea", latestStateProbe: "multicall3-block-number", coinId: "usdc-circle", contract: "0x176211869ca2b568f2a7d4ee941e073a821ee1ff", blockTimeSec: 2, comparator: { source: "pin", url: "https://rpc.linea.build" } },
  { chainId: "berachain", latestStateProbe: "multicall3-block-number", coinId: "usdc-circle", contract: "0x549943e04f40284185054145c6e4e9568c1d3241", blockTimeSec: 2, comparator: { source: "pin", url: "https://rpc.berachain.com" } },
  { chainId: "ink", latestStateProbe: "multicall3-block-number", coinId: "usdc-circle", contract: "0x2d270e6886d130d724215a266106e6832161eaed", blockTimeSec: 1, comparator: { source: "pin", url: "https://rpc-gel.inkonchain.com" } },
  { chainId: "zksync", latestStateProbe: "multicall3-block-number", coinId: "usdc-circle", contract: "0x1d17cbcf0d6d143135ae902365d2e5e2a16538d4", blockTimeSec: 1, comparator: { source: "pin", url: "https://mainnet.era.zksync.io" } },
  { chainId: "stable", latestStateProbe: "multicall3-block-number", coinId: "usdc-circle", contract: "0x8a2b28364102bea189d99a475c494330ef2bdd0b", blockTimeSec: 1, comparator: { source: "pin", url: "https://rpc.stable.xyz" } },
  { chainId: "megaeth", latestStateProbe: "multicall3-block-number", coinId: "usdt-tether", contract: "0xb8ce59fc3717ada4c02eadf9682a9e934f625ebb", blockTimeSec: 0.01, comparator: { source: "pin", url: "https://mainnet.megaeth.com/rpc" } },
  // Reviewed keyless dRPC pin avoids the census Alchemy bearer origin.
  { chainId: "worldchain", latestStateProbe: "multicall3-block-number", coinId: "usdc-circle", contract: "0x79a02482a880bce3f13e09da970dc34db4cd24d1", blockTimeSec: 2, comparator: { source: "pin", url: "https://worldchain.drpc.org" } },
  { chainId: "scroll", latestStateProbe: "multicall3-block-number", coinId: "usdc-circle", contract: "0x06efdbff2a14a7c8e15944d1f4a48f9f95f663a4", blockTimeSec: 3, comparator: { source: "pin", url: "https://rpc.scroll.io" } },
  { chainId: "unichain", latestStateProbe: "multicall3-block-number", coinId: "usdc-circle", contract: "0x078d782b760474a361dda0af3839290b0ef57ad6", blockTimeSec: 1, comparator: { source: "pin", url: "https://mainnet.unichain.org" } },
  { chainId: "xdc", latestStateProbe: "state-bracket", coinId: "usdc-circle", contract: "0xfa2958cb79b0491cc627c1557f441ef849ca8eb1", blockTimeSec: 2, comparator: { source: "pin", url: "https://rpc.xdcrpc.com" } },
  { chainId: "blast", latestStateProbe: "multicall3-block-number", coinId: "usde-ethena", contract: "0x5d3a1ff2b6bab83b63cd9ad0787074081a52ef34", blockTimeSec: 2, comparator: { source: "pin", url: "https://rpc.blast.io" } },
  { chainId: "manta", latestStateProbe: "multicall3-block-number", coinId: "usdc-circle", contract: "0xb73603c5d87fa094b7314c74ace2e64d165016fb", blockTimeSec: 12, comparator: { source: "pin", url: "https://pacific-rpc.manta.network/http" } },
  { chainId: "robinhood", latestStateProbe: "arbsys-block-number", coinId: "usde-ethena", contract: "0x5d3a1ff2b6bab83b63cd9ad0787074081a52ef34", blockTimeSec: 1, comparator: { source: "pin", url: "https://rpc.mainnet.chain.robinhood.com" } },
  { chainId: "arc", latestStateProbe: "multicall3-block-number", coinId: "usdc-circle", contract: "0x3600000000000000000000000000000000000000", blockTimeSec: 1, comparator: { source: "registry" } },
  // Numeric USDC state and logs live-verified in the 2026-10-05 chain harness.
  { chainId: "etherlink", latestStateProbe: "multicall3-block-number", coinId: "usdc-circle", contract: "0x796ea11fa2dd751ed01b53c372ffdb4aaa8f00f9", blockTimeSec: 1, comparator: { source: "pin", url: "https://node.mainnet.etherlink.com" } },
  { chainId: "cronos", latestStateProbe: "multicall3-block-number", coinId: "usdc-circle", contract: "0x3d7f2c478aafdb65542bcb44bceec05849999d2d", blockTimeSec: 0.4, comparator: { source: "pin", url: "https://evm.cronos.org" } },
  { chainId: "flow", latestStateProbe: "multicall3-block-number", coinId: "usdc-circle", contract: "0xf1815bd50389c46847f0bda824ec8da914045d14", blockTimeSec: 1, comparator: { source: "pin", url: "https://mainnet.evm.nodes.onflow.org" } },
  { chainId: "pulsechain", latestStateProbe: "multicall3-block-number", coinId: "usdc-circle", contract: "0x15d38573d2feeb82e7ad5187ab8c1d52810b1f07", blockTimeSec: 10, comparator: { source: "pin", url: "https://rpc.pulsechain.com" } },
  { chainId: "immutable-zkevm", latestStateProbe: "multicall3-block-number", coinId: "usdc-circle", contract: "0x6de8acc0d406837030ce4dd28e7c08c5a96a30d2", blockTimeSec: 2, comparator: { source: "pin", url: "https://rpc.immutable.com" } },
  { chainId: "boba", latestStateProbe: "multicall3-block-number", coinId: "usdc-circle", contract: "0x66a2a913e447d6b4bf33efbec43aaef87890fbbc", blockTimeSec: 2, comparator: { source: "pin", url: "https://mainnet.boba.network" } },
  { chainId: "astar", latestStateProbe: "multicall3-block-number", coinId: "usdc-circle", contract: "0x6a2d262d56735dba19dd70682b39f6be9a931d98", blockTimeSec: 6, comparator: { source: "pin", url: "https://evm.astar.network" } },
  { chainId: "taiko", latestStateProbe: "multicall3-block-number", coinId: "usdc-circle", contract: "0x07d83526730c7438048d55a4fc0b850e2aab6f0b", blockTimeSec: 2, comparator: { source: "pin", url: "https://rpc.mainnet.taiko.xyz" } },
];

/** Comparator as resolved for one run: the URL to call plus the claim it carries. */
export interface RpcParityComparatorTarget {
  url: string;
  ref: RpcParityComparatorRef;
}

const RPC_PARITY_DWELLIR_ENTRY_BY_CHAIN: Record<string, (typeof DWELLIR_CHAINS)[number]> = Object.fromEntries(
  DWELLIR_CHAINS.map((entry) => [entry.chainId, entry]),
);

/** The Dwellir entry behind a target, or null when the target table drifted from the registry. */
export function dwellirEntryForChain(chainId: string) {
  return RPC_PARITY_DWELLIR_ENTRY_BY_CHAIN[chainId] ?? null;
}

/** Host label used in stored samples and the trial report (e.g. "api-base-mainnet-archive.n.dwellir.com"). */
export function dwellirHostForChain(chainId: string): string | null {
  const entry = dwellirEntryForChain(chainId);
  return entry ? `${entry.host}.n.dwellir.com` : null;
}

/**
 * The reviewed comparator: the first registry endpoint, or an explicit
 * operator pin where archival state/log representation needs a fixed reference.
 * An authenticated pin never substitutes a native/public fallback.
 *
 * Resolution performs no network reads. Missing registry endpoints or paid-pin
 * configuration/auth resolve to null, so the run records a no-comparator skip
 * instead of inventing a reference or borrowing an unrelated origin's auth.
 */
export function resolveRpcParityComparator(
  target: RpcParityTarget,
  chainRpcs: Map<string, ChainRpcConfig>,
  step: "state" | "logs" = "state",
): RpcParityComparatorTarget | null {
  const plan = step === "logs" ? target.logsComparator ?? target.comparator : target.comparator;
  if (plan.source === "pin") {
    const operator = plan.operator ?? "public";
    const url = plan.url;
    if (operator !== "public") {
      const configured = getChainRpc(chainRpcs, target.chainId)?.endpoints.some((endpoint) => (
        endpoint.operator === operator && endpoint.url === url
      ));
      if (!configured || getRpcAuth(url)?.provider !== operator) return null;
    }
    return buildComparator(operator, url, "pin");
  }

  const endpoint = registryRpcEndpoints(getChainRpc(chainRpcs, target.chainId))
    .find((candidate) => candidate.operator !== "dwellir");
  if (!endpoint) return null;
  // `.find` narrows the element, not the endpoint's discriminated operator
  // field, so the dwellir exclusion is restated where the compiler can see it.
  if (endpoint.operator === "dwellir") return null;
  return buildComparator(endpoint.operator, endpoint.url, "registry");
}

function buildComparator(
  operator: RpcParityComparatorOperator,
  url: string,
  source: RpcParityComparatorSource,
): RpcParityComparatorTarget | null {
  let host: string;
  try {
    host = new URL(url).host;
  } catch {
    return null;
  }
  if (!host) return null;
  return { url, ref: { operator, host, source } };
}

/**
 * Comparator reported for a chain that has no retained sample yet: the
 * planned operator pin or unkeyed registry fallback. It is not an observation,
 * and every observed sample overrides it; paid pins still require configuration.
 */
export function plannedRpcParityComparator(target: RpcParityTarget, step: "state" | "logs" = "state"): RpcParityComparatorRef {
  const plan = step === "logs" ? target.logsComparator ?? target.comparator : target.comparator;
  if (plan.source === "pin") {
    return { operator: plan.operator ?? "public", host: new URL(plan.url).host, source: "pin" };
  }
  const publicUrl = getPublicRpcUrl(target.chainId);
  return {
    operator: "public",
    host: publicUrl ? new URL(publicUrl).host : "",
    source: "registry",
  };
}
