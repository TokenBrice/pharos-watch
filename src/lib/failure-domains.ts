import { CHAIN_META } from "@shared/lib/chains";
import type { SafetyScoreV9CurrentCard } from "@shared/types/safety-score-v9-public";

/**
 * Shared failure domains behind an asset's deployments, read from the V9
 * deployment-risk trace already carried on the report card.
 *
 * The engine writes a publishable `reason` for every row, including the
 * cross-asset context ("123 reviewed paths across 19 assets share this domain"),
 * so this module only resolves the machine key to a label and sorts by exposure.
 */

export type FailureDomainKind = "chain" | "bridge" | "other";

export interface FailureDomainRow {
  key: string;
  label: string;
  kind: FailureDomainKind;
  /** Share of reviewed supply behind this domain; null when unquantified. */
  exposureShare: number | null;
  /** Points the domain actually cost the score. Zero is common and meaningful. */
  adjustmentPoints: number;
  resolved: boolean;
  reason: string;
}

export interface FailureDomainsView {
  rows: FailureDomainRow[];
  totalAdjustmentPoints: number;
}

const PROTOCOL_LABELS: Record<string, string> = {
  "layerzero-v2": "LayerZero V2",
  layerzero: "LayerZero",
  "chainlink-ccip": "Chainlink CCIP",
  "wormhole-ntt": "Wormhole NTT",
  wormhole: "Wormhole",
};

function titleCase(slug: string): string {
  return slug
    .split("-")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
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
    return { label: CHAIN_META[chainId]?.name ?? titleCase(chainId), kind: "chain" };
  }

  const protocolPart = key.split("+").find((part) => part.startsWith("bridge-route:protocol:"));
  if (protocolPart) {
    const slug = protocolPart.slice("bridge-route:protocol:".length);
    return { label: PROTOCOL_LABELS[slug] ?? titleCase(slug), kind: "bridge" };
  }

  if (key.startsWith("bridge-route:")) {
    // `bridge-route:contract:<chain>:<address>` and its authority/program kin.
    const chainId = key.split("+")[0]?.split(":")[2] ?? "";
    const chainName = CHAIN_META[chainId]?.name ?? (chainId ? titleCase(chainId) : "");
    return { label: chainName ? `Bridge contract on ${chainName}` : "Bridge contract", kind: "bridge" };
  }

  return { label: titleCase(key.replace(/:/g, " ")), kind: "other" };
}

export function buildFailureDomainsView(
  card: SafetyScoreV9CurrentCard | null | undefined,
): FailureDomainsView | null {
  const trace = card?.scoreTrace?.deploymentRisk;
  if (!trace) return null;

  const rows: FailureDomainRow[] = [];
  for (const adjustment of trace.adjustments) {
    const { label, kind } = describeFailureDomain(adjustment.failureDomainKey);
    rows.push({
      key: `resolved:${adjustment.exposureKey}:${adjustment.failureDomainKey}`,
      label,
      kind,
      exposureShare: adjustment.exposureShare,
      adjustmentPoints: adjustment.adjustmentPoints,
      resolved: true,
      reason: adjustment.reason,
    });
  }
  for (const exposure of trace.unresolvedExposures) {
    const { label, kind } = describeFailureDomain(exposure.failureDomainKeys[0] ?? "");
    rows.push({
      key: `unresolved:${exposure.exposureKey}:${exposure.failureDomainKeys.join("+")}`,
      label,
      kind,
      exposureShare: null,
      adjustmentPoints: 0,
      resolved: false,
      reason: exposure.reason,
    });
  }

  if (rows.length === 0) return null;

  // Costly domains first, then largest exposure; unquantified exposures last.
  rows.sort((left, right) =>
    right.adjustmentPoints - left.adjustmentPoints
    || (right.exposureShare ?? -1) - (left.exposureShare ?? -1)
    || left.label.localeCompare(right.label),
  );

  return { rows, totalAdjustmentPoints: trace.totalAdjustmentPoints ?? 0 };
}
