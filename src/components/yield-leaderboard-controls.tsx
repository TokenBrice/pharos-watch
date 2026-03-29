"use client";

import { Search } from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import { formatPercent } from "@shared/lib/format";
import { YIELD_TYPE_LABELS, YIELD_TYPE_STYLES } from "@shared/lib/classification";
import type { YieldRanking, YieldType } from "@shared/types";

interface YieldLeaderboardControlsProps {
  rankings: YieldRanking[];
  searchQuery: string;
  searchOpen: boolean;
  activeLabels: Set<string>;
  hideWarnings: boolean;
  onSearchQueryChange: (value: string) => void;
  onSearchOpenChange: (open: boolean) => void;
  onSelectRanking: (rankingId: string) => void;
  onToggleLabel: (label: string) => void;
  onHideWarningsChange: (value: boolean) => void;
}

export function YieldLeaderboardControls({
  rankings,
  searchQuery,
  searchOpen,
  activeLabels,
  hideWarnings,
  onSearchQueryChange,
  onSearchOpenChange,
  onSelectRanking,
  onToggleLabel,
  onHideWarningsChange,
}: YieldLeaderboardControlsProps) {
  const visibleLabels = [...new Set(rankings.map((ranking) => YIELD_TYPE_LABELS[ranking.yieldType]))];
  const searchMatches = searchQuery.trim()
    ? rankings.filter((ranking) => {
      const q = searchQuery.trim().toLowerCase();
      return ranking.symbol.toLowerCase().includes(q) || ranking.name.toLowerCase().includes(q);
    })
    : [];

  return (
    <div className="flex flex-col gap-2 px-3 pt-3 mb-3">
      <Popover open={searchOpen} onOpenChange={onSearchOpenChange}>
        <PopoverTrigger asChild>
          <div className="relative max-w-xs">
            <Search className="absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => {
                onSearchQueryChange(e.target.value);
                onSearchOpenChange(e.target.value.trim().length > 0);
              }}
              onFocus={() => {
                if (searchQuery.trim()) onSearchOpenChange(true);
              }}
              placeholder="Search stablecoin..."
              className="pharos-focus-ring w-full rounded-full border border-border/60 bg-background/60 py-1.5 pl-8 pr-3 text-sm text-foreground placeholder:text-muted-foreground outline-none"
            />
          </div>
        </PopoverTrigger>
        {searchQuery.trim() && (
          <PopoverContent className="w-[280px] p-0" align="start" onOpenAutoFocus={(e) => e.preventDefault()}>
            <Command shouldFilter={false}>
              <CommandList>
                <CommandEmpty className="py-3 text-center text-xs text-muted-foreground">
                  No matches
                </CommandEmpty>
                <CommandGroup>
                  {searchMatches.slice(0, 5).map((ranking) => (
                      <CommandItem
                        key={ranking.id}
                        value={ranking.id}
                        onSelect={() => {
                          onSearchQueryChange("");
                          onSearchOpenChange(false);
                          onSelectRanking(ranking.id);
                        }}
                        className="flex items-center justify-between gap-2"
                      >
                        <div className="flex items-center gap-2">
                          <span className="font-mono text-xs font-medium">{ranking.symbol}</span>
                          <span className="text-xs text-muted-foreground">{ranking.name}</span>
                        </div>
                        <span className="font-mono text-xs tabular-nums text-muted-foreground">
                          {formatPercent(ranking.apy30d)}
                        </span>
                      </CommandItem>
                    ))}
                </CommandGroup>
              </CommandList>
            </Command>
          </PopoverContent>
        )}
      </Popover>

      <div className="flex flex-wrap items-center gap-2">
        {visibleLabels.map((label) => {
          const repType = (Object.entries(YIELD_TYPE_LABELS) as [YieldType, string][])
            .find(([, currentLabel]) => currentLabel === label)?.[0];
          return (
            <button
              key={label}
              type="button"
              onClick={() => onToggleLabel(label)}
              className={
                activeLabels.has(label)
                  ? `pharos-focus-ring rounded-full border px-2 py-0.5 text-xs font-medium ${repType ? YIELD_TYPE_STYLES[repType].badge : ""}`
                  : "pharos-focus-ring rounded-full border border-border px-2 py-0.5 text-xs font-medium text-muted-foreground"
              }
            >
              {label}
            </button>
          );
        })}
        <label className="ml-auto flex cursor-pointer items-center gap-1.5 text-xs text-muted-foreground">
          <input
            type="checkbox"
            checked={hideWarnings}
            onChange={(e) => onHideWarningsChange(e.target.checked)}
            className="h-3.5 w-3.5 rounded border-border"
          />
          Hide warned
        </label>
      </div>
    </div>
  );
}
