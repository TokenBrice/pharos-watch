"use client";

import { BACKING_LABELS_SHORT } from "@shared/lib/classification";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import type { ChainRouteViewModel } from "./view-model";

const BACKING_BAR_COLORS: Record<string, string> = {
  "rwa-backed": "bg-sky-500",
  "crypto-backed": "bg-violet-500",
  other: "bg-zinc-400",
};

const BACKING_FILTER_COLORS: Record<string, string> = {
  "rwa-backed": "bg-sky-500/15 text-sky-700 dark:text-sky-400 border-sky-500/30 hover:bg-sky-500/20",
  "crypto-backed": "bg-violet-500/15 text-violet-700 dark:text-violet-400 border-violet-500/30 hover:bg-violet-500/20",
  other: "bg-zinc-500/15 text-zinc-700 dark:text-zinc-400 border-zinc-500/30 hover:bg-zinc-500/20",
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
            return <div key={type} className={cn("h-full", BACKING_BAR_COLORS[type])} style={{ width: `${pct}%` }} />;
          })}
        </div>
        <div className="flex flex-wrap gap-2">
          <button
            onClick={() => onFilterChange(null)}
            className={cn(
              "pharos-focus-ring inline-flex items-center gap-2 rounded-full border px-2.5 py-1 text-xs font-medium transition-colors",
              activeFilter === null
                ? "border-primary/50 bg-primary/10 text-primary hover:bg-primary/15"
                : "border-border/60 bg-background hover:bg-muted/50",
            )}
            title={activeFilter === null ? "Showing all stablecoins" : "Click to show all stablecoins"}
          >
            <div className="h-2.5 w-2.5 rounded-full bg-gradient-to-br from-sky-500 via-violet-500 to-amber-500" />
            <span>All</span>
            <span className="font-mono text-muted-foreground">{coins.length}</span>
            {activeFilter === null && <span className="ml-1 text-xs">●</span>}
          </button>
          {Object.entries(backingTotals).map(([type, amount]) => {
            const pct = totalUsd > 0 ? (amount / totalUsd) * 100 : 0;
            if (pct <= 0) return null;
            const isActive = activeFilter === type;
            return (
              <button
                key={type}
                onClick={() => onFilterChange(isActive ? null : type)}
                className={cn(
                  "pharos-focus-ring inline-flex items-center gap-2 rounded-full border px-2.5 py-1 text-xs font-medium transition-colors",
                  isActive ? BACKING_FILTER_COLORS[type] : "border-border/60 bg-background hover:bg-muted/50",
                )}
                title={isActive ? "Click to clear filter" : `Click to filter by ${BACKING_LABELS_SHORT[type as keyof typeof BACKING_LABELS_SHORT] ?? type}`}
              >
                <div className={cn("h-2.5 w-2.5 rounded-full", BACKING_BAR_COLORS[type])} />
                <span>{BACKING_LABELS_SHORT[type as keyof typeof BACKING_LABELS_SHORT] ?? (type === "other" ? "Other" : type)}</span>
                <span className="font-mono text-muted-foreground">{pct.toFixed(1)}%</span>
                {isActive && <span className="ml-1 text-xs">✕</span>}
              </button>
            );
          })}
        </div>
        {activeFilter && (
          <p className="text-xs text-muted-foreground">
            Showing only {BACKING_LABELS_SHORT[activeFilter as keyof typeof BACKING_LABELS_SHORT] ?? activeFilter} stablecoins.{" "}
            <button onClick={() => onFilterChange(null)} className="pharos-focus-ring underline hover:text-foreground">
              Clear filter
            </button>
          </p>
        )}
      </CardContent>
    </Card>
  );
}
