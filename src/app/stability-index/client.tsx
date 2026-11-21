"use client";

import { useCallback, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { X } from "lucide-react";
import { QueryErrorNotice } from "@/components/query-error-notice";
import { ScoreChart } from "@/components/psi-beacon/psi-history-chart";
import { LazySection } from "@/components/lazy-section";
import { StaleDataBanner } from "@/components/stale-data-banner";
import { Button } from "@/components/ui/button";
import { useStabilityIndexDetail, useStabilityIndexFullHistory } from "@/hooks/api-hooks";
import { usePsiBeaconState } from "@/hooks/use-psi-beacon-state";
import { logosById } from "@/lib/logos";
import { ShowYourWorkPanel } from "@/components/show-your-work-panel";
import type { StabilityIndexResponse } from "@shared/types/stability";
import { formatScore } from "@shared/lib/format";
import {
  buildPsiChartData,
  getDisplayedPsi,
  getDisplayedPsiBasis,
  getPsiCompletedDayPoint,
} from "@shared/lib/psi-view-model";
import {
  buildFocusedPsiEventWindow,
  buildPsiComponentData,
  buildPsiBeamDimmers,
  buildPsiContributorRows,
  buildPsiEventTimelineRows,
  buildPsiHistoryStats,
  type PsiEventTimelineRow,
} from "./view-model";
import {
  PsiContributorsTableCard,
  PsiEventTimelineCard,
  PsiMethodologyCard,
  StabilityIndexEmptyState,
  StabilityIndexLoadingState,
  StabilityIndexPanel,
} from "./presentational";

function PsiHistoryChart({
  initialData,
  focusedEvent,
  onClearFocusedEvent,
}: {
  initialData: StabilityIndexResponse;
  focusedEvent: PsiEventTimelineRow | null;
  onClearFocusedEvent: () => void;
}) {
  const [rangeNeedsFullHistory, setRangeNeedsFullHistory] = useState(false);
  const needsFullHistory = rangeNeedsFullHistory || focusedEvent !== null;
  const fullHistory = useStabilityIndexFullHistory({ enabled: needsFullHistory });
  // A disabled TanStack query still serves its cached entry; the chart must
  // fall back to the detail read rather than freeze on old full history.
  const source = needsFullHistory ? (fullHistory.data ?? initialData) : initialData;
  const { history, current } = source;
  const chartData = useMemo(() => buildPsiChartData(history, current), [history, current]);
  const focusedWindowData = useMemo(
    () => buildFocusedPsiEventWindow(chartData, focusedEvent),
    [chartData, focusedEvent],
  );
  const displayData = focusedEvent ? (focusedWindowData ?? chartData) : chartData;

  return (
    <div className="space-y-3">
      <QueryErrorNotice
        error={fullHistory.error}
        hasData={!!fullHistory.data}
        onRetry={() => { void fullHistory.refetch(); }}
      />
      {focusedEvent ? (
        <div
          className="pharos-card-shell flex flex-wrap items-center justify-between gap-2 px-4 py-2.5 text-xs"
          role="status"
          data-testid="psi-focused-event-banner"
        >
          <div className="flex flex-wrap items-baseline gap-x-2.5 gap-y-1">
            <span className="pharos-label">Focused window</span>
            <span className="font-semibold text-foreground">{focusedEvent.label}</span>
            <span className="pharos-numeric text-muted-foreground">{focusedEvent.dateStr}</span>
            {focusedEvent.psi !== null ? (
              <span className={`pharos-numeric font-medium ${focusedEvent.psiColor}`}>
                PSI {formatScore(focusedEvent.psi)}
              </span>
            ) : null}
            {focusedEvent.caseStudies.map((study) => (
              <Link
                key={study.slug}
                href={study.href}
                className="pharos-focus-ring rounded-sm font-medium text-brand-accent-text hover:underline"
              >
                Read case study &rarr;
              </Link>
            ))}
          </div>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="min-h-8 gap-1 px-2.5 text-xs"
            onClick={onClearFocusedEvent}
          >
            <X className="h-3.5 w-3.5" aria-hidden="true" />
            Clear focus
          </Button>
        </div>
      ) : null}
      {needsFullHistory && !fullHistory.data ? (
        <p className="text-sm text-muted-foreground" role="status">
          {fullHistory.error
            ? "Full history unavailable; showing the recent year."
            : focusedEvent
              ? `Loading full history for ${focusedEvent.label}…`
              : "Loading full history…"}
        </p>
      ) : null}
      <ScoreChart
        key={focusedEvent ? `event-${focusedEvent.label}` : "default"}
        data={displayData}
        initialRange={focusedEvent ? "all" : "1y"}
        onRangeChange={(range) => {
          if (focusedEvent && range !== "all") {
            onClearFocusedEvent();
          }
          setRangeNeedsFullHistory(range === "all");
        }}
      />
    </div>
  );
}

export function StabilityIndexClient() {
  const { data, isLoading, error, dataUpdatedAt, refetch, meta } = useStabilityIndexDetail();
  const logos = logosById;
  const history = data?.history;
  const current = data?.current ?? null;
  const methodology = data?.methodology ?? null;
  const beacon = usePsiBeaconState({ current, meta, dataUpdatedAt, error, isLoading });

  const historySectionRef = useRef<HTMLElement>(null);
  const [focusedEvent, setFocusedEvent] = useState<PsiEventTimelineRow | null>(null);
  const [historyRevealed, setHistoryRevealed] = useState(false);

  const headlineAggregates = data?.headlineAggregates;
  const eventTimelineRows = useMemo(
    () => buildPsiEventTimelineRows(headlineAggregates?.eventScores ?? []),
    [headlineAggregates],
  );

  const componentData = useMemo(() => buildPsiComponentData(history ?? [], current), [current, history]);

  const beamDimmerLanes = useMemo(() => buildPsiBeamDimmers(componentData), [componentData]);

  const historyStats = useMemo(
    () => buildPsiHistoryStats(history ?? [], current?.computedAt ?? null),
    [history, current?.computedAt],
  );

  const contributorRows = useMemo(
    () => buildPsiContributorRows(current?.contributors ?? [], current?.totalMcapUsd ?? 0),
    [current?.contributors, current?.totalMcapUsd],
  );

  const displayPsi = useMemo(() => (current ? getDisplayedPsi(current) : null), [current]);
  const displayBasis = useMemo(() => (current ? getDisplayedPsiBasis(current) : "raw instant"), [current]);

  const delta = useMemo(() => {
    if (!current || !displayPsi) return null;
    const yesterday = getPsiCompletedDayPoint(history ?? [], current.computedAt, 1);
    return yesterday ? Math.round((displayPsi.score - yesterday.score) * 10) / 10 : null;
  }, [current, displayPsi, history]);

  const handleSelectEvent = useCallback((event: PsiEventTimelineRow) => {
    setFocusedEvent((prev) => {
      if (prev?.label === event.label) return null;
      return event;
    });
    setHistoryRevealed(true);
    historySectionRef.current?.scrollIntoView?.({ behavior: "smooth", block: "start" });
  }, []);

  const handleClearFocusedEvent = useCallback(() => {
    setFocusedEvent(null);
  }, []);

  if (isLoading) {
    return <StabilityIndexLoadingState />;
  }

  // A failed refetch over a retained coherent generation keeps the page; the banner ages it.
  if (!current || !headlineAggregates || headlineAggregates.computedAt !== current.computedAt) {
    const uiError = error ?? new Error("Stability Index data is temporarily unavailable.");
    return (
      <QueryErrorNotice
        error={uiError}
        hasData={false}
        onRetry={() => {
          void refetch();
        }}
      />
    );
  }

  if (!current || !displayPsi || !methodology || !headlineAggregates) {
    return <StabilityIndexEmptyState />;
  }

  return (
    <div className="space-y-6 animate-in fade-in duration-300">
      <StaleDataBanner
        queries={[{ preset: "stabilityIndex", dataUpdatedAt, error, hasData: !!current, meta }]}
      />

      <StabilityIndexPanel
        band={displayPsi.band}
        score={displayPsi.score}
        scoreBasis={displayBasis}
        instantScore={current.score}
        instantBand={current.band}
        delta={delta}
        daysInBand={headlineAggregates.daysInBand}
        historyStats={historyStats}
        lanes={beamDimmerLanes}
        componentData={componentData}
        beaconState={beacon.state}
      />

      <ShowYourWorkPanel kind="psi" current={current} />

      {current.contributors && current.contributors.length > 0 && (
        <PsiContributorsTableCard rows={contributorRows} logos={logos} />
      )}

      <div className="border-t border-border/40 pt-2" />

      <section ref={historySectionRef} id="psi-history" aria-label="PSI history" className="scroll-mt-24">
        {historyRevealed ? (
          <PsiHistoryChart
            initialData={data!}
            focusedEvent={focusedEvent}
            onClearFocusedEvent={handleClearFocusedEvent}
          />
        ) : (
          <LazySection minHeight={450}>
            <PsiHistoryChart
              initialData={data!}
              focusedEvent={focusedEvent}
              onClearFocusedEvent={handleClearFocusedEvent}
            />
          </LazySection>
        )}
      </section>

      <PsiEventTimelineCard
        rows={eventTimelineRows}
        selectedEventLabel={focusedEvent?.label ?? null}
        onSelectEvent={handleSelectEvent}
      />

      <PsiMethodologyCard methodology={methodology} />
    </div>
  );
}
