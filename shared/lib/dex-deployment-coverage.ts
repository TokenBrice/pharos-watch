import { CG_CHAIN_MAP, DS_CHAIN_MAP, GT_CHAIN_MAP } from "./chains";
import { canonicalExitRouteScopedId } from "./exit-route-identity";
import { getAddress } from "viem/utils";

export type DexDeploymentOutcome = "observed_pools" | "verified_no_pools" | "provider_inaccessible";
export type DexDiscoveryProvider =
  | "coingecko"
  | "geckoterminal"
  | "dexscreener"
  | "curve"
  | "horizon"
  | "aquarius"
  | "tezos"
  | "icon-balanced"
  | "kava-swap"
  | "osmosis-sqs"
  | "noble-swap";

/**
 * The chains on which Curve's getPools/all endpoint is queried and counts as a
 * registered token-pool discovery provider. This is the single definition:
 * `getDexDiscoveryProviders()` names it in the persisted `providers` array
 * that the deployment census validates against, and both Curve fetch paths
 * derive their query list from it.
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
  "optimism",
  "avalanche",
  "fantom",
  "kava",
  "gnosis",
]);

/** Native Horizon liquidity-pool discovery is currently scoped to classic Stellar assets. */
const HORIZON_DISCOVERY_CHAINS: ReadonlySet<string> = new Set(["stellar"]);

// eslint-disable-next-line security/detect-unsafe-regex -- anchored bounded optional code prefix plus fixed-width base32 contract id; linear, no backtracking ambiguity.
const AQUARIUS_SOROBAN_IDENTITY_RE = /^(?:[A-Za-z0-9]{1,12}-)?(C[A-Z2-7]{55})$/;

/** The exact eight Spiko Soroban token ids currently covered by Aquarius. */
export const AQUARIUS_SUPPORTED_TOKEN_IDS: Readonly<Record<string, true>> = {
  CBOOCGZSVRSZFRE4U2NWR2B4RXYVJWRCBTGOUD2JPI2TDJPWMTJX7FZP: true,
  CDWOB6T7SVSMMQN5V3P2OPTBAXOP7DAZHGVW3PYTZIKHVFKN6TBSXR6A: true,
  CBGV2QFQBBGEQRUKUMCPO3SZOHDDYO6SCP5CH6TW7EALKVHCXTMWDDOF: true,
  CAGYRRKPFSWKM6SJOE4QAAVYMOSHMDS5WOQ4T5A2E6XNCU7LZZKUNQKP: true,
  CDGSC6BA4TCAOVSFQCUEHDMOIIHYYVNYBT6YEARS4MX3ITAHUINVGQHX: true,
  CDS2GCAQTNQINSCJUJIVBJXILKBWP5PU7LOBGHMP3X47QCQBFKPMTCNT: true,
  CDT3KU6TQZNOHKNOHNAFFDQZDURVC3MSTL4ML7TUTZGNOPBZCLABP4FR: true,
  CARUUX2FZNPH6DGJOEUFSIUQWYHNL5AVDV7PMVSHWL7OBYIBFC76F4TO: true,
};

export const TEZOS_UUSD_DISCOVERY_ADDRESS = "KT1XRPEPXbZK25r3Htzp2o1x7xdMMmfocKNW";

/** Canonical ICON Balanced bnUSD deployment identity. */
export const ICON_BALANCED_BNUSD_DISCOVERY_ADDRESS = "cx88fd7df7ddff82f7cc735c871dc519838cb235bb";

/** Canonical native Kava USDX deployment identity. */
export const KAVA_SWAP_USDX_DISCOVERY_ADDRESS = "usdx";

/**
 * Cosmos bank denominations the two Cosmos census adapters can query.
 *
 * Osmosis' sidecar query server (`sqsprod.osmosis.zone`) and Noble's LCD both
 * address a pool leg by its bank denom, so the registry identity is used
 * verbatim. IBC hashes are case-sensitive on the wire and both chains are
 * `type: "other"` in the chain registry, so `canonicalExitRouteScopedId` leaves
 * them untouched — the census identity and the provider query string are the
 * same string.
 */
const COSMOS_IBC_DENOM_RE = /^ibc\/[0-9A-F]{64}$/;
const COSMOS_FACTORY_DENOM_RE = /^factory\/[a-z0-9]{8,90}\/[A-Za-z0-9._:-]{1,64}$/;
const COSMOS_NATIVE_DENOM_RE = /^[a-z][a-z0-9]{1,63}$/;

function isCosmosDiscoveryDenom(address: string): boolean {
  return (
    COSMOS_IBC_DENOM_RE.test(address) ||
    COSMOS_NATIVE_DENOM_RE.test(address) ||
    COSMOS_FACTORY_DENOM_RE.test(address)
  );
}

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

/** Whether a Soroban deployment is inside the bounded Aquarius Spiko census. */
export function isAquariusSorobanDeployment(chain: string, address?: string): boolean {
  if (chain !== "stellar" || address == null) return false;
  const match = AQUARIUS_SOROBAN_IDENTITY_RE.exec(address.trim().toUpperCase());
  return match?.[1] != null && AQUARIUS_SUPPORTED_TOKEN_IDS[match[1]] === true;
}

/** Whether a deployment is the Tezos uUSD identity covered by the TzKT census. */
export function isTezosDiscoveryDeployment(chain: string, address?: string): boolean {
  return chain === "tezos" && address === TEZOS_UUSD_DISCOVERY_ADDRESS;
}

/** Shared deployment predicate for worker/src/cron/dex-discovery/crawl-icon-balanced-pools.ts. */
export function isIconBalancedDiscoveryDeployment(chain: string, address?: string): boolean {
  return chain === "icon" && address?.trim().toLowerCase() === ICON_BALANCED_BNUSD_DISCOVERY_ADDRESS;
}

/** Shared deployment predicate for worker/src/cron/dex-discovery/crawl-kava-swap-pools.ts. */
export function isKavaSwapDiscoveryDeployment(chain: string, address?: string): boolean {
  return chain === "kava" && address?.trim().toLowerCase() === KAVA_SWAP_USDX_DISCOVERY_ADDRESS;
}

/**
 * Whether an Osmosis deployment can be queried through the Osmosis sidecar
 * query server's denom filter.
 *
 * The filter is served by Osmosis' own indexer across every pool module
 * (balancer, stableswap, concentrated, CosmWasm), which is why the provider is
 * registered exhaustive. `mantra` is deliberately not routed here: its Cosmos
 * IBC denoms live on a different chain whose pools this index does not hold.
 */
export function isOsmosisSqsDiscoveryDeployment(chain: string, address?: string): boolean {
  return chain === "osmosis" && address != null && isCosmosDiscoveryDenom(address.trim());
}

/**
 * Whether a Noble deployment can be queried through Noble's `swap` module.
 *
 * Investigated before wiring (2026-09-01): Noble is a permissioned app-chain
 * with no CosmWasm and no third-party AMM, but it does host a first-party
 * `noble/swap/v1` StableSwap module, so the census answer is a real query
 * rather than a standing not-applicable ruling. That single module is the
 * whole DEX surface of the chain, which is why the provider is exhaustive.
 */
export function isNobleSwapDiscoveryDeployment(chain: string, address?: string): boolean {
  return chain === "noble" && address != null && isCosmosDiscoveryDenom(address.trim());
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

/**
 * Every entry must still satisfy the waiver's own claim — that no registered
 * provider supports the chain. `usdn-noble`/noble and `usdx-kava`/osmosis were
 * removed when the Noble `swap` and Osmosis sidecar providers were registered,
 * and `uusd-youves`/tezos when the TzKT census was; keeping them would publish
 * "no provider supports this chain" beside a census row naming one.
 */
const EXCLUSIVE_UNSUPPORTED_STABLECOINS = [["silk-shade-protocol", "secret"]] as const;

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

export const DEX_DISCOVERY_PROVIDER_EXHAUSTIVENESS: Readonly<Record<DexDiscoveryProvider, boolean>> = {
  coingecko: true,
  geckoterminal: true,
  dexscreener: true,
  curve: true,
  horizon: true,
  aquarius: false, // Aquarius index only; Soroswap/Phoenix are unregistered.
  tezos: true, // TzKT token-holder census is chain-wide by construction.
  "icon-balanced": false, // Balanced venue only, not chain-wide.
  "kava-swap": false, // x/swap module only; Kava EVM venues exist.
  // Osmosis' own sidecar index spans every pool module on the chain.
  "osmosis-sqs": true,
  // Noble's `swap` module is the chain's entire DEX surface (no CosmWasm).
  "noble-swap": true,
};

export function isDexDiscoveryProviderExhaustive(provider: DexDiscoveryProvider): boolean {
  return DEX_DISCOVERY_PROVIDER_EXHAUSTIVENESS[provider];
}

export function getDexDiscoveryProviders(chain: string, address?: string): DexDiscoveryProvider[] {
  const providers: DexDiscoveryProvider[] = [];
  if (CG_CHAIN_MAP[chain]) providers.push("coingecko");
  if (getGeckoTerminalDiscoveryNetwork(chain, address)) providers.push("geckoterminal");
  if (DS_CHAIN_MAP[chain]) providers.push("dexscreener");
  if (CURVE_NATIVE_DISCOVERY_CHAINS.has(chain)) providers.push("curve");
  if (isHorizonDiscoveryDeployment(chain, address)) providers.push("horizon");
  if (isAquariusSorobanDeployment(chain, address)) providers.push("aquarius");
  if (isTezosDiscoveryDeployment(chain, address)) providers.push("tezos");
  if (isIconBalancedDiscoveryDeployment(chain, address)) providers.push("icon-balanced");
  if (isKavaSwapDiscoveryDeployment(chain, address)) providers.push("kava-swap");
  if (isOsmosisSqsDiscoveryDeployment(chain, address)) providers.push("osmosis-sqs");
  if (isNobleSwapDiscoveryDeployment(chain, address)) providers.push("noble-swap");
  return providers;
}

/**
 * Whether a persisted census provider set is contradicted by the live registry.
 *
 * A census row's provider set is a snapshot of a *registry* fact, not an
 * observation: an empty set means "no registered provider supported this chain
 * when the row was written". When discovery coverage for a chain is added, rows
 * written before it keep asserting an empty provider set until the crawl
 * rotation reaches that deployment again — for a windowed footprint that is
 * several runs. The registry, not the row, owns which providers exist, so a
 * contradicted row is superseded metadata awaiting a re-crawl rather than a
 * standing method limit.
 */
export function isCensusProviderSetSupersededByRegistry(
  chain: string,
  address: string | undefined,
  persistedProviderCount: number,
): boolean {
  return persistedProviderCount === 0 && getDexDiscoveryProviders(chain, address).length > 0;
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
