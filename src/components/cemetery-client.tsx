"use client";

import { useState, useCallback, useEffect, useMemo, useRef } from "react";
import type { CemeteryEntry } from "@shared/lib/cemetery-merged";
import { CemeteryTombstones } from "@/components/cemetery-tombstones";
import { StablecoinCemetery } from "@/components/stablecoin-cemetery";
import { ControlPillToggle } from "@/components/control-pill-toggle";
import { type CemeterySortMode, sortCemeteryCoins } from "@/lib/cemetery";

const SORT_OPTIONS: { value: CemeterySortMode; label: string }[] = [
  { value: "newest", label: "Newest first" },
  { value: "oldest", label: "Oldest first" },
];

export function CemeteryClient({ entries }: { entries: CemeteryEntry[] }) {
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [sortMode, setSortMode] = useState<CemeterySortMode>("newest");
  const [highlightedId, setHighlightedId] = useState<string | null>(null);
  const highlightTimerRef = useRef<ReturnType<typeof setTimeout>>(null);

  // Clear highlight timer on unmount
  useEffect(() => () => { if (highlightTimerRef.current) clearTimeout(highlightTimerRef.current); }, []);

  const orderedCoins = useMemo(() => sortCemeteryCoins(entries, sortMode), [entries, sortMode]);

  const handleToggle = useCallback((coinId: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(coinId)) {
        next.delete(coinId);
      } else {
        next.add(coinId);
      }
      return next;
    });
  }, []);

  const handleTombstoneSelect = useCallback((coinId: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      next.add(coinId);
      return next;
    });
    setHighlightedId(coinId);
    if (highlightTimerRef.current) clearTimeout(highlightTimerRef.current);
    highlightTimerRef.current = setTimeout(() => setHighlightedId(null), 2000);
    // Scroll to autopsy card after a tick so the DOM has expanded
    requestAnimationFrame(() => {
      const el = document.getElementById(`obituary-${coinId}`);
      if (el) {
        el.scrollIntoView({ behavior: "smooth", block: "center" });
      }
    });
  }, []);

  return (
    <div className="space-y-6">
      {/* Cemetery field */}
      <section className="space-y-4">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div className="min-w-0 space-y-1.5">
            <h2 className="pharos-kicker">The Cemetery</h2>
            <p className="text-sm leading-relaxed text-muted-foreground">
              {sortMode === "newest"
                ? "Newest graves surface first inside one continuous field. Each marker carries the coin logo, failure cause, date, and hover memorial."
                : "Oldest graves surface first inside one continuous field. Each marker carries the coin logo, failure cause, date, and hover memorial."}
            </p>
          </div>
          <ControlPillToggle
            className="inline-flex w-full flex-wrap gap-2 sm:w-auto"
            options={SORT_OPTIONS}
            value={sortMode}
            onChange={setSortMode}
          />
        </div>
        <CemeteryTombstones coins={orderedCoins} onSelect={handleTombstoneSelect} />
      </section>

      {/* Autopsy reports */}
      <section className="space-y-3">
        <div className="space-y-1.5">
          <h2 className="pharos-kicker">Autopsy Reports</h2>
          <p className="text-sm leading-relaxed text-muted-foreground">
            Obituaries follow the same order as the cemetery above so the memorial and archive stay in sync.
          </p>
        </div>
        <StablecoinCemetery
          coins={orderedCoins}
          expanded={expanded}
          onToggle={handleToggle}
          highlightedId={highlightedId}
        />
      </section>
    </div>
  );
}
