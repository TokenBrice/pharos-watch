"use client";

import { BACKING_BADGE_STYLES, BACKING_LABELS_SHORT } from "@shared/lib/classification";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import type { ChainRouteViewModel } from "./view-model";

/** Solid chart-fill twins of the canonical BACKING_BADGE_STYLES hues
 *  (blue = RWA, purple = crypto, orange = algorithmic); Tailwind needs
 *  static strings, so the fills are written out but keyed against the
 *  canonical map so a classification change breaks this loudly. */
const BACKING_BAR_COLORS: Record<keyof typeof BACKING_BADGE_STYLES | "other", string> = {
  "rwa-backed": "bg-blue-500",
  "crypto-backed": "bg-purple-500",
  algorithmic: "bg-orange-500",
  other: "bg-zinc-400",
};

export function BackingBreakdown({
  model,
  onFilterChange,
  activeFilter,
}: {
  model: ChainRouteViewModel;
  onFilterChange: (filter: string | null) => void;
  activeFilter: string | null;
}) {
  const { coins, totalUsd, backingTotals } = model;

  const hasData = Object.values(backingTotals).some((value) => value > 0);
  if (!hasData) return null;

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="pharos-kicker">Supply by Backing Type</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <div
          className="flex h-4 w-full overflow-hidden rounded-full"
          role="img"
          aria-label={`Backing breakdown: ${Object.entries(backingTotals).filter(([, amount]) => amount > 0).map(([type, amount]) => `${BACKING_LABELS_SHORT[type as keyof typeof BACKING_LABELS_SHORT] ?? type} ${(totalUsd > 0 ? (amount / totalUsd) * 100 : 0).toFixed(1)}%`).join(", ")}`}
        >
          {Object.entries(backingTotals).map(([type, amount]) => {
            const pct = totalUsd > 0 ? (amount / totalUsd) * 100 : 0;
            if (pct <= 0) return null;
            return <div key={type} className={cn("h-full", BACKING_BAR_COLORS[type as keyof typeof BACKING_BAR_COLORS])} style={{ width: `${pct}%` }} />;
          })}
        </div>
        <div className="flex flex-wrap gap-2">
          <button type="button"
            onClick={() => onFilterChange(null)}
            className={cn(
              "gap-2 text-xs",
              activeFilter === null
                ? "pharos-focus-ring pharos-control-pill pharos-control-pill-active"
                : "pharos-focus-ring pharos-toggle-pill",
            )}
            title={activeFilter === null ? "Showing all stablecoins" : "Click to show all stablecoins"}
          >
            <div className="h-2.5 w-2.5 rounded-full bg-muted-foreground/50" />
            <span>All</span>
            <span className="pharos-numeric opacity-80">{coins.length}</span>
          </button>
          {Object.entries(backingTotals).map(([type, amount]) => {
            const pct = totalUsd > 0 ? (amount / totalUsd) * 100 : 0;
            if (pct <= 0) return null;
            const isActive = activeFilter === type;
            return (
              <button type="button"
                key={type}
                onClick={() => onFilterChange(isActive ? null : type)}
                className={cn(
                  "gap-2 text-xs",
                  isActive
                    ? "pharos-focus-ring pharos-control-pill pharos-control-pill-active"
                    : "pharos-focus-ring pharos-toggle-pill",
                )}
                title={isActive ? "Click to clear filter" : `Click to filter by ${BACKING_LABELS_SHORT[type as keyof typeof BACKING_LABELS_SHORT] ?? type}`}
              >
                <div className={cn("h-2.5 w-2.5 rounded-full", BACKING_BAR_COLORS[type as keyof typeof BACKING_BAR_COLORS])} />
                <span>{BACKING_LABELS_SHORT[type as keyof typeof BACKING_LABELS_SHORT] ?? (type === "other" ? "Other" : type)}</span>
                <span className="pharos-numeric opacity-80">{pct.toFixed(1)}%</span>
                {isActive && <span className="ml-1 text-xs">✕</span>}
              </button>
            );
          })}
        </div>
        {activeFilter && (
          <p className="text-xs text-muted-foreground">
            Showing only {BACKING_LABELS_SHORT[activeFilter as keyof typeof BACKING_LABELS_SHORT] ?? activeFilter} stablecoins.{" "}
            <button type="button" onClick={() => onFilterChange(null)} className="pharos-focus-ring underline hover:text-foreground">
              Clear filter
            </button>
          </p>
        )}
      </CardContent>
    </Card>
  );
}
