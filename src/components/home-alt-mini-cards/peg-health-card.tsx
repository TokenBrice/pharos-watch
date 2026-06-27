"use client";

import { useMemo } from "react";
import { Skeleton } from "@/components/ui/skeleton";
import { PulseCardHeader } from "@/components/home-alt-mini-cards/pulse-card-header";
import { usePegSummary } from "@/hooks/api-hooks";
import { bucketByDeviationBps } from "@/lib/home-alt-aggregates";

const SEGMENTS = [
  { key: "tight", label: "≤25", legend: "Good", colorClass: "bg-emerald-500" },
  { key: "loose", label: "25–100", legend: "Alert", colorClass: "bg-yellow-400" },
  { key: "stressed", label: "100–250", legend: "Warning", colorClass: "bg-orange-500" },
  { key: "severe", label: ">250", legend: "Danger", colorClass: "bg-red-500" },
] as const;

export function PegHealthCard(): React.JSX.Element {
  const { data, isLoading } = usePegSummary();
  const buckets = useMemo(() => bucketByDeviationBps(data?.coins ?? []), [data?.coins]);
  const total = buckets.tight + buckets.loose + buckets.stressed + buckets.severe;
  const summary = data?.summary;

  return (
    <div className="pharos-card-shell flex h-full flex-col gap-4 p-4">
      <PulseCardHeader href="/screener/" expandLabel="Open Screener" label="Peg Health" />
      {isLoading || !summary ? (
        <>
          <Skeleton className="h-9 w-32" />
          <Skeleton className="h-2.5 w-full rounded-full" />
          <Skeleton className="h-24 w-full" />
        </>
      ) : (
        <>
          <div>
            <div className="flex items-baseline font-mono text-4xl font-bold tabular-nums tracking-tight">
              <span className="text-foreground">{summary.coinsAtPeg}</span>
              <span className="mx-2 text-2xl text-muted-foreground/50">/</span>
              <span className="text-muted-foreground">{summary.totalTracked}</span>
            </div>
            <p className="mt-1.5 font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
              {summary.activeDepegCount} active · {summary.medianDeviationBps.toFixed(0)} bps median
            </p>
          </div>

          <div className="space-y-3 border-t border-border/50 pt-5">
            {total === 0 ? (
              <Skeleton className="h-8 w-full rounded-md" />
            ) : (
              <div
                className="flex h-8 w-full gap-0.5 overflow-hidden rounded-md bg-background/70"
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
                      title={`${seg.legend}: ${count}`}
                    />
                  );
                })}
              </div>
            )}
            <ul className="flex flex-col gap-1.5 font-mono text-xs">
              {SEGMENTS.map((seg) => (
                <li key={seg.key} className="flex items-center justify-between gap-2">
                  <span className="flex items-center gap-2 uppercase tracking-tight text-muted-foreground">
                    <span className={`inline-block h-2 w-2 rounded-sm ${seg.colorClass}`} aria-hidden="true" />
                    {seg.legend}
                  </span>
                  <span className="tabular-nums text-foreground">{buckets[seg.key]}</span>
                </li>
              ))}
            </ul>
          </div>
        </>
      )}
    </div>
  );
}
