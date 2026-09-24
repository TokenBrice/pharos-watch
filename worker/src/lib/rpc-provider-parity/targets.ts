import {
  DWELLIR_CHAINS,
  getChainRpc,
  registryRpcEndpoints,
  type ChainRpcConfig,
} from "../chain-registry";
import { getPublicRpcUrl } from "../public-rpc-registry";
import type {
  RpcParityComparatorOperator,
  RpcParityComparatorRef,
  RpcParityComparatorSource,
} from "./types";

/**
 * The tracked contract and comparator for every chain Dwellir serves.
 *
 * One target per `DWELLIR_CHAINS` entry, in registry order: the contract is the
 * chain's own deployment of a coin this repo already tracks (so a parity
 * mismatch is a real read disagreement, not a wrong address), and the
 * comparator is either the chain's first registry operator or a keyless public
 * pin that is already cited elsewhere in the repo.
 *
 * `blockTimeSec` is nominal and is used for exactly two things: the margin
 * below the lowest head at which both operators are read, and the head-lag gate
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
  readonly comparator: RpcParityComparatorPlan;
}

export type RpcParityComparatorPlan =
  | { readonly source: "registry" }
  | { readonly source: "pin"; readonly url: string };

/**
 * Address provenance: `shared/data/stablecoins/coins/usdc-circle.json`,
 * `usdt-tether.json` (plasma, megaeth), and `usde-ethena.json` (blast,
 * robinhood). Pin provenance: the public endpoints onchain-supply-probe.ts and
 * public-rpc-registry.ts already read for these chains. XDC is the exception in
 * its source, not in its role: the reviewed `rpc.xinfin.network` endpoint now
 * answers Cloudflare error 1010 for some user agents, so the pin is
 * `rpc.xdcrpc.com` (verified eth_chainId 0x32 with and without a User-Agent).
 */
export const RPC_PARITY_TARGETS: readonly RpcParityTarget[] = [
  { chainId: "ethereum", coinId: "usdc-circle", contract: "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48", blockTimeSec: 12, comparator: { source: "registry" } },
  { chainId: "arbitrum", coinId: "usdc-circle", contract: "0xaf88d065e77c8cc2239327c5edb3a432268e5831", blockTimeSec: 0.25, comparator: { source: "registry" } },
  { chainId: "base", coinId: "usdc-circle", contract: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913", blockTimeSec: 2, comparator: { source: "registry" } },
  { chainId: "optimism", coinId: "usdc-circle", contract: "0x0b2c639c533813f4aa9d7837caf62653d097ff85", blockTimeSec: 2, comparator: { source: "registry" } },
  { chainId: "polygon", coinId: "usdc-circle", contract: "0x3c499c542cef5e3811e1192ce70d8cc03d5c3359", blockTimeSec: 2, comparator: { source: "registry" } },
  { chainId: "avalanche", coinId: "usdc-circle", contract: "0xb97ef9ef8734c71904d8002f8b6bc66dd9c48a6e", blockTimeSec: 2, comparator: { source: "registry" } },
  { chainId: "bsc", coinId: "usdc-circle", contract: "0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d", blockTimeSec: 0.75, comparator: { source: "registry" } },
  { chainId: "gnosis", coinId: "usdc-circle", contract: "0xddafbb505ad214d7b80b1f830fccc89b60fb7a83", blockTimeSec: 5, comparator: { source: "registry" } },
  { chainId: "celo", coinId: "usdc-circle", contract: "0xceba9300f2b948710d2653dd7b07f33a8b32118c", blockTimeSec: 1, comparator: { source: "registry" } },
  { chainId: "tempo", coinId: "usdc-circle", contract: "0x20c000000000000000000000b9537d11c60e8b50", blockTimeSec: 1, comparator: { source: "registry" } },
  { chainId: "plasma", coinId: "usdt-tether", contract: "0xb8ce59fc3717ada4c02eadf9682a9e934f625ebb", blockTimeSec: 1, comparator: { source: "registry" } },
  { chainId: "monad", coinId: "usdc-circle", contract: "0x754704bc059f8c67012fed69bc8a327a5aafb603", blockTimeSec: 0.4, comparator: { source: "registry" } },
  { chainId: "mantle", coinId: "usdc-circle", contract: "0x09bc4e0d864854c6afb6eb9a9cdf58ac190d0df9", blockTimeSec: 2, comparator: { source: "registry" } },
  { chainId: "sonic", coinId: "usdc-circle", contract: "0x29219dd400f2bf60e5a23d13be72b486d4038894", blockTimeSec: 1, comparator: { source: "registry" } },
  { chainId: "hyperevm", coinId: "usdc-circle", contract: "0xb88339cb7199b77e23db6e890353e22632ba630f", blockTimeSec: 1, comparator: { source: "pin", url: "https://rpc.hyperliquid.xyz/evm" } },
  { chainId: "linea", coinId: "usdc-circle", contract: "0x176211869ca2b568f2a7d4ee941e073a821ee1ff", blockTimeSec: 2, comparator: { source: "pin", url: "https://rpc.linea.build" } },
  { chainId: "berachain", coinId: "usdc-circle", contract: "0x549943e04f40284185054145c6e4e9568c1d3241", blockTimeSec: 2, comparator: { source: "pin", url: "https://rpc.berachain.com" } },
  { chainId: "ink", coinId: "usdc-circle", contract: "0x2d270e6886d130d724215a266106e6832161eaed", blockTimeSec: 1, comparator: { source: "pin", url: "https://rpc-gel.inkonchain.com" } },
  { chainId: "zksync", coinId: "usdc-circle", contract: "0x1d17cbcf0d6d143135ae902365d2e5e2a16538d4", blockTimeSec: 1, comparator: { source: "pin", url: "https://mainnet.era.zksync.io" } },
  { chainId: "stable", coinId: "usdc-circle", contract: "0x8a2b28364102bea189d99a475c494330ef2bdd0b", blockTimeSec: 1, comparator: { source: "pin", url: "https://rpc.stable.xyz" } },
  { chainId: "megaeth", coinId: "usdt-tether", contract: "0xb8ce59fc3717ada4c02eadf9682a9e934f625ebb", blockTimeSec: 0.01, comparator: { source: "pin", url: "https://mainnet.megaeth.com/rpc" } },
  { chainId: "worldchain", coinId: "usdc-circle", contract: "0x79a02482a880bce3f13e09da970dc34db4cd24d1", blockTimeSec: 2, comparator: { source: "pin", url: "https://worldchain-mainnet.g.alchemy.com/public" } },
  { chainId: "scroll", coinId: "usdc-circle", contract: "0x06efdbff2a14a7c8e15944d1f4a48f9f95f663a4", blockTimeSec: 3, comparator: { source: "pin", url: "https://rpc.scroll.io" } },
  { chainId: "unichain", coinId: "usdc-circle", contract: "0x078d782b760474a361dda0af3839290b0ef57ad6", blockTimeSec: 1, comparator: { source: "pin", url: "https://mainnet.unichain.org" } },
  { chainId: "xdc", coinId: "usdc-circle", contract: "0xfa2958cb79b0491cc627c1557f441ef849ca8eb1", blockTimeSec: 2, comparator: { source: "pin", url: "https://rpc.xdcrpc.com" } },
  { chainId: "blast", coinId: "usde-ethena", contract: "0x5d3a1ff2b6bab83b63cd9ad0787074081a52ef34", blockTimeSec: 2, comparator: { source: "pin", url: "https://rpc.blast.io" } },
  { chainId: "manta", coinId: "usdc-circle", contract: "0xb73603c5d87fa094b7314c74ace2e64d165016fb", blockTimeSec: 12, comparator: { source: "pin", url: "https://pacific-rpc.manta.network/http" } },
  { chainId: "robinhood", coinId: "usde-ethena", contract: "0x5d3a1ff2b6bab83b63cd9ad0787074081a52ef34", blockTimeSec: 1, comparator: { source: "pin", url: "https://rpc.mainnet.chain.robinhood.com" } },
  { chainId: "arc", coinId: "usdc-circle", contract: "0x3600000000000000000000000000000000000000", blockTimeSec: 1, comparator: { source: "registry" } },
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
 * The chain's current first operator: its first registry endpoint (Alchemy or
 * dRPC when keyed, otherwise the reviewed public endpoint), or the target's
 * reviewed public pin for the chains this repo reads without a registry config.
 *
 * Read failures are not possible here — a registry chain with no registry
 * endpoint and a pin target without a URL both resolve to `null`, and the run
 * skips that chain instead of inventing a comparator.
 */
export function resolveRpcParityComparator(
  target: RpcParityTarget,
  chainRpcs: Map<string, ChainRpcConfig>,
): RpcParityComparatorTarget | null {
  if (target.comparator.source === "pin") {
    return buildComparator("public", target.comparator.url, "pin");
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
 * keyless operator the lane would fall back to. It is a planned claim, not an
 * observation, and every observed sample overrides it.
 */
export function plannedRpcParityComparator(target: RpcParityTarget): RpcParityComparatorRef {
  if (target.comparator.source === "pin") {
    return { operator: "public", host: new URL(target.comparator.url).host, source: "pin" };
  }
  const publicUrl = getPublicRpcUrl(target.chainId);
  return {
    operator: "public",
    host: publicUrl ? new URL(publicUrl).host : "",
    source: "registry",
  };
}
