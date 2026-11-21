"use client";

import { useId, useMemo } from "react";
import { Skeleton } from "@/components/ui/skeleton";
import { PulseCard } from "@/components/home-alt-mini-cards/pulse-card-header";
import { RowSparkline } from "@/components/row-sparkline";
import { UniverseChip } from "@/components/universe-chip";
import { RailHeroFigureTransition } from "@/components/view-transitions";
import { useStabilityIndex } from "@/hooks/api-hooks";
import { usePsiBeaconState } from "@/hooks/use-psi-beacon-state";
import { CHART_BLUE } from "@/lib/chart-colors";
import { formatDataHealthTimestamp } from "@/lib/data-health";
import { resolveQueryViewState } from "@/lib/query-view-state";
import { type ConditionBand, DIRECTION_TONE_CLASSES, PSI_BAND_CLASSES } from "@shared/lib/classification";
import { formatScore } from "@shared/lib/format";
import { buildPsiChartData, getDisplayedPsi, getDisplayedPsiBasis } from "@shared/lib/psi-view-model";

function StabilityAreaChart({ values, color }: { values: number[]; color: string }): React.JSX.Element | null {
  const rawId = useId();
  const gradientId = `stability-area-fill-${rawId.replace(/[^a-zA-Z0-9_-]/g, "")}`;
  return (
    <RowSparkline
      data={values}
      width={100}
      height={40}
      inset={{ top: 4, right: 0, bottom: 2, left: 0 }}
      strokeWidth={1.5}
      yRangeMode="flat-unit"
      nonScalingStroke
      fillStyle={{
        kind: "vertical-gradient",
        id: gradientId,
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
  // A non-fresh observation keeps its band name without its hue (R3).
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
      className={`${embedded ? "h-full min-h-0 gap-2.5 p-3.5" : "pharos-card-shell gap-3 p-4"} flex flex-col`}
      href="/stability-index/"
      expandLabel="Open Stability Index"
      label={
        <span className="flex items-center gap-1.5">
          Stability Index
          {bandLabel ? <span className={`font-medium ${bandClass}`}>· {bandLabel}</span> : null}
        </span>
      }
      state={state}
    >
      <div className="flex flex-col gap-2">
        {/* Score + sparkline share the top row so narrow viewports never crush the sparkline. */}
        <div className="flex items-center justify-between gap-4">
          <div className="shrink-0">
            {state === "loading" ? (
              <Skeleton className="h-9 w-20" />
            ) : displayedPsi ? (
              <RailHeroFigureTransition rail="psi">
                <span className="block pharos-numeric text-4xl font-bold leading-none tracking-tight text-foreground">
                  {formatScore(displayedPsi.score)}
                </span>
              </RailHeroFigureTransition>
            ) : null}
          </div>
          <div className={`min-w-24 flex-1 ${embedded ? "h-12" : "h-16"}`}>
            <StabilityAreaChart values={sparkValues} color={sparkColor} />
          </div>
        </div>
        <div className="flex flex-wrap items-center justify-between gap-x-2 gap-y-1">
          <p className="pharos-meta min-w-0">
            {/* Homepage rule (docs/homepage.md#data-health): an aged reading gets a neutral date, not a state word. */}
            {current && !beacon.isCurrent ? (
              <span className="block" data-testid="psi-band-card-as-of">
                As of {formatDataHealthTimestamp(current.computedAt * 1000, "en-US", "UTC")}
              </span>
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
          {current ? <UniverseChip universe="psi" /> : null}
        </div>
      </div>
    </PulseCard>
  );
}
