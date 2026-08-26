"use client";

import { useMemo } from "react";
import { QueryErrorNotice } from "@/components/query-error-notice";
import { ScoreChart } from "@/components/psi-history-chart";
import { StaleDataBanner } from "@/components/stale-data-banner";
import { useStabilityIndexDetail } from "@/hooks/api-hooks";
import { logosById } from "@/lib/logos";
import { ShowYourWorkPanel } from "@/components/show-your-work-panel";
import {
  buildPsiChartData,
  getDisplayedPsi,
  getDisplayedPsiBasis,
  getPsiBandStreak,
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

export function StabilityIndexClient() {
  const { data, isLoading, isError, error, dataUpdatedAt, refetch, meta } = useStabilityIndexDetail();
  const logos = logosById;
  const history = data?.history;
  const current = data?.current ?? null;
  const methodology = data?.methodology ?? null;

  const daysInBand = useMemo(() => {
    if (!current || !history?.length) return 0;
    return getPsiBandStreak(history, current.computedAt, getDisplayedPsi(current).band);
  }, [current, history]);

  const chartData = useMemo(() => buildPsiChartData(history ?? [], current), [current, history]);

  const componentData = useMemo(() => buildPsiComponentData(history ?? [], current), [current, history]);

  const beamDimmerLanes = useMemo(() => buildPsiBeamDimmers(componentData), [componentData]);

  const historyStats = useMemo(() => buildPsiHistoryStats(history ?? []), [history]);

  const eventTimelineRows = useMemo(() => buildPsiEventTimelineRows(chartData), [chartData]);

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

  if (isError || (!isLoading && !current)) {
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

  if (!current || !displayPsi || !methodology) {
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
        daysInBand={daysInBand}
        historyStats={historyStats}
        lanes={beamDimmerLanes}
        componentData={componentData}
      />

      <ShowYourWorkPanel kind="psi" current={current} />

      {current.contributors && current.contributors.length > 0 && (
        <PsiContributorsTableCard rows={contributorRows} logos={logos} />
      )}

      <div className="border-t border-border/40 pt-2" />

      <ScoreChart data={chartData} />

      <PsiEventTimelineCard rows={eventTimelineRows} />

      <PsiMethodologyCard methodology={methodology} />
    </div>
  );
}
