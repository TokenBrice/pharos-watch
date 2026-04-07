"use client";

import { useMemo, useState, type ReactNode } from "react";
import type { PublicStatusHistoryWindow } from "@shared/types";
import { getBlacklistGapStatus } from "@shared/lib/status-thresholds";
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
import { usePublicStatusHistory } from "@/hooks/use-public-status-history";
import { buildBrowserProbeSummary, formatTimestampSeconds, getStatusTone } from "@/lib/status-dashboard-model";
import {
  getImpactedPublicSurfaces,
  getPublicMintBurnStatus,
  getPublicWorstCacheSummary,
} from "@/lib/status/public-status";

const RUNWAY_WINDOW: PublicStatusHistoryWindow = "30d";
const STATUS_SHELL_PROPS = {
  breadcrumbName: "System Status",
  path: "/status/",
  title: "System Status",
  leadParagraphs: [
    "Live public telemetry for route freshness, browser reachability, and ingestion drift.",
  ],
} as const;

function PublicSignalCard({
  title,
  badges,
  children,
}: {
  title: string;
  badges?: ReactNode;
  children: ReactNode;
}) {
  return (
    <article className="rounded-xl border border-border/50 bg-card/60 p-5 dark:bg-card/30">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h3 className="text-base font-semibold tracking-tight text-foreground">{title}</h3>
        {badges ? <div className="flex flex-wrap gap-2">{badges}</div> : null}
      </div>
      <div className="mt-4 space-y-4">{children}</div>
    </article>
  );
}

export default function StatusClient() {
  const [historyWindow, setHistoryWindow] = useState<PublicStatusHistoryWindow>("7d");
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
  const { data: runwayHistoryData } = usePublicStatusHistory(RUNWAY_WINDOW);
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

  let content: ReactNode;

  if (healthLoading && !healthData) {
    content = <div className="py-20 text-center text-muted-foreground">Loading system status...</div>;
  } else if (healthError && !healthData) {
    content = (
      <div className="rounded-[1.6rem] border border-red-500/30 bg-red-500/10 p-6 text-red-700 shadow-[0_18px_48px_oklch(0_0_0_/0.16)] dark:text-red-300">
        Failed to load public status data: {healthError.message}
      </div>
    );
  } else if (!healthData) {
    content = <div className="py-20 text-center text-muted-foreground">Public health data is unavailable.</div>;
  } else {
    const statusTone = getStatusTone(healthData.status);
    const worstCache = getPublicWorstCacheSummary(healthData.caches);
    const mintBurnStatus = getPublicMintBurnStatus(healthData.mintBurn.sync);
    const probeSummary = buildBrowserProbeSummary(probes, probesUpdatedAt ?? 0);
    const openCircuits = Object.values(healthData.circuits).filter((circuit) => circuit.state === "open").length;
    const halfOpenCircuits = Object.values(healthData.circuits).filter((circuit) => circuit.state === "half-open").length;
    const impactedPublicSurfaces = getImpactedPublicSurfaces(healthData);
    const blacklistStatus = getBlacklistGapStatus({
      missingRatio: healthData.blacklist.missingRatio,
      recentMissingAmounts: healthData.blacklist.recentMissingAmounts,
    });
    const blacklistWindowHours = Math.max(1, Math.round(healthData.blacklist.recentWindowSec / 3600));
    const telegramSummary = healthData.telegramSummary ?? null;

    content = (
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
          onRefresh={handleRefresh}
        />

        <UptimeBar
          transitions={runwayHistoryData?.transitions ?? []}
          currentStatus={runwayHistoryData?.currentStatus ?? healthData.status}
          lastChangedAt={runwayHistoryData?.lastChangedAt ?? null}
        />

        <NoticeRail notices={notices} />

        <StatusSection
          id="overview"
          title="Public service summary"
          accentClassName="border-l-frost-blue bg-[linear-gradient(180deg,oklch(0.988_0.008_248_/_0.98),oklch(0.956_0.012_248_/_0.99))] shadow-[0_18px_40px_oklch(0_0_0_/0.08)] dark:bg-[linear-gradient(180deg,rgba(11,18,32,0.88),rgba(4,10,20,0.94))] dark:shadow-[0_18px_40px_oklch(0_0_0_/0.14)]"
          summary={
            <>
              <SummaryBadge label="Status" value={statusTone.label} className={statusTone.badgeClassName} />
              {blacklistStatus !== "healthy" && (
                <SummaryBadge
                  label="Blacklist Gaps"
                  value={String(healthData.blacklist.missingAmounts)}
                  className={getStatusTone(blacklistStatus).badgeClassName}
                />
              )}
              {healthData.mintBurn.majorStaleCount > 0 && (
                <SummaryBadge label="Major Mint/Burn Stale" value={String(healthData.mintBurn.majorStaleCount)} className={getStatusTone("degraded").badgeClassName} />
              )}
              {telegramSummary && telegramSummary.pendingDeliveries > 0 && (
                <SummaryBadge
                  label="Alert Queue"
                  value={String(telegramSummary.pendingDeliveries)}
                  className={getStatusTone("degraded").badgeClassName}
                />
              )}
            </>
          }
        >
          <div className="grid gap-5 xl:grid-cols-2">
            <PublicSignalCard
              title="Mint/Burn Sync"
              badges={
                mintBurnStatus !== "healthy" || healthData.mintBurn.majorStaleCount > 0 ? (
                  <div className="flex flex-wrap gap-2">
                    {mintBurnStatus !== "healthy" && (
                      <SummaryBadge label="Writer" value={mintBurnStatus} className={getStatusTone(mintBurnStatus).badgeClassName} />
                    )}
                    {healthData.mintBurn.majorStaleCount > 0 && (
                      <SummaryBadge label="Major Stale" value={String(healthData.mintBurn.majorStaleCount)} className={getStatusTone("degraded").badgeClassName} />
                    )}
                  </div>
                ) : undefined
              }
            >
              <p className="text-sm leading-relaxed text-muted-foreground">
                {healthData.mintBurn.sync.warning
                  ?? "Critical mint/burn lanes are within their expected freshness and run-health windows."}
              </p>
              <div className="grid gap-3 sm:grid-cols-2">
                <div className="rounded-lg border border-border/40 bg-background/60 p-3 dark:bg-background/20">
                  <div className="text-xs uppercase tracking-[0.18em] text-muted-foreground">Last Successful Sync</div>
                  <div className="mt-2 font-mono text-sm text-foreground">
                    {formatTimestampSeconds(healthData.mintBurn.sync.lastSuccessfulSyncAt)}
                  </div>
                </div>
                <div className="rounded-lg border border-border/40 bg-background/60 p-3 dark:bg-background/20">
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
              title="Blacklist Ingestion"
              badges={
                blacklistStatus !== "healthy" ? (
                  <div className="flex flex-wrap gap-2">
                    <SummaryBadge
                      label="Missing Amounts"
                      value={String(healthData.blacklist.missingAmounts)}
                      className={getStatusTone(blacklistStatus).badgeClassName}
                    />
                  </div>
                ) : undefined
              }
            >
              <p className="text-sm leading-relaxed text-muted-foreground">
                Missing blacklist amounts surface here because they directly affect public data quality and downstream risk calculations.
              </p>
              <div className="rounded-lg border border-border/40 bg-background/60 p-3 dark:bg-background/20">
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
              title="Telegram Bot Health"
              badges={
                telegramSummary.pendingDeliveries > 0 || (telegramSummary.lastDispatchStatus && telegramSummary.lastDispatchStatus !== "ok") ? (
                  <div className="flex flex-wrap gap-2">
                    {telegramSummary.pendingDeliveries > 0 && (
                      <SummaryBadge label="Pending" value={String(telegramSummary.pendingDeliveries)} className={getStatusTone("degraded").badgeClassName} />
                    )}
                    {telegramSummary.lastDispatchStatus && telegramSummary.lastDispatchStatus !== "ok" && (
                      <SummaryBadge label="Last Dispatch" value={telegramSummary.lastDispatchStatus} className={getStatusTone("stale").badgeClassName} />
                    )}
                  </div>
                ) : undefined
              }
            >
              <div className="grid gap-3 sm:grid-cols-2">
                <div className="rounded-lg border border-border/40 bg-background/60 p-3 dark:bg-background/20">
                  <div className="text-xs uppercase tracking-[0.18em] text-muted-foreground">Subscribers</div>
                  <div className="mt-2 font-mono text-sm text-foreground">{telegramSummary.totalChats} chats registered</div>
                </div>
                <div className="rounded-lg border border-border/40 bg-background/60 p-3 dark:bg-background/20">
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
            title="Impacted public surfaces"
            badges={
              impactedPublicSurfaces.length > 0 ? (
                <SummaryBadge label="Impacted Surfaces" value={String(impactedPublicSurfaces.length)} className={getStatusTone("degraded").badgeClassName} />
              ) : undefined
            }
          >
            {impactedPublicSurfaces.length > 0 ? (
              <div className="grid gap-3 lg:grid-cols-2">
                {impactedPublicSurfaces.map((surface) => (
                  <div key={surface.id} className="rounded-lg border border-border/40 bg-background/60 p-3 dark:bg-background/20">
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
              <div className="rounded-lg border border-border/40 bg-background/60 p-3 text-sm leading-relaxed text-muted-foreground dark:bg-background/20">
                No current public surface impact flags are active beyond the hero summary.
              </div>
            )}
          </PublicSignalCard>
        </StatusSection>

        <StatusSection
          id="reliability"
          title="Route probes, breakers, and cache pressure"
          accentClassName="border-l-amber-500 bg-[linear-gradient(180deg,oklch(0.99_0.006_80_/_0.98),oklch(0.968_0.012_80_/_0.98)_46%,oklch(0.952_0.014_248_/_0.99))] shadow-[0_18px_40px_oklch(0_0_0_/0.08)] dark:bg-[linear-gradient(180deg,rgba(24,18,10,0.42),rgba(7,10,18,0.94))] dark:shadow-[0_18px_40px_oklch(0_0_0_/0.14)]"
          summary={
            <>
              {probeSummary && probeSummary.failCount > 0 && (
                <SummaryBadge
                  label="Probe Failures"
                  value={`${probeSummary.failCount}/${probeSummary.sampleCount}`}
                  className={getStatusTone("degraded").badgeClassName}
                />
              )}
              {openCircuits > 0 && (
                <SummaryBadge label="Open Breakers" value={String(openCircuits)} className={getStatusTone("stale").badgeClassName} />
              )}
              {halfOpenCircuits > 0 && (
                <SummaryBadge label="Half-open" value={String(halfOpenCircuits)} className={getStatusTone("degraded").badgeClassName} />
              )}
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
          title="Status transitions"
          accentClassName="border-l-slate-400 dark:border-l-slate-600 bg-[linear-gradient(180deg,oklch(0.99_0.002_248_/_0.98),oklch(0.968_0.006_248_/_0.98)_46%,oklch(0.952_0.008_248_/_0.99))] shadow-[0_18px_40px_oklch(0_0_0_/0.08)] dark:bg-[linear-gradient(180deg,rgba(14,16,22,0.42),rgba(7,10,18,0.94))] dark:shadow-[0_18px_40px_oklch(0_0_0_/0.14)]"
          summary={
            (historyData?.transitions.length ?? 0) > 0 ? (
              <SummaryBadge
                label="Transitions"
                value={String(historyData?.transitions.length ?? 0)}
              />
            ) : undefined
          }
        >
          <PublicTransitionTimeline
            transitions={historyData?.transitions ?? []}
            window={historyWindow}
            onWindowChange={setHistoryWindow}
            isLoading={historyLoading}
          />
        </StatusSection>
      </div>
    );
  }

  return (
    <FeaturePageShell {...STATUS_SHELL_PROPS}>
      {content}
    </FeaturePageShell>
  );
}
