"use client";

import Link from "next/link";
import { cn } from "@/lib/utils";
import { buildAllCoinTrackerLinks, type TrackerKind } from "@/lib/coin-tracker-links";

export interface CoinCrossTrackerHatnoteProps {
  coinId: string;
  coinSymbol: string;
  /** The tracker the user is currently on; excluded from the rendered list. */
  currentTracker: TrackerKind;
  className?: string;
}

/**
 * Wikipedia-style hatnote shown above a tracker's content when a single coin
 * is in focus. Lists the other Pharos surfaces that carry the same coin so
 * researchers can pivot laterally without re-finding the filter.
 *
 * Quiet by design: one line, muted color, no border. Mount above the page
 * title or breadcrumb. Render nothing when no other surfaces are available.
 */
export function CoinCrossTrackerHatnote({
  coinId,
  coinSymbol,
  currentTracker,
  className,
}: CoinCrossTrackerHatnoteProps) {
  const links = buildAllCoinTrackerLinks(coinId, currentTracker, coinSymbol);
  if (links.length === 0) return null;
  return (
    <p className={cn("text-xs text-muted-foreground", className)}>
      See <span className="font-medium text-foreground">{coinSymbol}</span> also in:{" "}
      {links.map((l, i) => (
        <span key={l.tracker}>
          <Link
            href={l.href}
            className="pharos-focus-ring rounded-sm underline-offset-4 transition-colors hover:text-foreground hover:underline"
          >
            {l.label}
          </Link>
          {i < links.length - 1 ? <span aria-hidden="true"> · </span> : null}
        </span>
      ))}
    </p>
  );
}
