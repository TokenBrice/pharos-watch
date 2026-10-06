"use client";

import { useState, type ReactNode } from "react";
import Link from "next/link";
import { ChevronDown, ExternalLink } from "lucide-react";
import { MODULE_DISCLOSURE_SUMMARY_CLASS } from "@/components/stablecoin-detail/module-disclosure";
import { useShowWorkMode } from "@/hooks/use-show-work-mode";
import { METHODOLOGY_CONTEXT, type MethodologyContextKey } from "@/lib/methodology-context";
import { cn } from "@/lib/utils";

export interface EvidenceFooterSource {
  label: string;
  url: string;
  /** Trailing annotation after the link, e.g. "Supports capacity". */
  note?: string;
}

/**
 * Footer controls keep the 16 px text line but carry a >= 32 px hit area: the
 * vertical padding is cancelled by an equal negative margin, so desktop density
 * is unchanged while the tap target grows.
 */
const FOOTER_LINK_CLASS =
  "pharos-focus-ring -my-2 inline-flex min-h-8 items-center rounded-sm hover:text-foreground hover:underline hover:underline-offset-4";
const FOOTER_TOGGLE_CLASS = "pharos-focus-ring -my-2 inline-flex min-h-11 items-center gap-1 rounded-sm lg:min-h-8";

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
        className={cn("h-3 w-3 shrink-0 transition-transform", enabled && "rotate-180")}
      />
    </button>
  );
}

/**
 * The standard module footer: one line carrying the methodology links, the
 * folded "Sources (N)" affordance, and the right-aligned reviewed/updated
 * stamp. Sources stay collapsed by default at every breakpoint; the list is
 * kept in the DOM (`hidden`) so citations remain crawlable.
 *
 * The methodology version never prints in the footer: five modules with five
 * different version strings read as noise. It lives in the "View methodology"
 * link's tooltip instead.
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
  sourcesFootnote,
  trailing,
  children,
  className,
}: {
  topic?: MethodologyContextKey;
  showWorkToggle?: boolean;
  sources?: readonly EvidenceFooterSource[];
  sourcesLabel?: string;
  /** Rendered under the expanded source list, e.g. a provenance line. */
  sourcesFootnote?: ReactNode;
  /** Right-aligned stamp, e.g. `Reviewed 2026-07-15`. */
  trailing?: ReactNode;
  /** Extra inline row items (module-specific links). */
  children?: ReactNode;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const item = topic ? METHODOLOGY_CONTEXT[topic] : null;
  const hasSources = (sources?.length ?? 0) > 0;

  return (
    <div className={cn("border-t border-border/50 pt-3 text-xs text-muted-foreground", className)}>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
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
        {hasSources ? (
          <button
            type="button"
            onClick={() => setOpen((value) => !value)}
            aria-expanded={open}
            className={FOOTER_TOGGLE_CLASS}
          >
            <span className="underline decoration-dashed underline-offset-2">{sourcesLabel}</span>
            <span aria-hidden="true" className="pharos-numeric">
              ({sources?.length})
            </span>
            <ChevronDown
              aria-hidden="true"
              className={cn("h-3 w-3 shrink-0 transition-transform", open && "rotate-180")}
            />
          </button>
        ) : null}
        {trailing ? <span className="ml-auto text-right">{trailing}</span> : null}
      </div>
      {hasSources ? (
        <div hidden={!open}>
          <ul className="mt-2.5 space-y-2">
            {sources?.map((source) => (
              <li key={`${source.label}:${source.url}`} className="flex min-w-0 gap-2 leading-relaxed">
                <ExternalLink className="mt-0.5 h-3 w-3 shrink-0" aria-hidden="true" />
                <span className="min-w-0">
                  <a
                    href={source.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="pharos-focus-ring break-words rounded-sm underline underline-offset-2 transition-colors hover:text-foreground"
                  >
                    {source.label}
                  </a>
                  {source.note ? <span className="ml-2 text-muted-foreground/80">{source.note}</span> : null}
                </span>
              </li>
            ))}
          </ul>
          {sourcesFootnote ? <div className="mt-2">{sourcesFootnote}</div> : null}
        </div>
      ) : null}
    </div>
  );
}
