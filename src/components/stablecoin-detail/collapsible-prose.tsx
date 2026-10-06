"use client";

import type { ReactNode } from "react";
import { ModuleDisclosure } from "@/components/stablecoin-detail/module-disclosure";
import { deriveVerdictLine } from "@/components/stablecoin-detail/verdict-line";
import { cn } from "@/lib/utils";

/**
 * Reviewer prose behind the standard `ModuleDisclosure`, labelled "Review
 * notes". Everything the summary layer may not carry — raw identifiers,
 * evaluator narration, block heights, long authored evidence — goes here.
 */
export function ReviewNotes({
  children,
  label = "Review notes",
  className,
}: {
  children: ReactNode;
  label?: string;
  className?: string;
}) {
  return (
    <ModuleDisclosure label={label} className={className}>
      <div className="space-y-2 pb-1 pt-1 text-xs leading-relaxed text-muted-foreground">{children}</div>
    </ModuleDisclosure>
  );
}

/**
 * Reviewed analyst prose reduced to the summary-layer budget: one verdict
 * sentence of at most 25 words, with the full note behind "Review notes".
 *
 * `verdict` overrides the sentence carved from `text` (callers pass a line
 * built from structured fields when the first authored sentence is not a
 * clean verdict); `verdict={null}` shows no line at all. Text that already is
 * a single verdict renders whole with no disclosure, so the fold never appears
 * as a no-op.
 */
export function CollapsibleProse({
  text,
  verdict,
  className,
  label,
}: {
  text: string;
  verdict?: string | null;
  /** Paragraph type scale, e.g. `text-xs` or `text-sm`. */
  className?: string;
  /** Disclosure label; defaults to "Review notes". */
  label?: string;
}) {
  const line = verdict === undefined ? deriveVerdictLine(text) : verdict;
  const flat = text.replace(/\s+/g, " ").trim();
  const textIsVerdict = line !== null && flat === line;

  return (
    <>
      {/* `className` merges first on purpose: `tailwind-merge` treats a later
          `text-{size}` as overriding `leading-*`, so a base-first merge would
          silently drop `leading-relaxed` for every caller that sets a size. */}
      {line ? <p className={cn(className, "leading-relaxed text-muted-foreground")}>{line}</p> : null}
      {textIsVerdict ? null : (
        <ReviewNotes label={label}>
          <p className="whitespace-pre-line">{text}</p>
        </ReviewNotes>
      )}
    </>
  );
}
