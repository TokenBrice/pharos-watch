import { CHAIN_META, normalizeChainId } from "@shared/types/chain-identity";
import { titleCaseSlug } from "@/lib/title-case-slug";

export type FailureDomainKind = "chain" | "bridge" | "other";

/**
 * Casing for protocol slug words that title-casing gets wrong ("Layerzero
 * Oft"). Words not listed fall back to the chain registry, then to title case.
 */
const PROTOCOL_WORDS: Record<string, string> = {
  layerzero: "LayerZero",
  oft: "OFT",
  dvns: "DVNs",
  ccip: "CCIP",
  cctp: "CCTP",
  ntt: "NTT",
  ibc: "IBC",
  ics20: "ICS20",
  gmp: "GMP",
  ism: "ISM",
  evm: "EVM",
  pos: "PoS",
  op: "OP",
  zkevm: "zkEVM",
  lxly: "LxLy",
  xreserve: "xReserve",
  starkgate: "StarkGate",
  cbridge: "cBridge",
  hypercore: "HyperCore",
  ovault: "OVault",
  xdai: "xDAI",
  m0: "M0",
};

const PROTOCOL_PART_PREFIX = "bridge-route:protocol:";

function protocolLabel(slug: string): string {
  return slug
    .split("-")
    .map((word) => {
      if (/^v\d+$/.test(word)) return word.toUpperCase();
      return PROTOCOL_WORDS[word] ?? CHAIN_META[word]?.name ?? titleCaseSlug(word);
    })
    .join(" ");
}

export function protocolSlug(key: string): string | null {
  const part = key.split("+").find((segment) => segment.startsWith(PROTOCOL_PART_PREFIX));
  return part ? part.slice(PROTOCOL_PART_PREFIX.length) : null;
}

/** `bridge-route:<kind>:<chain>:<id>` names the chain its first contract sits on. */
export function bridgeRouteChainId(key: string): string | null {
  const chain = key.split("+")[0]?.split(":")[2] ?? "";
  return chain ? normalizeChainId(chain) : null;
}

/**
 * Keys arrive as `chain:<id>`, `bridge-route:protocol:<slug>`, or a compound
 * `+`-joined contract key that often embeds the protocol it routes through.
 * Contract addresses are not a useful rail label, so a compound key resolves to
 * its protocol when one is present and to the routing chain otherwise.
 */
export function describeFailureDomain(key: string): { label: string; kind: FailureDomainKind } {
  if (key.startsWith("chain:")) {
    const chainId = key.slice("chain:".length);
    return { label: CHAIN_META[chainId]?.name ?? titleCaseSlug(chainId), kind: "chain" };
  }

  const slug = protocolSlug(key);
  if (slug) return { label: protocolLabel(slug), kind: "bridge" };

  if (key.startsWith("bridge-route:")) {
    // `bridge-route:contract:<chain>:<address>` and its authority/program kin.
    const chainId = bridgeRouteChainId(key);
    const chainName = chainId ? (CHAIN_META[chainId]?.name ?? titleCaseSlug(chainId)) : "";
    return { label: chainName ? `Bridge contract on ${chainName}` : "Bridge contract", kind: "bridge" };
  }

  return { label: titleCaseSlug(key.replace(/:/g, " ")), kind: "other" };
}
