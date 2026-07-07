"use client";

import Link from "next/link";
import { ArrowRight } from "lucide-react";
import { HeroSignalsRail, type HeroSignalRailItem } from "./hero-card-metrics";

/**
 * Compact safety summary for the detail right rail (Figma coin template).
 * Reuses the hero signals rail (grade hero tile + PEG/LIQUIDITY/DEWS rows);
 * the hero hides its inline copy at xl+ where this card takes over.
 */
export function RailSafetySummary({ items }: { items: HeroSignalRailItem[] }) {
  if (items.length === 0) return null;

  return (
    <div className="pharos-card-shell space-y-3 p-4">
      <div className="flex items-center justify-between gap-3">
        <p className="pharos-kicker">Safety</p>
        <Link
          href="#report-card"
          className="pharos-focus-ring inline-flex items-center gap-1 text-xs font-medium text-muted-foreground hover:text-foreground"
        >
          Details
          <ArrowRight className="h-3 w-3" aria-hidden="true" />
        </Link>
      </div>
      <HeroSignalsRail items={items} />
    </div>
  );
}
