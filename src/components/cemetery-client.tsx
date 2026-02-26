"use client";

import { useState, useCallback } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { DEAD_STABLECOINS } from "@/lib/dead-stablecoins";
import { CemeteryTombstones } from "@/components/cemetery-tombstones";
import { StablecoinCemetery } from "@/components/stablecoin-cemetery";

export function CemeteryClient() {
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

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
    // Scroll to autopsy card after a tick so the DOM has expanded
    requestAnimationFrame(() => {
      const el = document.getElementById(`obituary-${symbol}`);
      if (el) {
        el.scrollIntoView({ behavior: "smooth", block: "center" });
        el.classList.add("ring-2", "ring-primary/50");
        setTimeout(() => el.classList.remove("ring-2", "ring-primary/50"), 2000);
      }
    });
  }, []);

  return (
    <div className="space-y-6">
      {/* Tombstone grid */}
      <Card className="rounded-xl">
        <CardHeader className="pb-2">
          <CardTitle as="h2" className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">
            The Cemetery
          </CardTitle>
        </CardHeader>
        <CardContent>
          <CemeteryTombstones coins={DEAD_STABLECOINS} onSelect={handleTombstoneSelect} />
        </CardContent>
      </Card>

      {/* Autopsy reports */}
      <Card className="rounded-xl border-l-[3px] border-l-zinc-500">
        <CardContent className="pt-6">
          <StablecoinCemetery
            coins={DEAD_STABLECOINS}
            expanded={expanded}
            onToggle={handleToggle}
          />
        </CardContent>
      </Card>
    </div>
  );
}
