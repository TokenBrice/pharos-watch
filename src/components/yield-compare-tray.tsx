"use client";

import { StablecoinLogo } from "@/components/stablecoin-logo";
import { useYieldCompareSelection } from "@/hooks/use-yield-compare-selection";
import { getLogoSrc, type LogoMap } from "@/lib/logos";
import type { YieldViewModelRow } from "@/lib/yield-view-model";

interface YieldCompareTrayProps {
  rows: readonly YieldViewModelRow[];
  logos: LogoMap;
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
      className="pointer-events-none fixed inset-x-0 bottom-[calc(var(--mobile-utility-safe-offset)+0.75rem)] z-50 flex justify-center px-3 print:hidden sm:bottom-4 sm:px-4"
    >
      <div className="pointer-events-auto flex w-full max-w-xl items-center gap-2 rounded-lg border border-border/70 bg-background/95 px-3 py-2 shadow-lg backdrop-blur sm:w-auto sm:gap-3 sm:rounded-full sm:px-4">
        <span className="text-xs font-medium text-foreground">{ids.length} selected</span>
        <div className="flex -space-x-2" aria-hidden="true">
          {ids.map((id) => {
            const row = rowsById.get(id);
            return <StablecoinLogo key={id} src={getLogoSrc(logos, id)} name={row?.name ?? id} size={22} />;
          })}
        </div>
        <button
          type="button"
          onClick={onOpenDrawer}
          disabled={!canCompare}
          className="pharos-focus-ring ml-auto inline-flex min-h-11 items-center rounded-full bg-primary px-3 py-2 text-xs font-medium text-primary-foreground transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50 sm:ml-0 sm:min-h-8 sm:py-1"
          aria-label={canCompare ? "Open compare drawer" : "Select at least 2 coins to compare"}
        >
          Compare
        </button>
        <button
          type="button"
          onClick={clear}
          className="pharos-focus-ring inline-flex min-h-11 items-center rounded-full border border-border/60 px-3 py-2 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground sm:min-h-8 sm:py-1"
          aria-label="Clear compare selection"
        >
          Clear
        </button>
      </div>
    </div>
  );
}
