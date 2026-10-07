"use client";

import { useState, type ReactNode } from "react";
import { ChevronDown } from "lucide-react";
import { SECTION_SCROLL_MT } from "@/components/stablecoin-detail/section-title-class";
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
 * The one fold rhythm inside a module body (or any `space-y-*` stack): a run
 * of consecutive folds stacks with **no** gap, so its pitch is the summary's
 * own hit area (36 px at `lg`, 44 px below) and the run reads as one table of
 * contents, while content before and after the run keeps the stack's gap.
 *
 * Folds are matched by `data-module-fold`, which `ModuleDisclosure` and the
 * `EvidenceFooter` wrapper (it opens with the merged provenance fold) carry.
 * The rules cover folds that are siblings anywhere in the stack, and a
 * wrapper `<div>` whose last child is a fold followed by a fold. They zero the
 * stack's bottom margin (`space-y-*` in Tailwind v4) and any caller top margin
 * on the next fold, so ad-hoc `-mt-3`/`mt-3` nudges cannot reintroduce drift.
 */
export const MODULE_FOLD_RHYTHM_CLASS =
  "[&_[data-module-fold]:has(+[data-module-fold])]:mb-0 [&_[data-module-fold]+[data-module-fold]]:mt-0 [&>:has(>[data-module-fold]:last-child):has(+[data-module-fold])]:mb-0 [&>:has(>[data-module-fold]:last-child)+[data-module-fold]]:mt-0";

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
  /**
   * Optional item count rendered after the label, e.g. "Sources (5)". It is
   * part of the summary's accessible name: the count is information.
   */
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
      data-module-fold=""
      // An open fold keeps a little air before the next fold in its run. The
      // section scroll margin keeps a hash-opened summary clear of the sticky
      // header and section nav.
      className={cn("group/disclosure open:pb-2", SECTION_SCROLL_MT, className)}
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
          <>
            {/* Whitespace-only text between flex items is not rendered, but it
                keeps the accessible name "Sources (5)" rather than "Sources(5)". */}
            {" "}
            <span className="pharos-numeric text-xs text-muted-foreground/80">({count})</span>
          </>
        ) : null}
        <ChevronDown
          aria-hidden="true"
          className="h-3 w-3 shrink-0 transition-transform motion-reduce:transition-none group-open/disclosure:rotate-180"
        />
      </summary>
      {children}
      {deferredChildren != null && hasOpened ? deferredChildren : null}
    </details>
  );
}
