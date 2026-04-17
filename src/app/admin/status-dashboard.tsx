"use client";

import { Fragment, useState, type ReactNode } from "react";
import { LongformScrollspyNav } from "@/components/longform-scrollspy-nav";
import { formatElapsedSeconds } from "@shared/lib/format";
import { FreshnessIndicator } from "@/components/status/freshness-indicator";
import { RecommendedActionStrip } from "@/components/status/recommended-action-strip";
import { RefreshCountdown } from "@/components/status/refresh-countdown";

/** Stale once data is older than 3× the 60s refresh cadence. */
const ADMIN_STALE_AFTER_MS = 180_000;
import { getTopFoldCopy, isRecoveryHold as isRecoveryHoldState } from "@/components/status/top-fold-copy";
import { NoticeRail, SummaryBadge } from "@/components/status/page-primitives";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { useStatusDashboardModel } from "@/hooks/use-status-dashboard-model";
import {
  type DashboardSectionId,
  formatTimestampSeconds,
  formatTransitionLabel,
  getStatusTone,
  getSeverityBadgeClass,
} from "@/lib/status-dashboard-model";
import { cn } from "@/lib/utils";
import { useAutoExpand } from "./use-auto-expand";
import { SectionErrorBoundary } from "@/components/section-error-boundary";
import { OverviewSection } from "./sections/overview-section";
import { PipelineSection } from "./sections/pipeline-section";
import { ReliabilitySection } from "./sections/reliability-section";
import { CronsSection, type CronGroup } from "./sections/crons-section";
import { ControlSection } from "./sections/control-section";
import { HistorySection } from "./sections/history-section";
import { getCronSeverity } from "./cron-severity";

export function StatusDashboard({ onSignOut }: { onSignOut: () => void }) {
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
  } = useStatusDashboardModel();
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
  const [isBlockersExpanded, setIsBlockersExpanded] = useState(false);

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
    blockerCauses,
    browserProbeSummary,
    clientDataAgeSec,
    clientDataStale,
    cronGroups,
    latestTransition,
    notices,
    overallCauseCount,
    watchCauseCount,
    overallTone,
    querySyncs,
    recommendedActions,
    runningCrons,
    sections,
    statusHoldingAge,
  } = model;
  const topFoldCopy = getTopFoldCopy(data.overallStatus, data.rawOverallStatus);
  const statusEvaluatedAt = data.state.lastEvaluatedAt;
  const isRecoveryHold = isRecoveryHoldState(data.overallStatus, data.rawOverallStatus);
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
      <SectionErrorBoundary name="overview">
        <OverviewSection
          data={data}
          handleRefresh={handleRefresh}
          overallTone={overallTone}
          isDiagnosticsOpen={isDiagnosticsOpen}
          setIsDiagnosticsOpen={setIsDiagnosticsOpen}
          browserProbeSummary={browserProbeSummary}
          querySyncs={querySyncs}
          clientDataAgeSec={clientDataAgeSec}
          clientDataStale={clientDataStale}
        />
      </SectionErrorBoundary>
    ),
    pipeline: (
      <SectionErrorBoundary name="pipeline">
        <PipelineSection
          data={data}
          handleRefresh={handleRefresh}
        />
      </SectionErrorBoundary>
    ),
    reliability: (
      <SectionErrorBoundary name="reliability">
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
      </SectionErrorBoundary>
    ),
    crons: (
      <SectionErrorBoundary name="crons">
        <CronsSection
          data={data}
          runningCrons={runningCrons}
          activeCronGroups={activeCronGroups}
          healthyCronGroups={healthyCronGroups}
          isHealthyCronGroupsOpen={isHealthyCronGroupsOpen}
          setIsHealthyCronGroupsOpen={setIsHealthyCronGroupsOpen}
        />
      </SectionErrorBoundary>
    ),
    control: (
      <SectionErrorBoundary name="control">
        <ControlSection
          data={data}
          handleRefresh={handleRefresh}
          recommendedActions={recommendedActions}
          isTelegramOpen={isTelegramOpen}
          setIsTelegramOpen={setIsTelegramOpen}
        />
      </SectionErrorBoundary>
    ),
    history: (
      <SectionErrorBoundary name="history">
        <HistorySection
          allTransitions={allTransitions}
          latestTransition={latestTransition}
          historyWindow={historyWindow}
          setHistoryWindow={setHistoryWindow}
          historyLoading={historyLoading}
        />
      </SectionErrorBoundary>
    ),
  };

  return (
    <div className="space-y-6">
      <section
        className={cn(
          "rounded-[1.5rem] border px-4 py-4 sm:px-5 lg:px-6",
          topFoldCopy.shell,
        )}
      >
        <div className="space-y-4">
          {/* Triage header: status + key metrics + controls */}
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex flex-wrap items-center gap-3">
              <span
                className={cn(
                  "inline-flex items-center gap-2 rounded-full border px-3 py-1.5 text-xs font-medium uppercase tracking-[0.14em]",
                  overallTone.badgeClassName,
                )}
              >
                <span
                  className={cn(
                    "h-2 w-2 rounded-full",
                    data.overallStatus === "stale"
                      ? "bg-red-400"
                      : data.overallStatus === "degraded"
                        ? "bg-amber-400"
                        : "bg-emerald-400",
                  )}
                />
                {overallTone.label}
              </span>
              {isRecoveryHold && (
                <TooltipProvider>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <span className="cursor-help rounded-full border border-amber-500/30 bg-amber-500/10 px-2.5 py-1 text-[11px] font-medium text-amber-700 dark:text-amber-300">
                        recovery hold — raw {data.rawOverallStatus}
                      </span>
                    </TooltipTrigger>
                    <TooltipContent className="max-w-xs">
                      The state machine is holding at a higher severity than the raw signal so that improvements must hold for {data.state.minDwellSec}s before the overall status is downgraded. Prevents flap.
                    </TooltipContent>
                  </Tooltip>
                </TooltipProvider>
              )}
              <span className="text-sm text-muted-foreground">
                {topFoldCopy.eyebrow} · holding {formatElapsedSeconds(statusHoldingAge)}
              </span>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <FreshnessIndicator updatedAtMs={lastUpdated} staleAfterMs={ADMIN_STALE_AFTER_MS} />
              <RefreshCountdown key={lastUpdated} onRefresh={handleRefresh} />
              <Button variant="outline" size="sm" onClick={onSignOut}>
                Sign out
              </Button>
            </div>
          </div>

          {/* Tier 1: the numbers that decide "do I act?" */}
          <div className="flex flex-wrap gap-2">
            <SummaryBadge
              label="Blockers"
              value={String(overallCauseCount)}
              className={
                overallCauseCount > 0
                  ? "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300"
                  : undefined
              }
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
              label="Public Health"
              value={healthData?.status ?? "—"}
              className={healthData ? getStatusTone(healthData.status).badgeClassName : undefined}
            />
            <span className="mx-1 hidden self-center border-l border-border/40 py-2 sm:block" />
            <SummaryBadge label="Watch" value={String(watchCauseCount)} />
            <SummaryBadge label="Reserve Drift" value={String(data.reserveDrift?.length ?? 0)} />
            <SummaryBadge label="Class Warnings" value={String(data.classificationWarnings?.length ?? 0)} />
          </div>

          {/* Blockers + recommended actions side by side */}
          <div className="grid gap-4 xl:grid-cols-[minmax(0,1.25fr)_minmax(18rem,0.75fr)]">
            <div className="rounded-xl border border-border/60 bg-background/35 p-4">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <h3 className="text-sm font-semibold text-foreground">Current Blockers</h3>
                <span className="text-[11px] text-muted-foreground">
                  {overallCauseCount > 0
                    ? isBlockersExpanded
                      ? `${overallCauseCount} shown`
                      : `${Math.min(overallCauseCount, 3)} of ${overallCauseCount}`
                    : watchCauseCount > 0
                      ? "watch-only"
                      : "clear"}
                </span>
              </div>

              <div className="mt-3 space-y-2">
                {blockerCauses.length > 0 ? (
                  (isBlockersExpanded ? blockerCauses : blockerCauses.slice(0, 3)).map((cause) => (
                    <div
                      key={`${cause.layer}-${cause.code}-${cause.message}`}
                      className="rounded-lg border border-border/60 bg-background/30 p-3"
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
                      <div className="mt-1.5 text-sm leading-relaxed text-foreground">{cause.message}</div>
                      {cause.runbookUrl && (
                        <a
                          href={cause.runbookUrl}
                          target="_blank"
                          rel="noreferrer noopener"
                          className="pharos-focus-ring mt-2 inline-flex items-center gap-1 text-[11px] font-medium text-primary underline underline-offset-2"
                        >
                          Runbook →
                        </a>
                      )}
                    </div>
                  ))
                ) : (
                  <div className="rounded-lg border border-border/60 bg-background/45 p-3 text-sm text-muted-foreground">
                    {watchCauseCount > 0
                      ? `No active blockers. ${watchCauseCount} watch item(s) remain.`
                      : "No active blockers."}
                  </div>
                )}
                {overallCauseCount > 3 && (
                  <button
                    type="button"
                    onClick={() => setIsBlockersExpanded((v) => !v)}
                    className="pharos-focus-ring mt-1 inline-flex items-center gap-1 rounded-md px-2 py-1 text-[11px] font-medium text-muted-foreground hover:text-foreground"
                  >
                    {isBlockersExpanded ? "Show top 3" : `+${overallCauseCount - 3} more`}
                  </button>
                )}
              </div>

              <div className="mt-3 flex flex-wrap gap-2 border-t border-border/60 pt-3">
                <SummaryBadge label="Last Transition" value={formatTransitionLabel(latestTransition)} />
                <SummaryBadge
                  label="Changed"
                  value={
                    latestTransition ? `${formatElapsedSeconds(Math.max(0, data.timestamp - latestTransition.at))} ago` : "—"
                  }
                />
              </div>
            </div>

            <RecommendedActionStrip
              recommendations={recommendedActions}
              onActionFinished={handleRefresh}
            />
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
