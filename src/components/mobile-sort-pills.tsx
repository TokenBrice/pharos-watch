"use client";

import type { ReactNode } from "react";

type SortDirection = "asc" | "desc";

/** Compact metric pill used in mobile card rows. Accepts an optional className
 *  for color overrides (e.g. freshness text colour) — pass static literals. */
export function MobileMetricPill({
  className,
  children,
}: {
  className?: string;
  children: ReactNode;
}) {
  return (
    <span className={`rounded-full border border-border/60 bg-background/55 px-2 py-1${className ? ` ${className}` : ""}`}>
      {children}
    </span>
  );
}

/** Card shell wrapping mobile sort controls. Keeps the repeated
 *  rounded-xl border border-border/70 bg-background/70 px-3 py-3 in one place. */
export function MobileSortPanel({ kicker, children }: { kicker: string; children: ReactNode }) {
  return (
    <div className="rounded-xl border border-border/70 bg-background/70 px-3 py-3">
      <p className="pharos-kicker mb-2">{kicker}</p>
      {children}
    </div>
  );
}

export interface MobileSortOption<TKey extends string> {
  key: TKey;
  label: string;
}

interface MobileSortPillsProps<TKey extends string> {
  options: readonly MobileSortOption<TKey>[];
  sortKey: TKey;
  sortDirection: SortDirection;
  onSort: (key: TKey) => void;
  ariaLabel: string;
  className?: string;
}

export function MobileSortPills<TKey extends string>({
  options,
  sortKey,
  sortDirection,
  onSort,
  ariaLabel,
  className = "flex flex-wrap gap-2",
}: MobileSortPillsProps<TKey>) {
  return (
    <div className={className} role="group" aria-label={ariaLabel}>
      {options.map((option) => {
        const active = sortKey === option.key;
        return (
          <button
            key={option.key}
            type="button"
            aria-pressed={active}
            onClick={() => onSort(option.key)}
            className={`pharos-focus-ring inline-flex min-h-11 items-center rounded-full border px-3 text-xs font-medium transition-colors ${
              active
                ? "border-frost-blue/50 bg-frost-blue/12 text-foreground"
                : "border-border/60 bg-background/60 text-muted-foreground hover:text-foreground"
            }`}
          >
            {option.label}
            {active ? (
              <span className="ml-1 font-mono text-[10px]" aria-hidden="true">
                {sortDirection === "asc" ? "↑" : "↓"}
              </span>
            ) : null}
          </button>
        );
      })}
    </div>
  );
}
