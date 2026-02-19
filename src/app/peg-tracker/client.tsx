"use client";

import { useCallback } from "react";
import { usePegSummary } from "@/hooks/use-peg-summary";
import { useUrlFilters } from "@/hooks/use-url-filters";
import { useDepegEvents } from "@/hooks/use-depeg-events";
import { useLogos } from "@/hooks/use-logos";
import { PegTrackerStats } from "@/components/peg-tracker-stats";
import { PegHeatmap } from "@/components/peg-heatmap";
import { PegLeaderboard } from "@/components/peg-leaderboard";
import { DepegTimeline } from "@/components/depeg-timeline";
import { DepegFeed } from "@/components/depeg-feed";
import type { PegCurrency, GovernanceType } from "@/lib/types";

const VALID_PEG_FILTERS = new Set(["all", "USD", "EUR", "GOLD"]);
const VALID_TYPE_FILTERS = new Set(["all", "centralized", "centralized-dependent", "decentralized"]);

export function PegTrackerClient() {
  const { data: pegData, isLoading } = usePegSummary();
  const { data: eventsData } = useDepegEvents();
  const { data: logos } = useLogos();

  const { getParam, setParam } = useUrlFilters();

  const rawPeg = getParam("peg", "all");
  const rawType = getParam("type", "all");
  const searchQuery = getParam("q");
  const pegFilter = (VALID_PEG_FILTERS.has(rawPeg) ? rawPeg : "all") as PegCurrency | "all";
  const typeFilter = (VALID_TYPE_FILTERS.has(rawType) ? rawType : "all") as GovernanceType | "all";

  const setPegFilter = useCallback((v: PegCurrency | "all") => setParam("peg", v), [setParam]);
  const setTypeFilter = useCallback((v: GovernanceType | "all") => setParam("type", v), [setParam]);
  const setSearchQuery = useCallback((v: string) => setParam("q", v), [setParam]);

  const filteredCoins = (pegData?.coins ?? []).filter((c) => {
    if (pegFilter !== "all" && c.pegCurrency !== pegFilter) return false;
    if (typeFilter !== "all" && c.governance !== typeFilter) return false;
    if (searchQuery) {
      const q = searchQuery.toLowerCase().trim();
      if (!c.name.toLowerCase().includes(q) && !c.symbol.toLowerCase().includes(q)) return false;
    }
    return true;
  });

  return (
    <div className="space-y-6">
      <PegTrackerStats summary={pegData?.summary ?? null} isLoading={isLoading} />

      <PegHeatmap
        coins={filteredCoins}
        logos={logos}
        isLoading={isLoading}
        pegFilter={pegFilter}
        typeFilter={typeFilter}
        onPegFilterChange={setPegFilter}
        onTypeFilterChange={setTypeFilter}
        searchQuery={searchQuery}
        onSearchChange={setSearchQuery}
      />

      <PegLeaderboard
        coins={filteredCoins}
        logos={logos}
        isLoading={isLoading}
      />

      <DepegTimeline
        events={eventsData?.events ?? []}
        logos={logos}
      />

      <DepegFeed
        events={eventsData?.events ?? []}
        logos={logos}
      />
    </div>
  );
}
