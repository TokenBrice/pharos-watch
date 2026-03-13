"use client";

import { Fragment, type ReactNode, useEffect, useState } from "react";
import type { StatusResponse } from "@shared/types";
import { FeaturePageShell } from "@/components/feature-page-shell";
import { LongformScrollspyNav } from "@/components/longform-scrollspy-nav";
import { AdminActionsPanel } from "@/components/status/admin-actions-panel";
import { AdminKeyForm } from "@/components/status/admin-key-form";
import { CacheFreshnessTable } from "@/components/status/cache-freshness-table";
import { CircuitBreakerTable } from "@/components/status/circuit-breaker-table";
import { CronCard } from "@/components/status/cron-card";
import { DataQualityCards } from "@/components/status/data-quality-cards";
import { DatasetFreshnessTable } from "@/components/status/dataset-freshness-table";
import { DiscoveryCandidatesCard } from "@/components/status/discovery-candidates";
import { EndpointHealthGrid } from "@/components/status/endpoint-health-grid";
import { formatAge } from "@/components/status/format";
import { LiquidityHealthCard } from "@/components/status/liquidity-health";
import { MintBurnReconciliationCard } from "@/components/status/mint-burn-reconciliation";
import { PriceSourceHealthCard } from "@/components/status/price-source-health";
import { ReserveSyncHealthCard } from "@/components/status/reserve-sync-health";
import { RecommendedActionStrip } from "@/components/status/recommended-action-strip";
import { RefreshCountdown } from "@/components/status/refresh-countdown";
import { StatusBanner } from "@/components/status/status-banner";
import { StatusFacts } from "@/components/status/status-facts";
import { SystemDiagnostics } from "@/components/status/system-diagnostics";
import { TelegramBotStats } from "@/components/status/telegram-bot-stats";
import { TOP_FOLD_COPY } from "@/components/status/top-fold-copy";
import { TransitionTimeline } from "@/components/status/transition-timeline";
import {
  NoticeRail,
  PriorityLaneLink,
  StatusSection,
  SummaryBadge,
} from "@/components/status/page-primitives";
import { Button } from "@/components/ui/button";
import { useAdminSessionKey } from "@/hooks/use-admin-session-key";
import { useStatusDashboardModel } from "@/hooks/use-status-dashboard-model";
import {
  type DashboardSectionId,
  formatTimestampMs,
  formatTimestampSeconds,
  formatTransitionLabel,
  getStatusTone,
  getSeverityBadgeClass,
} from "@/lib/status-dashboard-model";
import { cn } from "@/lib/utils";

function getCronSeverity(cron: StatusResponse["crons"][string]): number {
  if (!cron.healthy || cron.lastRun?.status === "error" || cron.inFlight?.stale) return 2;
  if (cron.lastRun?.status === "degraded") return 1;
  return 0;
}


export default function StatusClient() {
  const { adminKey, handleKeySubmit, handleSignOut } = useAdminSessionKey();

  if (!adminKey) {
    return (
      <FeaturePageShell
        breadcrumbName="System Status"
        path="/status/"
        title="System Status"
        variant="auth-gated"
        leadParagraphs={[
          "Private operator panel for monitoring pipeline health, endpoint reliability, and incident state transitions.",
        ]}
      >
        <AdminKeyForm onSubmit={handleKeySubmit} />
      </FeaturePageShell>
    );
  }

  return (
    <FeaturePageShell
      breadcrumbName="System Status"
      path="/status/"
      title="System Status"
      variant="auth-gated"
      leadParagraphs={[
        "Private operator panel for monitoring pipeline health, endpoint reliability, and incident state transitions.",
      ]}
    >
      <StatusDashboard adminKey={adminKey} onSignOut={handleSignOut} />
    </FeaturePageShell>
  );
}

function StatusDashboard({ adminKey, onSignOut }: { adminKey: string; onSignOut: () => void }) {
  const {
    data,
    error,
    handleRefresh,
    healthData,
    historyLoading,
    historyWindow,
    isLoading,
    lastUpdated,
    model,
    probes,
    probesLoading,
    setHistoryWindow,
  } = useStatusDashboardModel(adminKey);
  const diagnosticsSignal =
    data?.overallStatus !== "healthy" || (model?.notices.length ?? 0) > 0 || (model?.healthDiffersFromStatus ?? false);
  const reliabilitySignal =
    (healthData?.status ?? data?.availabilityStatus ?? "healthy") !== "healthy" ||
    (model?.browserProbeSummary?.failCount ?? 0) > 0 ||
    (data?.summary.worstCacheRatio ?? 0) > 1;
  const telegramSignal = (data?.telegramBot?.pendingDeliveries ?? 0) > 0;
  const [isDiagnosticsOpen, setIsDiagnosticsOpen] = useState(false);
  const [isReliabilityOpen, setIsReliabilityOpen] = useState(false);
  const [isHealthyCronGroupsOpen, setIsHealthyCronGroupsOpen] = useState(false);
  const [isTelegramOpen, setIsTelegramOpen] = useState(false);

  useEffect(() => {
    if (!diagnosticsSignal) return;
    const timer = window.setTimeout(() => setIsDiagnosticsOpen(true), 0);
    return () => window.clearTimeout(timer);
  }, [diagnosticsSignal]);

  useEffect(() => {
    if (!reliabilitySignal) return;
    const timer = window.setTimeout(() => setIsReliabilityOpen(true), 0);
    return () => window.clearTimeout(timer);
  }, [reliabilitySignal]);

  useEffect(() => {
    if (!telegramSignal) return;
    const timer = window.setTimeout(() => setIsTelegramOpen(true), 0);
    return () => window.clearTimeout(timer);
  }, [telegramSignal]);

  if (isLoading) {
    return (
      <div className="py-20 text-center">
        <div className="text-muted-foreground">Loading status...</div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="py-20 text-center">
        <div className="text-red-600 dark:text-red-400">{error.message}</div>
        <Button variant="outline" className="mt-4" onClick={onSignOut}>
          Try a different key
        </Button>
      </div>
    );
  }

  if (!data) return <div className="p-8 text-center text-muted-foreground">Loading status data...</div>;
  if (!model) return <div className="p-8 text-center text-muted-foreground">Loading status data...</div>;

  const {
    allTransitions,
    browserProbeSummary,
    clientDataAgeSec,
    clientDataStale,
    cronGroups,
    latestTransition,
    notices,
    overallCauseCount,
    overallTone,
    recommendedActions,
    runningCrons,
    sections,
    statusHoldingAge,
    topCauses,
  } = model;
  const topFoldCopy = TOP_FOLD_COPY[data.overallStatus];
  const operationalSections = sections.filter((section) => section.id !== "overview" && section.id !== "history");
  const sortedCronGroups = cronGroups
    .map((group) => ({
      ...group,
      entries: [...group.entries].sort(([, a], [, b]) => getCronSeverity(b) - getCronSeverity(a)),
    }))
    .sort((a, b) => {
      const aSeverity = Math.max(...a.entries.map(([, cron]) => getCronSeverity(cron)), 0);
      const bSeverity = Math.max(...b.entries.map(([, cron]) => getCronSeverity(cron)), 0);
      return bSeverity - aSeverity;
    });
  const activeCronGroups = sortedCronGroups.filter((group) =>
    group.entries.some(([, cron]) => getCronSeverity(cron) > 0),
  );
  const healthyCronGroups = sortedCronGroups.filter((group) =>
    group.entries.every(([, cron]) => getCronSeverity(cron) === 0),
  );

  const renderCronGroup = (group: (typeof sortedCronGroups)[number]) => (
    <div key={group.key} className="rounded-[1.25rem] border border-border/60 bg-background/35 p-4">
      <div className="space-y-1">
        <div className="flex flex-wrap items-center gap-2">
          <h3 className="text-base font-semibold tracking-tight text-foreground">{group.title}</h3>
          <span className="rounded-full border border-border/60 bg-background/50 px-2 py-0.5 text-[11px] font-medium text-muted-foreground">
            {group.badge}
          </span>
        </div>
        <p className="text-sm leading-relaxed text-muted-foreground">{group.description}</p>
      </div>
      <div className="mt-4 grid gap-4 xl:grid-cols-2">
        {group.entries.map(([job, cron]) => (
          <CronCard key={job} job={job} cron={cron} nowSeconds={data.timestamp} />
        ))}
      </div>
    </div>
  );
  const sectionNodes: Record<DashboardSectionId, ReactNode> = {
    overview: (
      <StatusSection
        id="overview"
        kicker="Command Center"
        title="Current incident picture"
        description="Start here for the state holding, the active blockers, and the short path into deeper diagnostics."
        accentClassName="border-l-frost-blue"
        summary={
          <>
            <SummaryBadge label="Overall" value={overallTone.label} className={overallTone.badgeClassName} />
            <SummaryBadge label="Raw" value={data.rawOverallStatus} />
            <SummaryBadge label="Confidence" value={`${(data.confidence * 100).toFixed(1)}%`} />
          </>
        }
      >
        <StatusFacts
          adminKey={adminKey}
          dbHealthy={data.dbHealthy}
          summary={data.summary}
          causes={data.causes}
          onActionFinished={handleRefresh}
        />
        <details
          open={isDiagnosticsOpen}
          onToggle={(event) => setIsDiagnosticsOpen(event.currentTarget.open)}
          className="rounded-[1.25rem] border border-border/60 bg-background/30 p-4"
        >
          <summary className="cursor-pointer text-sm font-medium text-foreground">
            State machine, probe, and discrepancy diagnostics
          </summary>
          <div className="mt-4">
            <SystemDiagnostics
              state={data.state}
              staleness={data.staleness}
              probe={data.probe}
              discrepancy={data.discrepancy}
              browserProbe={browserProbeSummary}
              nowSeconds={data.timestamp}
            />
          </div>
        </details>
      </StatusSection>
    ),
    pipeline: (
      <StatusSection
        id="pipeline"
        kicker="Data Pipeline"
        title="Freshness and coverage"
        description="Use this lane when the issue is data quality rather than routing or cron execution."
        accentClassName="border-l-cyan-500"
        summary={
          <>
            <SummaryBadge
              label="Data Quality"
              value={getStatusTone(data.dataQualityStatus).label}
              className={getStatusTone(data.dataQualityStatus).badgeClassName}
            />
            <SummaryBadge label="Missing Prices" value={String(data.dataQuality.missingPrices)} />
            <SummaryBadge label="Stale On-chain" value={String(data.dataQuality.staleOnchainSupply)} />
          </>
        }
      >
        <div className="rounded-[1.25rem] border border-border/60 bg-background/35 p-4">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="space-y-1">
              <h3 className="text-base font-semibold tracking-tight text-foreground">Quality threshold board</h3>
              <p className="text-sm leading-relaxed text-muted-foreground">
                Critical data-quality blockers sort first so the noisiest metrics do not hide the real breakpoints.
              </p>
            </div>
            <span
              className={cn(
                "rounded-full border px-2.5 py-1 text-[11px] font-medium",
                getStatusTone(data.dataQualityStatus).badgeClassName,
              )}
            >
              {getStatusTone(data.dataQualityStatus).label}
            </span>
          </div>
          <div className="mt-4">
            <DataQualityCards dq={{ ...data.dataQuality, nowSeconds: data.timestamp }} />
          </div>
        </div>

        <div className="grid gap-5 xl:grid-cols-2">
          <PriceSourceHealthCard health={data.priceSourceHealth} nowSeconds={data.timestamp} />
          <LiquidityHealthCard health={data.liquidityHealth} />
        </div>

        <div className="grid gap-5 xl:grid-cols-2">
          <DatasetFreshnessTable datasetFreshness={data.datasetFreshness} nowSeconds={data.timestamp} />
          <ReserveSyncHealthCard health={data.reserveComposition} nowSeconds={data.timestamp} />
        </div>
        <MintBurnReconciliationCard summary={data.mintBurnReconciliation} />

        <DiscoveryCandidatesCard
          candidates={data.discoveryCandidates}
          adminKey={adminKey}
          nowSeconds={data.timestamp}
        />
      </StatusSection>
    ),
    reliability: (
      <StatusSection
        id="reliability"
        kicker="Service Health"
        title="Probes, breakers, and cache pressure"
        description="Use this lane when the issue looks like routing, availability, or public-service degradation."
        accentClassName="border-l-amber-500"
        summary={
          <>
            <SummaryBadge
              label="Public Health"
              value={healthData?.status ?? "—"}
              className={healthData ? getStatusTone(healthData.status).badgeClassName : undefined}
            />
            <SummaryBadge
              label="Browser Probes"
              value={browserProbeSummary ? `${browserProbeSummary.passCount}/${browserProbeSummary.sampleCount}` : "—"}
            />
            <SummaryBadge label="Worst Cache" value={`${data.summary.worstCacheRatio.toFixed(2)}x`} />
          </>
        }
      >
        <details
          open={isReliabilityOpen}
          onToggle={(event) => setIsReliabilityOpen(event.currentTarget.open)}
          className="rounded-[1.25rem] border border-border/60 bg-background/30 p-4"
        >
          <summary className="cursor-pointer text-sm font-medium text-foreground">
            Endpoint probes, circuit breakers, and cache freshness
          </summary>
          <div className="mt-4 space-y-5">
            <div className="grid gap-5 xl:grid-cols-[minmax(0,1.15fr)_minmax(0,0.85fr)]">
              <EndpointHealthGrid probes={probes} isLoading={probesLoading} />
              <CircuitBreakerTable circuits={healthData?.circuits} />
            </div>
            <CacheFreshnessTable caches={data.caches} />
          </div>
        </details>
      </StatusSection>
    ),
    crons: (
      <StatusSection
        id="crons"
        kicker="Schedulers"
        title="Worker job lanes"
        description="Unhealthy and degraded lanes stay on top. Healthy lanes collapse until you need them."
        accentClassName="border-l-orange-500"
        summary={
          <>
            <SummaryBadge label="Unhealthy" value={String(data.summary.unhealthyCrons)} />
            <SummaryBadge label="Degraded" value={String(data.summary.degradedCrons)} />
            <SummaryBadge label="Running" value={String(runningCrons)} />
          </>
        }
      >
        <div className="space-y-4">
          {activeCronGroups.length > 0 ? (
            activeCronGroups.map((group) => renderCronGroup(group))
          ) : (
            <div className="rounded-[1.25rem] border border-border/60 bg-background/35 p-4 text-sm leading-relaxed text-muted-foreground">
              No unhealthy cron lanes. Healthy groups are collapsed below.
            </div>
          )}
          {healthyCronGroups.length > 0 ? (
            <details
              open={isHealthyCronGroupsOpen}
              onToggle={(event) => setIsHealthyCronGroupsOpen(event.currentTarget.open)}
              className="rounded-[1.25rem] border border-border/60 bg-background/30 p-4"
            >
              <summary className="cursor-pointer text-sm font-medium text-foreground">
                Healthy lanes ({healthyCronGroups.length})
              </summary>
              <div className="mt-4 space-y-4">{healthyCronGroups.map((group) => renderCronGroup(group))}</div>
            </details>
          ) : null}
        </div>
      </StatusSection>
    ),
    control: (
      <StatusSection
        id="control"
        kicker="Operations"
        title="Manual response"
        description="Recovery tools stay near the top; downstream delivery telemetry is quieter and collapsible."
        accentClassName="border-l-emerald-500"
        summary={
          <>
            <SummaryBadge label="Suggested Actions" value={String(recommendedActions.length)} />
            <SummaryBadge label="Alert-ready Chats" value={String(data.telegramBot?.deliverableChats ?? 0)} />
            <SummaryBadge label="Pending Deliveries" value={String(data.telegramBot?.pendingDeliveries ?? 0)} />
          </>
        }
      >
        <AdminActionsPanel
          adminKey={adminKey}
          status={{ causes: data.causes, crons: data.crons }}
          nowSeconds={data.timestamp}
          onActionFinished={handleRefresh}
          showRecommendations={false}
        />
        <details
          open={isTelegramOpen}
          onToggle={(event) => setIsTelegramOpen(event.currentTarget.open)}
          className="rounded-[1.25rem] border border-border/60 bg-background/30 p-4"
        >
          <summary className="cursor-pointer text-sm font-medium text-foreground">Telegram delivery telemetry</summary>
          <div className="mt-4">
            <TelegramBotStats
              telegramBot={data.telegramBot}
              dispatchCron={data.crons["dispatch-telegram-alerts"]}
              nowSeconds={data.timestamp}
            />
          </div>
        </details>
      </StatusSection>
    ),
    history: (
      <StatusSection
        id="history"
        kicker="Incident Log"
        title="Timeline and recovery trail"
        description="Historical context stays last so the page tapers from action into evidence."
        accentClassName="border-l-rose-500"
        summary={
          <>
            <SummaryBadge label="Window" value={historyWindow} />
            <SummaryBadge label="Transitions" value={String(allTransitions.length)} />
            <SummaryBadge label="Latest" value={latestTransition ? formatTransitionLabel(latestTransition) : "—"} />
          </>
        }
      >
        <TransitionTimeline
          transitions={allTransitions}
          window={historyWindow}
          onWindowChange={setHistoryWindow}
          isLoading={historyLoading}
        />
      </StatusSection>
    ),
  };

  return (
    <div className="space-y-6">
      <section
        className={cn(
          "relative overflow-hidden rounded-[2rem] border px-4 py-5 shadow-[0_34px_90px_oklch(0_0_0_/0.28)] sm:px-5 lg:px-6",
          topFoldCopy.shell,
        )}
      >
        <div className="pointer-events-none absolute inset-0 opacity-[0.08] [background-image:linear-gradient(to_right,rgba(148,163,184,0.28)_1px,transparent_1px),linear-gradient(to_bottom,rgba(148,163,184,0.18)_1px,transparent_1px)] [background-size:4rem_4rem]" />
        <div
          className={cn(
            "pointer-events-none absolute inset-x-10 top-0 h-px bg-gradient-to-r from-transparent to-transparent",
            topFoldCopy.ruler,
          )}
        />
        <div
          className={cn(
            "pointer-events-none absolute -left-20 top-8 h-64 w-64 rounded-full blur-[125px]",
            topFoldCopy.flareA,
          )}
        />
        <div
          className={cn(
            "pointer-events-none absolute right-[14%] top-[5.5rem] h-52 w-52 rounded-full blur-[130px]",
            topFoldCopy.flareB,
          )}
        />
        <div className="pointer-events-none absolute right-0 top-20 h-px w-[28%] bg-gradient-to-l from-white/18 to-transparent" />
        <div className="relative space-y-5">
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-white/10 pb-3">
            <div className="flex flex-wrap items-center gap-2">
              <p className={cn("pharos-kicker", topFoldCopy.kicker)}>Operator Triage</p>
              <SummaryBadge label="Worker Check" value={formatTimestampSeconds(data.timestamp)} />
              <SummaryBadge label="Client Sync" value={formatTimestampMs(lastUpdated)} />
              <SummaryBadge
                label="Client Age"
                value={`${clientDataAgeSec}s`}
                className={clientDataStale ? "border-amber-500/30 bg-amber-500/10" : undefined}
              />
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <RefreshCountdown key={lastUpdated} onRefresh={handleRefresh} />
              <Button variant="outline" size="sm" onClick={onSignOut}>
                Sign out
              </Button>
            </div>
          </div>

          <div className="grid gap-5 xl:grid-cols-[minmax(0,1.2fr)_minmax(19rem,0.95fr)]">
            <div className="space-y-4">
              <div className="space-y-3">
                <div className="flex items-center gap-3">
                  <p className={cn("pharos-kicker", topFoldCopy.kicker)}>{topFoldCopy.eyebrow}</p>
                  <div className="h-px flex-1 bg-gradient-to-r from-white/18 to-transparent" />
                </div>
                <h2 className="max-w-4xl text-[clamp(2.9rem,7vw,5.65rem)] font-semibold leading-[0.92] tracking-[-0.085em] text-foreground">
                  {topFoldCopy.title}
                </h2>
                <p className="max-w-3xl text-sm leading-relaxed text-muted-foreground">{topFoldCopy.body}</p>
              </div>

              <StatusBanner
                status={data.overallStatus}
                timestamp={data.timestamp}
                availabilityStatus={data.availabilityStatus}
                dataQualityStatus={data.dataQualityStatus}
                rawStatus={data.rawOverallStatus}
                confidence={data.confidence}
              />

              <div className="flex flex-wrap gap-2">
                <SummaryBadge
                  label="Holding"
                  value={`${formatAge(statusHoldingAge)} in ${overallTone.label.toLowerCase()}`}
                />
                <SummaryBadge
                  label="Active Causes"
                  value={String(overallCauseCount)}
                  className={
                    overallCauseCount > 0
                      ? "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300"
                      : undefined
                  }
                />
                <SummaryBadge
                  label="Public Health"
                  value={healthData?.status ?? "—"}
                  className={healthData ? getStatusTone(healthData.status).badgeClassName : undefined}
                />
                <SummaryBadge
                  label="Cron Errors"
                  value={String(data.summary.cronErrors)}
                  className={
                    data.summary.cronErrors > 0
                      ? "border-red-500/30 bg-red-500/10 text-red-700 dark:text-red-300"
                      : undefined
                  }
                />
              </div>

              <div className="rounded-[1.55rem] border border-white/10 bg-[linear-gradient(180deg,rgba(255,255,255,0.05),rgba(255,255,255,0.015))] p-4 shadow-[0_18px_48px_oklch(0_0_0_/0.18)]">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="space-y-1">
                    <p className="pharos-kicker">Current Blockers</p>
                    <h3 className="text-[1.3rem] font-semibold tracking-tight text-foreground">
                      What needs attention now
                    </h3>
                  </div>
                  <span className="rounded-full border border-white/10 bg-white/5 px-2.5 py-1 text-[11px] text-muted-foreground">
                    {topCauses.length > 0 ? `${Math.min(topCauses.length, 3)} immediate` : "clear"}
                  </span>
                </div>

                <div className="mt-4 space-y-2.5">
                  {topCauses.length > 0 ? (
                    topCauses.slice(0, 3).map((cause) => (
                      <div
                        key={`${cause.layer}-${cause.code}-${cause.message}`}
                        className="rounded-[1.1rem] border border-white/10 bg-black/18 p-3.5"
                      >
                        <div className="flex flex-wrap items-center gap-2">
                          <span
                            className={cn(
                              "rounded-full px-2 py-0.5 text-[11px] font-medium",
                              getSeverityBadgeClass(cause.severity),
                            )}
                          >
                            {cause.severity}
                          </span>
                          <span className="text-[11px] text-muted-foreground">{cause.layer}</span>
                          <span className="font-mono text-[11px] text-muted-foreground">{cause.code}</span>
                        </div>
                        <div className="mt-2 text-sm leading-relaxed text-foreground">{cause.message}</div>
                      </div>
                    ))
                  ) : (
                    <div className="rounded-xl border border-border/60 bg-background/45 p-3 text-sm leading-relaxed text-muted-foreground">
                      No active causes. Current state has held for {formatAge(statusHoldingAge)}.
                    </div>
                  )}
                </div>

                <div className="mt-4 flex flex-wrap gap-2 border-t border-white/10 pt-4">
                  <SummaryBadge label="Last Transition" value={formatTransitionLabel(latestTransition)} />
                  <SummaryBadge
                    label="Changed"
                    value={
                      latestTransition ? `${formatAge(Math.max(0, data.timestamp - latestTransition.at))} ago` : "—"
                    }
                  />
                </div>
              </div>
            </div>

            <div className="space-y-4">
              <RecommendedActionStrip
                recommendations={recommendedActions}
                adminKey={adminKey}
                onActionFinished={handleRefresh}
              />

              <div className="rounded-[1.55rem] border border-white/10 bg-[linear-gradient(180deg,rgba(255,255,255,0.05),rgba(255,255,255,0.015))] p-5 shadow-[0_18px_48px_oklch(0_0_0_/0.18)]">
                <div className="space-y-1">
                  <p className="pharos-kicker">Follow This Order</p>
                  <h3 className="text-[1.3rem] font-semibold tracking-tight text-foreground">
                    The page now tapers by urgency
                  </h3>
                  <p className="text-sm leading-relaxed text-muted-foreground">
                    Each step down the page should feel broader, calmer, and less immediately actionable.
                  </p>
                </div>
                <div className="mt-3">
                  {operationalSections.map((section, index) => (
                    <PriorityLaneLink key={section.id} section={section} index={index} />
                  ))}
                </div>
              </div>
            </div>
          </div>
        </div>
      </section>

      <NoticeRail notices={notices} />

      <LongformScrollspyNav
        sections={sections.map((section) => ({ id: section.id, label: section.label }))}
        navAriaLabel="System status sections"
        railLabel="Jump to Lane"
        rightSlot={
          <span className="text-xs text-muted-foreground">
            Latest worker check {formatTimestampSeconds(data.timestamp)}
          </span>
        }
      />
      {sections.map((section) => (
        <Fragment key={section.id}>{sectionNodes[section.id]}</Fragment>
      ))}
    </div>
  );
}
