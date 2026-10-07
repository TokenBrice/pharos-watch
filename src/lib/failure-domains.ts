import { CHAIN_META, normalizeChainId } from "@shared/types/chain-identity";
import { normalizeDeploymentId } from "@shared/types/deployment-id";
import type { SafetyScoreV9CurrentCard } from "@shared/types/safety-score-v9-public";
import { groupSafetyScoreReasons } from "@/lib/safety-score-reason-labels";
import { bridgeRouteTierLabel } from "@/lib/stablecoin-detail-bridge-client";
import { titleCaseSlug } from "@/lib/title-case-slug";

/**
 * Shared failure domains behind an asset's deployments, read from the V9
 * deployment-risk trace already carried on the report card.
 *
 * The engine writes one trace entry per exposure slice and failure domain, so
 * one reader-facing domain ("LayerZero V2") can arrive as several entries: a
 * protocol-wide common-mode slice plus per-deployment slices whose compound
 * keys embed the same protocol. Rows merge every entry that resolves to one
 * label, keep the member count for `×N`, and combine shares without counting
 * the same supply twice (see `mergedShare`).
 */

export type FailureDomainKind = "chain" | "bridge" | "other";

/**
 * Deployments a domain covers, in the join keys of `BridgeRouteClientRow`, so a
 * deployment strip can bracket the cells that fail together.
 */
export interface FailureDomainSpan {
  /** Chain domains, and bridge contracts named by chain: every route on these chains. */
  chainIds: string[];
  /** Deployment slices: exact normalized route keys (`<chain>:<address>`). */
  routeKeys: string[];
  /** Protocol domains: routes whose reviewed `protocol:<slug>` domain matches (`BridgeRouteClientRow.protocolKey`). */
  protocolKeys: string[];
}

export interface FailureDomainRow {
  key: string;
  label: string;
  kind: FailureDomainKind;
  /** Trace entries merged under this label; the `×N` when above 1. */
  memberCount: number;
  /**
   * Share of reviewed supply behind this domain, merged across members without
   * double counting; null when any member is unquantified.
   */
  exposureShare: number | null;
  /** Modeled scoring share, including any methodology cap; never the exposure statistic. Merged like `exposureShare`. */
  modeledExposureShare: number | null;
  /** Points the merged entries actually cost the score. Zero is common and meaningful. */
  adjustmentPoints: number;
  /** True only when every member is a resolved, quantified exposure. */
  resolved: boolean;
  /** Reader-facing notes: humanized, deduplicated member reasons, free of evaluator keys. */
  reason: string;
  span: FailureDomainSpan;
}

export interface FailureDomainsView {
  rows: FailureDomainRow[];
  totalAdjustmentPoints: number;
}

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

const DEPLOYMENT_SLICE_PREFIX = "deployment-slice:";
const PROTOCOL_PART_PREFIX = "bridge-route:protocol:";
const BRIDGE_TIER_SLUG_PATTERN =
  /\b(?:single-chain-or-native|issuer-native-burn-mint|canonical-rollup-bridge|issuer-native-lock-mint|external-validated-network|liquidity-or-intent-route|external-lock-mint|opaque-or-unknown)\b/g;

function protocolLabel(slug: string): string {
  return slug
    .split("-")
    .map((word) => {
      if (/^v\d+$/.test(word)) return word.toUpperCase();
      return PROTOCOL_WORDS[word] ?? CHAIN_META[word]?.name ?? titleCaseSlug(word);
    })
    .join(" ");
}

function protocolSlug(key: string): string | null {
  const part = key.split("+").find((segment) => segment.startsWith(PROTOCOL_PART_PREFIX));
  return part ? part.slice(PROTOCOL_PART_PREFIX.length) : null;
}

/** `bridge-route:<kind>:<chain>:<id>` names the chain its first contract sits on. */
function bridgeRouteChainId(key: string): string | null {
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

interface DomainMember {
  exposureKey: string;
  failureDomainKey: string;
  exposureShare: number | null;
  modeledExposureShare: number | null;
  adjustmentPoints: number;
  resolved: boolean;
  reason: string;
}

/**
 * Union share of the members, never a double count. Deployment slices are
 * distinct deployments, so they add (one slice counted once even when several
 * domains reach it). Any other slice (a common-mode slice of a protocol, chain
 * or bridge contract) can cover the same supply as its siblings and as those
 * deployment slices, so it never adds: the merged share is the larger of the
 * biggest such slice and the deployment-slice sum. One unquantified member
 * leaves the whole row unquantified.
 */
function mergedShare(members: readonly DomainMember[], pick: (member: DomainMember) => number | null): number | null {
  const deploymentSlices = new Map<string, number>();
  let widestSlice = 0;
  for (const member of members) {
    const share = pick(member);
    if (share === null) return null;
    if (member.exposureKey.startsWith(DEPLOYMENT_SLICE_PREFIX)) {
      deploymentSlices.set(member.exposureKey, Math.max(deploymentSlices.get(member.exposureKey) ?? 0, share));
    } else {
      widestSlice = Math.max(widestSlice, share);
    }
  }
  let deploymentSum = 0;
  for (const share of deploymentSlices.values()) deploymentSum += share;
  return Math.min(1, Math.max(widestSlice, deploymentSum));
}

function memberSpan(member: DomainMember, span: { chainIds: Set<string>; routeKeys: Set<string>; protocolKeys: Set<string> }) {
  if (member.exposureKey.startsWith(DEPLOYMENT_SLICE_PREFIX)) {
    const routeKey = normalizeDeploymentId(member.exposureKey.slice(DEPLOYMENT_SLICE_PREFIX.length));
    if (routeKey) span.routeKeys.add(routeKey);
  }
  for (const key of member.failureDomainKey.split("+")) {
    if (key.startsWith("chain:")) {
      const chainId = normalizeChainId(key.slice("chain:".length));
      if (chainId) span.chainIds.add(chainId);
    }
  }
  const slug = protocolSlug(member.failureDomainKey);
  if (slug) {
    span.protocolKeys.add(slug);
  } else if (member.failureDomainKey.startsWith("bridge-route:")) {
    // Same chain the "Bridge contract on <chain>" label names.
    const chainId = bridgeRouteChainId(member.failureDomainKey);
    if (chainId) span.chainIds.add(chainId);
  }
}

/** Evaluator keys and bridge-tier slugs become reader words; repeats fold into one counted note. */
function memberNotes(members: readonly DomainMember[]): string {
  return groupSafetyScoreReasons(members.map((member) => member.reason))
    .map((group) => group.text.replace(BRIDGE_TIER_SLUG_PATTERN, (tier) => bridgeRouteTierLabel(tier).toLowerCase()))
    .map((text) => (/[.!?]$/.test(text) ? text : `${text}.`))
    .join(" ");
}

export function buildFailureDomainsView(
  card: SafetyScoreV9CurrentCard | null | undefined,
): FailureDomainsView | null {
  const trace = card?.scoreTrace?.deploymentRisk;
  if (!trace) return null;

  const groups = new Map<string, { label: string; kind: FailureDomainKind; members: DomainMember[] }>();
  function add(domainKey: string, member: DomainMember) {
    const { label, kind } = describeFailureDomain(domainKey);
    const groupKey = `${kind}:${label}`;
    const group = groups.get(groupKey);
    if (group) group.members.push(member);
    else groups.set(groupKey, { label, kind, members: [member] });
  }

  for (const adjustment of trace.adjustments) {
    add(adjustment.failureDomainKey, {
      exposureKey: adjustment.exposureKey,
      failureDomainKey: adjustment.failureDomainKey,
      exposureShare: adjustment.nominalExposureShare,
      modeledExposureShare: adjustment.exposureShare,
      adjustmentPoints: adjustment.adjustmentPoints,
      resolved: true,
      reason: adjustment.reason,
    });
  }
  for (const exposure of trace.unresolvedExposures) {
    // Keys arrive sorted, so a contract key can precede the protocol it routes
    // through; label the joined set the way a compound key is labelled.
    const domainKey = exposure.failureDomainKeys.join("+");
    add(domainKey, {
      exposureKey: exposure.exposureKey,
      failureDomainKey: domainKey,
      exposureShare: null,
      modeledExposureShare: null,
      adjustmentPoints: 0,
      resolved: false,
      reason: exposure.reason,
    });
  }

  if (groups.size === 0) return null;

  const rows: FailureDomainRow[] = [...groups.entries()].map(([groupKey, { label, kind, members }]) => {
    const span = { chainIds: new Set<string>(), routeKeys: new Set<string>(), protocolKeys: new Set<string>() };
    for (const member of members) memberSpan(member, span);
    return {
      key: groupKey,
      label,
      kind,
      memberCount: members.length,
      exposureShare: mergedShare(members, (member) => member.exposureShare),
      modeledExposureShare: mergedShare(members, (member) => member.modeledExposureShare),
      // Rounded so summed floats never print as 0.9324000000000001.
      adjustmentPoints: Math.round(members.reduce((total, member) => total + member.adjustmentPoints, 0) * 10_000) / 10_000,
      resolved: members.every((member) => member.resolved),
      reason: memberNotes(members),
      span: {
        chainIds: [...span.chainIds].sort(),
        routeKeys: [...span.routeKeys].sort(),
        protocolKeys: [...span.protocolKeys].sort(),
      },
    };
  });

  // Costly domains first, then largest exposure; unquantified exposures last.
  rows.sort((left, right) =>
    right.adjustmentPoints - left.adjustmentPoints
    || (right.exposureShare ?? -1) - (left.exposureShare ?? -1)
    || left.label.localeCompare(right.label),
  );

  return { rows, totalAdjustmentPoints: trace.totalAdjustmentPoints ?? 0 };
}
