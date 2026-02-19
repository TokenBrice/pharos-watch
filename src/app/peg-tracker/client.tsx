"use client";

import { useCallback } from "react";
import { useSearchParams, useRouter, usePathname } from "next/navigation";
import { usePegSummary } from "@/hooks/use-peg-summary";
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

  const searchParams = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();

  const rawPeg = searchParams.get("peg") ?? "all";
  const rawType = searchParams.get("type") ?? "all";
  const searchQuery = searchParams.get("q") ?? "";
  const pegFilter = (VALID_PEG_FILTERS.has(rawPeg) ? rawPeg : "all") as PegCurrency | "all";
  const typeFilter = (VALID_TYPE_FILTERS.has(rawType) ? rawType : "all") as GovernanceType | "all";

  const updateParams = useCallback((key: string, value: string) => {
    const params = new URLSearchParams(searchParams.toString());
    if (value === "all" || value === "") {
      params.delete(key);
    } else {
      params.set(key, value);
    }
    const qs = params.toString();
    router.replace(`${pathname}${qs ? `?${qs}` : ""}`, { scroll: false });
  }, [searchParams, router, pathname]);

  const setPegFilter = useCallback((v: PegCurrency | "all") => updateParams("peg", v), [updateParams]);
  const setTypeFilter = useCallback((v: GovernanceType | "all") => updateParams("type", v), [updateParams]);
  const setSearchQuery = useCallback((v: string) => updateParams("q", v), [updateParams]);

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
