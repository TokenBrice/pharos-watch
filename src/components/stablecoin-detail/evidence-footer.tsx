"use client";

import { useState, type ReactNode } from "react";
import { ChevronDown, ExternalLink } from "lucide-react";
import { MethodologyLinks } from "@/components/methodology-hint";
import { ShowYourWorkToggle } from "@/components/show-your-work-toggle";
import { METHODOLOGY_CONTEXT, type MethodologyContextKey } from "@/lib/methodology-context";
import { cn } from "@/lib/utils";

export interface EvidenceFooterSource {
  label: string;
  url: string;
  /** Trailing annotation after the link, e.g. "Supports capacity". */
  note?: string;
}

/**
 * The standard module footer: one line carrying the methodology links, the
 * folded "Sources (N)" affordance, and the right-aligned reviewed/updated
 * stamp. Sources stay collapsed by default at every breakpoint; the list is
 * kept in the DOM (`hidden`) so citations remain crawlable.
 *
 * Supersedes ad-hoc always-expanded evidence lists on the stablecoin detail
 * page; `MethodologyCardActions` remains for cards without source lists
 * elsewhere in the product.
 */
export function EvidenceFooter({
  topic,
  showVersion = true,
  showWorkToggle = false,
  sources,
  sourcesLabel = "Sources",
  sourcesFootnote,
  trailing,
  children,
  className,
}: {
  topic?: MethodologyContextKey;
  showVersion?: boolean;
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
        {item ? <MethodologyLinks item={item} showVersion={showVersion} /> : null}
        {showWorkToggle ? <ShowYourWorkToggle /> : null}
        {children}
        {hasSources ? (
          <button
            type="button"
            onClick={() => setOpen((value) => !value)}
            aria-expanded={open}
            className="pharos-focus-ring inline-flex min-h-11 items-center gap-1 rounded-sm lg:min-h-0"
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
