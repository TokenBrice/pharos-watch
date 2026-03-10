"use client";

import { useCallback, useEffect, useState } from "react";
import type { EndpointProbeResult } from "@shared/types";
import { FeaturePageShell } from "@/components/feature-page-shell";
import { Button } from "@/components/ui/button";
import { useEndpointProbes } from "@/hooks/use-endpoint-probes";
import { useHealth } from "@/hooks/use-health";
import { useStatusHistory, type StatusHistoryWindow } from "@/hooks/use-status-history";
import { useStatus } from "@/hooks/use-status";
import { AdminActionsPanel } from "@/components/status/admin-actions-panel";
import { AdminKeyForm } from "@/components/status/admin-key-form";
import { CacheFreshnessTable } from "@/components/status/cache-freshness-table";
import { CircuitBreakerTable } from "@/components/status/circuit-breaker-table";
import { CronCard } from "@/components/status/cron-card";
import { DataQualityCards } from "@/components/status/data-quality-cards";
import { DatasetFreshnessTable } from "@/components/status/dataset-freshness-table";
import { EndpointHealthGrid } from "@/components/status/endpoint-health-grid";
import { RefreshCountdown } from "@/components/status/refresh-countdown";
import { StatusBanner } from "@/components/status/status-banner";
import { StatusFacts } from "@/components/status/status-facts";
import { SystemDiagnostics } from "@/components/status/system-diagnostics";
import { TelegramBotStats } from "@/components/status/telegram-bot-stats";
import { TransitionTimeline } from "@/components/status/transition-timeline";
import { getStatusCronDisplay, STATUS_CRON_GROUPS } from "@/components/status/cron-config";
import { DiscoveryCandidatesCard } from "@/components/status/discovery-candidates";
import { LiquidityHealthCard } from "@/components/status/liquidity-health";
import { MintBurnReconciliationCard } from "@/components/status/mint-burn-reconciliation";
import { PriceSourceHealthCard } from "@/components/status/price-source-health";

const SESSION_KEY = "pharos-admin-key";

function percentile(values: number[], p: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[index] ?? null;
}

function buildBrowserProbeSummary(
  probes: EndpointProbeResult[] | undefined,
  updatedAtMs: number,
) {
  if (!probes || probes.length === 0) return null;
  const passCount = probes.filter((probe) => probe.status != null && probe.status >= 200 && probe.status < 300).length;
  const latencies = probes.map((probe) => probe.latencyMs).filter((latency) => Number.isFinite(latency));

  return {
    sampleCount: probes.length,
    passCount,
    failCount: probes.length - passCount,
    p95LatencyMs: percentile(latencies, 95),
    updatedAt: updatedAtMs > 0 ? Math.floor(updatedAtMs / 1000) : null,
  };
}

export default function StatusClient() {
  const [adminKey, setAdminKey] = useState(() => {
    if (typeof window === "undefined") return "";
    return sessionStorage.getItem(SESSION_KEY) ?? "";
  });

  const handleKeySubmit = useCallback((key: string) => {
    sessionStorage.setItem(SESSION_KEY, key);
    setAdminKey(key);
  }, []);

  const handleSignOut = useCallback(() => {
    sessionStorage.removeItem(SESSION_KEY);
    setAdminKey("");
  }, []);

  if (!adminKey) {
    return (
      <FeaturePageShell
        breadcrumbName="System Status"
        path="/status/"
        title="System Status"
        variant="auth-gated"
        leadParagraphs={[
          "Private operator panel for monitoring pipeline health, endpoint reliability, and incident state transitions.",
        ]}
      >
        <AdminKeyForm onSubmit={handleKeySubmit} />
      </FeaturePageShell>
    );
  }

  return (
    <FeaturePageShell
      breadcrumbName="System Status"
      path="/status/"
      title="System Status"
      variant="auth-gated"
      leadParagraphs={[
        "Private operator panel for monitoring pipeline health, endpoint reliability, and incident state transitions.",
      ]}
    >
      <StatusDashboard adminKey={adminKey} onSignOut={handleSignOut} />
    </FeaturePageShell>
  );
}

function StatusDashboard({ adminKey, onSignOut }: { adminKey: string; onSignOut: () => void }) {
  const { data, isLoading, error, refetch: refetchStatus, dataUpdatedAt: statusUpdatedAt } = useStatus(adminKey);
  const { data: healthData, error: healthError, refetch: refetchHealth, dataUpdatedAt: healthUpdatedAt } = useHealth();
  const {
    data: probes,
    isLoading: probesLoading,
    error: probesError,
    refetch: refetchProbes,
    dataUpdatedAt: probesUpdatedAt,
  } = useEndpointProbes(adminKey);
  const [historyWindow, setHistoryWindow] = useState<StatusHistoryWindow>("24h");
  const {
    data: historyData,
    isLoading: historyLoading,
    error: historyError,
    refetch: refetchHistory,
  } = useStatusHistory(adminKey, historyWindow);
  const [nowMs, setNowMs] = useState(() => Date.now());

  const lastUpdated = Math.max(statusUpdatedAt ?? 0, healthUpdatedAt ?? 0, probesUpdatedAt ?? 0);
  const clientDataAgeSec = Math.max(0, Math.floor((nowMs - lastUpdated) / 1000));
  const clientDataStale = lastUpdated > 0 && clientDataAgeSec > 120;
  const browserProbeSummary = buildBrowserProbeSummary(probes, probesUpdatedAt ?? 0);

  useEffect(() => {
    const id = setInterval(() => setNowMs(Date.now()), 5000);
    return () => clearInterval(id);
  }, []);

  const handleRefresh = useCallback(() => {
    refetchStatus();
    refetchHealth();
    refetchProbes();
    refetchHistory();
  }, [refetchStatus, refetchHealth, refetchProbes, refetchHistory]);

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
          Try a different key
        </Button>
      </div>
    );
  }

  if (!data) return <div className="p-8 text-center text-muted-foreground">Loading status data...</div>;

  const cronEntries = Object.entries(data.crons);
  const cronGroups = STATUS_CRON_GROUPS.map((group) => ({
    ...group,
    entries: cronEntries.filter(([job]) => getStatusCronDisplay(job).group === group.key),
  })).filter((group) => group.entries.length > 0);
  const healthDiffersFromStatus = healthData != null && healthData.status !== data.overallStatus;
  const publicHealthNeedsCallout =
    healthData != null &&
    (healthData.status !== "healthy" || healthDiffersFromStatus || healthData.mintBurn.majorStaleCount > 0);
  const publicHealthTone = healthData?.status === "stale"
    ? "border-red-500/30 bg-red-500/10 text-red-700 dark:text-red-300"
    : healthData?.status === "degraded"
      ? "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300"
      : "border-border/60 bg-muted/30 text-muted-foreground";

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-end gap-3">
        <div className="flex items-center gap-3">
          <RefreshCountdown key={lastUpdated} onRefresh={handleRefresh} />
          <Button variant="outline" size="sm" onClick={onSignOut}>
            Sign out
          </Button>
        </div>
      </div>

      <StatusBanner
        status={data.overallStatus}
        timestamp={data.timestamp}
        availabilityStatus={data.availabilityStatus}
        dataQualityStatus={data.dataQualityStatus}
        rawStatus={data.rawOverallStatus}
        confidence={data.confidence}
      />

      {clientDataStale && (
        <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 text-sm text-amber-700 dark:text-amber-300">
          Status page data is stale on the client ({clientDataAgeSec}s since last refresh). Signals may be outdated.
        </div>
      )}
      {healthError && (
        <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-sm text-amber-700 dark:text-amber-300">
          Health endpoint unavailable: {healthError.message}
        </div>
      )}
      {probesError && (
        <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-sm text-amber-700 dark:text-amber-300">
          Endpoint probe checks unavailable: {probesError.message}
        </div>
      )}
      {historyError && (
        <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-sm text-amber-700 dark:text-amber-300">
          Status history unavailable: {historyError.message}
        </div>
      )}
      {publicHealthNeedsCallout && healthData && (
        <div className={`rounded-lg border px-4 py-3 text-sm ${publicHealthTone}`}>
          <div className="font-medium">
            Public <code>/api/health</code> reports {healthData.status}.
            {healthDiffersFromStatus ? ` This differs from /api/status (${data.overallStatus}).` : ""}
          </div>
          <div className="mt-1 text-xs">
            {healthData.mintBurn.majorStaleCount > 0
              ? `Mint/burn stale majors: ${healthData.mintBurn.staleMajorSymbols.join(", ")}. `
              : ""}
            {healthData.mintBurn.freshnessAgeSec != null
              ? `Latest mint/burn event age: ${healthData.mintBurn.freshnessAgeSec}s. `
              : ""}
            Blacklist gaps tracked by /api/health: {healthData.blacklist.missingAmounts}.
          </div>
        </div>
      )}

      <section>
        <h2 className="mb-3 text-xl font-semibold">Status Facts</h2>
        <StatusFacts
          adminKey={adminKey}
          dbHealthy={data.dbHealthy}
          summary={data.summary}
          causes={data.causes}
          onActionFinished={handleRefresh}
        />
      </section>

      <section>
        <h2 className="mb-3 text-xl font-semibold">Status Diagnostics</h2>
        <SystemDiagnostics
          state={data.state}
          staleness={data.staleness}
          probe={data.probe}
          discrepancy={data.discrepancy}
          browserProbe={browserProbeSummary}
          nowSeconds={data.timestamp}
        />
      </section>

      <section>
        <h2 className="mb-3 text-xl font-semibold">Browser Endpoint Probes</h2>
        <EndpointHealthGrid probes={probes} isLoading={probesLoading} />
      </section>

      <section>
        <h2 className="mb-3 text-xl font-semibold">Circuit Breakers</h2>
        <CircuitBreakerTable circuits={healthData?.circuits} />
      </section>

      <section>
        <h2 className="mb-3 text-xl font-semibold">Price Source Health</h2>
        <PriceSourceHealthCard
          health={data.priceSourceHealth}
          shadowComparison={data.shadowComparison}
          nowSeconds={data.timestamp}
        />
      </section>

      <section>
        <h2 className="mb-3 text-xl font-semibold">Liquidity Health</h2>
        <LiquidityHealthCard health={data.liquidityHealth} />
      </section>

      <section>
        <h2 className="mb-3 text-xl font-semibold">Mint/Burn Reconciliation</h2>
        <MintBurnReconciliationCard summary={data.mintBurnReconciliation} />
      </section>

      <section>
        <h2 className="mb-3 text-xl font-semibold">Admin Actions</h2>
        <AdminActionsPanel
          adminKey={adminKey}
          status={{ causes: data.causes, crons: data.crons }}
          nowSeconds={data.timestamp}
          onActionFinished={handleRefresh}
        />
      </section>

      <section>
        <h2 className="mb-3 text-xl font-semibold">Coverage Discovery</h2>
        <DiscoveryCandidatesCard candidates={data.discoveryCandidates} adminKey={adminKey} nowSeconds={data.timestamp} />
      </section>

      <section>
        <h2 className="mb-3 text-xl font-semibold">Telegram Bot</h2>
        <TelegramBotStats
          telegramBot={data.telegramBot}
          dispatchCron={data.crons["dispatch-telegram-alerts"]}
          nowSeconds={data.timestamp}
        />
      </section>

      <section>
        <h2 className="mb-3 text-xl font-semibold">Cron Jobs</h2>
        <div className="space-y-6">
          {cronGroups.map((group) => (
            <div key={group.key} className="space-y-3">
              <div className="space-y-1">
                <div className="flex flex-wrap items-center gap-2">
                  <h3 className="text-base font-semibold">{group.title}</h3>
                  <span className="rounded-full border border-border/70 px-2 py-0.5 text-[11px] font-medium text-muted-foreground">
                    {group.badge}
                  </span>
                </div>
                <p className="text-sm text-muted-foreground">{group.description}</p>
              </div>
              <div className="grid gap-4 md:grid-cols-2">
                {group.entries.map(([job, cron]) => (
                  <CronCard key={job} job={job} cron={cron} nowSeconds={data.timestamp} />
                ))}
              </div>
            </div>
          ))}
        </div>
      </section>

      <section>
        <h2 className="mb-3 text-xl font-semibold">Data Quality</h2>
        <DataQualityCards dq={{ ...data.dataQuality, nowSeconds: data.timestamp }} />
      </section>

      <DatasetFreshnessTable datasetFreshness={data.datasetFreshness} nowSeconds={data.timestamp} />

      <section>
        <h2 className="mb-3 text-xl font-semibold">Incident Timeline</h2>
        <TransitionTimeline
          transitions={historyData?.transitions ?? data.timeline}
          window={historyWindow}
          onWindowChange={setHistoryWindow}
          isLoading={historyLoading}
        />
      </section>

      <CacheFreshnessTable caches={data.caches} />
    </div>
  );
}
