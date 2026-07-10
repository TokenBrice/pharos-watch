"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import type { ApiRequestAttributionResponse, EndpointProbeResult, HealthResponse, StatusResponse } from "@shared/types";
import { ApiKeyLoadTable } from "@/components/status/api-key-load-table";
import { CacheFreshnessTable } from "@/components/status/cache-freshness-table";
import { SummaryBadge } from "@/components/status/page-primitives";
import { ReliabilityDependenciesPanel } from "@/components/status/reliability-dependencies-panel";
import { ReliabilityEndpointsPanel } from "@/components/status/reliability-endpoints-panel";
import { ReliabilityEvidenceSummary } from "@/components/status/reliability-evidence-summary";
import { ReliabilityImpactPanel } from "@/components/status/reliability-impact-panel";
import {
  getReliabilityPanelId,
  getReliabilityTabId,
  ReliabilityModeTabs,
} from "@/components/status/reliability-mode-tabs";
import { RequestSourceAttributionCard } from "@/components/status/request-source-attribution-card";
import {
  buildReliabilityModeUrl,
  buildReliabilityWorkspaceModel,
  deriveInitialReliabilityMode,
  parseReliabilityMode,
  type ReliabilityMode,
} from "@/lib/reliability-workspace-model";
import { getStatusTone, type BrowserProbeSummary } from "@/lib/status-dashboard-model";

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
  const [activeMode, setActiveMode] = useState<ReliabilityMode>(defaultMode);

  useEffect(() => {
    const syncModeFromUrl = () => {
      const urlMode = parseReliabilityMode(window.location.search);
      if (urlMode) {
        setActiveMode(urlMode);
        return;
      }
      window.history.replaceState(window.history.state, "", buildReliabilityModeUrl(window.location, defaultMode));
      setActiveMode(defaultMode);
    };

    syncModeFromUrl();
    window.addEventListener("popstate", syncModeFromUrl);
    return () => window.removeEventListener("popstate", syncModeFromUrl);
  }, [defaultMode]);

  const selectMode = useCallback((mode: ReliabilityMode) => {
    setActiveMode(mode);
    window.history.replaceState(window.history.state, "", buildReliabilityModeUrl(window.location, mode));
  }, []);

  const renderActiveMode = () => {
    switch (activeMode) {
      case "impact":
        return (
          <ReliabilityImpactPanel
            data={data}
            healthData={healthData}
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
              <div className="rounded-md border border-amber-500/40 bg-amber-500/[0.06] px-3 py-2.5 text-sm text-amber-950 dark:text-amber-100">
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

  const publicTone = healthData ? getStatusTone(healthData.status) : null;

  return (
    <section
      id="reliability"
      aria-labelledby="reliability-title"
      className="space-y-5 scroll-mt-[var(--ops-sticky-offset)]"
    >
      <div className="flex flex-col gap-3 border-b border-border/70 pb-4 lg:flex-row lg:items-start lg:justify-between">
        <div className="space-y-1">
          <p className="pharos-kicker">Service Health</p>
          <h1 id="reliability-title" className="text-2xl font-bold leading-tight text-foreground">
            Reliability Workbench
          </h1>
          <p className="max-w-3xl text-sm leading-relaxed text-muted-foreground">
            Public impact, endpoint planes, dependency root causes, demand, and cache freshness in focused views.
          </p>
        </div>
        <div className="flex flex-wrap gap-2 lg:justify-end">
          <SummaryBadge
            label="Public health"
            value={healthData?.status ?? "Unknown"}
            className={publicTone?.badgeClassName}
          />
          <SummaryBadge label="Evidence gaps" value={String(model.evidenceGaps.length)} />
          <SummaryBadge
            label="Selected view"
            value={model.modeSummaries.find((mode) => mode.id === activeMode)?.label ?? "Impact"}
          />
        </div>
      </div>

      <ReliabilityEvidenceSummary gaps={model.evidenceGaps} />
      <ReliabilityModeTabs activeMode={activeMode} modes={model.modeSummaries} onModeChange={selectMode} />
      <p role="status" aria-live="polite" aria-atomic="true" className="sr-only">
        Reliability view: {model.modeSummaries.find((mode) => mode.id === activeMode)?.label ?? "Impact"}
      </p>
      <div
        id={getReliabilityPanelId(activeMode)}
        role="tabpanel"
        aria-labelledby={getReliabilityTabId(activeMode)}
        tabIndex={0}
        className="min-w-0"
      >
        <h2 className="sr-only">
          {model.modeSummaries.find((mode) => mode.id === activeMode)?.label ?? "Impact"} reliability view
        </h2>
        {renderActiveMode()}
      </div>
    </section>
  );
}
