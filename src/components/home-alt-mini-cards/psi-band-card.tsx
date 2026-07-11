"use client";

import { useMemo } from "react";
import { Skeleton } from "@/components/ui/skeleton";
import { PulseCardHeader } from "@/components/home-alt-mini-cards/pulse-card-header";
import { QueryStateNotice } from "@/components/query-state-notice";
import { useStabilityIndex } from "@/hooks/api-hooks";
import { CHART_BLUE } from "@/lib/chart-colors";
import { resolveQueryViewState } from "@/lib/query-view-state";
import { PSI_BAND_CLASSES, type ConditionBand } from "@shared/lib/psi-colors";
import { buildPsiChartData } from "@shared/lib/psi-view-model";

function StabilityAreaChart({ values, color }: { values: number[]; color: string }): React.JSX.Element | null {
  if (values.length < 2) return null;
  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = max - min || 1;
  const stepX = 100 / (values.length - 1);
  const points = values
    .map((v, i) => {
      const x = (i * stepX).toFixed(2);
      const y = (38 - ((v - min) / range) * 34).toFixed(2);
      return `${x},${y}`;
    })
    .join(" ");
  return (
    <svg viewBox="0 0 100 40" className="block h-full w-full" preserveAspectRatio="none" aria-hidden="true">
      <defs>
        <linearGradient id="stability-area-fill" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={color} stopOpacity={0.32} />
          <stop offset="100%" stopColor={color} stopOpacity={0.02} />
        </linearGradient>
      </defs>
      <polygon points={`${points} 100,40 0,40`} fill="url(#stability-area-fill)" stroke="none" />
      <polyline
        points={points}
        fill="none"
        stroke={color}
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
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
  const avgDelta = useMemo(() => {
    if (!current || sparkValues.length === 0) return null;
    const avg = sparkValues.reduce((sum, value) => sum + value, 0) / sparkValues.length;
    return current.score - avg;
  }, [current, sparkValues]);

  const band = current?.band as ConditionBand | undefined;
  const sparkColor = CHART_BLUE;
  const bandClass = band ? (PSI_BAND_CLASSES[band] ?? "text-foreground") : "text-muted-foreground";
  const bandLabel = band ? band.charAt(0) + band.slice(1).toLowerCase() : null;
  const avgDeltaClass =
    avgDelta != null && avgDelta >= 0 ? "text-green-700 dark:text-green-400" : "text-red-700 dark:text-red-400";
  const state = resolveQueryViewState({
    hasData: current !== null,
    isLoading,
    error: query.error,
    isEmpty: current === null,
  });

  return (
    <div className={`${embedded ? "h-full min-h-0 gap-3 p-3.5" : "pharos-card-shell gap-4 p-4"} flex flex-col`}>
      <PulseCardHeader
        href="/stability-index/"
        expandLabel="Open Stability Index"
        label={
          <span className="flex items-center gap-1.5">
            Stability Index
            {bandLabel ? <span className={`font-medium ${bandClass}`}>· {bandLabel}</span> : null}
          </span>
        }
      />
      {state === "unavailable" ? (
        <QueryStateNotice state={state} label="Stability Index" onRetry={() => void query.refetch()} compact />
      ) : (
        <div className="flex flex-col gap-2">
          {state === "stale-with-data" ? (
            <QueryStateNotice
              state={state}
              label="Stability Index"
              dataUpdatedAt={query.dataUpdatedAt}
              onRetry={() => void query.refetch()}
              compact
            />
          ) : null}
          <div className="flex items-center gap-4">
            <div className="min-w-0 shrink-0">
              {state === "loading" ? (
                <Skeleton className="h-9 w-24" />
              ) : current ? (
                <span className="block pharos-numeric text-4xl font-bold tracking-tight text-foreground">
                  {current.score.toFixed(2)}
                </span>
              ) : null}
              <p className="mt-1.5 font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
                90D{" "}
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
            </div>
            <div className={`ml-auto flex-1 ${embedded ? "h-14" : "h-20"}`}>
              <StabilityAreaChart values={sparkValues} color={sparkColor} />
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
