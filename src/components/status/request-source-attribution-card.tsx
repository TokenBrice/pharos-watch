import { formatCompactCount, formatPercent } from "@shared/lib/format";
import type { PublicApiRequestSourceStatsResponse } from "@shared/types";

function formatBucketLabel(bucketStart: number): string {
  return new Date(bucketStart * 1000).toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
  });
}

export function RequestSourceAttributionCard({
  stats,
  error,
  isLoading,
}: {
  stats: PublicApiRequestSourceStatsResponse | null | undefined;
  error?: string | null;
  isLoading?: boolean;
}) {
  const totals = stats?.totals ?? null;
  const routes = stats?.routes ?? [];
  const buckets = stats?.buckets ?? [];
  const bucketSizeMinutes = stats ? stats.window.bucketSizeSec / 60 : null;

  return (
    <div className="rounded-[1.25rem] border border-border/60 bg-background/35 p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="space-y-1">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="text-base font-semibold tracking-tight text-foreground">API load attribution</h3>
            {stats ? (
              <span className="rounded-full border border-border/60 bg-background/50 px-2 py-0.5 text-[11px] font-medium text-muted-foreground">
                {Math.round(stats.window.durationSec / 3600)}h window
              </span>
            ) : null}
          </div>
          <p className="text-sm leading-relaxed text-muted-foreground">
            Website-vs-external public API split from request metadata and the first-party browser marker.
          </p>
        </div>
        {totals ? (
          <div className="flex flex-wrap gap-2">
            <span className="rounded-full border border-sky-500/25 bg-sky-500/10 px-2.5 py-1 text-[11px] font-medium text-sky-700 dark:text-sky-300">
              Web {formatPercent(totals.webSharePct, 1)}
            </span>
            <span className="rounded-full border border-amber-500/25 bg-amber-500/10 px-2.5 py-1 text-[11px] font-medium text-amber-700 dark:text-amber-300">
              External {formatPercent(totals.externalSharePct, 1)}
            </span>
          </div>
        ) : null}
      </div>

      {error ? (
        <div className="mt-4 rounded-xl border border-amber-500/25 bg-amber-500/10 px-3 py-2 text-sm text-amber-700 dark:text-amber-300">
          {error}
        </div>
      ) : isLoading && !stats ? (
        <div className="mt-4 text-sm text-muted-foreground">Loading API attribution…</div>
      ) : !totals ? (
        <div className="mt-4 text-sm text-muted-foreground">No attribution data yet.</div>
      ) : (
        <div className="mt-4 space-y-4">
          <div className="grid gap-3 sm:grid-cols-3">
            <div className="rounded-xl border border-border/60 bg-background/45 p-3">
              <div className="text-[11px] uppercase tracking-[0.18em] text-muted-foreground">Total requests</div>
              <div className="mt-1 font-mono text-xl font-semibold text-foreground">{formatCompactCount(totals.totalRequests)}</div>
            </div>
            <div className="rounded-xl border border-border/60 bg-background/45 p-3">
              <div className="text-[11px] uppercase tracking-[0.18em] text-muted-foreground">Website</div>
              <div className="mt-1 font-mono text-xl font-semibold text-foreground">{formatCompactCount(totals.webRequests)}</div>
            </div>
            <div className="rounded-xl border border-border/60 bg-background/45 p-3">
              <div className="text-[11px] uppercase tracking-[0.18em] text-muted-foreground">External</div>
              <div className="mt-1 font-mono text-xl font-semibold text-foreground">{formatCompactCount(totals.externalRequests)}</div>
            </div>
          </div>

          <div className="grid gap-4 xl:grid-cols-[minmax(0,1.15fr)_minmax(0,0.85fr)]">
            <div className="rounded-xl border border-border/60 bg-background/45 p-3">
              <div className="mb-3 flex items-center justify-between gap-2">
                <div className="text-sm font-medium text-foreground">Top route groups</div>
                <div className="text-xs text-muted-foreground">Sorted by 24h volume</div>
              </div>
              <div className="space-y-2">
                {routes.length > 0 ? routes.map((route) => (
                  <div key={route.routeKey} className="rounded-lg border border-border/50 bg-background/40 px-3 py-2">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div className="min-w-0">
                        <div className="truncate font-mono text-xs text-foreground">{route.routePath}</div>
                        <div className="text-[11px] text-muted-foreground">{route.routeKey}</div>
                      </div>
                      <div className="text-right">
                        <div className="font-mono text-sm text-foreground">{formatCompactCount(route.totalRequests)}</div>
                        <div className="text-[11px] text-muted-foreground">ext {formatPercent(route.externalSharePct, 1)}</div>
                      </div>
                    </div>
                    <div className="mt-2 h-2 overflow-hidden rounded-full bg-muted/70">
                      <div className="flex h-full">
                        <div
                          className="bg-sky-500/70"
                          style={{ width: `${route.webSharePct}%` }}
                        />
                        <div
                          className="bg-amber-500/70"
                          style={{ width: `${route.externalSharePct}%` }}
                        />
                      </div>
                    </div>
                  </div>
                )) : (
                  <div className="text-sm text-muted-foreground">No route groups recorded in this window.</div>
                )}
              </div>
            </div>

            <div className="rounded-xl border border-border/60 bg-background/45 p-3">
              <div className="mb-3 flex items-center justify-between gap-2">
                <div className="text-sm font-medium text-foreground">Recent time buckets</div>
                <div className="text-xs text-muted-foreground">{bucketSizeMinutes != null ? `${bucketSizeMinutes}m rollup` : "—"}</div>
              </div>
              <div className="space-y-2">
                {buckets.length > 0 ? buckets.slice(-8).map((bucket) => (
                  <div key={bucket.bucketStart} className="space-y-1">
                    <div className="flex items-center justify-between gap-2 text-[11px]">
                      <span className="font-mono text-muted-foreground">{formatBucketLabel(bucket.bucketStart)}</span>
                      <span className="font-mono text-foreground">{formatCompactCount(bucket.totalRequests)}</span>
                    </div>
                    <div className="h-2 overflow-hidden rounded-full bg-muted/70">
                      <div className="flex h-full">
                        <div
                          className="bg-sky-500/70"
                          style={{ width: `${bucket.webSharePct}%` }}
                        />
                        <div
                          className="bg-amber-500/70"
                          style={{ width: `${bucket.externalSharePct}%` }}
                        />
                      </div>
                    </div>
                  </div>
                )) : (
                  <div className="text-sm text-muted-foreground">No time buckets recorded in this window.</div>
                )}
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
