"use client";

import { useState, type ReactNode } from "react";
import { ChevronDown } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * The summary grammar every detail-page fold shares: dashed label, trailing
 * chevron, and a 44 px (mobile) / 36 px (desktop) hit area. Exported so
 * controls that fold content they do not own (the footer's score-inputs
 * toggle) read as the same affordance.
 */
export const MODULE_DISCLOSURE_SUMMARY_CLASS =
  "pharos-focus-ring inline-flex min-h-11 cursor-pointer list-none items-center gap-1.5 rounded-md text-sm text-muted-foreground [&::-webkit-details-marker]:hidden lg:min-h-9";

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
  id,
  className,
  summaryClassName,
  children,
  deferredChildren,
}: {
  label: string;
  /** Optional item count rendered after the label, e.g. "Sources (5)". */
  count?: number;
  /** Initial state only — the element stays uncontrolled after mount. */
  defaultOpen?: boolean;
  /** Anchor id on the <details> so hash navigation can reveal + open it. */
  id?: string;
  className?: string;
  summaryClassName?: string;
  children: ReactNode;
  /**
   * Heavy content (charts, big tables) mounted only once the disclosure first
   * opens, then kept mounted. Crawl-relevant text belongs in `children`, which
   * always mounts.
   */
  deferredChildren?: ReactNode;
}) {
  const [hasOpened, setHasOpened] = useState(defaultOpen);
  return (
    <details
      id={id}
      className={cn("group/disclosure scroll-mt-24", className)}
      open={defaultOpen ? true : undefined}
      onToggle={
        deferredChildren != null && !hasOpened
          ? (event) => {
              if (event.currentTarget.open) setHasOpened(true);
            }
          : undefined
      }
    >
      <summary className={cn(MODULE_DISCLOSURE_SUMMARY_CLASS, summaryClassName)}>
        <span className="underline decoration-dashed underline-offset-2">{label}</span>
        {count != null ? (
          <span aria-hidden="true" className="pharos-numeric text-xs text-muted-foreground/80">
            ({count})
          </span>
        ) : null}
        <ChevronDown aria-hidden="true" className="h-3 w-3 shrink-0 transition-transform group-open/disclosure:rotate-180" />
      </summary>
      {children}
      {deferredChildren != null && hasOpened ? deferredChildren : null}
    </details>
  );
}
