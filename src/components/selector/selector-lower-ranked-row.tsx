"use client";

import type { SelectorInput, SelectorLowerRanked } from "@shared/lib/selector";
import { PEG_METADATA } from "@shared/lib/classification";
import { getLowerRankedText } from "@shared/lib/selector/what-to-watch-templates";

interface SelectorLowerRankedRowProps {
  entry: SelectorLowerRanked;
  pegCurrency: SelectorInput["pegCurrency"];
}

export function SelectorLowerRankedRow({
  entry,
  pegCurrency,
}: SelectorLowerRankedRowProps) {
  // Snapshot replay stores the lower-ranked entry prose-free, so a shared link
  // re-derives the curated text from the same inputs the live run used instead
  // of falling back to a generic sentence the reader never saw.
  const derived = getLowerRankedText(entry);
  const verdict = entry.verdictText ?? derived.verdictText;
  const teaching = entry.teachingText ?? derived.teachingText;
  const pegLabel = PEG_METADATA[pegCurrency]?.filterLabel ?? pegCurrency;

  return (
    <li className="flex flex-col gap-1 rounded-xl border border-dashed border-border/55 bg-muted/[0.06] px-3.5 py-3 focus-within:border-foreground/45 focus-within:ring-2 focus-within:ring-ring/30 sm:flex-row sm:items-baseline sm:gap-3">
      <p className="min-w-0 break-words text-sm font-semibold tracking-tight text-foreground sm:min-w-fit">
        {verdict} <span className="text-xs font-medium text-muted-foreground">({pegLabel} peg)</span>
      </p>
      <p className="min-w-0 break-words text-sm leading-relaxed text-muted-foreground">{teaching}</p>
    </li>
  );
}
