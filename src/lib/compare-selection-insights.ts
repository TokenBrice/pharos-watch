import { BACKING_LABELS, GOVERNANCE_LABELS, PEG_LABELS_SHORT } from "@shared/lib/classification";
import { CLIENT_TRACKED_META_BY_ID as TRACKED_META_BY_ID } from "@shared/lib/stablecoins/client-registry";
import type { CoinOption } from "@/lib/compare-types";

type CompareSelectionLink = Pick<CoinOption, "id" | "symbol">;

export interface CompareSelectionInsights {
  /** Null when the set mixes NAV-accruing tokens into a single peg flag: they do not target $1. */
  lens: string | null;
  cohort: string;
  structure: string;
  links: readonly CompareSelectionLink[];
}

export function buildCompareSelectionInsights({
  selectedIds,
}: {
  selectedIds: readonly string[];
}): CompareSelectionInsights | null {
  if (selectedIds.length < 2) return null;

  const selectedMeta = selectedIds
    .map((id) => TRACKED_META_BY_ID.get(id))
    .filter((meta): meta is NonNullable<typeof meta> => meta != null);

  if (selectedMeta.length < 2 || selectedMeta.length !== selectedIds.length) return null;

  const pegSet = new Set(selectedMeta.map((coin) => coin.flags.pegCurrency));
  const governanceSet = new Set(selectedMeta.map((coin) => coin.flags.governance));
  const backingSet = new Set(selectedMeta.map((coin) => coin.flags.backing));
  // A NAV-accruing token shares the peg flag but is designed to accrue, not to
  // hold $1: neither a same-peg substitution read nor a common peg target holds.
  const hasNavMember = selectedMeta.some((coin) => coin.flags.navToken === true);
  const samePegSet = pegSet.size === 1;

  const lens =
    samePegSet && hasNavMember
      ? null
      : samePegSet
        ? "Same-peg peer set. Read this screen as a true substitution decision: who keeps the peg cleaner, stays more liquid, and carries the cleaner structural risk profile."
        : "Cross-peg set. Structural differences matter more here than raw deviation, so use the panels below to separate currency exposure from stablecoin design risk.";

  const cohort =
    governanceSet.size === 1
      ? `Shared governance model across the set: ${GOVERNANCE_LABELS[selectedMeta[0].flags.governance] ?? selectedMeta[0].flags.governance}.`
      : "Mixed governance models across the selected assets.";

  const structure =
    backingSet.size === 1
      ? `Shared backing profile: ${BACKING_LABELS[selectedMeta[0].flags.backing] ?? selectedMeta[0].flags.backing}.`
      : "Mixed backing structures across the set.";

  const pegContext =
    samePegSet
      ? hasNavMember
        ? ""
        : `Common peg target: ${PEG_LABELS_SHORT[selectedMeta[0].flags.pegCurrency] ?? selectedMeta[0].flags.pegCurrency}.`
      : "Multiple peg targets are represented in the selected set.";

  return {
    lens,
    cohort,
    structure: pegContext ? `${structure} ${pegContext}` : structure,
    links: selectedMeta.map((coin) => ({ id: coin.id, symbol: coin.symbol })),
  };
}
