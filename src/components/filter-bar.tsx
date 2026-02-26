"use client";

import { Search, X } from "lucide-react";
import { Input } from "@/components/ui/input";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { FILTER_GROUPS } from "@/hooks/use-homepage-filters";
import type { FilterTag } from "@/lib/types";
import { FILTER_TAG_LABELS } from "@/lib/types";

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
    <div id="filter-bar" className="space-y-3 border-t pt-4 pb-3">
      <div className="flex items-center justify-between gap-4">
        <div className="flex items-center gap-3">
          <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
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
              className="text-xs text-muted-foreground hover:text-foreground transition-colors focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:outline-none rounded"
            >
              Clear all
            </button>
          )}
        </div>
        <div className="relative w-full sm:w-56">
          <Search className="absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            placeholder="Search by name or symbol..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="pl-8 pr-8 h-9 sm:h-8 text-xs"
            aria-label="Search stablecoins by name or symbol"
          />
          {searchQuery && (
            <button
              onClick={() => setSearchQuery("")}
              className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
              aria-label="Clear search"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          )}
        </div>
      </div>

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {FILTER_GROUPS.map((group) => (
          <div key={group.label} className="space-y-1.5">
            <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">{group.label}</p>
            <ToggleGroup
              type="single"
              value={groupSelections[group.label] ?? ""}
              onValueChange={(v) => handleGroupChange(group.label, v)}
              className="flex flex-wrap justify-start gap-1"
            >
              {group.options.map((opt) => (
                <ToggleGroupItem
                  key={opt}
                  value={opt}
                  variant="outline"
                  size="sm"
                  className="text-xs py-1.5 sm:py-1"
                >
                  {FILTER_TAG_LABELS[opt]}
                </ToggleGroupItem>
              ))}
            </ToggleGroup>
          </div>
        ))}
      </div>
    </div>
  );
}
