"use client";

import { useMemo, useState, type ReactNode } from "react";
import { getBlacklistGapStatus } from "@shared/lib/status-thresholds";
import { formatElapsedSeconds } from "@shared/lib/format";
import { FeaturePageShell } from "@/components/feature-page-shell";
import { CacheFreshnessTable } from "@/components/status/cache-freshness-table";
import { CircuitBreakerTable } from "@/components/status/circuit-breaker-table";
import { EndpointHealthGrid } from "@/components/status/endpoint-health-grid";
import { PublicStatusHero } from "@/components/status/public-status-hero";
import { PublicTransitionTimeline } from "@/components/status/public-transition-timeline";
import { UptimeBar } from "@/components/status/uptime-bar";
import { NoticeRail, StatusSection, SummaryBadge } from "@/components/status/page-primitives";
import { useHealth } from "@/hooks/api-hooks";
import { usePublicEndpointProbes } from "@/hooks/use-endpoint-probes";
import { usePublicStatusHistory, type PublicHistoryWindow } from "@/hooks/use-public-status-history";
import { buildBrowserProbeSummary, formatTimestampSeconds, getStatusTone } from "@/lib/status-dashboard-model";
import {
  getImpactedPublicSurfaces,
  getPublicMintBurnStatus,
  getPublicWorstCacheSummary,
} from "@/lib/status/public-status";

function PublicSignalCard({
  kicker,
  title,
  badges,
  description,
  children,
}: {
  kicker: string;
  title: string;
  badges?: ReactNode;
  description: string;
  children: ReactNode;
}) {
  return (
    <article className="rounded-[1.35rem] border border-black/7 bg-[linear-gradient(180deg,oklch(0.995_0.004_248_/_0.96),oklch(0.972_0.01_248_/_0.99))] p-5 shadow-[inset_0_1px_0_oklch(1_0_0_/0.72),0_16px_36px_oklch(0_0_0_/0.08)] dark:border-white/10 dark:bg-[linear-gradient(180deg,oklch(0.16_0.014_248_/_0.78),oklch(0.12_0.01_248_/_0.9))] dark:shadow-[0_16px_36px_oklch(0_0_0_/0.12)]">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="space-y-2">
          <p className="pharos-kicker">{kicker}</p>
          <div className="space-y-2">
            <h3 className="text-xl font-semibold tracking-tight text-foreground">{title}</h3>
            <p className="max-w-2xl text-sm leading-relaxed text-muted-foreground">{description}</p>
          </div>
        </div>
        {badges ? <div className="flex flex-wrap gap-2">{badges}</div> : null}
      </div>
      <div className="mt-5 space-y-4">{children}</div>
    </article>
  );
}

export default function StatusClient() {
  const [historyWindow, setHistoryWindow] = useState<PublicHistoryWindow>("7d");
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
  const { data: historyData, isLoading: historyLoading } = usePublicStatusHistory(historyWindow);

  const handleRefresh = () => {
    void refetchHealth();
    void refetchProbes();
  };

  const syncFloorCandidates = [healthUpdatedAt ?? 0, probesUpdatedAt ?? 0].filter((value) => value > 0);
  const lastUpdated = syncFloorCandidates.length > 0 ? Math.min(...syncFloorCandidates) : 0;
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
          "Live public telemetry for route freshness, browser reachability, and ingestion drift.",
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
          "Live public telemetry for route freshness, browser reachability, and ingestion drift.",
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
          "Live public telemetry for route freshness, browser reachability, and ingestion drift.",
        ]}
      >
        <div className="py-20 text-center text-muted-foreground">Public health data is unavailable.</div>
      </FeaturePageShell>
    );
  }

  const statusTone = getStatusTone(healthData.status);
  const worstCache = getPublicWorstCacheSummary(healthData.caches);
  const mintBurnStatus = getPublicMintBurnStatus(healthData.mintBurn.sync);
  const probeSummary = buildBrowserProbeSummary(probes, probesUpdatedAt ?? 0);
  const openCircuits = Object.values(healthData.circuits).filter((circuit) => circuit.state === "open").length;
  const halfOpenCircuits = Object.values(healthData.circuits).filter((circuit) => circuit.state === "half-open").length;
  const lastSuccessfulMintBurnSyncAge =
    healthData.mintBurn.sync.lastSuccessfulSyncAt != null
      ? formatElapsedSeconds(Math.max(0, healthData.timestamp - healthData.mintBurn.sync.lastSuccessfulSyncAt))
      : "—";
  const impactedPublicSurfaces = getImpactedPublicSurfaces(healthData);
  const blacklistStatus = getBlacklistGapStatus({
    missingRatio: healthData.blacklist.missingRatio,
    recentMissingAmounts: healthData.blacklist.recentMissingAmounts,
  });
  const blacklistWindowHours = Math.max(1, Math.round(healthData.blacklist.recentWindowSec / 3600));
  const telegramSummary = healthData.telegramSummary ?? null;

  return (
    <FeaturePageShell
      breadcrumbName="System Status"
      path="/status/"
      title="System Status"
      leadParagraphs={[
        "Live public telemetry for route freshness, browser reachability, and ingestion drift.",
      ]}
    >
      <div className="space-y-6">
        <PublicStatusHero
          healthData={healthData}
          lastUpdated={lastUpdated}
          probeSummary={probeSummary}
          worstCacheRatio={worstCache.ratio}
          worstCacheStatus={worstCache.status}
          impactedCacheLanes={worstCache.impactedCount}
          openCircuits={openCircuits}
          halfOpenCircuits={halfOpenCircuits}
          lastSuccessfulMintBurnSyncAge={lastSuccessfulMintBurnSyncAge}
          onRefresh={handleRefresh}
        />

        <NoticeRail notices={notices} />

        <StatusSection
          id="overview"
          kicker="Current Picture"
          title="Public service summary"
          description="The public read path reduced to the signals most likely to affect downstream trust."
          accentClassName="border-l-frost-blue bg-[linear-gradient(180deg,oklch(0.988_0.008_248_/_0.98),oklch(0.956_0.012_248_/_0.99))] shadow-[0_18px_40px_oklch(0_0_0_/0.08)] dark:bg-[linear-gradient(180deg,rgba(11,18,32,0.88),rgba(4,10,20,0.94))] dark:shadow-[0_18px_40px_oklch(0_0_0_/0.14)]"
          summary={
            <>
              <SummaryBadge label="Status" value={statusTone.label} className={statusTone.badgeClassName} />
              <SummaryBadge
                label="Blacklist Gaps"
                value={String(healthData.blacklist.missingAmounts)}
                className={blacklistStatus !== "healthy" ? getStatusTone(blacklistStatus).badgeClassName : undefined}
              />
              <SummaryBadge label="Major Mint/Burn Stale" value={String(healthData.mintBurn.majorStaleCount)} />
              {telegramSummary && (
                <SummaryBadge
                  label="Alert Queue"
                  value={String(telegramSummary.pendingDeliveries)}
                  className={telegramSummary.pendingDeliveries > 0 ? getStatusTone("degraded").badgeClassName : undefined}
                />
              )}
            </>
          }
        >
          <div className="grid gap-5 xl:grid-cols-2">
            <PublicSignalCard
              kicker="Sync Watch"
              title="Mint/Burn Sync"
              description="Critical mint/burn writer freshness and latest run health determine whether the public flows surface is current."
              badges={
                <div className="flex flex-wrap gap-2">
                  <SummaryBadge
                    label="Writer"
                    value={mintBurnStatus}
                    className={getStatusTone(mintBurnStatus).badgeClassName}
                  />
                  <SummaryBadge label="Freshness" value={healthData.mintBurn.sync.freshnessStatus} />
                  <SummaryBadge label="Major Stale" value={String(healthData.mintBurn.majorStaleCount)} />
                </div>
              }
            >
              <p className="text-sm leading-relaxed text-muted-foreground">
                {healthData.mintBurn.sync.warning
                  ?? "Critical mint/burn lanes are within their expected freshness and run-health windows."}
              </p>
              <div className="grid gap-3 sm:grid-cols-2">
                <div className="rounded-[1rem] border border-border/60 bg-background/78 p-3 shadow-[inset_0_1px_0_oklch(1_0_0_/0.58)] dark:bg-background/35 dark:shadow-none">
                  <div className="text-xs uppercase tracking-[0.18em] text-muted-foreground">Last Successful Sync</div>
                  <div className="mt-2 font-mono text-sm text-foreground">
                    {formatTimestampSeconds(healthData.mintBurn.sync.lastSuccessfulSyncAt)}
                  </div>
                </div>
                <div className="rounded-[1rem] border border-border/60 bg-background/78 p-3 shadow-[inset_0_1px_0_oklch(1_0_0_/0.58)] dark:bg-background/35 dark:shadow-none">
                  <div className="text-xs uppercase tracking-[0.18em] text-muted-foreground">Latest Hourly Sample</div>
                  <div className="mt-2 font-mono text-sm text-foreground">
                    {formatTimestampSeconds(healthData.mintBurn.latestHourlyTs)}
                  </div>
                </div>
              </div>
              {healthData.mintBurn.staleMajorSymbols.length > 0 ? (
                <div className="rounded-[1rem] border border-amber-500/20 bg-amber-500/5 p-3 text-xs leading-relaxed text-amber-700 dark:text-amber-300">
                  Impacted majors: {healthData.mintBurn.staleMajorSymbols.join(", ")}
                </div>
              ) : null}
            </PublicSignalCard>

            <PublicSignalCard
              kicker="Data Integrity"
              title="Blacklist Ingestion"
              description="Blacklist amount gaps stay visible here, but only recent or high-ratio gaps should escalate the public health signal."
              badges={
                <div className="flex flex-wrap gap-2">
                  <SummaryBadge
                    label="Missing Amounts"
                    value={String(healthData.blacklist.missingAmounts)}
                    className={blacklistStatus !== "healthy" ? getStatusTone(blacklistStatus).badgeClassName : undefined}
                  />
                  <SummaryBadge label="Tracked Events" value={String(healthData.blacklist.totalEvents)} />
                  <SummaryBadge label="Recent Window" value={`${blacklistWindowHours}h`} />
                </div>
              }
            >
              <p className="text-sm leading-relaxed text-muted-foreground">
                Missing blacklist amounts surface here because they directly affect public data quality and downstream risk calculations.
              </p>
              <div className="rounded-[1rem] border border-border/60 bg-background/78 p-3 shadow-[inset_0_1px_0_oklch(1_0_0_/0.58)] dark:bg-background/35 dark:shadow-none">
                <div className="text-xs uppercase tracking-[0.18em] text-muted-foreground">Public Health Interpretation</div>
                <div className="mt-2 leading-relaxed text-foreground">
                  {healthData.blacklist.missingAmounts > 0
                    ? healthData.blacklist.recentMissingAmounts > 0
                      ? `${healthData.blacklist.recentMissingAmounts} recent blacklist event(s) in the last ${blacklistWindowHours}h are still missing amounts.`
                      : blacklistStatus === "healthy"
                        ? `${healthData.blacklist.missingAmounts} blacklist event(s) are still missing amounts, but they are historical and below the public warning threshold.`
                        : `${healthData.blacklist.missingAmounts} blacklist event(s) are still missing amounts, but no new gaps were recorded in the last ${blacklistWindowHours}h.`
                    : "No current blacklist amount gaps are affecting the public health signal."}
                </div>
                {healthData.blacklist.missingAmounts > 0 ? (
                  <div className="mt-2 text-xs text-muted-foreground">
                    Missing ratio {(healthData.blacklist.missingRatio * 100).toFixed(2)}% of {healthData.blacklist.totalEvents} tracked events.
                  </div>
                ) : null}
              </div>
            </PublicSignalCard>
          </div>

          {telegramSummary && (
            <PublicSignalCard
              kicker="Alert Delivery"
              title="Telegram Bot Health"
              description="Aggregate delivery stats for the Pharos Telegram alert bot. Detailed dispatch telemetry is on the operator admin page."
              badges={
                <div className="flex flex-wrap gap-2">
                  <SummaryBadge label="Subscribers" value={String(telegramSummary.totalChats)} />
                  <SummaryBadge
                    label="Pending"
                    value={String(telegramSummary.pendingDeliveries)}
                    className={telegramSummary.pendingDeliveries > 0 ? getStatusTone("degraded").badgeClassName : undefined}
                  />
                  {telegramSummary.lastDispatchStatus && (
                    <SummaryBadge
                      label="Last Dispatch"
                      value={telegramSummary.lastDispatchStatus}
                      className={telegramSummary.lastDispatchStatus !== "ok" ? getStatusTone("stale").badgeClassName : undefined}
                    />
                  )}
                </div>
              }
            >
              <div className="grid gap-3 sm:grid-cols-2">
                <div className="rounded-[1rem] border border-border/60 bg-background/78 p-3 shadow-[inset_0_1px_0_oklch(1_0_0_/0.58)] dark:bg-background/35 dark:shadow-none">
                  <div className="text-xs uppercase tracking-[0.18em] text-muted-foreground">Subscribers</div>
                  <div className="mt-2 font-mono text-sm text-foreground">{telegramSummary.totalChats} chats registered</div>
                </div>
                <div className="rounded-[1rem] border border-border/60 bg-background/78 p-3 shadow-[inset_0_1px_0_oklch(1_0_0_/0.58)] dark:bg-background/35 dark:shadow-none">
                  <div className="text-xs uppercase tracking-[0.18em] text-muted-foreground">Last Dispatch</div>
                  <div className="mt-2 font-mono text-sm text-foreground">
                    {telegramSummary.lastDispatchAt
                      ? formatTimestampSeconds(telegramSummary.lastDispatchAt)
                      : "No dispatch recorded"}
                  </div>
                </div>
              </div>
              {telegramSummary.pendingDeliveries > 0 && (
                <div className="rounded-[1rem] border border-amber-500/20 bg-amber-500/5 p-3 text-xs leading-relaxed text-amber-700 dark:text-amber-300">
                  {telegramSummary.pendingDeliveries} alert{telegramSummary.pendingDeliveries !== 1 ? "s" : ""} pending delivery
                </div>
              )}
            </PublicSignalCard>
          )}

          <PublicSignalCard
            kicker="Surface Impact"
            title="Which public surfaces are affected"
            description="This translates the raw health signals into the public routes and read paths most likely to be misleading right now."
            badges={
              <div className="flex flex-wrap gap-2">
                <SummaryBadge label="Impacted Surfaces" value={String(impactedPublicSurfaces.length)} />
              </div>
            }
          >
            {impactedPublicSurfaces.length > 0 ? (
              <div className="grid gap-3 lg:grid-cols-2">
                {impactedPublicSurfaces.map((surface) => (
                  <div key={surface.id} className="rounded-[1rem] border border-border/60 bg-background/78 p-3 shadow-[inset_0_1px_0_oklch(1_0_0_/0.58)] dark:bg-background/35 dark:shadow-none">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div className="text-sm font-medium text-foreground">{surface.title}</div>
                      <SummaryBadge
                        label="Impact"
                        value={surface.tone}
                        className={getStatusTone(surface.tone).badgeClassName}
                      />
                    </div>
                    <p className="mt-2 text-sm leading-relaxed text-muted-foreground">{surface.detail}</p>
                  </div>
                ))}
              </div>
            ) : (
              <div className="rounded-[1rem] border border-border/60 bg-background/78 p-3 text-sm leading-relaxed text-muted-foreground shadow-[inset_0_1px_0_oklch(1_0_0_/0.58)] dark:bg-background/35 dark:shadow-none">
                No current public surface impact flags are active beyond the hero summary.
              </div>
            )}
          </PublicSignalCard>
        </StatusSection>

        <StatusSection
          id="reliability"
          kicker="Reliability"
          title="Route probes, breakers, and cache pressure"
          description="Browser canary reachability, worker cache pressure, and breaker posture for the public edge."
          accentClassName="border-l-amber-500 bg-[linear-gradient(180deg,oklch(0.99_0.006_80_/_0.98),oklch(0.968_0.012_80_/_0.98)_46%,oklch(0.952_0.014_248_/_0.99))] shadow-[0_18px_40px_oklch(0_0_0_/0.08)] dark:bg-[linear-gradient(180deg,rgba(24,18,10,0.42),rgba(7,10,18,0.94))] dark:shadow-[0_18px_40px_oklch(0_0_0_/0.14)]"
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

        <StatusSection
          id="history"
          kicker="Availability"
          title="Uptime and incident history"
          description="Trailing system availability and recent status transitions over the public monitoring window."
          accentClassName="border-l-rose-500 bg-[linear-gradient(180deg,oklch(0.99_0.006_12_/_0.98),oklch(0.968_0.012_12_/_0.98)_46%,oklch(0.952_0.014_248_/_0.99))] shadow-[0_18px_40px_oklch(0_0_0_/0.08)] dark:bg-[linear-gradient(180deg,rgba(24,12,14,0.42),rgba(7,10,18,0.94))] dark:shadow-[0_18px_40px_oklch(0_0_0_/0.14)]"
          summary={
            <>
              <SummaryBadge label="Window" value={historyWindow} />
              <SummaryBadge
                label="Transitions"
                value={String(historyData?.transitions.length ?? 0)}
              />
            </>
          }
        >
          <UptimeBar
            transitions={historyData?.transitions ?? []}
            currentStatus={historyData?.currentStatus ?? healthData.status}
            lastChangedAt={historyData?.lastChangedAt ?? null}
          />
          <PublicTransitionTimeline
            transitions={historyData?.transitions ?? []}
            window={historyWindow}
            onWindowChange={setHistoryWindow}
            isLoading={historyLoading}
          />
        </StatusSection>
      </div>
    </FeaturePageShell>
  );
}
