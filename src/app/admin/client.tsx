"use client";

import Link from "next/link";
import { Fragment, type ReactNode, useSyncExternalStore } from "react";
import { STATUS_RESERVE_DRIFT_THRESHOLD_POINTS } from "@shared/lib/status-thresholds";
import type { StatusResponse } from "@shared/types";
import { FeaturePageShell } from "@/components/feature-page-shell";
import { LongformScrollspyNav } from "@/components/longform-scrollspy-nav";
import { formatElapsedSeconds } from "@shared/lib/format";
import { RecommendedActionStrip } from "@/components/status/recommended-action-strip";
import { RefreshCountdown } from "@/components/status/refresh-countdown";
import { StatusBanner } from "@/components/status/status-banner";
import { getTopFoldCopy, isRecoveryHold as isRecoveryHoldState } from "@/components/status/top-fold-copy";
import { NoticeRail, PriorityLaneLink, SummaryBadge } from "@/components/status/page-primitives";
import { Button } from "@/components/ui/button";
import { useStatusDashboardModel } from "@/hooks/use-status-dashboard-model";
import { isOpsUiHost, type AdminAccess } from "@/lib/admin-access";
import {
  type DashboardSectionId,
  formatTimestampSeconds,
  formatTransitionLabel,
  getStatusTone,
  getSeverityBadgeClass,
} from "@/lib/status-dashboard-model";
import { cn } from "@/lib/utils";
import { useAutoExpand } from "./use-auto-expand";
import { OverviewSection } from "./sections/overview-section";
import { PipelineSection } from "./sections/pipeline-section";
import { ReliabilitySection } from "./sections/reliability-section";
import { CronsSection, type CronGroup } from "./sections/crons-section";
import { ControlSection } from "./sections/control-section";
import { HistorySection } from "./sections/history-section";

function getCronSeverity(cron: StatusResponse["crons"][string]): number {
  if (cron.telemetryUnknown) return 1;
  if (!cron.healthy || cron.lastRun?.status === "error" || cron.inFlight?.stale) return 2;
  if (cron.lastRun?.status === "degraded") return 1;
  return 0;
}

export default function StatusClient() {
  const opsUi = useSyncExternalStore(
    () => () => undefined,
    () => isOpsUiHost(),
    () => null,
  );
  const adminAccess: AdminAccess = { mode: "ops-proxy" };
  const handleOpsSignOut = () => {
    window.location.assign("/cdn-cgi/access/logout");
  };

  if (opsUi == null) {
    return (
      <FeaturePageShell
        breadcrumbName="Admin"
        path="/admin/"
        title="Operator Admin"
        variant="auth-gated"
        leadParagraphs={[
          "Access-protected operator panel for monitoring pipeline health, endpoint reliability, incident state transitions, and manual recovery flows.",
        ]}
      >
        <div className="py-20 text-center text-muted-foreground">Loading status access...</div>
      </FeaturePageShell>
    );
  }

  if (!opsUi) {
    return (
      <FeaturePageShell
        breadcrumbName="Admin"
        path="/admin/"
        title="Operator Admin"
        variant="auth-gated"
        leadParagraphs={["This route exists, but the operator control plane only runs on the Access-protected ops host."]}
      >
        <div className="pt-4">
          <div className="rounded-[1.6rem] border border-border/60 bg-background/35 p-6 shadow-[0_18px_48px_oklch(0_0_0_/0.16)]">
            <div className="space-y-3">
              <p className="pharos-kicker">Private Surface</p>
              <h2 className="text-2xl font-semibold tracking-tight text-foreground">
                Operator tooling is no longer available on the public host.
              </h2>
              <p className="max-w-2xl text-sm leading-relaxed text-muted-foreground">
                Manual response tools and deep operator telemetry now run behind the Access-protected ops host.
                The public `/status/` page is read-only.
              </p>
            </div>
            <div className="mt-5 flex flex-wrap gap-3">
              <Link
                href="/"
                className="pharos-focus-ring inline-flex min-h-11 items-center rounded-full border border-border/60 bg-background/60 px-4 py-2 text-sm font-medium text-foreground hover:border-primary/45 hover:bg-primary/8"
              >
                Return to dashboard
              </Link>
            </div>
          </div>
        </div>
      </FeaturePageShell>
    );
  }

  return (
    <FeaturePageShell
      breadcrumbName="Admin"
      path="/admin/"
      title="Operator Admin"
      variant="auth-gated"
      leadParagraphs={[
        opsUi
          ? "Access-protected operator panel for monitoring pipeline health, endpoint reliability, incident state transitions, and manual recovery flows."
          : "Private operator panel for monitoring pipeline health, endpoint reliability, incident state transitions, and manual recovery flows.",
      ]}
    >
      <StatusDashboard adminAccess={adminAccess} onSignOut={handleOpsSignOut} />
    </FeaturePageShell>
  );
}

function StatusDashboard({ adminAccess, onSignOut }: { adminAccess: AdminAccess; onSignOut: () => void }) {
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
    requestSourceError,
    requestSourceLoading,
    requestSourceStats,
    setHistoryWindow,
  } = useStatusDashboardModel(adminAccess);
  const diagnosticsSignal =
    data?.overallStatus !== "healthy" || (model?.notices.length ?? 0) > 0 || (model?.healthDiffersFromStatus ?? false);
  const reliabilitySignal =
    (healthData?.status ?? data?.availabilityStatus ?? "healthy") !== "healthy" ||
    (model?.browserProbeSummary?.failCount ?? 0) > 0 ||
    (data?.summary.worstCacheRatio ?? 0) > 1;
  const telegramSignal = (data?.telegramBot?.pendingDeliveries ?? 0) > 0;

  const [isDiagnosticsOpen, setIsDiagnosticsOpen] = useAutoExpand(diagnosticsSignal);
  const [isReliabilityOpen, setIsReliabilityOpen] = useAutoExpand(reliabilitySignal);
  const [isTelegramOpen, setIsTelegramOpen] = useAutoExpand(telegramSignal);
  const [isHealthyCronGroupsOpen, setIsHealthyCronGroupsOpen] = useAutoExpand(false);

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
          Sign out
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
    querySyncs,
    recommendedActions,
    runningCrons,
    sections,
    statusHoldingAge,
    topCauses,
  } = model;
  const topFoldCopy = getTopFoldCopy(data.overallStatus, data.rawOverallStatus);
  const statusEvaluatedAt = data.state.lastEvaluatedAt;
  const isRecoveryHold = isRecoveryHoldState(data.overallStatus, data.rawOverallStatus);
  const statusSync = querySyncs.find((sync) => sync.key === "status") ?? null;
  const publicHealthSync = querySyncs.find((sync) => sync.key === "health") ?? null;
  const browserProbeSync = querySyncs.find((sync) => sync.key === "probes") ?? null;
  const requestSourceSync = querySyncs.find((sync) => sync.key === "requestSource") ?? null;
  const operationalSections = sections.filter((section) => section.id !== "overview" && section.id !== "history" && section.id !== "control");
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
  const activeCronGroups: CronGroup[] = sortedCronGroups.filter((group) =>
    group.entries.some(([, cron]) => getCronSeverity(cron) > 0),
  );
  const healthyCronGroups: CronGroup[] = sortedCronGroups.filter((group) =>
    group.entries.every(([, cron]) => getCronSeverity(cron) === 0),
  );

  const sectionNodes: Record<DashboardSectionId, ReactNode> = {
    overview: (
      <OverviewSection
        data={data}
        adminAccess={adminAccess}
        handleRefresh={handleRefresh}
        overallTone={overallTone}
        isDiagnosticsOpen={isDiagnosticsOpen}
        setIsDiagnosticsOpen={setIsDiagnosticsOpen}
        browserProbeSummary={browserProbeSummary}
      />
    ),
    pipeline: (
      <PipelineSection
        data={data}
        adminAccess={adminAccess}
        handleRefresh={handleRefresh}
      />
    ),
    reliability: (
      <ReliabilitySection
        data={data}
        healthData={healthData}
        browserProbeSummary={browserProbeSummary}
        isReliabilityOpen={isReliabilityOpen}
        setIsReliabilityOpen={setIsReliabilityOpen}
        probes={probes}
        probesLoading={probesLoading}
        requestSourceStats={requestSourceStats}
        requestSourceError={requestSourceError instanceof Error ? requestSourceError.message : null}
        requestSourceLoading={requestSourceLoading}
      />
    ),
    crons: (
      <CronsSection
        data={data}
        runningCrons={runningCrons}
        activeCronGroups={activeCronGroups}
        healthyCronGroups={healthyCronGroups}
        isHealthyCronGroupsOpen={isHealthyCronGroupsOpen}
        setIsHealthyCronGroupsOpen={setIsHealthyCronGroupsOpen}
      />
    ),
    control: (
      <ControlSection
        data={data}
        adminAccess={adminAccess}
        handleRefresh={handleRefresh}
        recommendedActions={recommendedActions}
        isTelegramOpen={isTelegramOpen}
        setIsTelegramOpen={setIsTelegramOpen}
      />
    ),
    history: (
      <HistorySection
        allTransitions={allTransitions}
        latestTransition={latestTransition}
        historyWindow={historyWindow}
        setHistoryWindow={setHistoryWindow}
        historyLoading={historyLoading}
      />
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
              <SummaryBadge label="State Eval" value={formatTimestampSeconds(statusEvaluatedAt)} />
              <SummaryBadge label="Status Payload" value={formatTimestampSeconds(data.timestamp)} />
              <SummaryBadge label="Status Fetch" value={formatTimestampSeconds(statusSync?.updatedAtSec)} />
              <SummaryBadge label="Health Fetch" value={formatTimestampSeconds(publicHealthSync?.updatedAtSec)} />
              <SummaryBadge label="Probe Fetch" value={formatTimestampSeconds(browserProbeSync?.updatedAtSec)} />
              <SummaryBadge label="API Mix Fetch" value={formatTimestampSeconds(requestSourceSync?.updatedAtSec)} />
              <SummaryBadge
                label="Sync Floor"
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
                evaluatedAt={statusEvaluatedAt}
                availabilityStatus={data.availabilityStatus}
                dataQualityStatus={data.dataQualityStatus}
                rawStatus={data.rawOverallStatus}
                confidence={data.confidence}
                consecutiveRaw={data.state.consecutiveRaw}
                thresholds={data.state.thresholds}
              />

              <div className="flex flex-wrap gap-2">
                <SummaryBadge
                  label={isRecoveryHold ? "Recovery Hold" : "Holding"}
                  value={
                    isRecoveryHold
                      ? `${formatElapsedSeconds(statusHoldingAge)} at ${overallTone.label.toLowerCase()} / raw ${data.rawOverallStatus}`
                      : `${formatElapsedSeconds(statusHoldingAge)} in ${overallTone.label.toLowerCase()}`
                  }
                  className={
                    isRecoveryHold
                      ? "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300"
                      : undefined
                  }
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
                <SummaryBadge
                  label="Reserve Drift"
                  value={String(data.reserveDrift?.length ?? 0)}
                  className={
                    (data.reserveDrift?.length ?? 0) > 0
                      ? "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300"
                      : undefined
                  }
                />
                <SummaryBadge
                  label="Class Warnings"
                  value={String(data.classificationWarnings?.length ?? 0)}
                  className={
                    (data.classificationWarnings?.length ?? 0) > 0
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
                      No active causes. Current state has held for {formatElapsedSeconds(statusHoldingAge)}.
                    </div>
                  )}
                </div>

                <div className="mt-4 flex flex-wrap gap-2 border-t border-white/10 pt-4">
                  <SummaryBadge label="Last Transition" value={formatTransitionLabel(latestTransition)} />
                  <SummaryBadge
                    label="Changed"
                    value={
                      latestTransition ? `${formatElapsedSeconds(Math.max(0, data.timestamp - latestTransition.at))} ago` : "—"
                    }
                  />
                </div>

                {(data.reserveDrift?.length ?? 0) > 0 || (data.classificationWarnings?.length ?? 0) > 0 ? (
                  <div className="mt-4 grid gap-3 border-t border-white/10 pt-4 sm:grid-cols-2">
                    <div className="rounded-[1rem] border border-white/10 bg-black/18 p-3">
                      <div className="text-[11px] uppercase tracking-[0.18em] text-muted-foreground">
                        Reserve Metadata Watch
                      </div>
                      <div className="mt-2 text-sm leading-relaxed text-foreground">
                        {(data.reserveDrift?.length ?? 0) > 0
                          ? `${data.reserveDrift?.length} coin(s) show >${STATUS_RESERVE_DRIFT_THRESHOLD_POINTS}pt drift between live reserve slices and curated reserve metadata.`
                          : "No reserve drift watch items."}
                      </div>
                    </div>
                    <div className="rounded-[1rem] border border-white/10 bg-black/18 p-3">
                      <div className="text-[11px] uppercase tracking-[0.18em] text-muted-foreground">
                        Classification Watch
                      </div>
                      <div className="mt-2 text-sm leading-relaxed text-foreground">
                        {(data.classificationWarnings?.length ?? 0) > 0
                          ? `${data.classificationWarnings?.length} decentralized classifications exceed the centralized custody watch threshold.`
                          : "No classification watch items."}
                      </div>
                    </div>
                  </div>
                ) : null}
              </div>
            </div>

            <div className="space-y-4">
              <RecommendedActionStrip
                recommendations={recommendedActions}
                adminAccess={adminAccess}
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
            Latest state eval {formatTimestampSeconds(statusEvaluatedAt)}
          </span>
        }
      />
      {sections.map((section) => (
        <Fragment key={section.id}>{sectionNodes[section.id]}</Fragment>
      ))}
    </div>
  );
}
