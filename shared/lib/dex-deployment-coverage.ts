import { CG_CHAIN_MAP, DS_CHAIN_MAP, GT_CHAIN_MAP } from "./chains";
import { canonicalExitRouteScopedId } from "./exit-route-identity";

export type DexDeploymentOutcome = "observed_pools" | "verified_no_pools" | "provider_inaccessible";
export type DexDiscoveryProvider = "coingecko" | "geckoterminal" | "dexscreener" | "curve" | "horizon";

/**
 * The chains on which Curve counts as a registered token-pool discovery
 * provider. This is the single definition: `getDexDiscoveryProviders()` names
 * it in the persisted `providers` array that the deployment census validates
 * against, and the discovery crawl queries exactly these chains.
 *
 * Querying Curve outside this set produced evidence the census could not
 * attribute — a Curve `success` could flip a deployment to `verified_no_pools`
 * while the recorded provider list named only the providers that failed, which
 * is how a known-empty exit surface got certified on evidence no named provider
 * produced.
 */
export const CURVE_NATIVE_DISCOVERY_CHAINS: ReadonlySet<string> = new Set([
  "ethereum",
  "base",
  "arbitrum",
  "polygon",
  "fraxtal",
  "sonic",
  "taiko",
  "zksync",
  "kava",
]);

/** Native Horizon liquidity-pool discovery is currently scoped to Stellar. */
export const HORIZON_DISCOVERY_CHAINS: ReadonlySet<string> = new Set(["stellar"]);

/**
 * GeckoTerminal networks that are safe for the deployment census but are not
 * general-purpose chain-registry mappings. MANTRA is intentionally absent:
 * Pharos' `mantra` footprint mixes EVM contracts and Cosmos IBC denoms, while
 * GeckoTerminal's network is MANTRA EVM only.
 */
const SUPPLEMENTAL_GECKOTERMINAL_DISCOVERY_NETWORKS: Readonly<Record<string, string>> = {
  starknet: "starknet-alpha",
  stacks: "stacks",
};

const EVM_ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
const STARKNET_ADDRESS_RE = /^0x[0-9a-fA-F]{1,64}$/;

/** Resolve the exact GeckoTerminal network that can query one deployment. */
export function getGeckoTerminalDiscoveryNetwork(chain: string, address?: string): string | null {
  const configured = GT_CHAIN_MAP[chain];
  if (configured) return configured;
  if (chain === "mantra") {
    return address != null && EVM_ADDRESS_RE.test(address.trim()) ? "mantra-evm" : null;
  }
  const supplemental = SUPPLEMENTAL_GECKOTERMINAL_DISCOVERY_NETWORKS[chain];
  if (!supplemental) return null;
  if (address == null) return supplemental;
  if (chain === "starknet" && !STARKNET_ADDRESS_RE.test(address.trim())) return null;
  return address.trim().length > 0 ? supplemental : null;
}

/**
 * Build the provider-specific token query without changing the deployment's
 * persisted identity. GeckoTerminal pads Starknet felt addresses to 64 hex
 * digits, including for relationship ids returned with pool rows.
 */
export function getGeckoTerminalDiscoveryTarget(
  chain: string,
  address: string,
): { network: string; address: string } | null {
  const network = getGeckoTerminalDiscoveryNetwork(chain, address);
  if (!network) return null;
  const canonicalAddress = canonicalExitRouteScopedId(chain, address);
  return {
    network,
    address:
      chain === "starknet"
        ? `0x${canonicalAddress.slice(2).padStart(64, "0").toLowerCase()}`
        : chain === "mantra"
          ? canonicalAddress.toLowerCase()
          : canonicalAddress,
  };
}

export interface DexCoverageWaiver {
  stablecoinId: string;
  chain: string;
  owner: string;
  reason: string;
  expiresAt: number;
}

const EXCLUSIVE_UNSUPPORTED_STABLECOINS = [
  ["usdn-noble", "noble"],
  ["uusd-youves", "tezos"],
  ["usdx-kava", "osmosis"],
  ["silk-shade-protocol", "secret"],
  ["hchf-hedera-swiss-franc", "hedera"],
] as const;

const COVERAGE_WAIVER_EXPIRY_SEC = Date.UTC(2026, 9, 31) / 1000;

/**
 * Temporary ownership for active coins whose entire deployment footprint is
 * outside the discovery-provider registry. These waivers do not turn missing
 * observations into verified no-pool results; they keep the inaccessible
 * classification explicit while an adapter or provider mapping is evaluated.
 */
export const DEX_COVERAGE_WAIVERS: readonly DexCoverageWaiver[] = EXCLUSIVE_UNSUPPORTED_STABLECOINS.map(
  ([stablecoinId, chain]) => ({
    stablecoinId,
    chain,
    owner: "data-platform",
    reason: "No registered token-pool provider supports the coin's only deployment chain",
    expiresAt: COVERAGE_WAIVER_EXPIRY_SEC,
  }),
);

export function getDexDiscoveryProviders(chain: string, address?: string): DexDiscoveryProvider[] {
  const providers: DexDiscoveryProvider[] = [];
  if (CG_CHAIN_MAP[chain]) providers.push("coingecko");
  if (getGeckoTerminalDiscoveryNetwork(chain, address)) providers.push("geckoterminal");
  if (DS_CHAIN_MAP[chain]) providers.push("dexscreener");
  if (CURVE_NATIVE_DISCOVERY_CHAINS.has(chain)) providers.push("curve");
  if (HORIZON_DISCOVERY_CHAINS.has(chain)) providers.push("horizon");
  return providers;
}

export function getActiveDexCoverageWaiver(
  stablecoinId: string,
  chain: string,
  nowSec: number,
): DexCoverageWaiver | null {
  return (
    DEX_COVERAGE_WAIVERS.find(
      (waiver) =>
        waiver.stablecoinId === stablecoinId &&
        waiver.chain === chain &&
        waiver.expiresAt > nowSec &&
        waiver.owner.trim().length > 0,
    ) ?? null
  );
}
