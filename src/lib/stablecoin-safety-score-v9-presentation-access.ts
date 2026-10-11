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
  rows.push({ key: "reserve-access-coverage", label: "Reserve-access coverage", value: ACCESS_LOOKTHROUGH_COVERAGE_LABELS[summary.coverageState] });
  // Authorities that read the same to a holder (capability, acting chain,
  // known reach) merge into one row with a count; the authority key
  // identifies the group only and never reaches the reader.
  const groups = new Map<string, { key: string; label: string; chainName: string; reach: string; count: number }>();
  for (const authority of summary.authorities) {
    const reach = authority.knownReachShare === null
      ? "reach unquantified"
      : `${(100 * authority.knownReachShare).toFixed(1)}% known reach`;
    const chainId = authority.actingDeployment.chainId;
    const chainName = CHAIN_META[chainId]?.name ?? titleCaseSlug(chainId);
    const label = ACCESS_LOOKTHROUGH_CAPABILITY_LABELS[authority.capability];
    const groupKey = [label, chainName, reach].join("|");
    const group = groups.get(groupKey);
    if (group) group.count += 1;
    else groups.set(groupKey, { key: `reserve-access:${authority.authorityKey}`, label, chainName, reach, count: 1 });
  }
  for (const group of groups.values()) {
    rows.push({ key: group.key, label: group.label, value: `${group.chainName}${group.count > 1 ? ` ×${group.count}` : ""} · ${group.reach}` });
  }
  rows.push({ key: "reserve-access-unknown", label: "Unknown remainder", value: summary.unresolvedCoverageShare === null ? "Unknown / unquantified" : `${(100 * summary.unresolvedCoverageShare).toFixed(1)}%` });
  const reasons = new Map<string, { key: string; count: number }>();
  for (const branch of summary.unresolved) {
    const reason = reasons.get(branch.reason);
    if (reason) reason.count += 1;
    else reasons.set(branch.reason, { key: `reserve-access-gap:${branch.branchKey}`, count: 1 });
  }
  for (const [reason, { key, count }] of reasons) {
    rows.push({ key, label: "Unresolved", value: `${ACCESS_LOOKTHROUGH_REASON_LABELS[reason]}${count > 1 ? ` ×${count}` : ""}` });
  }
  return rows;
}
