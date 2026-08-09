import { formatCompactCount, formatPercent } from "@shared/lib/format";
import type { ApiRequestAttributionResponse } from "@shared/types";
import { StatTile } from "@/components/stat-tile";
import { AttributionBadge, AttributionPanel } from "./attribution-panel";

function formatBucketLabel(bucketStart: number): string {
  return new Date(bucketStart * 1000).toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
  });
}

function formatLaneLabel(lane: "public-api" | "site-api"): string {
  return lane === "public-api" ? "Public API" : "Site API";
}

function ShareBar({
  siteSharePct,
  externalSharePct,
  className,
}: {
  siteSharePct: number;
  externalSharePct: number;
  className?: string;
}) {
  return (
    <div className={["h-2 overflow-hidden rounded-full bg-muted/70", className].filter(Boolean).join(" ")}>
      <div className="flex h-full">
        <div
          className="bg-sky-500/70"
          style={{ width: `${siteSharePct}%` }}
        />
        <div
          className="bg-amber-500/70"
          style={{ width: `${externalSharePct}%` }}
        />
      </div>
    </div>
  );
}

function metricRow(label: string, value: number) {
  return (
    <div className="flex items-center justify-between gap-3 text-sm">
      <span className="text-muted-foreground">{label}</span>
      <span className="pharos-numeric text-foreground">{formatCompactCount(value)}</span>
    </div>
  );
}

export function RequestSourceAttributionCard({
  stats,
  error,
  isLoading,
}: {
  stats: ApiRequestAttributionResponse | null | undefined;
  error?: string | null;
  isLoading?: boolean;
}) {
  const totals = stats?.totals ?? null;
  const siteDelivery = stats?.siteDelivery ?? null;
  const lanes = stats?.lanes ?? [];
  const routes = stats?.routes ?? [];
  const buckets = stats?.buckets ?? [];
  const bucketSizeMinutes = stats ? stats.window.bucketSizeSec / 60 : null;

  return (
    <AttributionPanel
      title="Site vs external demand"
      windowHours={stats ? Math.round(stats.window.durationSec / 3600) : null}
      description={
        <>
          Total request demand across same-origin{" "}
          <code className="rounded bg-background/60 px-1 py-0.5 font-mono tabular-nums text-[0.92em] text-foreground">/_site-data/*</code>{" "}
          and{" "}
          <code className="rounded bg-background/60 px-1 py-0.5 font-mono tabular-nums text-[0.92em] text-foreground">api.pharos.watch</code>.
          Site demand includes Pages cache hits plus website-owned public API keys; external excludes those keys.
        </>
      }
      badges={
        totals ? (
          <>
            <AttributionBadge tone="sky">Site {formatPercent(totals.siteSharePct, 1)}</AttributionBadge>
            <AttributionBadge tone="watch">External {formatPercent(totals.externalSharePct, 1)}</AttributionBadge>
          </>
        ) : null
      }
      error={error}
      isLoading={isLoading}
      hasData={Boolean(totals && siteDelivery)}
      loadingLabel="Loading request attribution…"
      emptyLabel="No attribution data yet."
    >
      {totals && siteDelivery ? (
        <div className="space-y-4">
          <div className="grid gap-3 sm:grid-cols-3">
            <StatTile variant="tile" label="Total demand" value={formatCompactCount(totals.totalRequests)} />
            <StatTile variant="tile" label="Site" value={formatCompactCount(totals.siteRequests)} />
            <StatTile variant="tile" label="External" value={formatCompactCount(totals.externalRequests)} />
          </div>

          <div className="grid gap-4 lg:grid-cols-2">
            <div className="rounded-xl border border-border/60 bg-background/45 p-3">
              <div className="mb-3 flex items-center justify-between gap-2">
                <div className="text-sm font-medium text-foreground">Site delivery</div>
                <div className="text-xs text-muted-foreground">
                  {formatCompactCount(siteDelivery.totalSiteRequests)} site requests
                </div>
              </div>
              <div className="space-y-2">
                {metricRow("Pages cache hits", siteDelivery.pagesCacheHits)}
                {metricRow("Pages proxy fetches", siteDelivery.pagesUpstreamFetches)}
                {metricRow("Pages timeouts", siteDelivery.pagesUpstreamTimeouts)}
                {metricRow("Pages upstream errors", siteDelivery.pagesUpstreamErrors)}
                {metricRow("Public API site requests", siteDelivery.publicApiSiteRequests)}
              </div>
            </div>

            <div className="rounded-xl border border-border/60 bg-background/45 p-3">
              <div className="mb-3 flex items-center justify-between gap-2">
                <div className="text-sm font-medium text-foreground">Worker lanes</div>
                <div className="text-xs text-muted-foreground">Actual worker load</div>
              </div>
              <div className="space-y-2">
                {lanes.length > 0 ? lanes.map((lane) => (
                  <div key={lane.lane} className="rounded-lg border border-border/50 bg-background/40 px-3 py-2">
                    <div className="flex items-center justify-between gap-2">
                      <div>
                        <div className="text-sm text-foreground">{formatLaneLabel(lane.lane)}</div>
                        <div className="text-[11px] text-muted-foreground">
                          site {formatPercent(lane.siteSharePct, 1)} · external {formatPercent(lane.externalSharePct, 1)}
                        </div>
                      </div>
                      <div className="pharos-numeric text-sm text-foreground">{formatCompactCount(lane.totalRequests)}</div>
                    </div>
                    <ShareBar siteSharePct={lane.siteSharePct} externalSharePct={lane.externalSharePct} className="mt-2" />
                  </div>
                )) : (
                  <div className="text-sm text-muted-foreground">No worker-lane data recorded in this window.</div>
                )}
              </div>
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
                        <div className="truncate font-mono tabular-nums text-xs text-foreground">{route.routePath}</div>
                        <div className="text-[11px] text-muted-foreground">{route.routeKey}</div>
                      </div>
                      <div className="text-right">
                        <div className="pharos-numeric text-sm text-foreground">{formatCompactCount(route.totalRequests)}</div>
                        <div className="text-[11px] text-muted-foreground">ext {formatPercent(route.externalSharePct, 1)}</div>
                      </div>
                    </div>
                    <ShareBar siteSharePct={route.siteSharePct} externalSharePct={route.externalSharePct} className="mt-2" />
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
                      <span className="pharos-numeric text-muted-foreground">{formatBucketLabel(bucket.bucketStart)}</span>
                      <span className="pharos-numeric text-foreground">{formatCompactCount(bucket.totalRequests)}</span>
                    </div>
                    <ShareBar
                      siteSharePct={bucket.siteSharePct}
                      externalSharePct={bucket.externalSharePct}
                    />
                  </div>
                )) : (
                  <div className="text-sm text-muted-foreground">No time buckets recorded in this window.</div>
                )}
              </div>
            </div>
          </div>
        </div>
      ) : null}
    </AttributionPanel>
  );
}
