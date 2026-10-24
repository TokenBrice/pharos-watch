import { REQUEST_SOURCE_FILL_CLASSES } from "@shared/lib/classification";
import type { ApiRequestAttributionResponse, AttributionMeasurement } from "@pharos/contracts/request-source";
import { StatTile } from "@/components/stat-tile";
import { AttributionBadge, AttributionMeasurementNote, AttributionPanel, formatAttributionValue } from "./attribution-panel";

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
          className={REQUEST_SOURCE_FILL_CLASSES.primary}
          style={{ width: `${siteSharePct}%` }}
        />
        <div
          className={REQUEST_SOURCE_FILL_CLASSES.secondary}
          style={{ width: `${externalSharePct}%` }}
        />
      </div>
    </div>
  );
}

function metricRow(label: string, value: number, measurement: AttributionMeasurement) {
  return (
    <div className="flex items-center justify-between gap-3 text-sm">
      <span className="text-muted-foreground">{label}</span>
      <span className="pharos-numeric text-foreground">{formatAttributionValue(value, measurement)}</span>
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
          <code className="rounded-sm bg-background/60 px-1 py-0.5 font-mono tabular-nums text-[0.92em] text-foreground">/_site-data/*</code>{" "}
          and{" "}
          <code className="rounded-sm bg-background/60 px-1 py-0.5 font-mono tabular-nums text-[0.92em] text-foreground">api.pharos.watch</code>.
          Site demand includes Pages deliveries plus website-owned public API keys; external excludes those keys.
        </>
      }
      badges={
        totals ? (
          <>
            <AttributionBadge tone="sky">Site {formatAttributionValue(totals.siteSharePct, totals.measurement.siteSharePct, true)}</AttributionBadge>
            <AttributionBadge tone="watch">External {formatAttributionValue(totals.externalSharePct, totals.measurement.externalSharePct, true)}</AttributionBadge>
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
          <AttributionMeasurementNote measurement={totals.measurement.totalRequests} />
          <div className="grid gap-3 sm:grid-cols-3">
            <StatTile variant="tile" label="Total demand" value={formatAttributionValue(totals.totalRequests, totals.measurement.totalRequests)} />
            <StatTile variant="tile" label="Site" value={formatAttributionValue(totals.siteRequests, totals.measurement.siteRequests)} />
            <StatTile variant="tile" label="External" value={formatAttributionValue(totals.externalRequests, totals.measurement.externalRequests)} />
          </div>

          <div className="grid gap-4 lg:grid-cols-2">
            <div className="pharos-inset p-3">
              <div className="mb-3 flex items-center justify-between gap-2">
                <div className="text-sm font-medium text-foreground">Site delivery</div>
                <div className="text-xs text-muted-foreground">
                  {formatAttributionValue(siteDelivery.totalSiteRequests, siteDelivery.measurement.totalSiteRequests)} site requests
                </div>
              </div>
              <div className="space-y-2">
                {metricRow("Pages cache hits (historical)", siteDelivery.pagesCacheHits, siteDelivery.measurement.pagesCacheHits)}
                {metricRow("Pages proxy fetches", siteDelivery.pagesUpstreamFetches, siteDelivery.measurement.pagesUpstreamFetches)}
                {metricRow("Captured Pages timeouts", siteDelivery.pagesUpstreamTimeouts, siteDelivery.measurement.pagesUpstreamTimeouts)}
                {metricRow("Captured Pages upstream errors", siteDelivery.pagesUpstreamErrors, siteDelivery.measurement.pagesUpstreamErrors)}
                {metricRow("Public API site requests", siteDelivery.publicApiSiteRequests, siteDelivery.measurement.publicApiSiteRequests)}
              </div>
            </div>

            <div className="pharos-inset p-3">
              <div className="mb-3 flex items-center justify-between gap-2">
                <div className="text-sm font-medium text-foreground">Worker lanes</div>
                <div className="text-xs text-muted-foreground">{lanes.some((lane) => lane.measurement.totalRequests.kind !== "observed") ? "Estimated worker load" : "Recorded worker load"}</div>
              </div>
              <div className="space-y-2">
                {lanes.length > 0 ? lanes.map((lane) => (
                  <div key={lane.lane} className="pharos-inset px-3 py-2">
                    <div className="flex items-center justify-between gap-2">
                      <div>
                        <div className="text-sm text-foreground">{formatLaneLabel(lane.lane)}</div>
                        <div className="text-2xs text-muted-foreground">
                          site {formatAttributionValue(lane.siteSharePct, lane.measurement.siteSharePct, true)} · external {formatAttributionValue(lane.externalSharePct, lane.measurement.externalSharePct, true)}
                        </div>
                      </div>
                      <div className="pharos-numeric text-sm text-foreground">{formatAttributionValue(lane.totalRequests, lane.measurement.totalRequests)}</div>
                    </div>
                    <ShareBar siteSharePct={lane.siteSharePct} externalSharePct={lane.externalSharePct} className="mt-2" />
                  </div>
                )) : (
                  <div className="text-sm text-muted-foreground">No sampled observations for worker lanes in this window.</div>
                )}
              </div>
            </div>
          </div>

          <div className="grid grid-cols-1 gap-4 xl:grid-cols-[minmax(0,1.15fr)_minmax(0,0.85fr)]">
            <div className="pharos-inset p-3">
              <div className="mb-3 flex items-center justify-between gap-2">
                <div className="text-sm font-medium text-foreground">Top route groups</div>
                <div className="text-xs text-muted-foreground">Top {routes.length} observed route groups; full-window totals above</div>
              </div>
              <div className="space-y-2">
                {routes.length > 0 ? routes.map((route) => (
                  <div key={route.routeKey} className="pharos-inset px-3 py-2">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div className="min-w-0">
                        <div className="truncate font-mono tabular-nums text-xs text-foreground">{route.routePath}</div>
                        <div className="text-2xs text-muted-foreground">{route.routeKey}</div>
                      </div>
                      <div className="text-right">
                        <div className="pharos-numeric text-sm text-foreground">{formatAttributionValue(route.totalRequests, route.measurement.totalRequests)}</div>
                        <div className="text-2xs text-muted-foreground">ext {formatAttributionValue(route.externalSharePct, route.measurement.externalSharePct, true)}</div>
                      </div>
                    </div>
                    <ShareBar siteSharePct={route.siteSharePct} externalSharePct={route.externalSharePct} className="mt-2" />
                  </div>
                )) : (
                  <div className="text-sm text-muted-foreground">No sampled observations for route groups in this window.</div>
                )}
              </div>
            </div>

            <div className="pharos-inset p-3">
              <div className="mb-3 flex items-center justify-between gap-2">
                <div className="text-sm font-medium text-foreground">Latest 8 observed buckets</div>
                <div className="text-xs text-muted-foreground">{bucketSizeMinutes != null ? `${bucketSizeMinutes}m rollup` : "—"}</div>
              </div>
              <div className="space-y-2">
                {buckets.length > 0 ? buckets.slice(-8).map((bucket) => (
                  <div key={bucket.bucketStart} className="space-y-1">
                    <div className="flex items-center justify-between gap-2 text-2xs">
                      <span className="pharos-numeric text-muted-foreground">{formatBucketLabel(bucket.bucketStart)}</span>
                      <span className="pharos-numeric text-foreground">{formatAttributionValue(bucket.totalRequests, bucket.measurement.totalRequests)}</span>
                    </div>
                    <ShareBar
                      siteSharePct={bucket.siteSharePct}
                      externalSharePct={bucket.externalSharePct}
                    />
                  </div>
                )) : (
                  <div className="text-sm text-muted-foreground">No sampled observations for time buckets in this window.</div>
                )}
              </div>
            </div>
          </div>
        </div>
      ) : null}
    </AttributionPanel>
  );
}
