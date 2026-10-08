"use client";

import type { ReactNode } from "react";
import Link from "next/link";
import { ChevronDown } from "lucide-react";
import { MODULE_DISCLOSURE_SUMMARY_CLASS, ModuleDisclosure } from "@/components/stablecoin-detail/module-disclosure";
import { SourceLinkList, type SourceLink } from "@/components/stablecoin-detail/source-link-list";
import { useShowWorkMode } from "@/hooks/use-show-work-mode";
import { METHODOLOGY_CONTEXT, type MethodologyContextKey } from "@/lib/methodology-context";
import { cn } from "@/lib/utils";

/** A folded source row; rendered by the shared `SourceLinkList`. */
export type EvidenceFooterSource = SourceLink;

/**
 * Footer controls keep the 16 px text line but carry a >= 32 px hit area: the
 * vertical padding is cancelled by an equal negative margin, so desktop density
 * is unchanged while the tap target grows.
 */
const FOOTER_LINK_CLASS =
  "pharos-focus-ring -my-2 inline-flex min-h-8 items-center rounded-sm hover:text-foreground hover:underline hover:underline-offset-4";

/**
 * The sitewide score-inputs switch, drawn as a disclosure: it folds the
 * `ShowYourWorkPanel` rendered by the module above, so it carries the
 * `ModuleDisclosure` summary grammar and `aria-expanded` rather than a bare
 * link-styled toggle.
 */
function ScoreInputsDisclosure() {
  const { enabled, toggle } = useShowWorkMode();
  return (
    <button
      type="button"
      onClick={toggle}
      aria-expanded={enabled}
      className={cn(MODULE_DISCLOSURE_SUMMARY_CLASS, "-my-2 min-h-11 text-xs lg:min-h-8")}
    >
      <span className="underline decoration-dashed underline-offset-2">Score inputs</span>
      <ChevronDown
        aria-hidden="true"
        className={cn("h-3 w-3 shrink-0 transition-transform motion-reduce:transition-none", enabled && "rotate-180")}
      />
    </button>
  );
}

const ISO_DATE_PREFIX = /^\d{4}-\d{2}-\d{2}/;

/**
 * Footer dates are ISO (`YYYY-MM-DD`) everywhere, whatever the source field
 * carries ("2026-10-06T…", "Oct 6, 2026"). A date-only string parses as local
 * midnight on server and client alike, so its local calendar date is stable
 * across hydration. Unparseable values pass through untouched.
 */
function toIsoDate(value: string): string {
  if (ISO_DATE_PREFIX.test(value)) return value.slice(0, 10);
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return value;
  const month = String(parsed.getMonth() + 1).padStart(2, "0");
  const day = String(parsed.getDate()).padStart(2, "0");
  return `${parsed.getFullYear()}-${month}-${day}`;
}

/**
 * The standard module provenance (plan §8c): **one** folded disclosure, then
 * **one** footer line.
 *
 * - The fold is a `ModuleDisclosure` (native `<details>`, collapsed at every
 *   breakpoint, kept in the DOM so citations stay crawlable). With `notes` it
 *   reads "Review notes & sources (N)" and holds the notes, then the source
 *   list; without notes it reads "Sources (N)". It merges what used to be a
 *   separate "Review notes" fold and a footer sources toggle, and sits last in
 *   the module's disclosure order, in the same zero-gap run as the folds above
 *   it (`MODULE_FOLD_RHYTHM_CLASS`).
 * - The line has one grammar: live freshness and links on the left
 *   (methodology links, score inputs, `children`), the stamp on the right
 *   (`trailing`, then `Reviewed <YYYY-MM-DD>`). The stamp never drops to a
 *   row of its own: when space runs out the left cluster wraps beside it, so
 *   the line stays one row in the 22rem rail whenever its content can fit.
 * - `inline` puts the fold summary, the left items and the stamp on a single
 *   row with no divider, for a module whose whole body is its provenance
 *   (e.g. "Custody structure undisclosed"). An opened fold takes the full
 *   width and the stamp wraps below it.
 *
 * The methodology version never prints in the footer: five modules with five
 * different version strings read as noise. It lives in the "View methodology"
 * link's tooltip instead.
 *
 * `className` lands on the outermost element: the footer line when there is
 * nothing to fold, otherwise the wrapper around fold and line.
 *
 * Supersedes ad-hoc always-expanded evidence lists on the stablecoin detail
 * page; `MethodologyCardActions` remains for cards without source lists
 * elsewhere in the product.
 */
export function EvidenceFooter({
  topic,
  showWorkToggle = false,
  sources,
  sourcesLabel = "Sources",
  numberedSources = false,
  sourcesFootnote,
  notes,
  notesCount,
  foldId,
  reviewed,
  trailing,
  inline = false,
  children,
  className,
}: {
  topic?: MethodologyContextKey;
  showWorkToggle?: boolean;
  sources?: readonly EvidenceFooterSource[];
  /** Fold label when there are no notes. */
  sourcesLabel?: string;
  /**
   * Numbers the list (`<ol>`, 1-based in `sources` order) for a module whose
   * body cites its sources by number, e.g. the failure scenario's steps.
   */
  numberedSources?: boolean;
  /** Rendered under the source list inside the fold, e.g. a provenance line. */
  sourcesFootnote?: ReactNode;
  /** Reviewer narrative, folded together with the sources. */
  notes?: ReactNode;
  /** Number of note items; added to the source count in the fold's `(N)`. */
  notesCount?: number;
  /** Anchor id on the fold, e.g. `mint-review-notes`; hash reveal opens it. */
  foldId?: string;
  /** Review date, rendered right-aligned as `Reviewed <YYYY-MM-DD>`. */
  reviewed?: string;
  /** Right-aligned stamp before the review date, e.g. `Live · 3h ago`. */
  trailing?: ReactNode;
  /** Fold summary and footer line share one row, without the divider. */
  inline?: boolean;
  /** Extra inline row items on the left (freshness, module-specific links). */
  children?: ReactNode;
  className?: string;
}) {
  const item = topic ? METHODOLOGY_CONTEXT[topic] : null;
  const sourceCount = sources?.length ?? 0;
  const hasSources = sourceCount > 0;
  const hasNotes = notes != null && notes !== false;
  const hasFold = hasSources || hasNotes;
  const hasChildren = children != null && children !== false;
  const hasLeft = item != null || showWorkToggle || hasChildren;
  const hasStamp = Boolean(trailing) || Boolean(reviewed);

  const left = hasLeft ? (
    <>
      {item ? (
        <>
          <Link
            href={item.methodologyPath}
            title={item.versionLabel ? `Methodology ${item.versionLabel}` : undefined}
            className={FOOTER_LINK_CLASS}
          >
            View methodology
          </Link>
          {item.changelogPath ? (
            <Link href={item.changelogPath} className={FOOTER_LINK_CLASS}>
              Version history &rarr;
            </Link>
          ) : null}
        </>
      ) : null}
      {showWorkToggle ? <ScoreInputsDisclosure /> : null}
      {children}
    </>
  ) : null;

  const stamp = hasStamp ? (
    <span className="ml-auto min-w-0 text-right">
      {trailing}
      {trailing && reviewed ? " · " : null}
      {reviewed ? <span className="whitespace-nowrap">{`Reviewed ${toIsoDate(reviewed)}`}</span> : null}
    </span>
  ) : null;

  const fold = hasFold ? (
    <ModuleDisclosure
      id={foldId}
      // One label for the merged fold (plan §3 rule 6), even when the review
      // cites no sources: the notes then state that none are published.
      label={hasNotes ? "Review notes & sources" : sourcesLabel}
      count={
        hasNotes
          ? (notesCount != null || hasSources ? (notesCount ?? 0) + sourceCount : undefined)
          : sourceCount
      }
      className={inline ? "min-w-0 open:basis-full" : undefined}
    >
      <div className="mt-2 space-y-3 pb-1 text-xs leading-relaxed text-muted-foreground">
        {hasNotes ? <div className="space-y-2">{notes}</div> : null}
        {sources && hasSources ? (
          <SourceLinkList aria-label={sourcesLabel} sources={sources} numbered={numberedSources} className="space-y-2" />
        ) : null}
        {hasSources && sourcesFootnote ? <div>{sourcesFootnote}</div> : null}
      </div>
    </ModuleDisclosure>
  ) : null;

  if (inline) {
    if (!hasFold && !hasLeft && !hasStamp) return null;
    return (
      <div
        data-module-fold={hasFold ? "" : undefined}
        className={cn("flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground", className)}
      >
        {fold}
        {left}
        {stamp}
      </div>
    );
  }

  const line = hasLeft || hasStamp ? (
    <div
      className={cn(
        "flex items-baseline gap-x-3 border-t border-border/50 pt-3 text-xs text-muted-foreground",
        hasFold ? undefined : className,
      )}
    >
      {hasLeft ? <div className="flex min-w-0 flex-1 flex-wrap items-center gap-x-3 gap-y-1">{left}</div> : null}
      {stamp}
    </div>
  ) : null;

  if (!hasFold) return line;

  return (
    <div data-module-fold="" className={cn("space-y-3", className)}>
      {fold}
      {line}
    </div>
  );
}
