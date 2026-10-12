"use client";

import { useMemo } from "react";
import { Skeleton } from "@/components/ui/skeleton";
import { PulseCard } from "@/components/home-alt-mini-cards/pulse-card-header";
import { RowSparkline } from "@/components/row-sparkline";
import { UniverseChip } from "@/components/universe-chip";
import { RailHeroFigureTransition } from "@/components/view-transitions";
import { useStabilityIndex } from "@/hooks/api-hooks";
import { usePsiBeaconState } from "@/hooks/use-psi-beacon-state";
import { CHART_BLUE } from "@/lib/chart-colors";
import { resolveQueryViewState } from "@/lib/query-view-state";
import { type ConditionBand, DIRECTION_TONE_CLASSES, PSI_BAND_CLASSES } from "@shared/lib/classification";
import { formatScore } from "@shared/lib/format";
import { buildPsiChartData, getDisplayedPsi, getDisplayedPsiBasis } from "@shared/lib/psi-view-model";

function StabilityAreaChart({ values, color }: { values: number[]; color: string }): React.JSX.Element | null {
  return (
    <RowSparkline
      data={values}
      width={100}
      height={40}
      inset={{ top: 4, right: 0, bottom: 2, left: 0 }}
      strokeWidth={1.5}
      yRangeMode="flat-unit"
      nonScalingStroke={false}
      fillStyle={{
        kind: "vertical-gradient",
        id: "stability-area-fill",
        startOpacity: 0.32,
        endOpacity: 0.02,
        baselineY: 40,
      }}
      minPoints={2}
      positiveColor={color}
      decorative
      ariaLabel="Stability Index history"
      className="block h-full w-full"
      emptyContent={null}
    />
  );
}

export function PsiBandCard({ embedded = false }: { embedded?: boolean } = {}): React.JSX.Element {
  const query = useStabilityIndex();
  const { data, isLoading } = query;
  const current = data?.current ?? null;
  const sparkValues = useMemo(() => {
    const chartData = buildPsiChartData(data?.history ?? [], current);
    return chartData.slice(-90).map((p) => p.score);
  }, [current, data?.history]);
  // The card leads with the same displayed basis as the market-state line and
  // the /stability-index/ hero (rolling 24h avg when published, 1 decimal);
  // the raw instant reading is demoted to the context line.
  const displayedPsi = current ? getDisplayedPsi(current) : null;
  const displayedPsiBasis = current ? getDisplayedPsiBasis(current) : null;
  const avgDelta = displayedPsi && sparkValues.length > 0
    ? displayedPsi.score - sparkValues.reduce((sum, value) => sum + value, 0) / sparkValues.length
    : null;
  const beacon = usePsiBeaconState({
    current,
    meta: query.meta,
    dataUpdatedAt: query.dataUpdatedAt,
    error: query.error,
    isLoading,
  });

  const band = displayedPsi?.band as ConditionBand | undefined;
  const sparkColor = CHART_BLUE;
  // A retained (non-fresh) observation keeps its band name but not its hue, like the regime bar (R3).
  const bandClass = band && beacon.isCurrent ? (PSI_BAND_CLASSES[band] ?? "text-foreground") : "text-muted-foreground";
  const bandLabel = band ? band.charAt(0) + band.slice(1).toLowerCase() : null;
  const avgDeltaClass =
    avgDelta != null && avgDelta >= 0 ? DIRECTION_TONE_CLASSES.up : DIRECTION_TONE_CLASSES.down;
  const state = resolveQueryViewState({
    hasData: current !== null,
    isLoading,
    error: query.error,
    isEmpty: current === null,
  });

  return (
    <PulseCard
      className={`${embedded ? "h-full min-h-0 gap-3 p-3.5" : "pharos-card-shell gap-4 p-4"} flex flex-col`}
      href="/stability-index/"
      expandLabel="Open Stability Index"
      label={
        <span className="flex items-center gap-1.5">
          Stability Index
          {bandLabel ? <span className={`font-medium ${bandClass}`}>· {bandLabel}</span> : null}
        </span>
      }
      state={state}
      notice={{
        label: "Stability Index",
        dataUpdatedAt: query.dataUpdatedAt,
        queries: [{ preset: "stabilityIndex", dataUpdatedAt: query.dataUpdatedAt, meta: query.meta, error: query.error, hasData: data !== undefined }],
        onRetry: () => void query.refetch(),
        compact: true,
      }}
    >
      <div className="flex flex-col gap-2">
        <div className="flex items-center gap-4">
          <div className="min-w-0 shrink-0">
            {state === "loading" ? (
              <Skeleton className="h-9 w-24" />
            ) : displayedPsi ? (
              <RailHeroFigureTransition rail="psi">
                <span className="block pharos-numeric text-4xl font-bold tracking-tight text-foreground">
                  {formatScore(displayedPsi.score)}
                </span>
              </RailHeroFigureTransition>
            ) : null}
            <p className="pharos-meta mt-1.5">
              {current && !beacon.isCurrent && beacon.retainedLabel ? (
                <span className="block" data-testid="psi-band-card-retained">{beacon.retainedLabel}</span>
              ) : null}
              {current && displayedPsiBasis ? (
                <>
                  <span>{displayedPsiBasis === "rolling 24h avg" ? "Rolling 24h avg" : "Raw instant"}</span>
                  {displayedPsiBasis === "rolling 24h avg" ? (
                    <>
                      {" · "}
                      raw instant <span className="pharos-numeric">{current.score.toFixed(1)}</span>
                    </>
                  ) : null}
                  {" · "}
                </>
              ) : null}
              90d{" "}
              {avgDelta !== null ? (
                <span className={`pharos-numeric ${avgDeltaClass}`}>
                  {avgDelta >= 0 ? "+" : ""}
                  {avgDelta.toFixed(1)}
                </span>
              ) : (
                "—"
              )}{" "}
              vs avg
            </p>
            {current ? <UniverseChip universe="psi" className="mt-1.5" /> : null}
          </div>
          <div className={`ml-auto flex-1 ${embedded ? "h-14" : "h-20"}`}>
            <StabilityAreaChart values={sparkValues} color={sparkColor} />
          </div>
        </div>
      </div>
    </PulseCard>
  );
}
