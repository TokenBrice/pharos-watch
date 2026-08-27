import { CG_CHAIN_MAP, DS_CHAIN_MAP, GT_CHAIN_MAP } from "./chains";
import { canonicalExitRouteScopedId } from "./exit-route-identity";
import { getAddress } from "viem/utils";

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

/** Native Horizon liquidity-pool discovery is currently scoped to classic Stellar assets. */
export const HORIZON_DISCOVERY_CHAINS: ReadonlySet<string> = new Set(["stellar"]);

/**
 * GeckoTerminal networks that are safe for the deployment census but are not
 * general-purpose chain-registry mappings. MANTRA is intentionally absent:
 * Pharos' `mantra` footprint mixes EVM contracts and Cosmos IBC denoms, while
 * GeckoTerminal's network is MANTRA EVM only.
 */
const SUPPLEMENTAL_GECKOTERMINAL_DISCOVERY_NETWORKS: Readonly<Record<string, string>> = {
  hedera: "hedera-hashgraph",
  injective: "injective",
  starknet: "starknet-alpha",
  stacks: "stacks",
};

const EVM_ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
const STARKNET_ADDRESS_RE = /^0x[0-9a-fA-F]{1,64}$/;
const HEDERA_ENTITY_ID_RE = /^0\.0\.(\d+)$/;
const INJECTIVE_ERC20_RE = /^(?:erc20:)?(0x[0-9a-fA-F]{40})$/i;
const INJECTIVE_PEGGY_RE = /^peggy(0x[0-9a-fA-F]{40})$/i;
const INJECTIVE_IBC_RE = /^ibc\/([0-9a-fA-F]{64})$/;
const INJECTIVE_FACTORY_RE = /^factory\/[^/\s]+\/[^\s]+$/;
const STELLAR_CLASSIC_ASSET_RE = /^[A-Za-z0-9]{1,12}-G[A-Z2-7]{55}$/;
const STELLAR_ISSUER_RE = /^G[A-Z2-7]{55}$/;
const STELLAR_ASSET_CODE_RE = /^[A-Za-z0-9]{1,12}$/;

function isHederaDiscoveryAddress(address: string): boolean {
  return toHederaSolidityAddress(address) !== null;
}

function isInjectiveDiscoveryAddress(address: string): boolean {
  return (
    address === "inj" ||
    INJECTIVE_ERC20_RE.test(address) ||
    INJECTIVE_PEGGY_RE.test(address) ||
    INJECTIVE_IBC_RE.test(address) ||
    INJECTIVE_FACTORY_RE.test(address)
  );
}

function toHederaSolidityAddress(address: string): string | null {
  if (EVM_ADDRESS_RE.test(address)) return address.toLowerCase();
  const match = HEDERA_ENTITY_ID_RE.exec(address);
  if (!match) return null;
  if (match[1].length > 20) return null;
  const entityNumber = BigInt(match[1]);
  if (entityNumber > 0xffffffffffffffffn) return null;
  return `0x${entityNumber.toString(16).padStart(40, "0")}`;
}

function toInjectiveDiscoveryAddress(address: string): string | null {
  if (address === "inj" || INJECTIVE_FACTORY_RE.test(address)) return address;
  const ibcMatch = INJECTIVE_IBC_RE.exec(address);
  if (ibcMatch) return `ibc/${ibcMatch[1].toUpperCase()}`;
  const peggyMatch = INJECTIVE_PEGGY_RE.exec(address);
  if (peggyMatch) return `peggy${getAddress(peggyMatch[1].toLowerCase())}`;
  const erc20Match = INJECTIVE_ERC20_RE.exec(address);
  if (erc20Match) return `erc20:${getAddress(erc20Match[1].toLowerCase())}`;
  return null;
}

/** Whether one Stellar deployment can be queried through Horizon's classic AMM index. */
export function isHorizonDiscoveryDeployment(chain: string, address?: string): boolean {
  if (!HORIZON_DISCOVERY_CHAINS.has(chain)) return false;
  if (address == null) return true;
  const trimmed = address.trim();
  return STELLAR_CLASSIC_ASSET_RE.test(trimmed) || STELLAR_ISSUER_RE.test(trimmed);
}

/** Translate one eligible registry identity to Horizon's `CODE:ISSUER` filter. */
export function getHorizonDiscoveryAsset(address: string, symbol?: string): string | null {
  const trimmed = address.trim();
  const separator = trimmed.indexOf("-");
  if (separator > 0) {
    const code = trimmed.slice(0, separator);
    const issuer = trimmed.slice(separator + 1);
    if (STELLAR_ASSET_CODE_RE.test(code) && STELLAR_ISSUER_RE.test(issuer)) {
      return `${code}:${issuer}`;
    }
  }
  return STELLAR_ISSUER_RE.test(trimmed) && symbol && STELLAR_ASSET_CODE_RE.test(symbol)
    ? `${symbol}:${trimmed}`
    : null;
}

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
  const trimmed = address.trim();
  if (chain === "starknet" && !STARKNET_ADDRESS_RE.test(trimmed)) return null;
  if (chain === "hedera" && !isHederaDiscoveryAddress(trimmed)) return null;
  if (chain === "injective" && !isInjectiveDiscoveryAddress(trimmed)) return null;
  return trimmed.length > 0 ? supplemental : null;
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
  const providerAddress =
    chain === "starknet"
      ? `0x${canonicalAddress.slice(2).padStart(64, "0").toLowerCase()}`
      : chain === "hedera"
        ? toHederaSolidityAddress(canonicalAddress)
        : chain === "injective"
          ? toInjectiveDiscoveryAddress(canonicalAddress)
          : chain === "mantra"
            ? canonicalAddress.toLowerCase()
            : canonicalAddress;
  if (!providerAddress) return null;
  return {
    network,
    address: providerAddress,
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
  if (isHorizonDiscoveryDeployment(chain, address)) providers.push("horizon");
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
