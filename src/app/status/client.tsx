"use client";

import { useMemo } from "react";
import { STATUS_CACHE_RATIO_THRESHOLDS } from "@shared/lib/status-thresholds";
import { formatElapsedSeconds } from "@shared/lib/format";
import { FeaturePageShell } from "@/components/feature-page-shell";
import { CacheFreshnessTable } from "@/components/status/cache-freshness-table";
import { CircuitBreakerTable } from "@/components/status/circuit-breaker-table";
import { EndpointHealthGrid } from "@/components/status/endpoint-health-grid";
import { NoticeRail, StatusSection, SummaryBadge } from "@/components/status/page-primitives";
import { RefreshCountdown } from "@/components/status/refresh-countdown";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { useHealth } from "@/hooks/api-hooks";
import { usePublicEndpointProbes } from "@/hooks/use-endpoint-probes";
import { buildBrowserProbeSummary, formatTimestampMs, formatTimestampSeconds, getStatusTone } from "@/lib/status-dashboard-model";
import { cn } from "@/lib/utils";

function getWorstCacheRatio(caches: Record<string, { ageSeconds: number | null; maxAge: number }>): number | null {
  let worst: number | null = null;
  for (const cache of Object.values(caches)) {
    if (cache.ageSeconds == null || !Number.isFinite(cache.maxAge) || cache.maxAge <= 0) continue;
    const ratio = cache.ageSeconds / cache.maxAge;
    worst = worst == null ? ratio : Math.max(worst, ratio);
  }
  return worst;
}

function getWorstCacheStatus(ratio: number | null): "healthy" | "degraded" | "stale" {
  if (ratio == null) return "healthy";
  if (ratio > STATUS_CACHE_RATIO_THRESHOLDS.stale) return "stale";
  if (ratio > STATUS_CACHE_RATIO_THRESHOLDS.degraded) return "degraded";
  return "healthy";
}

function getMintBurnStatus(
  freshnessStatus: "fresh" | "degraded" | "stale",
): "healthy" | "degraded" | "stale" {
  if (freshnessStatus === "stale") return "stale";
  if (freshnessStatus === "degraded") return "degraded";
  return "healthy";
}

function MetricCard({
  label,
  value,
  tone,
  detail,
}: {
  label: string;
  value: string;
  tone?: "healthy" | "degraded" | "stale";
  detail: string;
}) {
  const badgeClassName = tone ? getStatusTone(tone).badgeClassName : "border-border/60 bg-background/45";

  return (
    <div className="rounded-[1.15rem] border border-border/60 bg-background/35 p-4">
      <div className="flex items-center justify-between gap-3">
        <div className="text-xs uppercase tracking-[0.18em] text-muted-foreground">{label}</div>
        <span className={cn("rounded-full border px-2.5 py-1 text-[11px] font-medium", badgeClassName)}>
          {tone ? getStatusTone(tone).label : "Info"}
        </span>
      </div>
      <div className="mt-3 font-mono text-3xl font-semibold tracking-tight text-foreground">{value}</div>
      <div className="mt-2 text-sm leading-relaxed text-muted-foreground">{detail}</div>
    </div>
  );
}

export default function StatusClient() {
  const {
    data: healthData,
    error: healthError,
    isLoading: healthLoading,
    refetch: refetchHealth,
    dataUpdatedAt: healthUpdatedAt,
  } = useHealth();
  const {
    data: probes,
    error: probesError,
    isLoading: probesLoading,
    refetch: refetchProbes,
    dataUpdatedAt: probesUpdatedAt,
  } = usePublicEndpointProbes();

  const handleRefresh = () => {
    void refetchHealth();
    void refetchProbes();
  };

  const lastUpdated = Math.max(healthUpdatedAt ?? 0, probesUpdatedAt ?? 0);
  const notices = useMemo(() => {
    if (!healthData) return [];

    const items = healthData.warnings.map((warning, index) => ({
      id: `health-warning-${index}`,
      title: "Health warning",
      detail: warning,
      tone: healthData.status === "stale" ? "critical" : "warning",
    })) as Array<{
      id: string;
      title: string;
      detail: string;
      tone: "neutral" | "warning" | "critical";
    }>;

    if (healthError) {
      items.unshift({
        id: "health-fetch-error",
        title: "Health response is stale",
        detail: healthError.message,
        tone: "warning",
      });
    }

    if (probesError) {
      items.push({
        id: "public-probe-error",
        title: "Public endpoint probes unavailable",
        detail: probesError.message,
        tone: "warning",
      });
    }

    return items;
  }, [healthData, healthError, probesError]);

  if (healthLoading && !healthData) {
    return (
      <FeaturePageShell
        breadcrumbName="System Status"
        path="/status/"
        title="System Status"
        leadParagraphs={[
          "Public health board for cache freshness, endpoint reachability, and ingestion pressure.",
          "Operator-only recovery tools now live on the Access-protected ops host under `/admin/`.",
        ]}
      >
        <div className="py-20 text-center text-muted-foreground">Loading system status...</div>
      </FeaturePageShell>
    );
  }

  if (healthError && !healthData) {
    return (
      <FeaturePageShell
        breadcrumbName="System Status"
        path="/status/"
        title="System Status"
        leadParagraphs={[
          "Public health board for cache freshness, endpoint reachability, and ingestion pressure.",
          "Operator-only recovery tools now live on the Access-protected ops host under `/admin/`.",
        ]}
      >
        <div className="rounded-[1.6rem] border border-red-500/30 bg-red-500/10 p-6 text-red-700 shadow-[0_18px_48px_oklch(0_0_0_/0.16)] dark:text-red-300">
          Failed to load public status data: {healthError.message}
        </div>
      </FeaturePageShell>
    );
  }

  if (!healthData) {
    return (
      <FeaturePageShell
        breadcrumbName="System Status"
        path="/status/"
        title="System Status"
        leadParagraphs={[
          "Public health board for cache freshness, endpoint reachability, and ingestion pressure.",
          "Operator-only recovery tools now live on the Access-protected ops host under `/admin/`.",
        ]}
      >
        <div className="py-20 text-center text-muted-foreground">Public health data is unavailable.</div>
      </FeaturePageShell>
    );
  }

  const statusTone = getStatusTone(healthData.status);
  const worstCacheRatio = getWorstCacheRatio(healthData.caches);
  const worstCacheStatus = getWorstCacheStatus(worstCacheRatio);
  const worstCacheTone = getStatusTone(worstCacheStatus);
  const probeSummary = buildBrowserProbeSummary(probes, probesUpdatedAt ?? 0);
  const unhealthyCaches = Object.values(healthData.caches).filter((cache) => !cache.healthy).length;
  const openCircuits = Object.values(healthData.circuits).filter((circuit) => circuit.state === "open").length;
  const halfOpenCircuits = Object.values(healthData.circuits).filter((circuit) => circuit.state === "half-open").length;
  const lastSuccessfulMintBurnSyncAge =
    healthData.mintBurn.sync.lastSuccessfulSyncAt != null
      ? formatElapsedSeconds(Math.max(0, healthData.timestamp - healthData.mintBurn.sync.lastSuccessfulSyncAt))
      : "—";

  return (
    <FeaturePageShell
      breadcrumbName="System Status"
      path="/status/"
      title="System Status"
      leadParagraphs={[
        "Public health board for cache freshness, endpoint reachability, and ingestion pressure.",
        "Operator-only recovery tools now live on the Access-protected ops host under `/admin/`.",
      ]}
      headerActions={
        <div className="flex flex-wrap items-center gap-2">
          <SummaryBadge label="Health Sample" value={formatTimestampSeconds(healthData.timestamp)} />
          <SummaryBadge label="Client Sync" value={formatTimestampMs(lastUpdated)} />
          <RefreshCountdown key={lastUpdated} onRefresh={handleRefresh} />
        </div>
      }
    >
      <div className="space-y-6">
        <section
          className={cn(
            "relative overflow-hidden rounded-[2rem] border px-4 py-5 shadow-[0_34px_90px_oklch(0_0_0_/0.24)] sm:px-5 lg:px-6",
            statusTone.badgeClassName,
          )}
        >
          <div className="pointer-events-none absolute inset-0 opacity-[0.08] [background-image:linear-gradient(to_right,rgba(148,163,184,0.28)_1px,transparent_1px),linear-gradient(to_bottom,rgba(148,163,184,0.18)_1px,transparent_1px)] [background-size:4rem_4rem]" />
          <div className="relative space-y-5">
            <div className="flex flex-wrap items-start justify-between gap-3 border-b border-white/10 pb-3">
              <div className="space-y-1">
                <p className="pharos-kicker">Public Monitor</p>
                <h2 className="text-[clamp(2.65rem,6vw,4.85rem)] font-semibold leading-[0.94] tracking-[-0.08em] text-foreground">
                  {statusTone.label}
                </h2>
                <p className="max-w-3xl text-sm leading-relaxed text-muted-foreground">
                  Read-only status for the public API surface. Use this page to check freshness pressure, route reachability,
                  and ingestion health without the operator controls.
                </p>
              </div>
              <div className="flex flex-wrap gap-2">
                <SummaryBadge label="Warnings" value={String(healthData.warnings.length)} />
                <SummaryBadge
                  label="Probes"
                  value={probeSummary ? `${probeSummary.passCount}/${probeSummary.sampleCount}` : "—"}
                  className={probeSummary && probeSummary.failCount > 0 ? getStatusTone("degraded").badgeClassName : undefined}
                />
                <SummaryBadge
                  label="Worst Cache"
                  value={worstCacheRatio != null ? `${worstCacheRatio.toFixed(2)}x` : "—"}
                  className={worstCacheTone.badgeClassName}
                />
              </div>
            </div>

            <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
              <MetricCard
                label="Public API"
                value={statusTone.label}
                tone={healthData.status}
                detail={`${healthData.warnings.length} active warning(s) across public health checks.`}
              />
              <MetricCard
                label="Worst Cache"
                value={worstCacheRatio != null ? `${worstCacheRatio.toFixed(2)}x` : "—"}
                tone={worstCacheStatus}
                detail={`${unhealthyCaches} cache lane(s) are outside their freshness target.`}
              />
              <MetricCard
                label="Mint/Burn Sync"
                value={healthData.mintBurn.sync.freshnessStatus}
                tone={getMintBurnStatus(healthData.mintBurn.sync.freshnessStatus)}
                detail={
                  healthData.mintBurn.sync.lastSuccessfulSyncAt != null
                    ? `Last successful sync ${lastSuccessfulMintBurnSyncAge} ago.`
                    : "No successful sync recorded yet."
                }
              />
              <MetricCard
                label="Circuit Breakers"
                value={String(openCircuits)}
                tone={openCircuits > 0 ? "stale" : halfOpenCircuits > 0 ? "degraded" : "healthy"}
                detail={
                  openCircuits > 0
                    ? `${openCircuits} open and ${halfOpenCircuits} half-open breaker(s).`
                    : halfOpenCircuits > 0
                      ? `${halfOpenCircuits} breaker(s) are probing recovery.`
                      : "All registered source breakers are closed."
                }
              />
            </div>
          </div>
        </section>

        <NoticeRail notices={notices} />

        <StatusSection
          id="overview"
          kicker="Current Picture"
          title="Public service summary"
          description="High-signal public telemetry at a glance."
          accentClassName="border-l-frost-blue"
          summary={
            <>
              <SummaryBadge label="Status" value={statusTone.label} className={statusTone.badgeClassName} />
              <SummaryBadge label="Blacklist Gaps" value={String(healthData.blacklist.missingAmounts)} />
              <SummaryBadge label="Major Mint/Burn Stale" value={String(healthData.mintBurn.majorStaleCount)} />
            </>
          }
        >
          <div className="grid gap-5 xl:grid-cols-2">
            <Card>
              <CardHeader>
                <CardTitle className="text-base">Mint/Burn Sync</CardTitle>
              </CardHeader>
              <CardContent className="space-y-3 text-sm">
                <div className="flex flex-wrap gap-2">
                  <SummaryBadge
                    label="Freshness"
                    value={healthData.mintBurn.sync.freshnessStatus}
                    className={getStatusTone(getMintBurnStatus(healthData.mintBurn.sync.freshnessStatus)).badgeClassName}
                  />
                  <SummaryBadge label="Major Stale" value={String(healthData.mintBurn.majorStaleCount)} />
                </div>
                <p className="leading-relaxed text-muted-foreground">
                  {healthData.mintBurn.sync.warning ?? "Critical mint/burn lanes are within their expected freshness window."}
                </p>
                <div className="grid gap-3 sm:grid-cols-2">
                  <div className="rounded-lg border border-border/60 p-3">
                    <div className="text-xs text-muted-foreground">Last Successful Sync</div>
                    <div className="mt-1 font-mono text-sm text-foreground">
                      {formatTimestampSeconds(healthData.mintBurn.sync.lastSuccessfulSyncAt)}
                    </div>
                  </div>
                  <div className="rounded-lg border border-border/60 p-3">
                    <div className="text-xs text-muted-foreground">Latest Hourly Sample</div>
                    <div className="mt-1 font-mono text-sm text-foreground">
                      {formatTimestampSeconds(healthData.mintBurn.latestHourlyTs)}
                    </div>
                  </div>
                </div>
                {healthData.mintBurn.staleMajorSymbols.length > 0 ? (
                  <div className="rounded-lg border border-amber-500/20 bg-amber-500/5 p-3 text-xs text-amber-700 dark:text-amber-300">
                    Impacted majors: {healthData.mintBurn.staleMajorSymbols.join(", ")}
                  </div>
                ) : null}
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle className="text-base">Blacklist Ingestion</CardTitle>
              </CardHeader>
              <CardContent className="space-y-3 text-sm">
                <div className="flex flex-wrap gap-2">
                  <SummaryBadge
                    label="Missing Amounts"
                    value={String(healthData.blacklist.missingAmounts)}
                    className={healthData.blacklist.missingAmounts > 0 ? getStatusTone("degraded").badgeClassName : undefined}
                  />
                  <SummaryBadge label="Tracked Events" value={String(healthData.blacklist.totalEvents)} />
                </div>
                <p className="leading-relaxed text-muted-foreground">
                  Missing blacklist amounts surface here because they directly affect public data quality and downstream risk calculations.
                </p>
                <div className="rounded-lg border border-border/60 p-3">
                  <div className="text-xs text-muted-foreground">Public Health Interpretation</div>
                  <div className="mt-1 leading-relaxed text-foreground">
                    {healthData.blacklist.missingAmounts > 0
                      ? "Recent blacklist events are missing amount data and need follow-up."
                      : "No current blacklist amount gaps are affecting the public health signal."}
                  </div>
                </div>
              </CardContent>
            </Card>
          </div>
        </StatusSection>

        <StatusSection
          id="reliability"
          kicker="Reliability"
          title="Route probes, breakers, and cache pressure"
          description="Public-canary reachability from this browser, plus worker cache and circuit state."
          accentClassName="border-l-amber-500"
          summary={
            <>
              <SummaryBadge
                label="Probe Pass"
                value={probeSummary ? `${probeSummary.passCount}/${probeSummary.sampleCount}` : "—"}
                className={probeSummary && probeSummary.failCount > 0 ? getStatusTone("degraded").badgeClassName : undefined}
              />
              <SummaryBadge label="Open Breakers" value={String(openCircuits)} />
              <SummaryBadge label="Half-open" value={String(halfOpenCircuits)} />
            </>
          }
        >
          <div className="grid gap-5 xl:grid-cols-[minmax(0,1.15fr)_minmax(0,0.85fr)]">
            <EndpointHealthGrid
              probes={probes}
              isLoading={probesLoading}
              groups={["public"]}
              description="Browser-origin probe loop from this public session. It covers only public canary routes."
              footnote="Admin and manual action paths are intentionally excluded from the public probe board."
            />
            <CircuitBreakerTable circuits={healthData.circuits} />
          </div>
          <CacheFreshnessTable caches={healthData.caches} />
        </StatusSection>
      </div>
    </FeaturePageShell>
  );
}
