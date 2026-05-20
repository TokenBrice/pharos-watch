"use client";

import { StablecoinLogo } from "@/components/stablecoin-logo";
import { useYieldCompareSelection } from "@/hooks/use-yield-compare-selection";
import type { YieldViewModelRow } from "@/lib/yield-view-model";

interface YieldCompareTrayProps {
  rows: readonly YieldViewModelRow[];
  logos: Record<string, string>;
  onOpenDrawer: () => void;
}

export function YieldCompareTray({ rows, logos, onOpenDrawer }: YieldCompareTrayProps) {
  const { ids, clear } = useYieldCompareSelection();
  if (ids.length === 0) return null;

  const rowsById = new Map(rows.map((row) => [row.id, row] as const));
  const canCompare = ids.length >= 2;

  return (
    <div
      role="region"
      aria-label="Compare selection"
      className="pointer-events-none fixed inset-x-0 bottom-4 z-50 flex justify-center px-4 print:hidden"
    >
      <div className="pointer-events-auto flex max-w-full items-center gap-3 rounded-full border border-border/70 bg-background/95 px-4 py-2 shadow-lg backdrop-blur">
        <span className="text-xs font-medium text-foreground">
          {ids.length} selected
        </span>
        <div className="flex -space-x-2" aria-hidden="true">
          {ids.map((id) => {
            const row = rowsById.get(id);
            return (
              <StablecoinLogo
                key={id}
                src={logos[id]}
                name={row?.name ?? id}
                size={22}
              />
            );
          })}
        </div>
        <button
          type="button"
          onClick={onOpenDrawer}
          disabled={!canCompare}
          className="pharos-focus-ring inline-flex items-center rounded-full bg-primary px-3 py-1 text-xs font-medium text-primary-foreground transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
          aria-label={canCompare ? "Open compare drawer" : "Select at least 2 coins to compare"}
        >
          Compare
        </button>
        <button
          type="button"
          onClick={clear}
          className="pharos-focus-ring inline-flex items-center rounded-full border border-border/60 px-3 py-1 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground"
          aria-label="Clear compare selection"
        >
          Clear
        </button>
      </div>
    </div>
  );
}
