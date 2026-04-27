"use client";
import Link from "next/link";
import { useState } from "react";
import { ChevronDown, ChevronRight, ExternalLink } from "lucide-react";
import { cn } from "@/lib/utils";
import { CAUSE_HEX, CAUSE_META } from "@shared/lib/cause-of-death";
import type { StablecoinObituary } from "@shared/types";

interface FrozenStateBannerProps {
  symbol: string;
  frozenAt: string;
  obituary: StablecoinObituary;
}

export function FrozenStateBanner({ symbol, frozenAt, obituary }: FrozenStateBannerProps) {
  // Initial render is expanded so detail-page height is stable on mount
  // (LongformScrollspyNav reads section offsets at first paint). User clicks
  // to collapse afterwards.
  const [expanded, setExpanded] = useState(true);
  const cause = CAUSE_META[obituary.causeOfDeath];
  const causeColor = CAUSE_HEX[obituary.causeOfDeath];
  const epitaphId = `${symbol}-frozen-epitaph`;
  return (
    <section
      aria-labelledby={epitaphId}
      className="pharos-card-shell relative overflow-hidden px-5 py-6 sm:px-7 sm:py-7"
    >
      <div
        aria-hidden="true"
        className="absolute inset-x-0 top-0 h-[3px]"
        style={{ backgroundColor: causeColor }}
      />
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[10px] font-medium uppercase tracking-[0.22em] text-muted-foreground">
        <span aria-hidden="true">In Memoriam</span>
        <span aria-hidden="true" className="text-muted-foreground/50">·</span>
        <span className={cn("normal-case tracking-wide", cause.textColor)}>{cause.label}</span>
      </div>
      <h2
        id={epitaphId}
        className="mt-4 text-2xl italic font-normal leading-snug text-foreground sm:text-[1.6rem]"
      >
        &ldquo;{obituary.epitaph}&rdquo;
      </h2>
      <p className="mt-2 text-xs tracking-wide text-muted-foreground">
        {symbol} archived {frozenAt}
      </p>
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="pharos-focus-ring mt-5 inline-flex items-center gap-1 text-xs uppercase tracking-[0.18em] text-muted-foreground hover:text-foreground"
        aria-expanded={expanded}
      >
        {expanded ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
        Read full obituary
      </button>
      {expanded ? (
        <div className="mt-4 space-y-4 border-t border-border/40 pt-4 text-[0.95rem] leading-relaxed text-foreground/85">
          <p>{obituary.obituary}</p>
          <div className="flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
            <a
              className="pharos-focus-ring inline-flex items-center gap-1 underline-offset-2 hover:underline"
              href={obituary.sourceUrl}
              target="_blank"
              rel="noreferrer noopener"
            >
              {obituary.sourceLabel}
              <ExternalLink className="h-3 w-3" />
            </a>
            <Link
              className="pharos-focus-ring inline-flex items-center gap-1 underline-offset-2 hover:underline"
              href="/cemetery/"
            >
              View on cemetery →
            </Link>
          </div>
        </div>
      ) : null}
    </section>
  );
}
