"use client";

import { type ReactNode } from "react";
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
import { RefreshCountdown } from "@/components/status/refresh-countdown";
import { StatusBanner } from "@/components/status/status-banner";
import { StatusFacts } from "@/components/status/status-facts";
import { SystemDiagnostics } from "@/components/status/system-diagnostics";
import { TelegramBotStats } from "@/components/status/telegram-bot-stats";
import { TransitionTimeline } from "@/components/status/transition-timeline";
import { Button } from "@/components/ui/button";
import { useAdminSessionKey } from "@/hooks/use-admin-session-key";
import { useStatusDashboardModel } from "@/hooks/use-status-dashboard-model";
import {
  type DashboardNotice,
  type DashboardSection,
  type DashboardSectionId,
  formatTimestampMs,
  formatTimestampSeconds,
  formatTransitionLabel,
  getNoticeTone,
  getStatusTone,
  getSeverityBadgeClass,
} from "@/lib/status-dashboard-model";
import { cn } from "@/lib/utils";

function SummaryBadge({
  label,
  value,
  className,
}: {
  label: string;
  value: string;
  className?: string;
}) {
  return (
    <div className={cn("rounded-full border border-border/60 bg-background/45 px-3 py-1.5 text-xs", className)}>
      <span className="text-muted-foreground">{label}</span>
      <span className="ml-1.5 font-mono tabular-nums text-foreground">{value}</span>
    </div>
  );
}

function OverviewStat({
  label,
  value,
  detail,
  valueClassName,
}: {
  label: string;
  value: string;
  detail: string;
  valueClassName?: string;
}) {
  return (
    <div className="rounded-xl border border-border/60 bg-background/40 p-3.5">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className={cn("mt-1 font-mono text-2xl font-semibold tabular-nums text-foreground", valueClassName)}>
        {value}
      </div>
      <div className="mt-1 text-xs leading-relaxed text-muted-foreground">{detail}</div>
    </div>
  );
}

function StatusSection({
  id,
  kicker,
  title,
  description,
  accentClassName,
  summary,
  children,
}: {
  id: DashboardSectionId;
  kicker: string;
  title: string;
  description: string;
  accentClassName: string;
  summary?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section
      id={id}
      className={cn(
        "scroll-mt-36 rounded-[1.5rem] border border-border/70 border-l-[3px] bg-card/82 px-4 py-5 shadow-[0_18px_40px_oklch(0_0_0_/0.14)] md:scroll-mt-28 sm:px-5 lg:px-6",
        accentClassName,
      )}
    >
      <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
        <div className="space-y-2">
          <p className="pharos-kicker">{kicker}</p>
          <div className="space-y-1">
            <h2 className="text-xl font-semibold tracking-tight text-foreground sm:text-[1.35rem]">{title}</h2>
            <p className="max-w-3xl text-sm leading-relaxed text-muted-foreground">{description}</p>
          </div>
        </div>
        {summary ? <div className="flex flex-wrap gap-2 lg:justify-end">{summary}</div> : null}
      </div>
      <div className="mt-5 space-y-5">{children}</div>
    </section>
  );
}

function QuickJumpCard({ section }: { section: DashboardSection }) {
  return (
    <a
      href={`#${section.id}`}
      className={cn(
        "pharos-focus-ring pharos-card-shell pharos-interactive-card group flex h-full flex-col gap-3 border-l-[3px] bg-gradient-to-b from-background/35 to-transparent p-4",
        section.accentClassName,
      )}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="space-y-1">
          <p className="pharos-kicker">{section.label}</p>
          <h3 className="text-base font-semibold tracking-tight text-foreground">{section.title}</h3>
        </div>
        <span
          className={cn(
            "rounded-full border border-border/60 bg-background/55 px-2.5 py-1 text-[11px] font-medium text-foreground",
            section.valueClassName,
          )}
        >
          {section.value}
        </span>
      </div>
      <p className="text-sm leading-relaxed text-muted-foreground">{section.summary}</p>
      <div className="text-xs text-muted-foreground transition-colors group-hover:text-foreground">Open section →</div>
    </a>
  );
}

function NoticeRail({ notices }: { notices: DashboardNotice[] }) {
  if (notices.length === 0) return null;

  return (
    <div className="grid gap-3 lg:grid-cols-2">
      {notices.map((notice) => (
        <div key={notice.id} className={cn("rounded-xl border px-4 py-3", getNoticeTone(notice.tone))}>
          <div className="text-sm font-medium">{notice.title}</div>
          <div className="mt-1 text-xs leading-relaxed opacity-90">{notice.detail}</div>
        </div>
      ))}
    </div>
  );
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
    healthDiffersFromStatus,
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

  return (
    <div className="space-y-6">
      <section className="relative overflow-hidden rounded-[1.75rem] border border-border/70 bg-card/90 px-4 py-5 shadow-[0_22px_48px_oklch(0_0_0_/0.16)] sm:px-5 lg:px-6">
        <div className="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-frost-blue/45 to-transparent" />
        <div className="pointer-events-none absolute -left-10 top-4 h-32 w-32 rounded-full bg-frost-blue/16 blur-[100px]" />
        <div className="pointer-events-none absolute right-0 top-0 h-40 w-40 rounded-full bg-sky-500/8 blur-[110px]" />
        <div className="relative grid gap-5 xl:grid-cols-[minmax(0,1.25fr)_minmax(19rem,0.95fr)]">
          <div className="space-y-4">
            <div className="space-y-2">
              <div className="flex items-center gap-3">
                <p className="pharos-kicker text-sky-700 dark:text-frost-blue/82">Operator Command Center</p>
                <div className="h-px flex-1 bg-gradient-to-r from-frost-blue/35 to-transparent" />
              </div>
              <h2 className="text-2xl font-semibold tracking-tight text-foreground sm:text-[2rem]">
                Status organized by response path, not by widget order.
              </h2>
              <p className="max-w-3xl text-sm leading-relaxed text-muted-foreground">
                Start with the active signals, move into the affected lane, then drop into cron-by-cron detail only
                when a lane actually needs intervention.
              </p>
            </div>

            <StatusBanner
              status={data.overallStatus}
              timestamp={data.timestamp}
              availabilityStatus={data.availabilityStatus}
              dataQualityStatus={data.dataQualityStatus}
              rawStatus={data.rawOverallStatus}
              confidence={data.confidence}
            />

            <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
              <OverviewStat
                label="Confidence"
                value={`${(data.confidence * 100).toFixed(1)}%`}
                detail={`raw ${data.rawOverallStatus} -> effective ${data.overallStatus}`}
                valueClassName={overallTone.valueClassName}
              />
              <OverviewStat
                label="Active Causes"
                value={String(overallCauseCount)}
                detail={`${data.causes.availability.length} availability, ${data.causes.dataQuality.length} data quality`}
                valueClassName={
                  overallCauseCount > 0 ? "text-amber-700 dark:text-amber-400" : "text-green-700 dark:text-green-400"
                }
              />
              <OverviewStat
                label="Public /api/health"
                value={healthData?.status ?? "—"}
                detail={
                  healthData
                    ? healthDiffersFromStatus
                      ? `Differs from admin status (${data.overallStatus})`
                      : "Matches admin status surface"
                    : "Health endpoint not loaded"
                }
                valueClassName={
                  healthData
                    ? getStatusTone(healthData.status).valueClassName
                    : "text-muted-foreground"
                }
              />
              <OverviewStat
                label="Running Lanes"
                value={String(runningCrons)}
                detail={`${data.summary.cronErrors} cron errors, ${data.summary.degradedCrons} degraded`}
                valueClassName={
                  data.summary.cronErrors > 0
                    ? "text-red-700 dark:text-red-400"
                    : data.summary.degradedCrons > 0
                      ? "text-amber-700 dark:text-amber-400"
                      : "text-green-700 dark:text-green-400"
                }
              />
            </div>
          </div>

          <div className="grid gap-4">
            <div className="rounded-[1.25rem] border border-border/70 bg-background/35 p-4">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="space-y-1">
                  <p className="pharos-kicker">Session Controls</p>
                  <h3 className="text-base font-semibold tracking-tight text-foreground">Refresh and auth state</h3>
                  <p className="text-sm leading-relaxed text-muted-foreground">
                    This browser session stores the admin key in session storage and polls the status surfaces on an
                    operator cadence.
                  </p>
                </div>
                <Button variant="outline" size="sm" onClick={onSignOut}>
                  Sign out
                </Button>
              </div>
              <div className="mt-4 rounded-xl border border-border/60 bg-background/45 px-3 py-3">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div>
                    <div className="text-sm font-medium text-foreground">Client refresh loop</div>
                    <div className="text-xs text-muted-foreground">Last synced {formatTimestampMs(lastUpdated)}.</div>
                  </div>
                  <RefreshCountdown key={lastUpdated} onRefresh={handleRefresh} />
                </div>
              </div>
              <div className="mt-3 flex flex-wrap gap-2">
                <SummaryBadge label="Worker Check" value={formatTimestampSeconds(data.timestamp)} />
                <SummaryBadge
                  label="Client Age"
                  value={`${clientDataAgeSec}s`}
                  className={clientDataStale ? "border-amber-500/30 bg-amber-500/10" : undefined}
                />
              </div>
            </div>

            <div className="rounded-[1.25rem] border border-border/70 bg-background/35 p-4">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="space-y-1">
                  <p className="pharos-kicker">Watchlist</p>
                  <h3 className="text-base font-semibold tracking-tight text-foreground">What needs attention now</h3>
                </div>
                <span className="rounded-full border border-border/60 bg-background/50 px-2.5 py-1 text-[11px] text-muted-foreground">
                  {topCauses.length > 0 ? `${topCauses.length} signals` : "clear"}
                </span>
              </div>

              <div className="mt-4 space-y-2.5">
                {topCauses.length > 0 ? (
                  topCauses.map((cause) => (
                    <div key={`${cause.layer}-${cause.code}-${cause.message}`} className="rounded-xl border border-border/60 bg-background/45 p-3">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className={cn("rounded-full px-2 py-0.5 text-[11px] font-medium", getSeverityBadgeClass(cause.severity))}>
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

              <div className="mt-4 flex flex-wrap gap-2 border-t border-border/60 pt-4">
                <SummaryBadge label="Last Transition" value={formatTransitionLabel(latestTransition)} />
                <SummaryBadge
                  label="Changed"
                  value={latestTransition ? `${formatAge(Math.max(0, data.timestamp - latestTransition.at))} ago` : "—"}
                />
              </div>
            </div>
          </div>
        </div>
      </section>

      <NoticeRail notices={notices} />

      <section className="space-y-3">
        <div className="flex items-center gap-3">
          <p className="pharos-kicker">Section Map</p>
          <div className="h-px flex-1 bg-gradient-to-r from-border to-transparent" />
        </div>
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {sections.map((section) => (
            <QuickJumpCard key={section.id} section={section} />
          ))}
        </div>
      </section>

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

      <StatusSection
        id="overview"
        kicker="Command Center"
        title="Current incident picture"
        description="Read this section first. It explains whether the status machine is stable, why it is in this state, and what changed recently."
        accentClassName="border-l-frost-blue"
        summary={
          <>
            <SummaryBadge label="Overall" value={overallTone.label} className={overallTone.badgeClassName} />
            <SummaryBadge label="Raw" value={data.rawOverallStatus} />
            <SummaryBadge label="Confidence" value={`${(data.confidence * 100).toFixed(1)}%`} />
          </>
        }
      >
        <SystemDiagnostics
          state={data.state}
          staleness={data.staleness}
          probe={data.probe}
          discrepancy={data.discrepancy}
          browserProbe={browserProbeSummary}
          nowSeconds={data.timestamp}
        />
        <StatusFacts
          adminKey={adminKey}
          dbHealthy={data.dbHealthy}
          summary={data.summary}
          causes={data.causes}
          onActionFinished={handleRefresh}
        />
      </StatusSection>

      <StatusSection
        id="pipeline"
        kicker="Data Pipeline"
        title="Freshness and coverage"
        description="Use this lane when the issue is data quality rather than routing or cron execution. It groups quality thresholds, dataset recency, source quality, and backlog discovery."
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
                Stablecoins cache health, blacklist amount gaps, on-chain drift, active depegs, and stale supply
                samples summarized against the status thresholds.
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
          <PriceSourceHealthCard
            health={data.priceSourceHealth}
            nowSeconds={data.timestamp}
          />
          <LiquidityHealthCard health={data.liquidityHealth} />
        </div>

        <div className="grid gap-5 xl:grid-cols-3">
          <DatasetFreshnessTable datasetFreshness={data.datasetFreshness} nowSeconds={data.timestamp} />
          <ReserveSyncHealthCard health={data.reserveComposition} nowSeconds={data.timestamp} />
          <MintBurnReconciliationCard summary={data.mintBurnReconciliation} />
        </div>

        <DiscoveryCandidatesCard candidates={data.discoveryCandidates} adminKey={adminKey} nowSeconds={data.timestamp} />
      </StatusSection>

      <StatusSection
        id="reliability"
        kicker="Service Health"
        title="Probes, breakers, and cache pressure"
        description="Use this lane when the issue looks like routing, availability, or public-service degradation rather than ingestion quality."
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
        <div className="grid gap-5 xl:grid-cols-[minmax(0,1.15fr)_minmax(0,0.85fr)]">
          <EndpointHealthGrid probes={probes} isLoading={probesLoading} />
          <CircuitBreakerTable circuits={healthData?.circuits} />
        </div>
        <CacheFreshnessTable caches={data.caches} />
      </StatusSection>

      <StatusSection
        id="crons"
        kicker="Schedulers"
        title="Worker job lanes"
        description="Cron cards stay grouped by operational theme so you can scan the affected lane before diving into an individual job."
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
          {cronGroups.map((group) => (
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
          ))}
        </div>
      </StatusSection>

      <StatusSection
        id="control"
        kicker="Operations"
        title="Manual response and delivery systems"
        description="Manual triggers and alert-delivery telemetry live together here so recovery actions and downstream operator comms are easy to cross-check."
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
        />
        <TelegramBotStats
          telegramBot={data.telegramBot}
          dispatchCron={data.crons["dispatch-telegram-alerts"]}
          nowSeconds={data.timestamp}
        />
      </StatusSection>

      <StatusSection
        id="history"
        kicker="Incident Log"
        title="Timeline and recovery trail"
        description="Use the persisted transition history to validate dwell behavior, correlate incidents, and confirm recovery paths over different windows."
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
    </div>
  );
}
