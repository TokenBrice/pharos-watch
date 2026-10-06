"use client";

import type { ReactNode } from "react";
import { Info } from "lucide-react";
import type { SafetyScoreV9CurrentCard } from "@shared/types";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { describePartialEvidence } from "@/lib/safety-score-reason-labels";
import { cn } from "@/lib/utils";

/**
 * Ops/pipeline state as an amber header chip (dossier UX D6): the state is
 * named in two words and the detail — budget, date, machine-readable reason
 * (data-integrity R3/R4) — opens on tap or click, never as a body callout.
 */
export function OpsStatusChip({
  label,
  reasonCodes,
  className,
  children,
}: {
  label: string;
  /** Machine-readable reasons (R4). Evaluator identifiers are never copy, so
   *  they live only in `data-reason-codes`. */
  reasonCodes: readonly string[];
  className?: string;
  /** Popover body: plain-language detail only. */
  children: ReactNode;
}) {
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          data-reason-codes={[...new Set(reasonCodes)].join(" ")}
          className={cn(
            "pharos-focus-ring inline-flex min-h-6 shrink-0 items-center gap-1 whitespace-nowrap rounded-full border border-amber-500/40 bg-amber-500/10 px-2 py-0.5 text-[11px] font-medium text-amber-800 dark:text-amber-300",
            className,
          )}
        >
          {label}
          <Info className="h-3 w-3" aria-hidden="true" />
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-72 space-y-1.5 p-3 text-xs leading-relaxed">
        {children}
      </PopoverContent>
    </Popover>
  );
}

/** The "Partial evidence" chip shared by the Safety Score card, hero and mobile sticky bar. */
export function PartialEvidenceChip({
  partialEvidence,
  className,
}: {
  partialEvidence: NonNullable<SafetyScoreV9CurrentCard["partialEvidence"]>;
  className?: string;
}) {
  const description = describePartialEvidence(partialEvidence);
  return (
    <OpsStatusChip label="Partial evidence" reasonCodes={[description.reasonCode]} className={className}>
      <p className="text-foreground">{description.summary}</p>
    </OpsStatusChip>
  );
}
