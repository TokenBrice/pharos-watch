"use client";

import { useMemo, useState } from "react";
import { QueryErrorNotice } from "@/components/query-error-notice";
import { ScoreChart } from "@/components/psi-history-chart";
import { LazySection } from "@/components/lazy-section";
import { StaleDataBanner } from "@/components/stale-data-banner";
import { useStabilityIndexDetail, useStabilityIndexFullHistory } from "@/hooks/api-hooks";
import { usePsiBeaconState } from "@/hooks/use-psi-beacon-state";
import { logosById } from "@/lib/logos";
import { ShowYourWorkPanel } from "@/components/show-your-work-panel";
import type { StabilityIndexResponse } from "@shared/types/stability";
import {
  buildPsiChartData,
  getDisplayedPsi,
  getDisplayedPsiBasis,
  getPsiCompletedDayPoint,
} from "@shared/lib/psi-view-model";
import {
  buildPsiComponentData,
  buildPsiBeamDimmers,
  buildPsiContributorRows,
  buildPsiEventTimelineRows,
  buildPsiHistoryStats,
} from "./view-model";
import {
  PsiContributorsTableCard,
  PsiEventTimelineCard,
  PsiMethodologyCard,
  StabilityIndexEmptyState,
  StabilityIndexLoadingState,
  StabilityIndexPanel,
} from "./presentational";

function PsiHistoryChart({ initialData }: { initialData: StabilityIndexResponse }) {
  const [needsFullHistory, setNeedsFullHistory] = useState(false);
  const fullHistory = useStabilityIndexFullHistory({ enabled: needsFullHistory });
  const { history, current } = fullHistory.data ?? initialData;
  const chartData = useMemo(() => buildPsiChartData(history, current), [history, current]);
  return (
    <div className="space-y-3">
      <QueryErrorNotice
        error={fullHistory.error}
        hasData={!!fullHistory.data}
        onRetry={() => { void fullHistory.refetch(); }}
      />
      {needsFullHistory && !fullHistory.data ? (
        <p className="text-sm text-muted-foreground" role="status">
          {fullHistory.error ? "Full history unavailable; showing the recent year." : "Loading full history…"}
        </p>
      ) : null}
      <ScoreChart
        data={chartData}
        initialRange="1y"
        onRangeChange={(range) => setNeedsFullHistory(range === "all")}
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

      <section aria-label="PSI history">
        <LazySection minHeight={450}>
          <PsiHistoryChart initialData={data!} />
        </LazySection>
      </section>

      <PsiEventTimelineCard rows={eventTimelineRows} />

      <PsiMethodologyCard methodology={methodology} />
    </div>
  );
}
