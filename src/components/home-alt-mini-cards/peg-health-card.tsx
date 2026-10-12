"use client";

import { useMemo } from "react";
import { Skeleton } from "@/components/ui/skeleton";
import { PulseCard } from "@/components/home-alt-mini-cards/pulse-card-header";
import { usePegSummary } from "@/hooks/api-hooks";
import { bucketByDeviationBps } from "@/lib/home-alt-aggregates";
import { resolveQueryViewState } from "@/lib/query-view-state";
import {
  PEG_DEVIATION_LEVEL_LABELS,
  PEG_DEVIATION_LEVEL_MIN_BPS,
  PEG_DEVIATION_TONE_CLASSES,
  type PegDeviationLevel,
} from "@shared/lib/classification";

// Buckets, fills and legend all come from the shared peg-deviation levels
// (healthy green → mild amber → moderate orange → severe red).
const { mild, moderate, severe } = PEG_DEVIATION_LEVEL_MIN_BPS;
const SEGMENT_RANGES: ReadonlyArray<readonly [PegDeviationLevel, string]> = [
  ["healthy", `<${mild} bps`],
  ["mild", `${mild}–${moderate} bps`],
  ["moderate", `${moderate}–${severe} bps`],
  ["severe", `≥${severe} bps`],
];
const SEGMENTS = SEGMENT_RANGES.map(([key, label]) => ({
  key,
  label,
  legend: PEG_DEVIATION_LEVEL_LABELS[key],
  colorClass: PEG_DEVIATION_TONE_CLASSES[key].bar,
}));

export function PegHealthCard(): React.JSX.Element {
  const query = usePegSummary();
  const { data, isLoading } = query;
  const buckets = useMemo(() => bucketByDeviationBps(data?.coins ?? []), [data?.coins]);
  const total = buckets.healthy + buckets.mild + buckets.moderate + buckets.severe;
  const summary = data?.summary;
  const state = resolveQueryViewState({
    hasData: summary !== undefined,
    isLoading,
    error: query.error,
    isEmpty: summary?.totalTracked === 0,
  });

  return (
    <PulseCard
      className="pharos-card-shell flex h-full flex-col gap-4 p-4"
      href="/screener/"
      expandLabel="Open Screener"
      label="Peg health"
      state={state}
      notice={{
        label: "Peg health data",
        dataUpdatedAt: query.dataUpdatedAt,
        queries: [{ preset: "pegSummary", dataUpdatedAt: query.dataUpdatedAt, meta: query.meta, error: query.error, hasData: data !== undefined }],
        onRetry: () => void query.refetch(),
      }}
      loadingContent={
        <>
          <Skeleton className="h-9 w-32" />
          <Skeleton className="h-2.5 w-full rounded-full" />
          <Skeleton className="h-24 w-full" />
        </>
      }
    >
      {summary ? (
        <div className="flex flex-1 flex-col">
          <div>
            <div className="flex items-baseline pharos-numeric text-4xl font-bold tracking-tight">
              <span className="text-foreground">{summary.coinsAtPeg}</span>
              <span className="mx-2 text-2xl text-muted-foreground/50">/</span>
              <span className="text-muted-foreground">{summary.totalTracked}</span>
            </div>
            {/* The active-depeg count already answers on the market-state line and
                its own card; this card speaks in deviation bands. */}
            <p className="pharos-meta mt-1.5">
              At peg (per-coin threshold) · <span className="pharos-numeric">{summary.medianDeviationBps.toFixed(0)}</span> bps median
            </p>
          </div>

          <div className="mt-4 flex flex-1 flex-col border-t border-border/50 pt-4">
            <p className="pharos-label mb-2">Current deviation bands</p>
            {total === 0 ? (
              <div className="flex h-10 items-center justify-center rounded-md border border-border/60 bg-muted/30 pharos-meta">
                No coin-level deviation rows
              </div>
            ) : (
              <div
                className="flex h-10 w-full gap-0.5 overflow-hidden rounded-md bg-background/70"
                role="img"
                aria-label="Peg deviation distribution by band"
              >
                {SEGMENTS.map((seg, index) => {
                  const count = buckets[seg.key];
                  if (count === 0) return null;
                  const share = count / total;
                  return (
                    <div
                      key={seg.key}
                      className={`${seg.colorClass} ${index === 0 ? "rounded-l-md" : ""} ${index === SEGMENTS.length - 1 ? "rounded-r-md" : ""}`}
                      style={{ width: `${share * 100}%` }}
                      title={`${seg.legend} (${seg.label}): ${count}`}
                    />
                  );
                })}
              </div>
            )}
            <ul className="mt-3 grid flex-1 content-between gap-y-1.5 text-xs">
              {SEGMENTS.map((seg) => (
                <li key={seg.key} className="flex items-center justify-between gap-2">
                  <span className="flex items-center gap-2 text-muted-foreground">
                    <span className={`inline-block h-2 w-2 rounded-sm ${seg.colorClass}`} aria-hidden="true" />
                    {seg.legend}
                    <span className="pharos-numeric text-muted-foreground/70">{seg.label}</span>
                  </span>
                  <span className="pharos-numeric text-foreground">{buckets[seg.key]}</span>
                </li>
              ))}
            </ul>
          </div>
        </div>
      ) : null}
    </PulseCard>
  );
}
