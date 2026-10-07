import type { SafetyScoreV9CurrentCard } from "@shared/types";
import { CHAIN_META } from "@shared/types/chain-identity";
import { ACCESS_LOOKTHROUGH_CAPABILITY_LABELS, ACCESS_LOOKTHROUGH_COVERAGE_LABELS, ACCESS_LOOKTHROUGH_REASON_LABELS } from "@shared/lib/classification";
import {
  humanizeSafetyScoreV9Value,
  isUnknownSafetyScoreV9Value,
} from "@/lib/stablecoin-safety-score-v9-presentation-helpers";
import { titleCaseSlug } from "@/lib/title-case-slug";

const ACCESS_FIELDS = [
  ["transfer", "Transfer"],
  ["freezeExposure", "Freeze exposure"],
  ["primaryExit", "Primary exit"],
  ["governance", "Governance"],
] as const;

export interface StablecoinSafetyScoreV9AccessRow {
  key: string;
  label: string;
  value: string;
}

/** Access posture rows for the summary rail; unknown fields drop out. */
export function buildSafetyScoreV9AccessRows(
  card: SafetyScoreV9CurrentCard,
): StablecoinSafetyScoreV9AccessRow[] {
  const rows: StablecoinSafetyScoreV9AccessRow[] = ACCESS_FIELDS.flatMap(([key, label]) => {
    const value = card.accessPosture[key];
    return isUnknownSafetyScoreV9Value(value) ? [] : [{ key, label, value: humanizeSafetyScoreV9Value(value) }];
  });
  const summary = card.accessPosture.freezeLookthrough;
  if (!summary) return rows;
  rows.push({ key: "reserve-access-coverage", label: "Reserve access (diagnostic)", value: ACCESS_LOOKTHROUGH_COVERAGE_LABELS[summary.coverageState] });
  // The authority key identifies the row only; the reader sees the capability
  // (label), the chain it acts on and its known reach, never an internal key.
  for (const authority of summary.authorities) {
    const reach = authority.knownReachShare === null
      ? "known reach unquantified"
      : `${(100 * authority.knownReachShare).toFixed(1)}% known reach`;
    const chainId = authority.actingDeployment.chainId;
    const chainName = CHAIN_META[chainId]?.name ?? titleCaseSlug(chainId);
    rows.push({ key: `reserve-access:${authority.authorityKey}`, label: `${ACCESS_LOOKTHROUGH_CAPABILITY_LABELS[authority.capability]} (diagnostic)`, value: `On ${chainName} · ${reach}; authorities are not additive` });
  }
  rows.push({ key: "reserve-access-unknown", label: "Unknown reserve-access remainder", value: summary.unresolvedCoverageShare === null ? "Unknown / unquantified" : `${(100 * summary.unresolvedCoverageShare).toFixed(1)}%` });
  for (const branch of summary.unresolved) rows.push({ key: `reserve-access-gap:${branch.branchKey}`, label: "Reserve-access diagnostic", value: ACCESS_LOOKTHROUGH_REASON_LABELS[branch.reason] });
  return rows;
}
