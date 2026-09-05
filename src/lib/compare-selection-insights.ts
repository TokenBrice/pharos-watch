import { BACKING_LABELS, GOVERNANCE_LABELS, PEG_LABELS_SHORT } from "@shared/lib/classification";
import type { CoinOption } from "@/lib/compare-types";
import type { ComparisonCoinEntry } from "@/lib/compare-derive";

type CompareSelectionLink = Pick<CoinOption, "id" | "symbol">;

export interface CompareSelectionInsights {
  lens: string;
  cohort: string;
  structure: string;
  links: readonly CompareSelectionLink[];
}

export function buildCompareSelectionInsights({
  selectedIds,
  selectedCoins,
  comparisonCoins,
}: {
  selectedIds: readonly string[];
  selectedCoins: readonly (CoinOption | null)[];
  comparisonCoins: readonly ComparisonCoinEntry[];
}): CompareSelectionInsights | null {
  if (selectedIds.length < 2) return null;

  const selectedLinks = selectedCoins.filter((coin): coin is CoinOption => coin !== null);

  if (comparisonCoins.length < 2) {
    return {
      lens: "Build the peer set first, then read peg behavior, liquidity, and safety in the same frame instead of hopping between detail pages.",
      cohort: "Live metadata is still loading for the selected set.",
      structure: "The comparison panels below will sharpen once the full dataset lands.",
      links: selectedLinks,
    };
  }

  const comparisonMeta = comparisonCoins;

  const pegSet = new Set(comparisonMeta.map((coin) => coin.meta.flags.pegCurrency));
  const governanceSet = new Set(comparisonMeta.map((coin) => coin.meta.flags.governance));
  const backingSet = new Set(comparisonMeta.map((coin) => coin.meta.flags.backing));

  const lens =
    pegSet.size === 1
      ? "Same-peg peer set. Read this screen as a true substitution decision: who keeps the peg cleaner, stays more liquid, and carries the cleaner structural risk profile."
      : "Cross-peg set. Structural differences matter more here than raw deviation, so use the panels below to separate currency exposure from stablecoin design risk.";

  const cohort =
    governanceSet.size === 1
      ? `Shared governance model across the set: ${GOVERNANCE_LABELS[comparisonMeta[0].meta.flags.governance] ?? comparisonMeta[0].meta.flags.governance}.`
      : "Mixed governance models across the selected assets.";

  const structure =
    backingSet.size === 1
      ? `Shared backing profile: ${BACKING_LABELS[comparisonMeta[0].meta.flags.backing] ?? comparisonMeta[0].meta.flags.backing}.`
      : "Mixed backing structures across the set.";

  const pegContext =
    pegSet.size === 1
      ? `Common peg target: ${PEG_LABELS_SHORT[comparisonMeta[0].meta.flags.pegCurrency] ?? comparisonMeta[0].meta.flags.pegCurrency}.`
      : "Multiple peg targets are represented in the selected set.";

  return { lens, cohort, structure: `${structure} ${pegContext}`, links: comparisonMeta };
}
