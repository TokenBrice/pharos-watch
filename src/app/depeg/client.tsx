"use client";

import { useMemo, useCallback, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { FilterSearchInput } from "@/components/filter-search-input";
import { usePegSummary } from "@/hooks/api-hooks";
import { useStressSignals } from "@/hooks/api-hooks";
import { useDepegResolver } from "@/hooks/api-hooks";
import { useInfiniteDepegEvents } from "@/hooks/use-depeg-events";
import { useLogos } from "@/hooks/use-logos";
import { useUrlFilters } from "@/hooks/use-url-filters";
import { usePreference } from "@/hooks/use-preferences";
import { QueryFreshnessNotices } from "@/components/query-freshness-notices";
import { SectionErrorBoundary } from "@/components/section-error-boundary";
import { DepegTrackerStats } from "@/components/depeg-tracker-stats";
import { DepegTrackerTable } from "@/components/depeg-tracker-table";
import { DEWSSummary } from "@/components/dews-summary";
import { DEWSAlertFeed } from "@/components/dews-alert-feed";
import { PegHeatmap } from "@/components/peg-heatmap";
import { PegDeviationStrip } from "@/components/peg-deviation-strip";
import { PegCohortRidge } from "@/components/peg-cohort-ridge";
import { DepegFeed } from "@/components/depeg-feed";
import { DepegPendingIncidents } from "@/components/depeg-pending-incidents";
import { DepegResolverModule } from "@/components/depeg-resolver-module";
import { trackEvent, trackSearch } from "@/lib/analytics";
import { extractPendingDepegIncidents, mapPendingIncidentsByCoin } from "@/lib/depeg-incident-utils";
import { refetchQueryGroup } from "@/lib/query-refetch-group";
import { buildStablecoinUrl } from "@/lib/urls";
import { formatElapsedSeconds } from "@shared/lib/format";
import type { PegCurrency, GovernanceType } from "@shared/types";
import { PEG_LABELS_SHORT, GOVERNANCE_LABELS, PEG_FILTER_OPTIONS, GOVERNANCE_FILTER_OPTIONS } from "@shared/lib/classification";
import type { DepegTrackerRow } from "@/components/depeg-tracker-table";


export function DepegClient() {
  const [nowSeconds] = useState(() => Math.floor(Date.now() / 1000));
  const {
    data: pegData,
    isLoading: isPegLoading,
    error: pegError,
    dataUpdatedAt: pegUpdatedAt,
    meta: pegMeta,
    refetch: refetchPeg,
  } = usePegSummary();
  const {
    data: dewsData,
    error: dewsError,
    dataUpdatedAt: dewsUpdatedAt,
    meta: dewsMeta,
    refetch: refetchDews,
  } = useStressSignals();
  const {
    data: eventsData,
    error: eventsError,
    dataUpdatedAt: eventsUpdatedAt,
    meta: eventsMeta,
    refetch: refetchEvents,
    fetchNextPage,
    hasNextPage,
    isFetchingNextPage,
  } = useInfiniteDepegEvents({ includePending: true });
  const {
    data: resolverData,
    error: resolverError,
    dataUpdatedAt: resolverUpdatedAt,
    meta: resolverMeta,
    refetch: refetchResolver,
  } = useDepegResolver();
  const { data: logos } = useLogos();
  const router = useRouter();

  // Heatmap-vs-strip view preference (council D12). Default = grid.
  const [depegView, setDepegView] = usePreference<string>("pharos-depeg-view", "grid");

  // Unified filter state (shared by table + heatmap)
  const { getParam, setParam } = useUrlFilters();
  const rawPeg = getParam("peg", "all");
  const pegFilter: PegCurrency | "all" = rawPeg === "all" || rawPeg in PEG_LABELS_SHORT ? rawPeg as PegCurrency | "all" : "all";
  const rawType = getParam("type", "all");
  const typeFilter: GovernanceType | "all" = rawType === "all" || rawType in GOVERNANCE_LABELS ? rawType as GovernanceType | "all" : "all";
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
  const pendingIncidents = useMemo(() => extractPendingDepegIncidents(eventsData), [eventsData]);
  const pendingByCoin = useMemo(() => mapPendingIncidentsByCoin(pendingIncidents), [pendingIncidents]);

  // Merge peg coins with DEWS data for table rows
  const tableRows = useMemo((): DepegTrackerRow[] => {
    return filteredPegCoins.map((coin) => ({
      coin,
      dews: dewsData?.signals?.[coin.id] ?? null,
      pendingIncident: pendingByCoin.get(coin.id) ?? null,
    }));
  }, [filteredPegCoins, dewsData, pendingByCoin]);
  const trackedIds = useMemo(
    () => (pegData?.coins ? new Set(pegData.coins.map((coin) => coin.id)) : undefined),
    [pegData],
  );
  const activeEvents = useMemo(
    () => (eventsData?.events ?? []).filter((event) => event.endedAt === null),
    [eventsData],
  );
  const recentClosedEvents = useMemo(
    () => (eventsData?.events ?? []).filter((event) => event.endedAt !== null),
    [eventsData],
  );
  const reliability = useMemo(() => {
    const signals = dewsData?.signals ? Object.values(dewsData.signals) : [];
    const oldestComputedAt = dewsData?.oldestComputedAt ?? signals.reduce<number | null>((oldest, entry) => {
      if (!entry.computedAt) return oldest;
      return oldest == null ? entry.computedAt : Math.min(oldest, entry.computedAt);
    }, null);
    const oldestAgeSec = oldestComputedAt ? Math.max(0, nowSeconds - oldestComputedAt) : null;
    return {
      dewsCoverageCount: signals.length,
      oldestAgeSec,
      malformedRows: dewsData?.malformedRows ?? 0,
      coverageLimitedCount: pegData?.coins?.filter((coin) => coin.depegEventCoverageLimited).length ?? 0,
      activeCount: pegData?.summary?.activeDepegCount ?? activeEvents.length,
      pendingCount: pendingIncidents.length,
    };
  }, [activeEvents.length, dewsData, nowSeconds, pegData, pendingIncidents.length]);

  const handleRowClick = useCallback((id: string) => {
    router.push(buildStablecoinUrl(id));
  }, [router]);
  const globalError = pegError ?? dewsError ?? eventsError;
  const handleRetry = useCallback(() => {
    return refetchQueryGroup([refetchPeg, refetchDews, refetchEvents, refetchResolver]);
  }, [refetchDews, refetchEvents, refetchPeg, refetchResolver]);

  // Loading state
  if (isPegLoading) {
    return (
      <div className="space-y-6">
        <div className="grid grid-cols-1 gap-6 xl:grid-cols-2 xl:items-stretch">
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
      <QueryFreshnessNotices
        error={globalError}
        hasData={!!pegData?.coins?.length}
        onRetry={handleRetry}
        queries={[
          { preset: "pegSummary", dataUpdatedAt: pegUpdatedAt, error: pegError, hasData: !!pegData?.coins?.length, meta: pegMeta },
          { preset: "stressSignals", dataUpdatedAt: dewsUpdatedAt, error: dewsError, hasData: !!dewsData?.signals, meta: dewsMeta },
          { preset: "depegEvents", dataUpdatedAt: eventsUpdatedAt, error: eventsError, hasData: eventsData != null, meta: eventsMeta },
          { label: "Depeg Resolver", staleTime: 900_000, dataUpdatedAt: resolverUpdatedAt, error: resolverError, hasData: resolverData != null, meta: resolverMeta },
        ]}
      />

      {/* DEWS radar + stat boxes — 2-column on desktop */}
      <div className="grid grid-cols-1 gap-6 xl:grid-cols-2 xl:items-start">
        <div className="flex flex-col gap-6 xl:self-stretch">
          <SectionErrorBoundary name="dews">
            <DEWSSummary logos={logos} />
          </SectionErrorBoundary>
          <Card className="rounded-xl">
            <CardHeader className="pb-2">
              <h2 className="pharos-kicker">Coverage</h2>
            </CardHeader>
            <CardContent className="grid grid-cols-2 gap-3 text-sm sm:grid-cols-3">
              <div>
                <div className="font-mono text-lg font-semibold tabular-nums">{reliability.activeCount}</div>
                <div className="text-xs text-muted-foreground">live confirmed</div>
              </div>
              <div>
                <div className="font-mono text-lg font-semibold tabular-nums">{reliability.pendingCount}</div>
                <div className="text-xs text-muted-foreground">pending</div>
              </div>
              <div>
                <div className="font-mono text-lg font-semibold tabular-nums">{reliability.dewsCoverageCount}</div>
                <div className="text-xs text-muted-foreground">DEWS current</div>
              </div>
              <div>
                <div className="font-mono text-lg font-semibold tabular-nums">
                  {reliability.oldestAgeSec != null ? formatElapsedSeconds(reliability.oldestAgeSec) : "—"}
                </div>
                <div className="text-xs text-muted-foreground">oldest DEWS</div>
              </div>
              <div>
                <div className="font-mono text-lg font-semibold tabular-nums">{reliability.coverageLimitedCount}</div>
                <div className="text-xs text-muted-foreground">event floor</div>
              </div>
              <div>
                <div className="font-mono text-lg font-semibold tabular-nums">{reliability.malformedRows}</div>
                <div className="text-xs text-muted-foreground">malformed</div>
              </div>
            </CardContent>
          </Card>
        </div>
        <div className="flex flex-col gap-6 xl:self-stretch">
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

      {/* Depeg Duration Resolver — recovery verdict + expected duration per open event */}
      <SectionErrorBoundary name="depeg-resolver">
        <DepegResolverModule data={resolverData} logos={logos} />
      </SectionErrorBoundary>

      {/* Cohort deviation shape (Council D15) — standalone ridge plot */}
      <SectionErrorBoundary name="cohort-ridge">
        <PegCohortRidge coins={pegData?.coins ?? []} />
      </SectionErrorBoundary>

      {/* Filters + Table */}
      <SectionErrorBoundary name="depeg-table">
        <section id="data" aria-label="Data table" tabIndex={-1} className="space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h2 className="pharos-kicker">Leaderboard and heatmap filters</h2>
            <div className="flex flex-wrap items-center gap-3">
              <ToggleGroup
                type="single"
                value={pegFilter}
                onValueChange={(v) => v && setPegFilter(v as PegCurrency | "all")}
                className="flex gap-1"
                aria-label="Filter by peg currency"
              >
                {PEG_FILTER_OPTIONS.map((f) => (
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
                {GOVERNANCE_FILTER_OPTIONS.map((f) => (
                  <ToggleGroupItem key={f.value} value={f.value} variant="outline" size="sm" className="text-xs">
                    {f.label}
                  </ToggleGroupItem>
                ))}
              </ToggleGroup>
              <FilterSearchInput
                value={searchQuery}
                onValueChange={setSearchQuery}
                placeholder="Search..."
                className="relative w-full sm:w-44"
                inputClassName="pl-8 h-8 text-xs"
                ariaLabel="Search stablecoins by name or symbol"
              />
            </div>
          </div>

          <DepegTrackerTable
            rows={tableRows}
            logos={logos}
            onRowClick={handleRowClick}
          />
        </section>
      </SectionErrorBoundary>

      <SectionErrorBoundary name="active-depeg-feed">
        <DepegFeed
          title="Active Incidents"
          events={activeEvents}
          logos={logos}
          emptyMessage="No confirmed active depeg incidents."
        />
      </SectionErrorBoundary>

      <SectionErrorBoundary name="pending-depeg-feed">
        <DepegPendingIncidents incidents={pendingIncidents} logos={logos} />
      </SectionErrorBoundary>

      {/* Recent Depeg Events */}
      <SectionErrorBoundary name="depeg-feed">
        <DepegFeed
          events={recentClosedEvents}
          logos={logos}
          emptyMessage="No confirmed depeg history in this view."
          hasMore={!!hasNextPage}
          isLoadingMore={isFetchingNextPage}
          onLoadMore={() => void fetchNextPage()}
        />
        <div className="mt-2 flex justify-end">
          <Link
            href="/timeline/?type=depeg.*"
            className="pharos-focus-ring text-xs text-muted-foreground hover:text-foreground"
          >
            See all depeg events on the Timeline →
          </Link>
        </div>
      </SectionErrorBoundary>

      {/* Peg Heatmap (moved from homepage) — shares filter state.
          Council D12: Grid / Strip view toggle, default = grid. */}
      <SectionErrorBoundary name="heatmap">
        <div className="space-y-2">
          <div className="flex justify-end">
            <ToggleGroup
              type="single"
              value={depegView}
              onValueChange={(v) => v && setDepegView(v)}
              className="flex gap-1"
              aria-label="Live peg deviation view"
            >
              <ToggleGroupItem value="grid" variant="outline" size="sm" className="text-xs">
                Grid
              </ToggleGroupItem>
              <ToggleGroupItem value="strip" variant="outline" size="sm" className="text-xs">
                Strip
              </ToggleGroupItem>
            </ToggleGroup>
          </div>
          {depegView === "strip" ? (
            <PegDeviationStrip coins={filteredPegCoins} />
          ) : (
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
              fallbackPegTypes={pegData?.summary?.fallbackPegRates}
              hideFilters
            />
          )}
        </div>
      </SectionErrorBoundary>

    </div>
  );
}
