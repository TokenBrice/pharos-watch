"use client";

import { useMemo } from "react";
import { Skeleton } from "@/components/ui/skeleton";
import { usePegSummary } from "@/hooks/api-hooks";
import { bucketByDeviationBps } from "@/lib/home-alt-aggregates";

const SEGMENTS = [
  { key: "tight", label: "≤25", colorClass: "bg-emerald-500/85" },
  { key: "loose", label: "25–100", colorClass: "bg-amber-500/85" },
  { key: "stressed", label: "100–250", colorClass: "bg-orange-500/85" },
  { key: "severe", label: ">250", colorClass: "bg-red-500/90" },
] as const;

export function PegHealthCard(): React.JSX.Element {
  const { data, isLoading } = usePegSummary();
  const buckets = useMemo(
    () => bucketByDeviationBps(data?.coins ?? []),
    [data?.coins],
  );
  const total =
    buckets.tight + buckets.loose + buckets.stressed + buckets.severe;
  const summary = data?.summary;

  return (
    <div className="pharos-card-shell flex items-center gap-4 p-4">
      <div className="min-w-0 shrink-0">
        <p className="pharos-kicker">Peg Health</p>
        {isLoading || !summary ? (
          <Skeleton className="mt-1.5 h-7 w-32" />
        ) : (
          <div className="mt-1 flex items-baseline gap-2">
            <span className="font-mono text-3xl font-semibold tabular-nums text-foreground">
              {summary.coinsAtPeg}
            </span>
            <span className="text-xs text-muted-foreground">
              of {summary.totalTracked} at peg
            </span>
          </div>
        )}
        <p className="mt-1 font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
          {summary
            ? `${summary.activeDepegCount} active · median ${summary.medianDeviationBps.toFixed(0)} bps`
            : "Deviation distribution"}
        </p>
      </div>
      <div className="ml-auto h-12 flex-1">
        {isLoading || total === 0 ? (
          <Skeleton className="h-full w-full rounded-sm" />
        ) : (
          <div
            className="flex h-full w-full overflow-hidden rounded-sm bg-muted/40"
            role="img"
            aria-label="Peg deviation distribution by band"
          >
            {SEGMENTS.map((seg) => {
              const count = buckets[seg.key];
              if (count === 0) return null;
              const share = count / total;
              const showInline = share >= 0.08;
              return (
                <div
                  key={seg.key}
                  className={`relative flex items-center justify-center overflow-hidden ${seg.colorClass}`}
                  style={{ width: `${share * 100}%` }}
                  title={`${seg.label}: ${count}`}
                >
                  {showInline && (
                    <div className="flex min-w-0 flex-col items-center gap-0 px-1 text-center font-mono leading-tight text-white drop-shadow-[0_1px_1px_rgba(0,0,0,0.3)]">
                      <span className="text-xs font-semibold tabular-nums">
                        {count}
                      </span>
                      <span className="truncate text-[9px] uppercase tracking-tight opacity-90">
                        {seg.label}
                      </span>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
