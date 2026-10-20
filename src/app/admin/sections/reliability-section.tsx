"use client";

import { useMemo } from "react";
import type { ApiRequestAttributionResponse } from "@pharos/contracts/request-source";
import type { EndpointProbeResult, HealthResponse, StatusResponse } from "@shared/types";
import { ApiKeyLoadTable } from "@/components/status/api-key-load-table";
import { CacheFreshnessTable } from "@/components/status/cache-freshness-table";
import { StatusSection, SummaryBadge } from "@/components/status/page-primitives";
import { ReliabilityDependenciesPanel } from "@/components/status/reliability-dependencies-panel";
import { ReliabilityEndpointsPanel } from "@/components/status/reliability-endpoints-panel";
import { ReliabilityEvidenceSummary } from "@/components/status/reliability-evidence-summary";
import { ReliabilityImpactPanel } from "@/components/status/reliability-impact-panel";
import { RequestSourceAttributionCard } from "@/components/status/request-source-attribution-card";
import { createWorkspaceModeIds, WorkspaceModeTabs } from "@/components/status/workspace-mode-tabs";
import { useWorkspaceMode } from "@/hooks/use-workspace-mode";
import { buildReliabilityWorkspaceModel } from "@/lib/reliability-workspace-issue-builder";
import {
  deriveInitialReliabilityMode,
  RELIABILITY_MODES,
} from "@/lib/reliability-workspace-model";
import type { BrowserProbeSummary } from "@/lib/status-dashboard-model";
import { describePublicHeadline } from "@/lib/status/public-status";
import { PUBLIC_HEADLINE_TONE } from "@shared/lib/classification";

export interface ReliabilitySectionProps {
  data: StatusResponse;
  healthData: HealthResponse | null | undefined;
  healthError?: string | null;
  healthLoading: boolean;
  requestSourceStats: ApiRequestAttributionResponse | null | undefined;
  requestSourceError?: string | null;
  requestSourceLoading: boolean;
  browserProbeSummary: BrowserProbeSummary | null;
  probes: EndpointProbeResult[] | undefined;
  probesError?: string | null;
  probesLoading: boolean;
}

const RELIABILITY_MODE_IDS = createWorkspaceModeIds("reliability");

export function ReliabilitySection({
  data,
  healthData,
  healthError,
  healthLoading,
  requestSourceStats,
  requestSourceError,
  requestSourceLoading,
  browserProbeSummary,
  probes,
  probesError,
  probesLoading,
}: ReliabilitySectionProps) {
  const model = useMemo(
    () =>
      buildReliabilityWorkspaceModel({
        data,
        healthData,
        healthError,
        healthLoading,
        probes,
        probesError,
        probesLoading,
        browserProbeSummary,
        requestSourceStats,
        requestSourceError,
        requestSourceLoading,
      }),
    [
      browserProbeSummary,
      data,
      healthData,
      healthError,
      healthLoading,
      probes,
      probesError,
      probesLoading,
      requestSourceError,
      requestSourceLoading,
      requestSourceStats,
    ],
  );
  const defaultMode = useMemo(() => deriveInitialReliabilityMode(model), [model]);
  const { activeMode, selectMode } = useWorkspaceMode({ modes: RELIABILITY_MODES, defaultMode });

  const renderActiveMode = () => {
    switch (activeMode) {
      case "impact":
        return (
          <ReliabilityImpactPanel
            data={data}
            healthData={healthData}
            healthLoadFailed={Boolean(healthError)}
            issues={model.issues.filter((issue) => issue.mode === "impact")}
          />
        );
      case "endpoints":
        return <ReliabilityEndpointsPanel model={model.endpoints} />;
      case "dependencies":
        return <ReliabilityDependenciesPanel model={model.dependencies} />;
      case "demand":
        return (
          <div className="space-y-5">
            <div className="max-w-3xl">
              <h3 className="text-base font-semibold text-foreground">Demand attribution</h3>
              <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
                Request mix is diagnostic context, not a primary availability signal. Use it after impact, endpoint, and
                dependency evidence identifies a likely service problem.
              </p>
            </div>
            <RequestSourceAttributionCard
              stats={requestSourceStats}
              error={requestSourceError}
              isLoading={requestSourceLoading}
            />
            <ApiKeyLoadTable stats={requestSourceStats} error={requestSourceError} isLoading={requestSourceLoading} />
          </div>
        );
      case "cache":
        return (
          <div className="space-y-4">
            {model.cacheUnknownCount > 0 ? (
              <div className="rounded-md border border-state-warn-solid/40 bg-state-warn-solid/[0.06] px-3 py-2.5 text-sm text-state-warn-ink">
                {model.cacheUnknownCount} cache {model.cacheUnknownCount === 1 ? "row has" : "rows have"} missing age or
                budget evidence and remains Unknown.
              </div>
            ) : null}
            {Object.keys(data.caches).length > 0 ? (
              <CacheFreshnessTable caches={data.caches} />
            ) : (
              <div className="border-y border-border/60 py-4 text-sm text-muted-foreground">
                Cache freshness inventory is Unknown.
              </div>
            )}
          </div>
        );
    }
  };

  const publicHeadline = describePublicHeadline(healthData, Boolean(healthError));

  return (
    <StatusSection
      id="reliability"
      kicker="Service health"
      title="Reliability"
      headingLevel="h1"
      variant="workspace"
      description="Public impact, endpoint planes, dependency root causes, demand, and cache freshness in focused views."
      summary={
        <>
          <SummaryBadge
            label="Public status"
            value={publicHeadline.label}
            className={
              publicHeadline.state && publicHeadline.state !== "operational"
                ? PUBLIC_HEADLINE_TONE[publicHeadline.state].pill
                : undefined
            }
          />
          <SummaryBadge label="Evidence gaps" value={String(model.evidenceGaps.length)} />
        </>
      }
    >
      <ReliabilityEvidenceSummary gaps={model.evidenceGaps} />
      <WorkspaceModeTabs
        activeMode={activeMode}
        modes={model.modeSummaries}
        onModeChange={selectMode}
        ariaLabel="Reliability views"
        tabClassName="min-w-[7.5rem]"
        {...RELIABILITY_MODE_IDS}
      />
      <p role="status" aria-live="polite" aria-atomic="true" className="sr-only">
        Reliability view: {model.modeSummaries.find((mode) => mode.id === activeMode)?.label ?? "Impact"}
      </p>
      <div
        id={RELIABILITY_MODE_IDS.getPanelId(activeMode)}
        role="tabpanel"
        aria-labelledby={RELIABILITY_MODE_IDS.getTabId(activeMode)}
        tabIndex={0}
        className="min-w-0"
      >
        <h2 className="sr-only">
          {model.modeSummaries.find((mode) => mode.id === activeMode)?.label ?? "Impact"} reliability view
        </h2>
        {renderActiveMode()}
      </div>
    </StatusSection>
  );
}
