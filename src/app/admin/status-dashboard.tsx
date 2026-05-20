"use client";

import { Fragment, type ReactNode } from "react";
import { LongformScrollspyNav } from "@/components/longform-scrollspy-nav";
import { parseTelegramDispatchCronMetadata } from "@shared/lib/status-metadata";
import { NoticeRail } from "@/components/status/page-primitives";
import { Button } from "@/components/ui/button";
import { useStatusDashboardModel } from "@/hooks/use-status-dashboard-model";
import {
  type DashboardSectionId,
  formatTimestampSeconds,
} from "@/lib/status-dashboard-model";
import { useAutoExpand } from "./use-auto-expand";
import { SectionErrorBoundary } from "@/components/section-error-boundary";
import { OverviewSection } from "./sections/overview-section";
import { PipelineSection } from "./sections/pipeline-section";
import { ReliabilitySection } from "./sections/reliability-section";
import { CronsSection, type CronGroup } from "./sections/crons-section";
import { ControlSection } from "./sections/control-section";
import { HistorySection } from "./sections/history-section";
import { getCronSeverity } from "./cron-severity";
import { TriageSummary } from "./status-dashboard/triage-summary";

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
  const telegramDispatch = data?.crons["dispatch-telegram-alerts"]?.lastRun ?? null;
  const telegramDispatchMeta = parseTelegramDispatchCronMetadata(telegramDispatch?.metadata);
  const telegramSignal =
    (data?.telegramBot?.pendingDeliveries ?? 0) > 0 ||
    Boolean(data?.sectionErrors.telegramBot) ||
    (telegramDispatch != null && telegramDispatch.status !== "ok") ||
    Boolean(telegramDispatchMeta?.cappedAtLimit) ||
    Boolean(telegramDispatchMeta?.pendingRateLimited) ||
    Boolean(telegramDispatchMeta?.safetyAlertsSuppressed);

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
  const statusEvaluatedAt = data.state.lastEvaluatedAt;
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
          reserveComposition={data.reserveComposition}
          historyWindow={historyWindow}
          setHistoryWindow={setHistoryWindow}
          historyLoading={historyLoading}
        />
      </SectionErrorBoundary>
    ),
  };

  return (
    <div className="space-y-6">
      <TriageSummary
        data={data}
        healthData={healthData}
        overallTone={overallTone}
        statusHoldingAge={statusHoldingAge}
        overallCauseCount={overallCauseCount}
        watchCauseCount={watchCauseCount}
        blockerCauses={blockerCauses}
        latestTransition={latestTransition}
        recommendedActions={recommendedActions}
        lastUpdated={lastUpdated}
        handleRefresh={handleRefresh}
        onSignOut={onSignOut}
      />

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
