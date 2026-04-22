"use client";

import { useMemo, useState, type ReactNode } from "react";
import type { PublicStatusHistoryWindow } from "@shared/types";
import { isPublicImpactCircuitKey } from "@shared/lib/public-health";
import { FeaturePageShell } from "@/components/feature-page-shell";
import { PublicServiceSummarySection } from "@/components/status/public-service-summary-section";
import { PublicStatusHistorySection } from "@/components/status/public-status-history-section";
import { PublicStatusHero } from "@/components/status/public-status-hero";
import { PublicStatusReliabilitySection } from "@/components/status/public-status-reliability-section";
import { UptimeBar } from "@/components/status/uptime-bar";
import { NoticeRail } from "@/components/status/page-primitives";
import { useHealth } from "@/hooks/api-hooks";
import { usePublicEndpointProbes } from "@/hooks/use-endpoint-probes";
import { usePublicStatusHistory } from "@/hooks/use-public-status-history";
import { buildBrowserProbeSummary, type DashboardNotice } from "@/lib/status-dashboard-model";
import {
  getPublicDivergenceNotice,
  getPublicWorstCacheSummary,
} from "@/lib/status/public-status";

const RUNWAY_WINDOW: PublicStatusHistoryWindow = "30d";
const STATUS_SHELL_PROPS = {
  breadcrumbName: "System Status",
  path: "/status/",
  title: "System Status",
  leadParagraphs: [
    "Live public telemetry for route freshness, browser reachability, and ingestion drift.",
  ],
} as const;

export default function StatusClient() {
  const [historyWindow, setHistoryWindow] = useState<PublicStatusHistoryWindow>("7d");
  const {
    data: healthData,
    error: healthError,
    isLoading: healthLoading,
    refetch: refetchHealth,
    dataUpdatedAt: healthUpdatedAt,
  } = useHealth();
  const {
    data: probes,
    error: probesError,
    isLoading: probesLoading,
    refetch: refetchProbes,
    dataUpdatedAt: probesUpdatedAt,
  } = usePublicEndpointProbes();
  const { data: runwayHistoryData } = usePublicStatusHistory(RUNWAY_WINDOW);
  const { data: historyData, isLoading: historyLoading } = usePublicStatusHistory(historyWindow);

  const handleRefresh = () => {
    void refetchHealth();
    void refetchProbes();
  };

  const syncFloorCandidates = [healthUpdatedAt ?? 0, probesUpdatedAt ?? 0].filter((value) => value > 0);
  const lastUpdated = syncFloorCandidates.length > 0 ? Math.min(...syncFloorCandidates) : 0;
  const notices = useMemo(() => {
    if (!healthData) return [];

    const items: DashboardNotice[] = healthData.warnings.map((warning, index) => ({
      id: `health-warning-${index}`,
      title: "Health warning",
      detail: warning,
      tone: healthData.status === "stale" ? "critical" : "warning",
    }));

    if (healthError) {
      items.unshift({
        id: "health-fetch-error",
        title: "Health response is stale",
        detail: healthError.message,
        tone: "warning",
      });
    }

    if (probesError) {
      items.push({
        id: "public-probe-error",
        title: "Public endpoint probes unavailable",
        detail: probesError.message,
        tone: "warning",
      });
    }

    return items;
  }, [healthData, healthError, probesError]);

  let content: ReactNode;

  if (healthLoading && !healthData) {
    content = (
      <div className="space-y-6">
        <div className="rounded-2xl bg-muted/30 animate-pulse h-[200px]" />
        <div className="rounded-xl bg-muted/30 animate-pulse h-[60px]" />
        <div className="grid gap-6 lg:grid-cols-2">
          <div className="rounded-xl bg-muted/30 animate-pulse h-[300px]" />
          <div className="rounded-xl bg-muted/30 animate-pulse h-[300px]" />
        </div>
      </div>
    );
  } else if (healthError && !healthData) {
    content = (
      <div className="rounded-[1.6rem] border border-red-500/30 bg-red-500/10 p-6 text-red-700 shadow-[0_18px_48px_oklch(0_0_0_/0.16)] dark:text-red-300">
        Failed to load public status data: {healthError.message}
      </div>
    );
  } else if (!healthData) {
    content = <div className="py-20 text-center text-muted-foreground">Public health data is unavailable.</div>;
  } else {
    const worstCache = getPublicWorstCacheSummary(healthData.caches);
    const probeSummary = buildBrowserProbeSummary(probes, probesUpdatedAt ?? 0);
    const publicImpactCircuits = Object.entries(healthData.circuits)
      .filter(([key]) => isPublicImpactCircuitKey(key))
      .map(([, circuit]) => circuit);
    const openCircuits = publicImpactCircuits.filter((circuit) => circuit.state === "open").length;
    const halfOpenCircuits = publicImpactCircuits.filter((circuit) => circuit.state === "half-open").length;
    const divergence = probeSummary
      ? getPublicDivergenceNotice(healthData.status, probeSummary.status)
      : { kind: "in-sync" as const };

    content = (
      <div className="space-y-6">
        <PublicStatusHero
          healthData={healthData}
          lastUpdated={lastUpdated}
          probeSummary={probeSummary}
          worstCacheRatio={worstCache.ratio}
          worstCacheStatus={worstCache.status}
          impactedCacheLanes={worstCache.impactedCount}
          openCircuits={openCircuits}
          halfOpenCircuits={halfOpenCircuits}
          onRefresh={handleRefresh}
        />

        <UptimeBar
          transitions={runwayHistoryData?.transitions ?? []}
          currentStatus={runwayHistoryData?.currentStatus ?? healthData.status}
          lastChangedAt={runwayHistoryData?.lastChangedAt ?? null}
        />

        <NoticeRail notices={notices} />

        {divergence.kind !== "in-sync" && (
          <div className="rounded-xl border border-amber-500/30 bg-amber-500/10 p-4 text-sm text-amber-900 dark:text-amber-200">
            {divergence.detail}
          </div>
        )}

        <PublicServiceSummarySection healthData={healthData} />

        <PublicStatusReliabilitySection
          healthData={healthData}
          probes={probes}
          probesLoading={probesLoading}
          probeSummary={probeSummary}
        />

        <PublicStatusHistorySection
          historyData={historyData}
          historyWindow={historyWindow}
          historyLoading={historyLoading}
          onHistoryWindowChange={setHistoryWindow}
        />
      </div>
    );
  }

  return (
    <FeaturePageShell {...STATUS_SHELL_PROPS}>
      {content}
    </FeaturePageShell>
  );
}
