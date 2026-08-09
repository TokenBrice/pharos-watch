"use client";

import type { SelectorInput, SelectorLowerRanked } from "@shared/lib/selector";
import { PEG_METADATA } from "@shared/lib/classification";
import { selectorComponentReadingLabel } from "@shared/lib/selector/selector-labels";

interface SelectorLowerRankedRowProps {
  entry: SelectorLowerRanked;
  pegCurrency: SelectorInput["pegCurrency"];
}

export function SelectorLowerRankedRow({
  entry,
  pegCurrency,
}: SelectorLowerRankedRowProps) {
  const verdict = entry.verdictText ?? `${entry.symbol} needs review`;
  const teaching =
    entry.teachingText
    ?? (entry.failedComponent
      ? `Lower-ranked for this profile because its ${readableComponent(entry.failedComponent)} reading did not clear the selected profile threshold.`
      : "Lower-ranked for this profile after the same filters and weights were applied.");
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

function readableComponent(key: string): string {
  return selectorComponentReadingLabel(key) ?? key.replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase();
}
