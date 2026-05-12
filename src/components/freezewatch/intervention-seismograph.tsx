"use client";

import { Skeleton } from "@/components/ui/skeleton";
import { formatCurrency } from "@shared/lib/format";
import type { BlacklistSummaryResponse } from "@shared/types";

interface InterventionSeismographProps {
  stats: BlacklistSummaryResponse["stats"] | undefined;
  chart: BlacklistSummaryResponse["chart"] | undefined;
  isLoading: boolean;
}

const COUNT_FORMATTER = new Intl.NumberFormat("en-US", {
  maximumFractionDigits: 0,
});

function formatCount(value: number): string {
  return COUNT_FORMATTER.format(Number.isFinite(value) ? value : 0);
}

export function InterventionSeismograph({ stats, chart, isLoading }: InterventionSeismographProps) {
  if (isLoading) {
    return (
      <section className="pharos-card-shell overflow-hidden">
        <div className="pharos-panel-header space-y-2">
          <Skeleton className="h-4 w-40" />
          <Skeleton className="h-6 w-80 max-w-full" />
        </div>
        <div className="grid gap-0 lg:grid-cols-[1.1fr_1fr]">
          <div className="space-y-2 border-border/60 p-4 sm:p-5 lg:border-r">
            {Array.from({ length: 12 }).map((_, index) => (
              <Skeleton key={index} className="h-5 w-full" />
            ))}
          </div>
          <div className="grid gap-3 border-t border-border/60 p-4 sm:grid-cols-2 sm:p-5 lg:border-t-0">
            {Array.from({ length: 4 }).map((_, index) => (
              <Skeleton key={index} className="h-24 rounded-xl" />
            ))}
          </div>
        </div>
      </section>
    );
  }

  const visibleChart = (chart ?? []).filter((point) => point.total > 0);
  const maxTotal = visibleChart.reduce((max, point) => Math.max(max, point.total), 0);
  const recentPoint = visibleChart[visibleChart.length - 1] ?? null;
  const peakPoint = visibleChart.reduce<BlacklistSummaryResponse["chart"][number] | null>(
    (peak, point) => (!peak || point.total > peak.total ? point : peak),
    null,
  );

  return (
    <section
      className="pharos-card-shell overflow-hidden animate-in fade-in duration-300"
      aria-labelledby="intervention-seismograph-title"
    >
      <div className="pharos-panel-header flex flex-col gap-2 lg:flex-row lg:items-start lg:justify-between">
        <div className="space-y-1">
          <p className="pharos-kicker">Intervention Seismograph</p>
          <h2 id="intervention-seismograph-title" className="pharos-section-title">
            Freeze-ledger intensity by quarter
          </h2>
        </div>
        <p className="max-w-xl text-xs leading-relaxed text-muted-foreground">
          Balance intensity is measured from tracked frozen totals; event counts stay separate from value at risk.
        </p>
      </div>

      <div className="grid gap-0 lg:grid-cols-[1.1fr_1fr]">
        <div className="border-border/60 p-4 sm:p-5 lg:border-r">
          {visibleChart.length > 0 ? (
            <div className="grid gap-1.5">
              {visibleChart.slice(-18).map((point) => {
                const width = maxTotal > 0 ? Math.max(4, (point.total / maxTotal) * 100) : 0;
                return (
                  <div key={point.quarter} className="grid grid-cols-[4.5rem_1fr_5.5rem] items-center gap-3">
                    <span className="font-mono text-xs tabular-nums text-muted-foreground">{point.quarter}</span>
                    <div className="h-3 rounded-full bg-muted">
                      <div className="h-full rounded-full bg-red-500/75" style={{ width: `${width}%` }} />
                    </div>
                    <span className="text-right font-mono text-xs tabular-nums text-muted-foreground">
                      {formatCurrency(point.total, 0)}
                    </span>
                  </div>
                );
              })}
            </div>
          ) : (
            <div className="flex min-h-52 items-center justify-center text-sm text-muted-foreground">
              No tracked frozen balance in the current summary.
            </div>
          )}
        </div>

        <div className="grid gap-3 border-t border-border/60 p-4 sm:grid-cols-2 sm:p-5 lg:border-t-0">
          <Metric label="Peak quarter" value={peakPoint?.quarter ?? "None"} detail={formatCurrency(peakPoint?.total ?? 0, 0)} />
          <Metric label="Latest quarter" value={recentPoint?.quarter ?? "None"} detail={formatCurrency(recentPoint?.total ?? 0, 0)} />
          <Metric label="Observed events" value={formatCount(stats?.recentCount ?? 0)} detail="Current summary window" />
          <Metric label="24h events" value={formatCount(stats?.recentCount24h ?? 0)} detail="Latest supported tracker rows" />
        </div>
      </div>
    </section>
  );
}

function Metric({ label, value, detail }: { label: string; value: string; detail: string }) {
  return (
    <div className="rounded-xl border border-border/60 bg-background/60 p-3">
      <p className="text-[11px] font-semibold uppercase text-muted-foreground">{label}</p>
      <p className="mt-2 font-mono text-xl font-semibold tabular-nums text-foreground">{value}</p>
      <p className="mt-1 text-xs text-muted-foreground">{detail}</p>
    </div>
  );
}
