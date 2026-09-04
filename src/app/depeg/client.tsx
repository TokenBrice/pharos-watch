"use client";

import { useMemo, useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { usePegSummary, useStressSignals } from "@/hooks/api-hooks";
import { useInfiniteDepegEvents } from "@/hooks/use-depeg-events";
import { useDepegResolverSurfaces } from "@/hooks/use-depeg-resolver-surfaces";
import { useQuerySlices } from "@/hooks/use-query-slice";
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
import { summarizeResolverBook } from "@/components/depeg-resolver-book-summary";
import { trackEvent, trackSearch } from "@/lib/analytics";
import { extractPendingDepegIncidents, mapPendingIncidentsByCoin } from "@/lib/depeg-incident-utils";
import { refetchQueryGroup } from "@/lib/query-refetch-group";
import { buildStablecoinUrl } from "@shared/lib/urls";
import { formatElapsedSeconds } from "@shared/lib/format";
import type { PegCurrency, GovernanceType } from "@shared/types";
import { PEG_LABELS_SHORT, GOVERNANCE_LABELS, THREAT_BAND_ORDER, isThreatBand } from "@shared/lib/classification";
import type { DepegTrackerRow } from "@/lib/depeg-sort";
import { DepegContentLoadingState } from "./loading";

/** DEWS publishes every 30 minutes, so anything past two cycles is worth saying out loud. */
const STALE_DEWS_AGE_SEC = 60 * 60;

interface DepegCoverageMetrics {
  oldestAgeSec: number | null;
  malformedRows: number;
}

/** Caveat text for each degraded-reliability condition, in reading order. */
function reliabilityNotes(reliability: DepegCoverageMetrics): string[] {
  const notes: string[] = [];
  if (reliability.oldestAgeSec != null && reliability.oldestAgeSec > STALE_DEWS_AGE_SEC) {
    notes.push(`oldest DEWS signal ${formatElapsedSeconds(reliability.oldestAgeSec)} old`);
  }
  if (reliability.malformedRows > 0) {
    notes.push(`${reliability.malformedRows} malformed DEWS ${reliability.malformedRows === 1 ? "row" : "rows"}`);
  }
  return notes;
}

/**
 * Degraded-reliability caveats only, announced when they appear.
 *
 * The caller decides whether to mount it: a component that returns `null` is
 * still a truthy element, which would leave an empty bordered strip under the
 * hero in the healthy state.
 *
 * The healthy-state counts this band used to carry (live confirmed, pending,
 * DEWS population) are owned by the hero and the radar. The event-history floor
 * count also left: it is stable methodology eligibility, not a data fault, so it
 * belongs to the board that lists those assets.
 */
function DepegReliabilityNote({ notes }: { notes: string[] }) {
  return (
    <p className="pharos-subtle-band pharos-meta" role="status">
      <span className="font-semibold uppercase tracking-wide">Coverage caveats</span> · {notes.join(" · ")}
    </p>
  );
}

export function DepegClient() {
  // Ticks so an open session can actually cross the staleness threshold; a
  // mount-time timestamp would freeze the caveat in whatever state it loaded in.
  const [nowSeconds, setNowSeconds] = useState(() => Math.floor(Date.now() / 1000));
  useEffect(() => {
    const timer = setInterval(() => setNowSeconds(Math.floor(Date.now() / 1000)), 60_000);
    return () => clearInterval(timer);
  }, []);
  // The grading ledger renders open: it is the accountability half of the
  // forecast story and readers went looking for it. The control stays so a
  // reader scanning to the board can collapse ~1,300px of ledger out of the way.
  const [gradingOpen, setGradingOpen] = useState(true);
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
  } = useInfiniteDepegEvents({ includePending: true });
  const { resolverEnabled, resolverReviewerEnabled, resolver, resolverReview } = useDepegResolverSurfaces();
  const { resolverSlice, resolverReviewSlice } = useQuerySlices({
    resolverSlice: resolver,
    resolverReviewSlice: resolverReview,
  });
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
    }));
  }, [filteredPegCoins, dewsData, pendingByCoin]);
  const trackedIds = useMemo(
    () => (pegData?.coins ? new Set(pegData.coins.map((coin) => coin.id)) : undefined),
    [pegData],
  );
  // Coins in a confirmed live depeg. Same response as the hero's headline count,
  // though the headline excludes NAV tokens while this set does not — see the
  // eligibility note in docs/depeg-page.md.
  const activeDepegIds = useMemo(
    () => new Set((pegData?.coins ?? []).filter((coin) => coin.activeDepeg).map((coin) => coin.id)),
    [pegData],
  );
  // Methodology eligibility, not a data fault: it belongs beside the board that
  // lists these assets, not in the hero's degraded-reliability caveats.
  const eventFloorCount = useMemo(
    () => pegData?.coins?.filter((coin) => coin.depegEventCoverageLimited).length ?? 0,
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
      oldestAgeSec,
      malformedRows: dewsData?.malformedRows ?? 0,
    };
  }, [dewsData, nowSeconds]);
  const caveats = useMemo(() => reliabilityNotes(reliability), [reliability]);
  // One derivation of the resolver book, shared with the module's own header so
  // the hero's posture and that header can never disagree.
  const resolverBook = useMemo(
    () => (resolverData?.rows ? summarizeResolverBook(resolverData.rows) : null),
    [resolverData],
  );

  // Coins at ALERT+ on DEWS, scoped to the peg-catalog ids the route tracks.
  const dewsAlertCount = useMemo(() => {
    const signals = dewsData?.signals;
    if (!signals) return 0;
    let count = 0;
    for (const [id, entry] of Object.entries(signals)) {
      if (trackedIds && !trackedIds.has(id)) continue;
      if (!isThreatBand(entry.band)) continue;
      if ((THREAT_BAND_ORDER[entry.band] ?? 0) >= THREAT_BAND_ORDER.ALERT) count += 1;
    }
    return count;
  }, [dewsData, trackedIds]);

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
    { preset: "stressSignals", dataUpdatedAt: dewsUpdatedAt, error: dewsError, hasData: !!dewsData?.signals, meta: dewsMeta },
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
        pendingCount={pendingIncidents.length}
        dewsAlertCount={dewsAlertCount}
        book={resolverEnabled ? resolverBook : null}
        lineage={resolverEnabled ? resolverData?._meta.lineage ?? null : null}
        review={resolverReviewerEnabled ? resolverReviewData?.summary ?? null : null}
        logos={logos}
        alertQueue={
          <SectionErrorBoundary name="dews-alert-feed">
            <DEWSAlertFeed signals={dewsData?.signals} logos={logos} allowedIds={trackedIds} embedded />
          </SectionErrorBoundary>
        }
        footer={caveats.length > 0 ? <DepegReliabilityNote notes={caveats} /> : null}
      />

      {/* Recovery forecasts: the most urgent incidents, full book on demand. */}
      {resolverEnabled ? (
        <SectionErrorBoundary name="depeg-resolver">
          <DepegResolverModule data={resolverData} logos={logos} />
        </SectionErrorBoundary>
      ) : null}

      {/* Model accountability, kept beside the forecasts it grades. The ledger
          is heavy DOM, so it opens on demand; the hero's track-record figure
          links here. */}
      {resolverReviewerEnabled ? (
        <SectionErrorBoundary name="depeg-resolver-reviewer">
          <section id="forecast-grading" aria-label="Forecast grading" className="space-y-3">
            <button
              type="button"
              onClick={() => setGradingOpen((open) => !open)}
              aria-expanded={gradingOpen}
              className="pharos-focus-ring pharos-control-pill"
            >
              {gradingOpen ? "Hide forecast grading · DDRR" : "Show forecast grading · DDRR"}
            </button>
            {gradingOpen ? (
              <DepegResolverReviewerModule
                data={resolverReviewData}
                error={resolverReview.error}
                logos={logos}
              />
            ) : null}
          </section>
        </SectionErrorBoundary>
      ) : null}

      {/* The universe workbench: filters, sorts, exact per-coin values. */}
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

      {/* History handoff. The permanent archive preview and FAQ follow as server
          content from page.tsx. */}
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

    </div>
  );
}
