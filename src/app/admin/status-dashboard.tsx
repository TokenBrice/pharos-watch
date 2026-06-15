"use client";

import type { ReactNode } from "react";
import { LongformScrollspyNav } from "@/components/longform-scrollspy-nav";
import { NoticeRail } from "@/components/status/page-primitives";
import { Button } from "@/components/ui/button";
import { useStatusDashboardModel } from "@/hooks/use-status-dashboard-model";
import {
  type DashboardSectionId,
  formatTimestampSeconds,
} from "@/lib/status-dashboard-model";
import { useAutoExpand } from "./use-auto-expand";
import { SectionErrorBoundary } from "@/components/section-error-boundary";
import { PipelineSection } from "./sections/pipeline-section";
import { ReliabilitySection } from "./sections/reliability-section";
import { CronsSection, type CronGroup } from "./sections/crons-section";
import { ActionsSection } from "./sections/actions-section";
import { CredentialsSection } from "./sections/credentials-section";
import { CommsSection } from "./sections/comms-section";
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
    (data != null && data.summary.worstCacheRatio > 1);

  const [isDiagnosticsOpen, setIsDiagnosticsOpen] = useAutoExpand(diagnosticsSignal);
  const [isReliabilityOpen, setIsReliabilityOpen] = useAutoExpand(reliabilitySignal);
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
    attentionSections,
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

  const sectionNodes: Partial<Record<DashboardSectionId, ReactNode>> = {
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
    actions: (
      <SectionErrorBoundary name="actions">
        <ActionsSection
          data={data}
          handleRefresh={handleRefresh}
          recommendedActions={recommendedActions}
        />
      </SectionErrorBoundary>
    ),
    credentials: (
      <SectionErrorBoundary name="credentials">
        <CredentialsSection />
      </SectionErrorBoundary>
    ),
    comms: (
      <SectionErrorBoundary name="comms">
        <CommsSection data={data} />
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
        attentionSections={attentionSections}
        recommendedActions={recommendedActions}
        isDiagnosticsOpen={isDiagnosticsOpen}
        setIsDiagnosticsOpen={setIsDiagnosticsOpen}
        browserProbeSummary={browserProbeSummary}
        querySyncs={querySyncs}
        clientDataAgeSec={clientDataAgeSec}
        clientDataStale={clientDataStale}
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
      {sections
        .filter((section) => section.id !== "overview")
        .map((section) => (
          <div key={section.id}>{sectionNodes[section.id]}</div>
        ))}
    </div>
  );
}
