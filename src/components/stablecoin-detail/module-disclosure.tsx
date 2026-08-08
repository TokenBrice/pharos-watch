"use client";

import type { ReactNode } from "react";
import { ChevronDown } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * The one disclosure affordance for detail-page modules: a native `<details>`
 * so folded content stays in the DOM (crawlable, and Chromium auto-expands it
 * on find-in-page), with the dashed-underline summary grammar the page already
 * uses for "Scoring breakdown".
 *
 * Use a named label ("Full market breakdown", "Evidence & controls") rather
 * than a generic "Show more" — the label is the module's table of contents.
 */
export function ModuleDisclosure({
  label,
  count,
  defaultOpen = false,
  className,
  summaryClassName,
  children,
}: {
  label: string;
  /** Optional item count rendered after the label, e.g. "Sources (5)". */
  count?: number;
  /** Initial state only — the element stays uncontrolled after mount. */
  defaultOpen?: boolean;
  className?: string;
  summaryClassName?: string;
  children: ReactNode;
}) {
  return (
    <details className={cn("group", className)} open={defaultOpen ? true : undefined}>
      <summary
        className={cn(
          "pharos-focus-ring inline-flex min-h-11 cursor-pointer list-none items-center gap-1.5 rounded-md text-sm text-muted-foreground [&::-webkit-details-marker]:hidden lg:min-h-9",
          summaryClassName,
        )}
      >
        <span className="underline decoration-dashed underline-offset-2">{label}</span>
        {count != null ? (
          <span aria-hidden="true" className="pharos-numeric text-xs text-muted-foreground/80">
            ({count})
          </span>
        ) : null}
        <ChevronDown aria-hidden="true" className="h-3 w-3 shrink-0 transition-transform group-open:rotate-180" />
      </summary>
      {children}
    </details>
  );
}
