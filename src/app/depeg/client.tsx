"use client";

import { useMemo, useCallback } from "react";
import { useRouter } from "next/navigation";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Search } from "lucide-react";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { usePegSummary } from "@/hooks/use-peg-summary";
import { useStressSignals } from "@/hooks/use-stress-signals";
import { useDepegEvents } from "@/hooks/use-depeg-events";
import { useLogos } from "@/hooks/use-logos";
import { useUrlFilters } from "@/hooks/use-url-filters";
import { StaleDataBanner } from "@/components/stale-data-banner";
import { SectionErrorBoundary } from "@/components/section-error-boundary";
import { CRON_15MIN } from "@/hooks/use-api-query";
import { DepegTrackerStats } from "@/components/depeg-tracker-stats";
import { DepegTrackerTable } from "@/components/depeg-tracker-table";
import { DEWSSummary } from "@/components/dews-summary";
import { DEWSAlertFeed } from "@/components/dews-alert-feed";
import { PegHeatmap } from "@/components/peg-heatmap";
import { DepegFeed } from "@/components/depeg-feed";
import { trackEvent, trackSearch } from "@/lib/analytics";
import type { PegCurrency, GovernanceType } from "@/lib/types";
import type { DepegTrackerRow } from "@/components/depeg-tracker-table";

const PEG_FILTERS: { value: PegCurrency | "all"; label: string }[] = [
  { value: "all", label: "All" },
  { value: "USD", label: "USD" },
  { value: "EUR", label: "EUR" },
  { value: "GOLD", label: "Gold" },
];

const TYPE_FILTERS: { value: GovernanceType | "all"; label: string }[] = [
  { value: "all", label: "All Types" },
  { value: "centralized", label: "CeFi" },
  { value: "centralized-dependent", label: "CeFi-Dep" },
  { value: "decentralized", label: "DeFi" },
];

export function DepegClient() {
  const { data: pegData, isLoading: isPegLoading, isError: isPegError, error: pegError, dataUpdatedAt: pegUpdatedAt } = usePegSummary();
  const { data: dewsData, dataUpdatedAt: dewsUpdatedAt } = useStressSignals();
  const { data: eventsData, dataUpdatedAt: eventsUpdatedAt } = useDepegEvents();
  const { data: logos } = useLogos();
  const router = useRouter();

  // Unified filter state (shared by table + heatmap)
  const { getParam, setParam } = useUrlFilters();
  const pegFilter = getParam("peg", "all") as PegCurrency | "all";
  const typeFilter = getParam("type", "all") as GovernanceType | "all";
  const searchQuery = getParam("q");

  const setPegFilter = useCallback((v: PegCurrency | "all") => {
    trackEvent("filter_applied", { page: "depeg", filter_type: "peg", filter_value: v });
    setParam("peg", v);
  }, [setParam]);
  const setTypeFilter = useCallback((v: GovernanceType | "all") => {
    trackEvent("filter_applied", { page: "depeg", filter_type: "type", filter_value: v });
    setParam("type", v);
  }, [setParam]);
  const setSearchQuery = useCallback((v: string) => {
    trackSearch("depeg", v.length);
    setParam("q", v);
  }, [setParam]);

  // Filter peg coins (shared between table + heatmap)
  const filteredPegCoins = useMemo(
    () =>
      (pegData?.coins ?? []).filter((c) => {
        if (pegFilter !== "all" && c.pegCurrency !== pegFilter) return false;
        if (typeFilter !== "all" && c.governance !== typeFilter) return false;
        if (searchQuery) {
          const q = searchQuery.toLowerCase();
          if (!c.name.toLowerCase().includes(q) && !c.symbol.toLowerCase().includes(q)) return false;
        }
        return true;
      }),
    [pegData, pegFilter, typeFilter, searchQuery],
  );

  // Merge peg coins with DEWS data for table rows
  const tableRows = useMemo((): DepegTrackerRow[] => {
    return filteredPegCoins.map((coin) => ({
      coin,
      dews: dewsData?.signals?.[coin.id] ?? null,
    }));
  }, [filteredPegCoins, dewsData]);
  const trackedIds = useMemo(
    () => (pegData?.coins ? new Set(pegData.coins.map((coin) => coin.id)) : undefined),
    [pegData],
  );

  const handleRowClick = useCallback((id: string) => {
    router.push(`/stablecoin/${id}`);
  }, [router]);

  // Loading state
  if (isPegLoading) {
    return (
      <div className="space-y-6">
        <div className="grid grid-cols-1 gap-6 lg:grid-cols-2 lg:items-stretch">
          <Skeleton className="h-[500px] rounded-xl" />
          <div className="flex flex-col gap-6">
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
              {Array.from({ length: 6 }).map((_, i) => (
                <Card key={i} className="rounded-xl">
                  <CardHeader className="pb-1"><Skeleton className="h-3 w-24" /></CardHeader>
                  <CardContent><Skeleton className="h-8 w-32" /></CardContent>
                </Card>
              ))}
            </div>
            <Skeleton className="flex-1 min-h-[200px] rounded-xl" />
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {isPegError && (
        <div className="rounded-md border border-destructive/50 bg-destructive/10 p-4 text-sm text-destructive">
          Failed to load peg data. {pegError instanceof Error ? pegError.message : "Please check your connection."}
        </div>
      )}
      {!isPegError && (
        <StaleDataBanner
          queries={[
            { label: "Peg Data", dataUpdatedAt: pegUpdatedAt, staleTime: CRON_15MIN },
            { label: "DEWS", dataUpdatedAt: dewsUpdatedAt, staleTime: CRON_15MIN },
            { label: "Depeg Events", dataUpdatedAt: eventsUpdatedAt, staleTime: CRON_15MIN },
          ]}
        />
      )}

      {/* DEWS radar + stat boxes — 2-column on desktop */}
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2 lg:items-stretch">
        <SectionErrorBoundary name="dews">
          <DEWSSummary logos={logos} />
        </SectionErrorBoundary>
        <div className="flex flex-col gap-6">
          {pegData?.summary && (
            <SectionErrorBoundary name="depeg-stats">
              <DepegTrackerStats stats={pegData.summary} />
            </SectionErrorBoundary>
          )}
          <SectionErrorBoundary name="dews-alert-feed">
            <DEWSAlertFeed
              signals={dewsData?.signals}
              logos={logos}
              allowedIds={trackedIds}
              className="flex-1 min-h-0"
            />
          </SectionErrorBoundary>
        </div>
      </div>

      {/* Filters + Table */}
      <SectionErrorBoundary name="depeg-table">
        <div className="space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h2 className="text-xl font-semibold">Peg Leaderboard</h2>
            <div className="flex flex-wrap items-center gap-3">
              <ToggleGroup
                type="single"
                value={pegFilter}
                onValueChange={(v) => v && setPegFilter(v as PegCurrency | "all")}
                className="flex gap-1"
                aria-label="Filter by peg currency"
              >
                {PEG_FILTERS.map((f) => (
                  <ToggleGroupItem key={f.value} value={f.value} variant="outline" size="sm" className="text-xs">
                    {f.label}
                  </ToggleGroupItem>
                ))}
              </ToggleGroup>
              <ToggleGroup
                type="single"
                value={typeFilter}
                onValueChange={(v) => v && setTypeFilter(v as GovernanceType | "all")}
                className="flex gap-1"
                aria-label="Filter by governance type"
              >
                {TYPE_FILTERS.map((f) => (
                  <ToggleGroupItem key={f.value} value={f.value} variant="outline" size="sm" className="text-xs">
                    {f.label}
                  </ToggleGroupItem>
                ))}
              </ToggleGroup>
              <div className="relative w-full sm:w-44">
                <Search className="absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
                <Input
                  placeholder="Search..."
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  className="pl-8 h-8 text-xs"
                  aria-label="Search stablecoins by name or symbol"
                />
              </div>
            </div>
          </div>

          <DepegTrackerTable
            rows={tableRows}
            logos={logos}
            onRowClick={handleRowClick}
          />
        </div>
      </SectionErrorBoundary>

      {/* Recent Depeg Events */}
      <SectionErrorBoundary name="depeg-feed">
        <DepegFeed
          events={eventsData?.events ?? []}
          logos={logos}
        />
      </SectionErrorBoundary>

      {/* Peg Heatmap (moved from homepage) — shares filter state */}
      <SectionErrorBoundary name="heatmap">
        <PegHeatmap
          coins={filteredPegCoins}
          logos={logos}
          isLoading={isPegLoading}
          pegFilter={pegFilter}
          typeFilter={typeFilter}
          onPegFilterChange={setPegFilter}
          onTypeFilterChange={setTypeFilter}
          searchQuery={searchQuery}
          onSearchChange={setSearchQuery}
          hideFilters
        />
      </SectionErrorBoundary>

    </div>
  );
}
