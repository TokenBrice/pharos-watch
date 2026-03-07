"use client";

import { useCallback, useEffect, useState } from "react";
import { FeaturePageShell } from "@/components/feature-page-shell";
import { Button } from "@/components/ui/button";
import { useEndpointProbes } from "@/hooks/use-endpoint-probes";
import { useHealth } from "@/hooks/use-health";
import { useStatus } from "@/hooks/use-status";
import { AdminActionsPanel } from "@/components/status/admin-actions-panel";
import { AdminKeyForm } from "@/components/status/admin-key-form";
import { CacheFreshnessTable } from "@/components/status/cache-freshness-table";
import { CircuitBreakerTable } from "@/components/status/circuit-breaker-table";
import { CronCard } from "@/components/status/cron-card";
import { DataQualityCards } from "@/components/status/data-quality-cards";
import { EndpointHealthGrid } from "@/components/status/endpoint-health-grid";
import { RefreshCountdown } from "@/components/status/refresh-countdown";
import { StatusBanner } from "@/components/status/status-banner";
import { SystemDiagnostics } from "@/components/status/system-diagnostics";
import { TransitionTimeline } from "@/components/status/transition-timeline";

const SESSION_KEY = "pharos-admin-key";

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
  const [nowMs, setNowMs] = useState(() => Date.now());

  const lastUpdated = Math.max(statusUpdatedAt ?? 0, healthUpdatedAt ?? 0, probesUpdatedAt ?? 0);
  const clientDataAgeSec = Math.max(0, Math.floor((nowMs - lastUpdated) / 1000));
  const clientDataStale = lastUpdated > 0 && clientDataAgeSec > 120;

  useEffect(() => {
    const id = setInterval(() => setNowMs(Date.now()), 5000);
    return () => clearInterval(id);
  }, []);

  const handleRefresh = useCallback(() => {
    refetchStatus();
    refetchHealth();
    refetchProbes();
  }, [refetchStatus, refetchHealth, refetchProbes]);

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

      <section>
        <h2 className="mb-3 text-xl font-semibold">Status Diagnostics</h2>
        <SystemDiagnostics
          state={data.state}
          staleness={data.staleness}
          probe={data.probe}
          discrepancy={data.discrepancy}
          nowSeconds={data.timestamp}
        />
      </section>

      <section>
        <h2 className="mb-3 text-xl font-semibold">Endpoint Health</h2>
        <EndpointHealthGrid probes={probes} isLoading={probesLoading} />
      </section>

      <section>
        <h2 className="mb-3 text-xl font-semibold">Circuit Breakers</h2>
        <CircuitBreakerTable circuits={healthData?.circuits} />
      </section>

      <section>
        <h2 className="mb-3 text-xl font-semibold">Admin Actions</h2>
        <AdminActionsPanel adminKey={adminKey} />
      </section>

      <section>
        <h2 className="mb-3 text-xl font-semibold">Cron Jobs</h2>
        <div className="grid gap-4 md:grid-cols-2">
          {Object.entries(data.crons).map(([job, cron]) => (
            <CronCard key={job} job={job} cron={cron} nowSeconds={data.timestamp} />
          ))}
        </div>
      </section>

      <section>
        <h2 className="mb-3 text-xl font-semibold">Data Quality</h2>
        <DataQualityCards dq={data.dataQuality} />
      </section>

      <section>
        <h2 className="mb-3 text-xl font-semibold">Incident Timeline</h2>
        <TransitionTimeline transitions={data.timeline} />
      </section>

      <CacheFreshnessTable caches={data.caches} />
    </div>
  );
}
