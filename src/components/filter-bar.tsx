"use client";

import { Search, X } from "lucide-react";
import { Input } from "@/components/ui/input";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { FILTER_GROUPS } from "@/hooks/use-homepage-filters";
import type { FilterTag } from "@shared/types";
import { FILTER_TAG_LABELS } from "@shared/types";

const FILTER_BAR_LABEL_OVERRIDES: Partial<Record<FilterTag, string>> = {
  "fiat-non-usd-peg": "Non USD",
  "rwa-backed": "RWA",
  "crypto-backed": "Crypto",
  "centralized-dependent": "CeFi-Dep",
};

interface FilterBarProps {
  groupSelections: Record<string, FilterTag | "">;
  searchQuery: string;
  setSearchQuery: (q: string) => void;
  handleGroupChange: (group: string, value: string) => void;
  clearAll: () => void;
  activeFilters: FilterTag[];
  hasFilters: boolean;
}

export function FilterBar({
  groupSelections,
  searchQuery,
  setSearchQuery,
  handleGroupChange,
  clearAll,
  activeFilters,
  hasFilters,
}: FilterBarProps) {
  return (
    <div id="filter-bar" className="pharos-panel-header space-y-3.5 border-b border-t-0 pb-4">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div className="flex items-center gap-3 flex-wrap">
          <p className="pharos-kicker">
            Filters
            {hasFilters && (
              <span className="ml-1.5 inline-flex items-center justify-center rounded-full bg-primary text-primary-foreground text-xs font-bold w-4 h-4">
                {activeFilters.length}
              </span>
            )}
          </p>
          {hasFilters && (
            <button
              onClick={clearAll}
              className="pharos-focus-ring rounded-md px-1.5 py-1 text-xs text-muted-foreground hover:text-foreground"
            >
              Clear all
            </button>
          )}
        </div>
        <div className="relative w-full sm:w-60">
          <Search className="absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            placeholder="Search by name or symbol..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="h-11 border-border/70 pl-8 pr-8 text-sm sm:h-8 sm:text-xs"
            aria-label="Search stablecoins by name or symbol"
          />
          {searchQuery && (
            <button
              onClick={() => setSearchQuery("")}
              className="pharos-focus-ring absolute right-1 top-1/2 -translate-y-1/2 rounded-md p-2 text-muted-foreground hover:text-foreground"
              aria-label="Clear search"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          )}
        </div>
      </div>

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-[1fr_1.2fr_1fr_1fr_0.8fr]">
        {FILTER_GROUPS.map((group) => (
          <div
            key={group.label}
            className={`space-y-2${group.label === "Peg" ? " hidden sm:block" : ""}${group.label === "Type" ? " lg:min-w-0" : ""}`}
          >
            <p className="pharos-kicker">{group.label}</p>
            <ToggleGroup
              type="single"
              value={groupSelections[group.label] ?? ""}
              onValueChange={(v) => handleGroupChange(group.label, v)}
              className="flex w-full flex-wrap justify-start gap-1"
            >
              {group.options.map((opt) => (
                <ToggleGroupItem
                  key={opt}
                  value={opt}
                  variant="outline"
                  size="sm"
                  className="pharos-toggle-pill min-h-11 px-3 sm:min-h-8 sm:py-1"
                >
                  {FILTER_BAR_LABEL_OVERRIDES[opt] ?? FILTER_TAG_LABELS[opt]}
                </ToggleGroupItem>
              ))}
            </ToggleGroup>
          </div>
        ))}
      </div>
    </div>
  );
}
