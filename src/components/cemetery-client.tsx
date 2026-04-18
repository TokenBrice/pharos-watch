"use client";

import { useState, useCallback, useEffect, useRef } from "react";
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { DEAD_STABLECOINS } from "@shared/lib/dead-stablecoins";
import { CemeteryTombstones } from "@/components/cemetery-tombstones";
import { StablecoinCemetery } from "@/components/stablecoin-cemetery";
import { type CemeterySortMode, sortCemeteryCoins } from "@/lib/cemetery";
import { cn } from "@/lib/utils";

const SORT_OPTIONS: { value: CemeterySortMode; label: string }[] = [
  { value: "newest", label: "Newest first" },
  { value: "oldest", label: "Oldest first" },
];

export function CemeteryClient() {
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [sortMode, setSortMode] = useState<CemeterySortMode>("newest");
  const [highlightedSymbol, setHighlightedSymbol] = useState<string | null>(null);
  const highlightTimerRef = useRef<ReturnType<typeof setTimeout>>(null);

  // Clear highlight timer on unmount
  useEffect(() => () => { if (highlightTimerRef.current) clearTimeout(highlightTimerRef.current); }, []);

  const orderedCoins = sortCemeteryCoins(DEAD_STABLECOINS, sortMode);

  const handleToggle = useCallback((symbol: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(symbol)) {
        next.delete(symbol);
      } else {
        next.add(symbol);
      }
      return next;
    });
  }, []);

  const handleTombstoneSelect = useCallback((symbol: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      next.add(symbol);
      return next;
    });
    setHighlightedSymbol(symbol);
    if (highlightTimerRef.current) clearTimeout(highlightTimerRef.current);
    highlightTimerRef.current = setTimeout(() => setHighlightedSymbol(null), 2000);
    // Scroll to autopsy card after a tick so the DOM has expanded
    requestAnimationFrame(() => {
      const el = document.getElementById(`obituary-${symbol}`);
      if (el) {
        el.scrollIntoView({ behavior: "smooth", block: "center" });
      }
    });
  }, []);

  return (
    <div className="space-y-6">
      {/* Tombstone grid */}
      <Card className="rounded-xl gap-2">
        <CardHeader className="gap-3">
          <div className="space-y-1.5">
            <CardTitle as="h2" className="pharos-kicker">
              The Cemetery
            </CardTitle>
            <CardDescription className="leading-relaxed">
              {sortMode === "newest"
                ? "Newest graves surface first. Year bands preserve the archive without breaking the field into separate buckets."
                : "Oldest graves surface first. Year bands keep the memorial chronological without breaking the field into separate buckets."}
            </CardDescription>
          </div>
          <CardAction className="w-full max-w-full @min-[560px]/card-header:w-auto">
            <div className="inline-flex w-full flex-wrap gap-2 rounded-full border border-border/70 bg-muted/30 p-1 @min-[560px]/card-header:w-auto">
              {SORT_OPTIONS.map((option) => (
                <button
                  key={option.value}
                  type="button"
                  className={cn(
                    "pharos-focus-ring rounded-full px-3 py-1.5 text-xs font-medium transition-colors",
                    sortMode === option.value
                      ? "bg-background text-foreground shadow-sm"
                      : "text-muted-foreground hover:bg-background/60 hover:text-foreground",
                  )}
                  onClick={() => setSortMode(option.value)}
                  aria-pressed={sortMode === option.value}
                >
                  {option.label}
                </button>
              ))}
            </div>
          </CardAction>
        </CardHeader>
        <CardContent className="pt-0">
          <CemeteryTombstones coins={orderedCoins} onSelect={handleTombstoneSelect} />
        </CardContent>
      </Card>

      {/* Autopsy reports */}
      <Card className="rounded-xl border-l-[3px] border-l-zinc-500">
        <CardHeader className="gap-1.5 border-b border-border/60">
          <CardTitle as="h2" className="pharos-kicker">
            Autopsy Reports
          </CardTitle>
          <CardDescription className="leading-relaxed">
            Obituaries follow the same order as the cemetery above so the memorial and archive stay in sync.
          </CardDescription>
        </CardHeader>
        <CardContent className="pt-4">
          <StablecoinCemetery
            coins={orderedCoins}
            expanded={expanded}
            onToggle={handleToggle}
            highlightedSymbol={highlightedSymbol}
          />
        </CardContent>
      </Card>
    </div>
  );
}
