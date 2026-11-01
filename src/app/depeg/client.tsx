"use client";

import { useMemo, useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { usePegSummary, useStressSignals } from "@/hooks/api-hooks";
import { useActiveDepegEvents, useInfiniteDepegEvents } from "@/hooks/use-depeg-events";
import { useDepegResolverSurfaces } from "@/hooks/use-depeg-resolver-surfaces";
import { useQuerySlice } from "@/hooks/use-query-slice";
import { logosById } from "@/lib/logos";
import { useUrlFilters } from "@/hooks/use-url-filters";
import { QueryFreshnessNotices } from "@/components/query-freshness-notices";
import type { StaleQuery } from "@/components/stale-data-banner";
import { SectionErrorBoundary } from "@/components/section-error-boundary";
import { DepegOutlookHero } from "@/components/depeg-outlook-hero";
import { DepegControlBoard } from "@/components/depeg-control-board";
import { DEWSAlertFeed } from "@/components/dews-alert-feed";
import { DepegFeed } from "@/components/depeg-feed";
import { DepegResolverModule } from "@/components/depeg-resolver-module";
import { DepegResolverReviewerModule } from "@/components/depeg-resolver-reviewer-module";
import { isResolverBookAvailable, summarizeResolverBook } from "@/components/depeg-resolver-book-summary";
import { trackEvent, trackSearch } from "@/lib/analytics";
import { extractPendingDepegIncidents, mapPendingIncidentsByCoin } from "@/lib/depeg-incident-utils";
import { refetchQueryGroup } from "@/lib/query-refetch-group";
import type { ApiMeta } from "@/lib/api";
import { classifyOpenIncidentEvidence } from "@shared/lib/active-depegs";
import { buildStablecoinUrl } from "@shared/lib/urls";
import type { PegCurrency, GovernanceType, StressSignalsAllResponse } from "@shared/types";
import { PEG_LABELS_SHORT, GOVERNANCE_LABELS, THREAT_BAND_ORDER, isThreatBand } from "@shared/lib/classification";
import type { DepegTrackerRow } from "@/lib/depeg-sort";
import { DepegContentLoadingState } from "./loading-state";
import { useStablecoins } from "@/hooks/use-stablecoins";

function isProducerClock(value: number | undefined): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

/**
 * DEWS health ages by the oldest retained signal generation, not the newest one the transport
 * stamps, keeping its verdict, warning, budgets and dependencies. An explicit-null transport clock
 * stays unknown; without a body clock the transported or body producer clock stands, never receipt.
 */
function selectDewsHealthClock(
  data: StressSignalsAllResponse | undefined,
  meta: ApiMeta | null,
): Pick<StaleQuery, "dataUpdatedAt" | "meta"> {
  if (meta?.updatedAt === null) return { dataUpdatedAt: 0, meta };
  const oldest = data?.oldestComputedAt;
  if (isProducerClock(oldest) && typeof meta?.updatedAt === "number") {
    const ageSeconds = typeof meta.ageSeconds === "number" ? meta.ageSeconds : 0;
    return {
      dataUpdatedAt: oldest * 1000,
      meta: { ...meta, updatedAt: oldest, ageSeconds: Math.max(0, ageSeconds + meta.updatedAt - oldest) } as ApiMeta,
    };
  }
  const bodyClock = isProducerClock(oldest) ? oldest : isProducerClock(data?.updatedAt) ? data.updatedAt : null;
  return { dataUpdatedAt: bodyClock == null ? 0 : bodyClock * 1000, meta };
}

export function DepegClient() {
  // Ticks so an open session's board keeps its relative event ages current; a
  // mount-time timestamp would freeze them in whatever state they loaded in.
  const [nowSeconds, setNowSeconds] = useState(() => Math.floor(Date.now() / 1000));
  useEffect(() => {
    const timer = setInterval(() => setNowSeconds(Math.floor(Date.now() / 1000)), 60_000);
    return () => clearInterval(timer);
  }, []);
  const {
    data: pegData,
    isLoading: isPegLoading,
    error: pegError,
    dataUpdatedAt: pegUpdatedAt,
    meta: pegMeta,
    refetch: refetchPeg,
  } = usePegSummary();
  // Radar sizing is independent of the peg-summary response and its loading shell.
  useStablecoins();
  const {
    data: dewsData,
    error: dewsError,
    meta: dewsMeta,
    refetch: refetchDews,
  } = useStressSignals();
  const {
    data: eventsData,
    error: eventsError,
    dataUpdatedAt: eventsUpdatedAt,
    meta: eventsMeta,
    refetch: refetchEvents,
  } = useInfiniteDepegEvents({ includePending: true });
  // Detail for open incidents only: the board's evidence labels, never the census.
  const { data: activeEventsData } = useActiveDepegEvents();
  const { resolverEnabled, resolverReviewerEnabled, resolver, resolverReview } = useDepegResolverSurfaces();
  const resolverSlice = useQuerySlice(resolver);
  const resolverReviewSlice = useQuerySlice(resolverReview);
  const resolverData = resolverSlice.data;
  const resolverReviewData = resolverReviewSlice.data;
  const logos = logosById;
  const router = useRouter();

  // Unified filter state (shared by the control board's filters and its rows)
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
      openIncidentEvidence: coin.activeDepeg
        ? classifyOpenIncidentEvidence(activeEventsData?.events, coin.id, nowSeconds)
        : null,
    }));
  }, [filteredPegCoins, dewsData, pendingByCoin, activeEventsData, nowSeconds]);
  const trackedIds = useMemo(
    () => (pegData?.coins ? new Set(pegData.coins.map((coin) => coin.id)) : undefined),
    [pegData],
  );
  // Coins with an open confirmed incident. Same response as the hero's headline count,
  // though the headline excludes NAV tokens while this set does not — see the
  // eligibility note in docs/depeg-page.md.
  const activeDepegIds = useMemo(
    () => new Set((pegData?.coins ?? []).filter((coin) => coin.activeDepeg).map((coin) => coin.id)),
    [pegData],
  );
  // Methodology eligibility, not a data fault: it belongs beside the board that
  // lists these assets, not in the hero.
  const eventFloorCount = useMemo(
    () => pegData?.coins?.filter((coin) => coin.depegEventCoverageLimited).length ?? 0,
    [pegData],
  );
  const recentClosedEvents = useMemo(
    () => (eventsData?.events ?? []).filter((event) => event.endedAt !== null),
    [eventsData],
  );
  // One derivation of the resolver book, shared with the module's own header so
  // the hero's posture and that header can never disagree.
  const resolverBook = useMemo(
    () => (isResolverBookAvailable(resolverData) ? summarizeResolverBook(resolverData.rows) : null),
    [resolverData],
  );

  // The worker answers an unreadable DEWS publication with an empty `signals`
  // map and `updatedAt: 0`; that is an absent read, not a calm measurement.
  const dewsAvailable = (dewsData?.updatedAt ?? 0) > 0;

  // Coins at ALERT+ on DEWS, scoped to the peg-catalog ids the route tracks.
  const dewsAlertCount = useMemo(() => {
    const signals = dewsData?.signals;
    if (!dewsAvailable || !signals || !trackedIds) return null;
    let count = 0;
    for (const [id, entry] of Object.entries(signals)) {
      if (trackedIds && !trackedIds.has(id)) continue;
      if (!isThreatBand(entry.band)) continue;
      if ((THREAT_BAND_ORDER[entry.band] ?? 0) >= THREAT_BAND_ORDER.ALERT) count += 1;
    }
    return count;
  }, [dewsAvailable, dewsData, trackedIds]);

  const handleRowClick = useCallback((id: string) => {
    router.push(buildStablecoinUrl(id));
  }, [router]);
  const globalError =
    pegError ??
    dewsError ??
    eventsError ??
    (resolverEnabled ? resolverSlice.error : null) ??
    (resolverReviewerEnabled ? resolverReviewSlice.error : null);
  const handleRetry = useCallback(() => {
    return refetchQueryGroup([
      refetchPeg,
      refetchDews,
      refetchEvents,
      ...(resolverEnabled ? [resolver.refetch] : []),
      ...(resolverReviewerEnabled ? [resolverReview.refetch] : []),
    ]);
  }, [
    refetchDews,
    refetchEvents,
    refetchPeg,
    resolver.refetch,
    resolverReview.refetch,
    resolverEnabled,
    resolverReviewerEnabled,
  ]);
  const freshnessQueries: StaleQuery[] = [
    { preset: "pegSummary", dataUpdatedAt: pegUpdatedAt, error: pegError, hasData: !!pegData?.coins?.length, meta: pegMeta },
    { preset: "stressSignals", ...selectDewsHealthClock(dewsData, dewsMeta), error: dewsError, hasData: dewsAvailable },
    { preset: "depegEvents", dataUpdatedAt: eventsUpdatedAt, error: eventsError, hasData: eventsData != null, meta: eventsMeta },
  ];
  if (resolverEnabled) {
    freshnessQueries.push({
      preset: "depegResolver",
      dataUpdatedAt: resolverSlice.dataUpdatedAt,
      error: resolverSlice.error,
      hasData: resolverData != null,
      meta: resolverSlice.meta,
    });
  }
  if (resolverReviewerEnabled) {
    freshnessQueries.push({
      preset: "depegResolverReview",
      dataUpdatedAt: resolverReviewSlice.dataUpdatedAt,
      error: resolverReviewSlice.error,
      hasData: resolverReviewData != null,
      meta: resolverReviewSlice.meta,
    });
  }

  // The ledger mounts after the browser's own anchor jump on a cold load (behind
  // the loading state), so align a `#forecast-grading` entry once it is in the DOM.
  const gradingScrollPending = useRef(true);
  useEffect(() => {
    if (!gradingScrollPending.current || isPegLoading) return;
    gradingScrollPending.current = false;
    if (window.location.hash !== "#forecast-grading") return;
    document.getElementById("forecast-grading")?.scrollIntoView?.();
  }, [isPegLoading]);

  // Loading state
  if (isPegLoading) {
    return <DepegContentLoadingState />;
  }

  return (
    <div className="space-y-6">
      <QueryFreshnessNotices
        error={globalError}
        hasData={!!pegData?.coins?.length}
        onRetry={handleRetry}
        queries={freshnessQueries}
      />

      {/* Signature hero: everything the route knows right now in one block —
          confirmed incidents, early warning, recovery posture, forecast track
          record — with the alert queue as the radar's detail layer. It is the
          single owner of every one of those headline figures; no module below
          restates them. */}
      <DepegOutlookHero
        stats={pegData?.summary}
        activeDepegIds={activeDepegIds}
        catalogCount={pegData?.coins ? pegData.coins.length : null}
        pendingCount={eventsData ? pendingIncidents.length : null}
        dewsAlertCount={dewsAlertCount}
        book={resolverEnabled ? resolverBook : null}
        lineage={resolverEnabled ? resolverData?._meta.lineage ?? null : null}
        review={resolverReviewerEnabled ? resolverReviewData?.summary ?? null : null}
        logos={logos}
        alertQueue={
          dewsAvailable ? (
            <SectionErrorBoundary name="dews-alert-feed">
              <DEWSAlertFeed signals={dewsData?.signals} logos={logos} allowedIds={trackedIds} embedded />
            </SectionErrorBoundary>
          ) : null
        }
      />

      {/* Recovery forecasts: the most urgent incidents, full book on demand. */}
      {resolverEnabled ? (
        <SectionErrorBoundary name="depeg-resolver">
          <DepegResolverModule data={resolverData} logos={logos} />
        </SectionErrorBoundary>
      ) : null}

      {/* The universe workbench: filters, sorts, exact per-coin values. Every row
          comes from the peg summary, so an absent read hides the board instead
          of rendering a manufactured empty catalog. */}
      {pegData != null ? (
        <SectionErrorBoundary name="depeg-table">
          <DepegControlBoard
            rows={tableRows}
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
            eventFloorCount={eventFloorCount}
          />
        </SectionErrorBoundary>
      ) : null}

      {/* Model accountability: audit evidence, after the board the reader acts on;
          the hero's track-record figure links here. */}
      {resolverReviewerEnabled ? (
        <SectionErrorBoundary name="depeg-resolver-reviewer">
          <section id="forecast-grading" aria-label="Forecast grading" className="scroll-mt-24">
            <DepegResolverReviewerModule
              data={resolverReviewData}
              error={resolverReview.error}
              logos={logos}
            />
          </section>
        </SectionErrorBoundary>
      ) : null}

      {/* History handoff. The permanent archive preview and FAQ follow as server
          content from page.tsx. An absent first page hides the card instead of
          claiming a settled empty history. */}
      {eventsData != null ? (
        <SectionErrorBoundary name="depeg-feed">
          <DepegFeed
            title="Recent resolved detections"
            events={recentClosedEvents}
            logos={logos}
            emptyMessage="No confirmed depeg history in this view."
          />
          <div className="mt-2 flex justify-end">
            <Link
              href="/timeline/?type=depeg.*"
              className="pharos-focus-ring text-xs text-muted-foreground hover:text-foreground"
            >
              Open the full Timeline stream →
            </Link>
          </div>
        </SectionErrorBoundary>
      ) : null}

    </div>
  );
}
