import type { BridgeRouteRiskTier } from "../../types";

export const L2BEAT_INTEROP_SNAPSHOT_META = {
  source: "https://l2beat.com/interop/summary",
  fetchedAt: "2026-06-12",
  notes:
    "Static snapshot of L2BEAT Interop protocol taxonomy. Runtime scoring does not fetch L2BEAT live.",
} as const;

export type L2BeatInteropProtocolType = "canonical" | "multichain" | "intent" | "other";
export type L2BeatInteropBridgeType = "lockAndMint" | "burnAndMint" | "nonMinting";

export interface L2BeatInteropProtocolSnapshot {
  id: string;
  slug: string;
  name: string;
  type: L2BeatInteropProtocolType;
  bridgeTypes: readonly L2BeatInteropBridgeType[];
}

export const L2BEAT_INTEROP_PROTOCOLS = [
  { id: "avalanche", slug: "avalanche", name: "Avalanche", type: "canonical", bridgeTypes: ["lockAndMint"] },
  { id: "debridge-dln", slug: "debridge-dln", name: "Debridge DLN", type: "intent", bridgeTypes: ["nonMinting"] },
  {
    id: "hyperlane-hwr",
    slug: "hyperlane-hwr",
    name: "Hyperlane Warp Routes",
    type: "multichain",
    bridgeTypes: ["lockAndMint", "burnAndMint"],
  },
  {
    id: "ccip",
    slug: "ccip",
    name: "Chainlink CCIP",
    type: "multichain",
    bridgeTypes: ["nonMinting", "lockAndMint", "burnAndMint"],
  },
  { id: "cctpv1", slug: "cctpv1", name: "CCTP v1", type: "multichain", bridgeTypes: ["burnAndMint"] },
  { id: "cctpv2", slug: "cctpv2", name: "CCTP v2", type: "multichain", bridgeTypes: ["burnAndMint"] },
  { id: "relay", slug: "relay", name: "Relay", type: "intent", bridgeTypes: ["nonMinting"] },
  { id: "gaszip", slug: "gaszip", name: "Gas.zip", type: "intent", bridgeTypes: ["nonMinting"] },
  { id: "lifi", slug: "lifi", name: "LI.FI", type: "intent", bridgeTypes: ["nonMinting"] },
  {
    id: "layerzero",
    slug: "layerzero",
    name: "LayerZero",
    type: "multichain",
    bridgeTypes: ["lockAndMint", "burnAndMint"],
  },
  {
    id: "axelar",
    slug: "axelar",
    name: "Axelar",
    type: "multichain",
    bridgeTypes: ["lockAndMint", "burnAndMint"],
  },
  {
    id: "axelar-its",
    slug: "axelar-its",
    name: "Axelar ITS",
    type: "multichain",
    bridgeTypes: ["lockAndMint", "burnAndMint"],
  },
  { id: "squid", slug: "squid", name: "Squid", type: "intent", bridgeTypes: ["nonMinting"] },
  { id: "fusionplus", slug: "fusionplus", name: "1inch Fusion+", type: "intent", bridgeTypes: ["nonMinting"] },
  {
    id: "circlegateway",
    slug: "circlegateway",
    name: "Circle Gateway",
    type: "multichain",
    bridgeTypes: ["burnAndMint"],
  },
  { id: "wormhole-wtt", slug: "wormhole-wtt", name: "Wormhole WTT", type: "other", bridgeTypes: ["lockAndMint"] },
  {
    id: "wormhole-ntt",
    slug: "wormhole-ntt",
    name: "Wormhole NTT",
    type: "multichain",
    bridgeTypes: ["lockAndMint", "burnAndMint"],
  },
  { id: "mayan", slug: "mayan", name: "Mayan", type: "intent", bridgeTypes: ["nonMinting"] },
  { id: "meson", slug: "meson", name: "Meson", type: "intent", bridgeTypes: ["nonMinting"] },
  { id: "across", slug: "across", name: "Across", type: "intent", bridgeTypes: ["nonMinting"] },
  { id: "debridge", slug: "debridge", name: "deBridge", type: "other", bridgeTypes: ["lockAndMint"] },
  { id: "stargate", slug: "stargate", name: "Stargate", type: "intent", bridgeTypes: ["nonMinting", "lockAndMint"] },
  { id: "cbridge", slug: "cbridge", name: "Celer cBridge", type: "intent", bridgeTypes: ["nonMinting"] },
  { id: "abstract", slug: "abstract", name: "Abstract", type: "canonical", bridgeTypes: ["lockAndMint"] },
  { id: "arbitrum", slug: "arbitrum", name: "Arbitrum Canonical", type: "canonical", bridgeTypes: ["lockAndMint"] },
  { id: "base", slug: "base", name: "Base Canonical", type: "canonical", bridgeTypes: ["lockAndMint"] },
  { id: "celo", slug: "celo", name: "Celo Canonical", type: "canonical", bridgeTypes: ["lockAndMint"] },
  { id: "ink", slug: "ink", name: "Ink Canonical", type: "canonical", bridgeTypes: ["lockAndMint"] },
  { id: "lighter", slug: "lighter", name: "Lighter", type: "canonical", bridgeTypes: ["lockAndMint"] },
  { id: "megaeth", slug: "megaeth", name: "MegaETH Canonical", type: "canonical", bridgeTypes: ["lockAndMint"] },
  {
    id: "optimism",
    slug: "op-mainnet",
    name: "OP Canonical",
    type: "canonical",
    bridgeTypes: ["lockAndMint", "burnAndMint"],
  },
  { id: "polygon-pos", slug: "polygon-pos", name: "Polygon PoS", type: "canonical", bridgeTypes: ["lockAndMint"] },
  { id: "unichain", slug: "unichain", name: "Unichain Canonical", type: "canonical", bridgeTypes: ["lockAndMint"] },
  {
    id: "worldchain",
    slug: "world",
    name: "World Chain Canonical",
    type: "canonical",
    bridgeTypes: ["lockAndMint"],
  },
  { id: "zksync2", slug: "zksync-era", name: "ZKsync Era", type: "canonical", bridgeTypes: ["lockAndMint"] },
  { id: "hyperliquid", slug: "hyperliquid", name: "Hyperliquid", type: "canonical", bridgeTypes: ["lockAndMint"] },
  { id: "agglayer", slug: "agglayer", name: "Agglayer", type: "canonical", bridgeTypes: ["lockAndMint", "burnAndMint"] },
] as const satisfies readonly L2BeatInteropProtocolSnapshot[];

export type L2BeatInteropProtocolId = (typeof L2BEAT_INTEROP_PROTOCOLS)[number]["id"];

const EXTRA_PROTOCOL_SEARCH_TERMS: Partial<Record<L2BeatInteropProtocolId, readonly string[]>> = {
  avalanche: ["avalanche bridge"],
  "hyperlane-hwr": ["hyperlane warp routes", "hyperlane"],
  cctpv2: ["cctp v2", "cctp"],
  relay: ["relay protocol", "relay bridge", "l2beat.com interop protocols relay"],
  layerzero: ["layerzero", "layerzero oft", "oft"],
  fusionplus: ["1inch fusion+", "fusion+"],
  "wormhole-wtt": ["wormhole wtt", "wormhole wrapped token transfers"],
  "wormhole-ntt": ["wormhole ntt", "native token transfers"],
  abstract: ["abstract canonical"],
  optimism: ["op canonical", "optimism canonical", "op mainnet canonical"],
  "polygon-pos": ["polygon pos bridge", "polygon pos"],
  zksync2: ["zksync era canonical", "zksync canonical"],
};

const AMBIGUOUS_SINGLE_TOKEN_TERMS = new Set(["base", "ink", "oft", "relay"]);

function normalizeSearchText(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, " ");
}

function searchTermsForProtocol(protocol: (typeof L2BEAT_INTEROP_PROTOCOLS)[number]): string[] {
  const terms = [protocol.id, protocol.slug, protocol.name, ...(EXTRA_PROTOCOL_SEARCH_TERMS[protocol.id] ?? [])];
  const normalizedTerms: string[] = [];
  const seen = new Set<string>();

  for (const term of terms) {
    const normalizedTerm = normalizeSearchText(term).trim();
    if (!normalizedTerm || AMBIGUOUS_SINGLE_TOKEN_TERMS.has(normalizedTerm) || seen.has(normalizedTerm)) {
      continue;
    }
    seen.add(normalizedTerm);
    normalizedTerms.push(normalizedTerm);
  }

  return normalizedTerms;
}

function containsSearchTerm(normalizedText: string, normalizedTerm: string): boolean {
  return ` ${normalizedText.trim()} `.includes(` ${normalizedTerm} `);
}

export function suggestBridgeRouteRiskTierFromL2BeatProtocol(
  protocol: L2BeatInteropProtocolSnapshot,
): BridgeRouteRiskTier {
  if (protocol.type === "canonical") return "canonical-rollup-bridge";
  if (protocol.id === "cctpv1" || protocol.id === "cctpv2" || protocol.id === "circlegateway") {
    return "issuer-native-burn-mint";
  }
  if (protocol.type === "intent") return "liquidity-or-intent-route";
  if (protocol.bridgeTypes.includes("lockAndMint")) return "external-lock-mint";
  if (protocol.bridgeTypes.includes("burnAndMint")) return "external-validated-network";
  return "opaque-or-unknown";
}

export function findL2BeatInteropProtocolReferences(text: string): L2BeatInteropProtocolSnapshot[] {
  const normalized = normalizeSearchText(text);
  if (!normalized) return [];
  const matches: L2BeatInteropProtocolSnapshot[] = [];

  for (const protocol of L2BEAT_INTEROP_PROTOCOLS) {
    const terms = searchTermsForProtocol(protocol);
    if (terms.some((term) => containsSearchTerm(normalized, term))) {
      matches.push(protocol);
    }
  }

  return matches.sort((left, right) => left.name.localeCompare(right.name));
}
