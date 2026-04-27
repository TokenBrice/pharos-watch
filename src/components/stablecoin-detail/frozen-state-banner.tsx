"use client";
import Link from "next/link";
import { useState } from "react";
import { ChevronDown, ChevronRight, ExternalLink } from "lucide-react";
import { cn } from "@/lib/utils";
import { CAUSE_META, CAUSE_BORDER_INTENSE } from "@shared/lib/cause-of-death";
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
  const intenseBorder = CAUSE_BORDER_INTENSE[obituary.causeOfDeath];
  return (
    <div
      className={cn(
        "pharos-card-shell border-l-4 p-4 sm:p-5",
        intenseBorder,
      )}
      role="status"
      aria-label={`${symbol} is a frozen stablecoin archive`}
    >
      <div className="flex flex-wrap items-center gap-2">
        <span
          className={cn(
            "rounded-md border px-2 py-0.5 text-xs font-medium uppercase tracking-wide",
            cause.borderColor,
            cause.textColor,
          )}
        >
          {cause.label}
        </span>
        <span className="text-xs text-muted-foreground">Frozen on {frozenAt}</span>
      </div>
      <h2 className="mt-2 text-lg font-semibold leading-tight text-foreground">{obituary.epitaph}</h2>
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="pharos-focus-ring mt-2 inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
        aria-expanded={expanded}
      >
        {expanded ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
        Read full obituary
      </button>
      {expanded ? (
        <div className="mt-3 space-y-3 text-sm text-foreground/90">
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
    </div>
  );
}
