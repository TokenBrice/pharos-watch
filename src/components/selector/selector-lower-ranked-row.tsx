"use client";

import type { SelectorInput, SelectorLowerRanked } from "@shared/lib/selector";
import { PEG_METADATA } from "@shared/lib/classification";

interface SelectorLowerRankedRowProps {
  entry: SelectorLowerRanked;
  pegCurrency: SelectorInput["pegCurrency"];
  /**
   * Pre-rendered prose. The engine's `what-to-watch-templates.ts` is expected
   * to emit the bold verdict + muted teaching line keyed off `reasonKey`. If
   * the engine has not yet attached prose, we fall back to a structural line
   * built from `reasonKey` + `failedComponent`.
   */
  verdictText?: string;
  teachingText?: string;
}

export function SelectorLowerRankedRow({
  entry,
  pegCurrency,
  verdictText,
  teachingText,
}: SelectorLowerRankedRowProps) {
  // TODO(integration): engine should attach `verdictText` + `teachingText`
  // (from editorial templates). Fallback shows the canonical reasonKey so the
  // row never ships empty.
  const verdict = verdictText ?? `${entry.symbol} — ${entry.reasonKey}`;
  const teaching =
    teachingText
    ?? (entry.failedComponent
      ? `Lower-ranked for this profile because ${entry.failedComponent} fell below the profile threshold.`
      : "Lower-ranked for this profile under the current weight set.");
  const pegLabel = PEG_METADATA[pegCurrency]?.filterLabel ?? pegCurrency;

  return (
    <li className="flex flex-col gap-1 rounded-xl border border-dashed border-border/55 bg-muted/[0.06] px-3.5 py-3 sm:flex-row sm:items-baseline sm:gap-3">
      <p className="text-sm font-semibold tracking-tight text-foreground sm:min-w-fit">
        {verdict} <span className="text-xs font-medium text-muted-foreground">({pegLabel} peg)</span>
      </p>
      <p className="text-sm leading-relaxed text-muted-foreground">{teaching}</p>
    </li>
  );
}
