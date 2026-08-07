import { CG_CHAIN_MAP, DS_CHAIN_MAP, GT_CHAIN_MAP } from "./chains";

export type DexDeploymentOutcome = "observed_pools" | "verified_no_pools" | "provider_inaccessible";
export type DexDiscoveryProvider = "coingecko" | "geckoterminal" | "dexscreener" | "curve";

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
]);

export interface DexCoverageWaiver {
  stablecoinId: string;
  chain: string;
  owner: string;
  reason: string;
  expiresAt: number;
}

const EXCLUSIVE_UNSUPPORTED_STABLECOINS = [
  ["usdn-noble", "noble"],
  ["usdh-hermetica", "stacks"],
  ["ctusd-citrea", "citrea"],
  ["usdm-moneta", "cardano"],
  ["hollar-hydrated", "hydration"],
  ["usda-anzens", "cardano"],
  ["uusd-youves", "tezos"],
  ["cgo-comtech", "xdc"],
  ["jusd-juicedollar", "citrea"],
  ["usdx-kava", "osmosis"],
  ["cdp-enosys", "flare"],
  ["vcred-vcred", "hemi"],
  ["iusd-indigo-protocol", "cardano"],
  ["djed-coti", "cardano"],
  ["pathusd-bridge", "tempo"],
  ["fxd-fathom", "xdc"],
  ["silk-shade-protocol", "secret"],
  ["hchf-hedera-swiss-franc", "hedera"],
  ["iusd-initia", "initia"],
  ["usdcx-movement", "movement"],
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

export function getDexDiscoveryProviders(chain: string): DexDiscoveryProvider[] {
  const providers: DexDiscoveryProvider[] = [];
  if (CG_CHAIN_MAP[chain]) providers.push("coingecko");
  if (GT_CHAIN_MAP[chain]) providers.push("geckoterminal");
  if (DS_CHAIN_MAP[chain]) providers.push("dexscreener");
  if (CURVE_NATIVE_DISCOVERY_CHAINS.has(chain)) providers.push("curve");
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
