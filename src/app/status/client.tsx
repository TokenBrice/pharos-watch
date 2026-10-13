"use client";

import { useEffect, useMemo, useState, type ReactNode } from "react";
import type { PublicStatusHistoryWindow } from "@shared/types";
import { FeaturePageShell } from "@/components/feature-page-shell";
import { FaqSection } from "@/components/faq-section";
import { Button } from "@/components/ui/button";
import {
  PublicServiceSummarySection,
  type PublicHistoryLoadState,
} from "@/components/status/public-service-summary-section";
import { PublicStatusHistorySection } from "@/components/status/public-status-history-section";
import { PublicStatusHero } from "@/components/status/public-status-hero";
import { PublicStatusReliabilitySection } from "@/components/status/public-status-reliability-section";
import { useHealth } from "@/hooks/api-hooks";
import { usePublicEndpointProbes } from "@/hooks/use-endpoint-probes";
import { usePublicStatusHistory } from "@/hooks/use-public-status-history";
import { buildBrowserProbeSummary } from "@/lib/status-dashboard-model";
import {
  getAcknowledgedPriceGapNotice,
  getPublicDivergenceNotice,
  resolvePublicProjection,
} from "@/lib/status/public-status";
import { buildComponentDayCells, getHeadlineSince } from "@/lib/status/public-status-timeline";
import type { FaqItem } from "@/lib/faq";
import { FRONTEND_API_QUERY_DESCRIPTORS } from "@/lib/api-query-descriptors";
import { getPollingWindow } from "@/lib/api-query-polling";

const HISTORY_WINDOW: PublicStatusHistoryWindow = "30d";
const HISTORY_DAYS = 30;
const HEALTH_FETCH_BUDGET_MS = getPollingWindow(FRONTEND_API_QUERY_DESCRIPTORS.health.producerIntervalMs).refetchInterval;
/** Re-evaluates "is the shown verdict older than its budget"; not a data poll. */
const STALENESS_CLOCK_MS = 60_000;
const STATUS_SHELL_PROPS = {
  breadcrumbName: "System Status",
  path: "/status/",
  title: "System Status",
  leadParagraphs: ["Current state of Pharos pages, the public API and each data feed, with 30 days of incident history."],
} as const;

export default function StatusClient({ faqItems }: { faqItems: readonly FaqItem[] }) {
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
  const { data: historyData, isLoading: historyLoading, error: historyError } = usePublicStatusHistory(HISTORY_WINDOW);
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNowMs(Date.now()), STALENESS_CLOCK_MS);
    return () => clearInterval(timer);
  }, []);

  const handleRefresh = () => {
    void refetchHealth();
    void refetchProbes();
  };

  const projection = useMemo(() => (healthData ? resolvePublicProjection(healthData) : null), [healthData]);
  // A failed history read never renders as a quiet history, even with retained data (R2).
  const historyState: PublicHistoryLoadState = historyError ? "error" : historyData ? "ready" : historyLoading ? "loading" : "error";
  const dayCells = useMemo(() => {
    if (!projection || !historyData || historyError) return null;
    return buildComponentDayCells({
      transitions: historyData.transitions,
      liveComponents: projection.components,
      publicHistoryStartedAt: historyData.publicHistoryStartedAt,
      nowSec: historyData.timestamp,
      days: HISTORY_DAYS,
      truncated: historyData.hasMore === true,
    });
  }, [historyData, historyError, projection]);

  let content: ReactNode;

  if (healthLoading && !healthData) {
    content = (
      <div className="space-y-6" aria-busy="true" aria-label="Loading status">
        <div className="h-[72px] animate-pulse rounded-xl bg-muted/30" />
        <div className="h-[420px] animate-pulse rounded-xl bg-muted/30" />
      </div>
    );
  } else if (!healthData || !projection) {
    content = (
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-state-danger bg-state-danger-subtle p-4 text-sm text-state-danger">
        <span title={healthError?.message}>The status check could not be reached.</span>
        <Button variant="outline" size="sm" className="min-h-11" onClick={handleRefresh}>
          Refresh
        </Button>
      </div>
    );
  } else {
    const probeSummary = buildBrowserProbeSummary(probes, probesUpdatedAt ?? 0);
    const divergence = probeSummary ? getPublicDivergenceNotice(healthData.status, probeSummary.status) : null;
    const fetchStale = healthUpdatedAt > 0 && nowMs - healthUpdatedAt > HEALTH_FETCH_BUDGET_MS;

    content = (
      <div className="space-y-6">
        <PublicStatusHero
          headline={projection.headline}
          since={getHeadlineSince(projection.components)}
          checkedAt={healthData.timestamp}
          fetchError={healthError}
          fetchStale={fetchStale}
          onRefresh={handleRefresh}
        />

        <PublicServiceSummarySection
          components={projection.components}
          dayCells={dayCells}
          historyState={historyState}
          historyDays={HISTORY_DAYS}
          nowSec={historyData?.timestamp ?? healthData.timestamp}
          publicHistoryStartedAt={historyData?.publicHistoryStartedAt ?? null}
          footnote={getAcknowledgedPriceGapNotice(healthData.activePriceCoverage)}
        />

        <PublicStatusHistorySection
          historyData={historyData}
          historyDays={HISTORY_DAYS}
          historyLoading={historyLoading}
          historyError={historyError}
          liveOperational={projection.headline.state === "operational"}
        />

        <PublicStatusReliabilitySection
          healthData={healthData}
          probes={probes}
          probesLoading={probesLoading}
          probesError={probesError}
          divergenceDetail={divergence && divergence.kind !== "in-sync" ? divergence.detail : null}
        />
      </div>
    );
  }

  return (
    <FeaturePageShell {...STATUS_SHELL_PROPS}>
      {content}
      <FaqSection items={faqItems} title="System Status FAQ" includeJsonLd />
    </FeaturePageShell>
  );
}
