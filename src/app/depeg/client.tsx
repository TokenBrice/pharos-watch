"use client";

import { useMemo, useCallback, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { usePegSummary, useStressSignals } from "@/hooks/api-hooks";
import { useInfiniteDepegEvents } from "@/hooks/use-depeg-events";
import { useDepegResolverSurfaces } from "@/hooks/use-depeg-resolver-surfaces";
import { useLogos } from "@/hooks/use-logos";
import { useUrlFilters } from "@/hooks/use-url-filters";
import { QueryFreshnessNotices } from "@/components/query-freshness-notices";
import { SectionErrorBoundary } from "@/components/section-error-boundary";
import { DepegTrackerStats } from "@/components/depeg-tracker-stats";
import { DepegControlBoard } from "@/components/depeg-control-board";
import { DEWSSummary } from "@/components/dews-summary";
import { DEWSAlertFeed } from "@/components/dews-alert-feed";
import { DepegFeed } from "@/components/depeg-feed";
import { DepegResolverModule } from "@/components/depeg-resolver-module";
import { DepegResolverPostureModule } from "@/components/depeg-resolver-posture-module";
import { DepegResolverReviewerModule } from "@/components/depeg-resolver-reviewer-module";
import { trackEvent, trackSearch } from "@/lib/analytics";
import { extractPendingDepegIncidents, mapPendingIncidentsByCoin } from "@/lib/depeg-incident-utils";
import { refetchQueryGroup } from "@/lib/query-refetch-group";
import { buildStablecoinUrl } from "@/lib/urls";
import { formatElapsedSeconds } from "@shared/lib/format";
import type { PegCurrency, GovernanceType } from "@shared/types";
import { PEG_LABELS_SHORT, GOVERNANCE_LABELS } from "@shared/lib/classification";
import type { DepegTrackerRow } from "@/components/depeg-tracker-table";

interface DepegCoverageMetrics {
  dewsCoverageCount: number;
  oldestAgeSec: number | null;
  malformedRows: number;
  coverageLimitedCount: number;
  activeCount: number;
  pendingCount: number;
}

function DepegLoadingState() {
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

function DepegCoverageBand({ reliability }: { reliability: DepegCoverageMetrics }) {
  const items: Array<{ value: string; label: string }> = [
    { value: String(reliability.activeCount), label: "live confirmed" },
    { value: String(reliability.pendingCount), label: "pending" },
    { value: String(reliability.dewsCoverageCount), label: "DEWS current" },
    {
      value: reliability.oldestAgeSec != null ? formatElapsedSeconds(reliability.oldestAgeSec) : "—",
      label: "oldest DEWS",
    },
    { value: String(reliability.coverageLimitedCount), label: "event floor" },
    { value: String(reliability.malformedRows), label: "malformed" },
  ];
  return (
    <div className="pharos-subtle-band flex flex-wrap items-center gap-x-5 gap-y-1.5 sm:justify-between">
      <h2 className="pharos-kicker mr-1">Coverage</h2>
      {items.map((item) => (
        <span key={item.label} className="text-xs text-muted-foreground">
          <span className="font-mono font-semibold tabular-nums text-foreground">{item.value}</span>{" "}
          {item.label}
        </span>
      ))}
    </div>
  );
}


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
    resolverEnabled,
    resolverReviewerEnabled,
    resolverData,
    resolverError,
    resolverUpdatedAt,
    resolverMeta,
    refetchResolver,
    resolverReviewData,
    resolverReviewError,
    resolverReviewUpdatedAt,
    resolverReviewMeta,
    refetchResolverReview,
  } = useDepegResolverSurfaces();
  const { data: logos } = useLogos();
  const router = useRouter();

  // Unified filter state (shared by table + heatmap)
  const { getParam, setParam, setParams } = useUrlFilters();
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
  const clearBoardFilters = useCallback(() => {
    trackEvent("filter_applied", { page: "depeg", filter_type: "all", filter_value: "clear" });
    setParams({ peg: "all", type: "all", q: "" });
  }, [setParams]);

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
  // Coins currently in an active depeg — same source as the activeDepegCount headline, so the
  // hero logo cluster always matches the count. Worst deviation first.
  const activeDepegCoins = useMemo(
    () =>
      (pegData?.coins ?? [])
        .filter((coin) => coin.activeDepeg)
        .sort((a, b) => Math.abs(b.currentDeviationBps ?? 0) - Math.abs(a.currentDeviationBps ?? 0))
        .map((coin) => ({ id: coin.id, symbol: coin.symbol })),
    [pegData],
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
      activeCount: pegData?.summary?.activeDepegCount ?? 0,
      pendingCount: pendingIncidents.length,
    };
  }, [dewsData, nowSeconds, pegData, pendingIncidents.length]);

  const handleRowClick = useCallback((id: string) => {
    router.push(buildStablecoinUrl(id));
  }, [router]);
  const globalError =
    pegError ??
    dewsError ??
    eventsError ??
    (resolverEnabled ? resolverError : null) ??
    (resolverReviewerEnabled ? resolverReviewError : null);
  const handleRetry = useCallback(() => {
    return refetchQueryGroup([
      refetchPeg,
      refetchDews,
      refetchEvents,
      ...(resolverEnabled ? [refetchResolver] : []),
      ...(resolverReviewerEnabled ? [refetchResolverReview] : []),
    ]);
  }, [refetchDews, refetchEvents, refetchPeg, refetchResolver, refetchResolverReview, resolverEnabled, resolverReviewerEnabled]);

  // Loading state
  if (isPegLoading) {
    return <DepegLoadingState />;
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
          ...(resolverEnabled ? [{ label: "Depeg Resolver", staleTime: 900_000, dataUpdatedAt: resolverUpdatedAt, error: resolverError, hasData: resolverData != null, meta: resolverMeta }] : []),
          ...(resolverReviewerEnabled ? [{ label: "DDR Reviewer", staleTime: 900_000, dataUpdatedAt: resolverReviewUpdatedAt, error: resolverReviewError, hasData: resolverReviewData != null, meta: resolverReviewMeta }] : []),
        ]}
      />

      {/* DEWS radar (left) + prioritized stats and alert queue (right) — 2-column on desktop */}
      <div className="grid grid-cols-1 gap-6 xl:grid-cols-2 xl:items-stretch">
        <SectionErrorBoundary name="dews">
          <DEWSSummary logos={logos} className="xl:h-full" />
        </SectionErrorBoundary>
        <div className="flex flex-col gap-6 xl:self-stretch">
          {pegData?.summary && (
            <SectionErrorBoundary name="depeg-stats">
              <DepegTrackerStats stats={pegData.summary} activeDepegCoins={activeDepegCoins} logos={logos} />
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

      {/* Coverage — full-width, low-prominence reliability band */}
      <DepegCoverageBand reliability={reliability} />

      {/* Outlook Posture — the whole live book aggregated by recovery verdict, above the per-event cards */}
      {resolverEnabled ? (
        <SectionErrorBoundary name="depeg-posture">
          <DepegResolverPostureModule data={resolverData} logos={logos} />
        </SectionErrorBoundary>
      ) : null}
      {/* Depeg Duration Resolver — recovery verdict + expected duration per open event */}
      {resolverEnabled ? (
        <SectionErrorBoundary name="depeg-resolver">
          <DepegResolverModule data={resolverData} logos={logos} />
        </SectionErrorBoundary>
      ) : null}
      {resolverEnabled && resolverReviewerEnabled ? (
        <div className="flex items-center justify-center gap-3 font-mono text-[10px] uppercase tracking-[0.14em] text-muted-foreground/70">
          <span className="h-px w-10 bg-gradient-to-r from-transparent to-border" aria-hidden="true" />
          <span>Live forecasts above · graded below</span>
          <span className="h-px w-10 bg-gradient-to-l from-transparent to-border" aria-hidden="true" />
        </div>
      ) : null}
      {resolverReviewerEnabled ? (
        <SectionErrorBoundary name="depeg-resolver-reviewer">
          <DepegResolverReviewerModule data={resolverReviewData} error={resolverReviewError} logos={logos} />
        </SectionErrorBoundary>
      ) : null}

      {/* Control board: filters + heatmap + ranked instrument rows */}
      <SectionErrorBoundary name="depeg-table">
        <DepegControlBoard
          rows={tableRows}
          stats={pegData?.summary}
          logos={logos}
          pegFilter={pegFilter}
          typeFilter={typeFilter}
          searchQuery={searchQuery}
          onPegFilterChange={setPegFilter}
          onTypeFilterChange={setTypeFilter}
          onSearchChange={setSearchQuery}
          onClearFilters={clearBoardFilters}
          onRowClick={handleRowClick}
          nowSeconds={nowSeconds}
        />
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

    </div>
  );
}
