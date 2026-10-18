"use client";

import type { ReactNode } from "react";
import { Info } from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";

/**
 * Ops/pipeline state as an amber header chip (dossier UX D6, and the hero
 * status slot on rail and Markets pages): the state is named in two words and
 * the detail — budget, date, machine-readable reason (data-integrity R3/R4) —
 * opens on tap or click, never as a body callout.
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
            "pharos-focus-ring inline-flex min-h-6 shrink-0 items-center gap-1 whitespace-nowrap rounded-full border border-state-warn-solid/40 bg-state-warn-subtle px-2 py-0.5 text-2xs font-medium text-state-warn-strong",
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
