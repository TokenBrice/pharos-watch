"use client";

import { useMemo, type ReactNode } from "react";
import { LongformScrollspyNav } from "@/components/longform-scrollspy-nav";
import { NoticeRail } from "@/components/status/page-primitives";
import { Button } from "@/components/ui/button";
import { useStatusDashboardModel } from "@/hooks/use-status-dashboard-model";
import { type DashboardSectionId, formatTimestampSeconds } from "@/lib/status-dashboard-model";
import { useAutoExpand } from "./use-auto-expand";
import { useReleaseMetadata } from "@/hooks/use-release-metadata";
import { SectionErrorBoundary } from "@/components/section-error-boundary";
import { PipelineSection } from "./sections/pipeline-section";
import { ReliabilitySection } from "./sections/reliability-section";
import { CronsSection } from "./sections/crons-section";
import { ActionsSection } from "./sections/actions-section";
import { CredentialsSection } from "./sections/credentials-section";
import { CommsSection } from "./sections/comms-section";
import { HistorySection } from "./sections/history-section";
import { getCronSeverity, sortCronGroupsBySeverity } from "./cron-severity";
import { TriageSummary } from "./status-dashboard/triage-summary";

export function StatusDashboard({ onSignOut }: { onSignOut: () => void }) {
  const {
    data,
    handleRefresh,
    healthData,
    historyLoading,
    historyWindow,
    initialLoadError,
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
  const releaseMetadataState = useReleaseMetadata();
  const diagnosticsSignal =
    data?.overallStatus !== "healthy" || (model?.notices.length ?? 0) > 0 || (model?.healthDiffersFromStatus ?? false);
  const reliabilitySignal =
    (healthData?.status ?? data?.availabilityStatus ?? "healthy") !== "healthy" ||
    (model?.browserProbeSummary?.failCount ?? 0) > 0 ||
    (data != null && data.summary.worstCacheRatio > 1);

  const [isDiagnosticsOpen, setIsDiagnosticsOpen] = useAutoExpand(diagnosticsSignal);
  const [isReliabilityOpen, setIsReliabilityOpen] = useAutoExpand(reliabilitySignal);
  const [isHealthyCronGroupsOpen, setIsHealthyCronGroupsOpen] = useAutoExpand(false);

  // model.cronGroups is rebuilt every render but is a pure derivation of
  // data.crons, so key the sort on data.crons: cron groups only need
  // re-sorting when the underlying cron data changes, not on every poll tick.
  const cronGroups = model?.cronGroups;
  const { activeCronGroups, healthyCronGroups } = useMemo(() => {
    const sorted = sortCronGroupsBySeverity(cronGroups ?? []);
    return {
      activeCronGroups: sorted.filter((group) => group.entries.some(([, cron]) => getCronSeverity(cron) > 0)),
      healthyCronGroups: sorted.filter((group) => group.entries.every(([, cron]) => getCronSeverity(cron) === 0)),
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- cronGroups is a pure derivation of data?.crons
  }, [data?.crons]);

  if (isLoading) {
    return (
      <div className="py-20 text-center">
        <div className="text-muted-foreground">Loading status...</div>
      </div>
    );
  }

  if (initialLoadError) {
    return (
      <div className="py-20 text-center">
        <div className="text-red-600 dark:text-red-400">{initialLoadError.message}</div>
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
    browserProbeSummary,
    clientDataAgeSec,
    clientDataStale,
    decision,
    evidence,
    issueGroups,
    latestTransition,
    notices,
    overallTone,
    querySyncs,
    recommendedActions,
    runningCrons,
    sections,
    statusHoldingAge,
  } = model;
  const statusEvaluatedAt = data.state.lastEvaluatedAt;

  const sectionNodes: Partial<Record<DashboardSectionId, ReactNode>> = {
    pipeline: (
      <SectionErrorBoundary name="pipeline">
        <PipelineSection data={data} handleRefresh={handleRefresh} />
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
          healthData={healthData}
          clientDataStale={clientDataStale}
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
          releaseMetadataState={releaseMetadataState}
          nowSeconds={data.timestamp}
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
        issueGroups={issueGroups}
        evidence={evidence}
        decision={decision}
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
