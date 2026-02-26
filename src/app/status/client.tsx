"use client";

import { useState, useEffect, useCallback, type FormEvent } from "react";
import { useStatus } from "@/hooks/use-status";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

// --- Status Banner ---

const STATUS_CONFIG = {
  healthy: { label: "Healthy", bg: "bg-green-500/15", text: "text-green-700 dark:text-green-400", border: "border-green-500/30" },
  degraded: { label: "Degraded", bg: "bg-amber-500/15", text: "text-amber-700 dark:text-amber-400", border: "border-amber-500/30" },
  stale: { label: "Stale", bg: "bg-red-500/15", text: "text-red-700 dark:text-red-400", border: "border-red-500/30" },
} as const;

function StatusBanner({ status, timestamp }: { status: "healthy" | "degraded" | "stale"; timestamp: number }) {
  const config = STATUS_CONFIG[status];
  const time = new Date(timestamp * 1000).toLocaleString();
  return (
    <div className={`rounded-lg border p-4 ${config.bg} ${config.border}`}>
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className={`h-3 w-3 rounded-full ${status === "healthy" ? "bg-green-500" : status === "degraded" ? "bg-amber-500" : "bg-red-500"}`} />
          <span className={`text-lg font-semibold ${config.text}`}>{config.label}</span>
        </div>
        <span className="text-sm text-muted-foreground">Checked: {time}</span>
      </div>
    </div>
  );
}

// --- Cron Card ---

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function formatAge(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m`;
  return `${Math.floor(seconds / 86400)}d`;
}

function formatInterval(seconds: number): string {
  if (seconds < 3600) return `${seconds / 60}min`;
  return `${seconds / 3600}h`;
}

function CronCard({ job, cron }: {
  job: string;
  cron: {
    lastRun: { startedAt: number; durationMs: number; status: string; error?: string; itemCount?: number } | null;
    recentRuns: Array<{ startedAt: number; durationMs: number; status: string; error?: string }>;
    expectedIntervalSec: number;
    healthy: boolean;
  };
}) {
  const now = Math.floor(Date.now() / 1000);
  const borderColor = cron.healthy ? "border-green-500/30" : "border-red-500/30";

  return (
    <Card className={`border-2 ${borderColor}`}>
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between">
          <CardTitle className="text-sm font-mono">{job}</CardTitle>
          <span className="text-xs text-muted-foreground">every {formatInterval(cron.expectedIntervalSec)}</span>
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        {cron.lastRun ? (
          <div className="space-y-1">
            <div className="flex items-center gap-2 text-sm">
              <Badge variant={cron.lastRun.status === "ok" ? "secondary" : "destructive"} className="text-xs">
                {cron.lastRun.status}
              </Badge>
              <span className="text-muted-foreground">{formatAge(now - cron.lastRun.startedAt)} ago</span>
              <span className="text-muted-foreground">({formatDuration(cron.lastRun.durationMs)})</span>
              {cron.lastRun.itemCount != null && (
                <span className="text-muted-foreground">{cron.lastRun.itemCount} items</span>
              )}
            </div>
            {cron.lastRun.error && (
              <details className="text-xs">
                <summary className="cursor-pointer text-red-600 dark:text-red-400">Error details</summary>
                <pre className="mt-1 max-h-24 overflow-auto rounded bg-muted p-2 text-xs">{cron.lastRun.error}</pre>
              </details>
            )}
          </div>
        ) : (
          <span className="text-sm text-muted-foreground">No runs recorded</span>
        )}

        {/* Recent runs dot row */}
        <div className="flex items-center gap-1">
          <span className="text-xs text-muted-foreground mr-1">History:</span>
          {cron.recentRuns.map((run, i) => (
            <div
              key={i}
              className={`h-2.5 w-2.5 rounded-full ${run.status === "ok" ? "bg-green-500" : "bg-red-500"}`}
              title={`${run.status} — ${new Date(run.startedAt * 1000).toLocaleString()} (${formatDuration(run.durationMs)})`}
            />
          ))}
          {cron.recentRuns.length === 0 && <span className="text-xs text-muted-foreground">none</span>}
        </div>
      </CardContent>
    </Card>
  );
}

// --- Data Quality Cards ---

function DataQualityCards({ dq }: {
  dq: {
    totalStablecoins: number;
    missingPrices: number;
    blacklistMissingAmounts: number;
    blacklistTotal: number;
    onchainSupplyDivergences: number;
    activeDepegs: number;
    staleOnchainSupply: number;
  };
}) {
  type Severity = "green" | "amber" | "red";
  const cards: Array<{ label: string; value: number; detail: string; severity: Severity }> = [
    {
      label: "Missing Prices",
      value: dq.missingPrices,
      detail: `/ ${dq.totalStablecoins} coins`,
      severity: dq.missingPrices > 5 ? "red" : dq.missingPrices > 0 ? "amber" : "green",
    },
    {
      label: "Blacklist Gaps",
      value: dq.blacklistMissingAmounts,
      detail: `/ ${dq.blacklistTotal.toLocaleString()} events`,
      severity: dq.blacklistMissingAmounts > 50 ? "red" : dq.blacklistMissingAmounts > 0 ? "amber" : "green",
    },
    {
      label: "On-chain Divergences",
      value: dq.onchainSupplyDivergences,
      detail: "coins >5% off",
      severity: dq.onchainSupplyDivergences > 3 ? "red" : dq.onchainSupplyDivergences > 0 ? "amber" : "green",
    },
    {
      label: "Active Depegs",
      value: dq.activeDepegs,
      detail: "open events",
      severity: dq.activeDepegs > 5 ? "red" : dq.activeDepegs > 0 ? "amber" : "green",
    },
    {
      label: "Stale On-chain",
      value: dq.staleOnchainSupply,
      detail: "coins >2h old",
      severity: dq.staleOnchainSupply > 5 ? "red" : dq.staleOnchainSupply > 0 ? "amber" : "green",
    },
  ];

  const severityColor = {
    green: "text-green-600 dark:text-green-400",
    amber: "text-amber-600 dark:text-amber-400",
    red: "text-red-600 dark:text-red-400",
  };

  return (
    <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-5">
      {cards.map((c) => (
        <Card key={c.label}>
          <CardContent className="pt-4">
            <div className="text-xs text-muted-foreground">{c.label}</div>
            <div className={`text-2xl font-extrabold font-mono tabular-nums ${severityColor[c.severity]}`}>{c.value}</div>
            <div className="text-xs text-muted-foreground">{c.detail}</div>
          </CardContent>
        </Card>
      ))}
    </div>
  );
}

// --- Cache Freshness Table ---

function CacheFreshnessTable({ caches }: { caches: Record<string, { ageSeconds: number | null; maxAge: number; healthy: boolean }> }) {
  const sorted = Object.entries(caches).sort(([, a], [, b]) => {
    const ratioA = a.ageSeconds != null ? a.ageSeconds / a.maxAge : Infinity;
    const ratioB = b.ageSeconds != null ? b.ageSeconds / b.maxAge : Infinity;
    return ratioB - ratioA;
  });

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Cache Freshness</CardTitle>
      </CardHeader>
      <CardContent>
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b text-left text-muted-foreground">
              <th className="pb-2 font-medium">Cache Key</th>
              <th className="pb-2 font-medium">Age</th>
              <th className="pb-2 font-medium">Max Age</th>
              <th className="pb-2 font-medium">Status</th>
            </tr>
          </thead>
          <tbody>
            {sorted.map(([key, cache]) => (
              <tr key={key} className="border-b last:border-0">
                <td className="py-2 font-mono text-xs">{key}</td>
                <td className="py-2">{cache.ageSeconds != null ? formatAge(cache.ageSeconds) : "\u2014"}</td>
                <td className="py-2">{formatAge(cache.maxAge)}</td>
                <td className="py-2">
                  <div className={`h-2.5 w-2.5 rounded-full ${cache.healthy ? "bg-green-500" : "bg-red-500"}`} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </CardContent>
    </Card>
  );
}

// --- Auth Gate ---

const SESSION_KEY = "pharos-admin-key";

function AdminKeyForm({ onSubmit }: { onSubmit: (key: string) => void }) {
  const [value, setValue] = useState("");

  function handleSubmit(e: FormEvent) {
    e.preventDefault();
    const trimmed = value.trim();
    if (trimmed) onSubmit(trimmed);
  }

  return (
    <div className="flex min-h-[60vh] items-center justify-center">
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle>Pharos System Status</CardTitle>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleSubmit} className="space-y-4">
            <Input
              type="password"
              placeholder="Admin key"
              value={value}
              onChange={(e) => setValue(e.target.value)}
              autoFocus
            />
            <Button type="submit" className="w-full" disabled={!value.trim()}>
              Sign in
            </Button>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}

// --- Main Page ---

export default function StatusClient() {
  const [adminKey, setAdminKey] = useState("");
  const [ready, setReady] = useState(false);

  useEffect(() => {
    const stored = sessionStorage.getItem(SESSION_KEY);
    if (stored) setAdminKey(stored);
    setReady(true);
  }, []);

  const handleKeySubmit = useCallback((key: string) => {
    sessionStorage.setItem(SESSION_KEY, key);
    setAdminKey(key);
  }, []);

  const handleSignOut = useCallback(() => {
    sessionStorage.removeItem(SESSION_KEY);
    setAdminKey("");
  }, []);

  if (!ready) {
    return <div className="py-20 text-center text-muted-foreground">Loading...</div>;
  }

  if (!adminKey) {
    return <AdminKeyForm onSubmit={handleKeySubmit} />;
  }

  return <StatusDashboard adminKey={adminKey} onSignOut={handleSignOut} />;
}

function StatusDashboard({ adminKey, onSignOut }: { adminKey: string; onSignOut: () => void }) {
  const { data, isLoading, error } = useStatus(adminKey);

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

  if (!data) return null;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-extrabold tracking-tighter">Pharos System Status</h1>
        <Button variant="outline" size="sm" onClick={onSignOut}>
          Sign out
        </Button>
      </div>

      <StatusBanner status={data.overallStatus} timestamp={data.timestamp} />

      <section>
        <h2 className="mb-3 text-xl font-semibold">Cron Jobs</h2>
        <div className="grid gap-4 md:grid-cols-2">
          {Object.entries(data.crons).map(([job, cron]) => (
            <CronCard key={job} job={job} cron={cron} />
          ))}
        </div>
      </section>

      <section>
        <h2 className="mb-3 text-xl font-semibold">Data Quality</h2>
        <DataQualityCards dq={data.dataQuality} />
      </section>

      <CacheFreshnessTable caches={data.caches} />
    </div>
  );
}
