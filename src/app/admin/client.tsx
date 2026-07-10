"use client";

import { NoticeRail } from "@/components/status/page-primitives";
import { useCriticalOpsModel } from "@/hooks/use-critical-ops-model";
import { TriageSummary } from "./status-dashboard/triage-summary";
import { useAutoExpand } from "./use-auto-expand";
import { WorkspaceStatusBoundary } from "./workspace-status-boundary";

export default function TriageClient() {
  const { data, handleRefresh, healthData, initialLoadError, isLoading, lastUpdated, model } = useCriticalOpsModel();
  const diagnosticsSignal =
    data?.overallStatus !== "healthy" || (model?.notices.length ?? 0) > 0 || (model?.healthDiffersFromStatus ?? false);
  const [isDiagnosticsOpen, setIsDiagnosticsOpen] = useAutoExpand(diagnosticsSignal);

  return (
    <WorkspaceStatusBoundary data={data} error={initialLoadError} isLoading={isLoading} onRetry={handleRefresh}>
      {(status) => {
        if (!model) return null;

        return (
          <div className="space-y-4">
            <TriageSummary
              data={status}
              healthData={healthData}
              overallTone={model.overallTone}
              statusHoldingAge={model.statusHoldingAge}
              issueGroups={model.issueGroups}
              evidence={model.evidence}
              decision={model.decision}
              latestTransition={model.latestTransition}
              attentionSections={model.attentionSections}
              recommendedActions={model.recommendedActions}
              isDiagnosticsOpen={isDiagnosticsOpen}
              setIsDiagnosticsOpen={setIsDiagnosticsOpen}
              browserProbeSummary={model.browserProbeSummary}
              probeCoverageLabel="Critical Browser Probes"
              querySyncs={model.querySyncs}
              clientDataAgeSec={model.clientDataAgeSec}
              clientDataStale={model.clientDataStale}
              lastUpdated={lastUpdated}
              handleRefresh={handleRefresh}
              showSignOut={false}
            />
            <NoticeRail notices={model.notices} />
          </div>
        );
      }}
    </WorkspaceStatusBoundary>
  );
}
