"use client";

import Link from "next/link";
import { ArrowRight } from "lucide-react";
import { Skeleton } from "@/components/ui/skeleton";
import { formatCurrency, formatPercent } from "@shared/lib/format";
import type { AltPegSnapshot } from "@/lib/alt-peg-market";

export function HomepageAltPegsTeaser({
  snapshot,
  isLoading = false,
}: {
  snapshot: AltPegSnapshot;
  isLoading?: boolean;
}) {
  if (isLoading && snapshot.altCoinCount === 0) {
    return (
      <section className="pharos-card-shell space-y-4 p-4 sm:p-5">
        <div className="space-y-2">
          <Skeleton className="h-3 w-24" />
          <Skeleton className="h-7 w-72" />
          <Skeleton className="h-4 w-full max-w-2xl" />
        </div>
        <div className="grid gap-4 lg:grid-cols-[minmax(0,0.9fr)_minmax(0,1.1fr)]">
          <Skeleton className="h-40 w-full rounded-xl" />
          <Skeleton className="h-40 w-full rounded-xl" />
        </div>
      </section>
    );
  }

  return (
    <section className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="space-y-1">
          <p className="pharos-kicker">Non-USD Route</p>
          <h2 className="pharos-section-title">Alternative Pegs Need Their Own Surface</h2>
          <p className="pharos-meta">
            The non-USD market now spans {snapshot.altCoinCount} tracked coins across {snapshot.altPegCount} peg
            cohorts. Open the dedicated route for current distribution, historical share growth, and crawlable cohort
            drill-down.
          </p>
        </div>
        <Link
          href="/alt-pegs/"
          className="pharos-focus-ring inline-flex items-center gap-1 rounded-sm text-xs text-muted-foreground hover:text-foreground"
        >
          Open Non-USD Route
          <ArrowRight className="h-3 w-3" />
        </Link>
      </div>

      <div className="pharos-card-shell overflow-hidden">
        <div className="grid gap-4 px-4 py-4 sm:px-5 sm:py-5 lg:grid-cols-[minmax(0,0.9fr)_minmax(0,1.1fr)] lg:items-start">
          <div className="space-y-3">
            <div className="space-y-1">
              <p className="text-[clamp(1.8rem,3vw,2.7rem)] font-black tracking-[-0.04em] text-foreground">
                {formatCurrency(snapshot.altMarketCap, 1)}
              </p>
              <p className="text-sm font-medium text-foreground">
                {formatPercent(snapshot.altSharePct)} of tracked stablecoin market cap is outside USD pegs.
              </p>
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="rounded-xl border border-border/60 bg-muted/15 px-3 py-3">
                <p className="pharos-kicker">Non-commodity Non-USD</p>
                <p className="mt-1 font-mono text-sm font-semibold text-foreground">
                  {formatCurrency(snapshot.fiatNonUsdMarketCap, 1)}
                </p>
              </div>
              <div className="rounded-xl border border-border/60 bg-muted/15 px-3 py-3">
                <p className="pharos-kicker">Commodities</p>
                <p className="mt-1 font-mono text-sm font-semibold text-foreground">
                  {formatCurrency(snapshot.commodityMarketCap, 1)}
                </p>
              </div>
            </div>
          </div>

          <div className="space-y-3">
            <p className="pharos-kicker">Largest Cohorts</p>
            <div className="space-y-2">
              {snapshot.topRows.map((row) => (
                <div
                  key={row.peg}
                  className="rounded-xl border border-border/60 bg-background/40 px-3 py-3"
                >
                  <div className="flex items-center justify-between gap-3">
                    <div className="flex min-w-0 items-center gap-2">
                      <span
                        className="inline-block h-2.5 w-2.5 rounded-full"
                        style={{ backgroundColor: row.colorHex }}
                      />
                      <span className="truncate text-sm font-medium text-foreground">{row.label}</span>
                    </div>
                    <span className="font-mono text-xs text-muted-foreground">{formatPercent(row.sharePct)}</span>
                  </div>
                  <div className="mt-2 h-2 overflow-hidden rounded-full bg-muted/30">
                    <div
                      className="h-full rounded-full"
                      style={{ width: `${Math.max(row.sharePct, 2)}%`, backgroundColor: row.colorHex }}
                    />
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
