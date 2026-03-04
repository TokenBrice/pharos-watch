"use client";

import { useState, useEffect, useCallback, type FormEvent } from "react";
import { useStatus } from "@/hooks/use-status";
import { useHealth } from "@/hooks/use-health";
import { useEndpointProbes, ENDPOINT_GROUPS } from "@/hooks/use-endpoint-probes";
import { API_BASE } from "@/lib/api";
import { getStatusPageActions, type StatusPageAction } from "@/lib/api-endpoints";
import type { EndpointProbeResult, CircuitRecord } from "@/lib/types";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";

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

function CronCard({ job, cron, nowSeconds }: {
  job: string;
  cron: {
    lastRun: { startedAt: number; durationMs: number; status: string; error?: string; itemCount?: number } | null;
    recentRuns: Array<{ startedAt: number; durationMs: number; status: string; error?: string }>;
    expectedIntervalSec: number;
    healthy: boolean;
  };
  nowSeconds: number;
}) {
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
              <span className="text-muted-foreground">{formatAge(nowSeconds - cron.lastRun.startedAt)} ago</span>
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
    onchainSupplyMonitoring: "active" | "unavailable";
    onchainSupplyLatestAt: number | null;
    onchainSupplyTrackedCoins: number;
    activeDepegs: number;
    staleOnchainSupply: number;
  };
}) {
  type Severity = "green" | "amber" | "red" | "neutral";
  const onchainUnavailable = dq.onchainSupplyMonitoring === "unavailable";
  const onchainStalenessDetail = onchainUnavailable
    ? "monitor unavailable"
    : `/${dq.onchainSupplyTrackedCoins} coins >2h old`;

  const cards: Array<{ label: string; value: number | string; detail: string; severity: Severity }> = [
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
      value: onchainUnavailable ? "N/A" : dq.onchainSupplyDivergences,
      detail: onchainUnavailable ? "monitor unavailable" : "coins >5% off",
      severity: onchainUnavailable
        ? "neutral"
        : dq.onchainSupplyDivergences > 3 ? "red" : dq.onchainSupplyDivergences > 0 ? "amber" : "green",
    },
    {
      label: "Active Depegs",
      value: dq.activeDepegs,
      detail: "open events",
      severity: dq.activeDepegs > 5 ? "red" : dq.activeDepegs > 0 ? "amber" : "green",
    },
    {
      label: "Stale On-chain",
      value: onchainUnavailable ? "N/A" : dq.staleOnchainSupply,
      detail: onchainStalenessDetail,
      severity: onchainUnavailable
        ? "neutral"
        : dq.staleOnchainSupply > 5 ? "red" : dq.staleOnchainSupply > 0 ? "amber" : "green",
    },
  ];

  const severityColor = {
    green: "text-green-600 dark:text-green-400",
    amber: "text-amber-600 dark:text-amber-400",
    red: "text-red-600 dark:text-red-400",
    neutral: "text-muted-foreground",
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

// --- Refresh Countdown ---

function RefreshCountdown({ onRefresh }: { onRefresh: () => void }) {
  const [elapsedSeconds, setElapsedSeconds] = useState(0);

  useEffect(() => {
    const id = setInterval(() => setElapsedSeconds((prev) => prev + 1), 1000);
    return () => clearInterval(id);
  }, []);

  const secondsLeft = Math.max(0, 60 - elapsedSeconds);

  return (
    <div className="flex items-center gap-2">
      <span className="text-sm text-muted-foreground">{"\u27F3"} {secondsLeft}s</span>
      <Button variant="outline" size="sm" onClick={onRefresh}>
        Refresh
      </Button>
    </div>
  );
}

// --- Endpoint Health Grid ---

const GROUP_LABELS: Array<{ key: keyof typeof ENDPOINT_GROUPS; label: string }> = [
  { key: "public", label: "Public" },
  { key: "admin", label: "Admin" },
  { key: "manual", label: "Manual Actions" },
];

function EndpointHealthGrid({ probes, isLoading }: { probes: EndpointProbeResult[] | undefined; isLoading: boolean }) {
  if (isLoading && !probes) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Endpoint Health</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground">Probing endpoints...</p>
        </CardContent>
      </Card>
    );
  }

  const probeMap = new Map<string, EndpointProbeResult>();
  if (probes) {
    for (const p of probes) probeMap.set(p.path, p);
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Endpoint Health</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {GROUP_LABELS.map(({ key, label }) => {
          const paths = [...ENDPOINT_GROUPS[key]];
          const isInline = key === "manual";

          // Sort probed endpoints: errors first, then by path
          if (!isInline) {
            paths.sort((a, b) => {
              const pa = probeMap.get(a);
              const pb = probeMap.get(b);
              const aErr = pa ? (pa.status === null || pa.status >= 400 ? 0 : 1) : 1;
              const bErr = pb ? (pb.status === null || pb.status >= 400 ? 0 : 1) : 1;
              if (aErr !== bErr) return aErr - bErr;
              return a.localeCompare(b);
            });
          }

          return (
            <div key={key}>
              <h3 className="mb-2 text-sm font-medium text-muted-foreground">{label}</h3>
              <div className="space-y-1">
                {paths.map((path) => {
                  const probe = probeMap.get(path);
                  const display = path.replace(/^\/api\//, "");

                  if (isInline) {
                    return (
                      <div key={path} className="flex items-center justify-between py-1">
                        <span className="font-mono text-xs">{display}</span>
                        <span className="text-xs text-muted-foreground">Not probed</span>
                      </div>
                    );
                  }

                  const isOk = probe?.status != null && probe.status >= 200 && probe.status < 300;
                  const isError = probe?.status != null && probe.status >= 400;

                  return (
                    <div key={path} className="flex items-center justify-between py-1">
                      <span className="font-mono text-xs">{display}</span>
                      <div className="flex items-center gap-2">
                        {probe ? (
                          <>
                            {isOk && (
                              <Badge className="bg-green-500/15 text-green-700 dark:text-green-400 text-xs">
                                {probe.status}
                              </Badge>
                            )}
                            {isError && (
                              <Badge className="bg-red-500/15 text-red-700 dark:text-red-400 text-xs">
                                {probe.status}
                              </Badge>
                            )}
                            {probe.status === null && (
                              <Badge className="bg-muted text-muted-foreground text-xs">
                                {"\u2014"}
                              </Badge>
                            )}
                            <span className="text-xs text-muted-foreground tabular-nums">{probe.latencyMs}ms</span>
                          </>
                        ) : (
                          <Badge className="bg-muted text-muted-foreground text-xs">{"\u2014"}</Badge>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          );
        })}
      </CardContent>
    </Card>
  );
}

// --- Circuit Breaker Table ---

function CircuitBreakerTable({ circuits }: { circuits: Record<string, CircuitRecord> | undefined }) {
  if (!circuits || Object.keys(circuits).length === 0) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Circuit Breakers</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground">No circuit breakers registered</p>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Circuit Breakers</CardTitle>
      </CardHeader>
      <CardContent>
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b text-left text-muted-foreground">
              <th className="pb-2 font-medium">Name</th>
              <th className="pb-2 font-medium">State</th>
              <th className="pb-2 font-medium">Failures</th>
              <th className="pb-2 font-medium">Last Failure</th>
              <th className="pb-2 font-medium">Last Success</th>
            </tr>
          </thead>
          <tbody>
            {Object.entries(circuits).map(([name, circuit]) => (
              <tr key={name} className="border-b last:border-0">
                <td className="py-2 font-mono text-xs">{name}</td>
                <td className="py-2">
                  {circuit.state === "closed" && (
                    <Badge className="bg-green-500/15 text-green-700 dark:text-green-400 text-xs">closed</Badge>
                  )}
                  {circuit.state === "half-open" && (
                    <Badge className="bg-amber-500/15 text-amber-700 dark:text-amber-400 text-xs">half-open</Badge>
                  )}
                  {circuit.state === "open" && (
                    <Badge className="bg-red-500/15 text-red-700 dark:text-red-400 text-xs">open</Badge>
                  )}
                </td>
                <td className="py-2 font-mono tabular-nums">{circuit.consecutiveFailures}</td>
                <td className="py-2 text-muted-foreground">
                  {circuit.lastFailureAt ? new Date(circuit.lastFailureAt * 1000).toLocaleString() : "\u2014"}
                </td>
                <td className="py-2 text-muted-foreground">
                  {circuit.lastSuccessAt ? new Date(circuit.lastSuccessAt * 1000).toLocaleString() : "\u2014"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </CardContent>
    </Card>
  );
}

// --- Admin Actions ---

const ADMIN_ACTIONS: StatusPageAction[] = getStatusPageActions();

function AdminActionButton({ action, adminKey }: { action: StatusPageAction; adminKey: string }) {
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const handleConfirm = async () => {
    setLoading(true);
    setResult(null);
    setError(null);
    try {
      const res = await fetch(`${API_BASE}${action.path}`, {
        method: action.method,
        headers: { "X-Admin-Key": adminKey },
      });
      const text = await res.text();
      if (!res.ok) {
        setError(`${res.status}: ${text}`);
      } else {
        try {
          const json = JSON.parse(text);
          setResult(JSON.stringify(json, null, 2));
        } catch {
          setResult(text);
        }
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unknown error");
    } finally {
      setLoading(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(isOpen) => {
      setOpen(isOpen);
      if (isOpen) {
        setResult(null);
        setError(null);
      }
    }}>
      <DialogTrigger asChild>
        <Button
          variant={action.destructive ? "destructive" : "outline"}
          size="sm"
          className="w-full"
        >
          {action.label}
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{action.label}</DialogTitle>
          <DialogDescription>{action.confirm}</DialogDescription>
        </DialogHeader>
        {result && (
          <pre className="max-h-60 overflow-auto rounded bg-muted p-3 text-xs">{result}</pre>
        )}
        {error && (
          <pre className="max-h-60 overflow-auto rounded bg-red-500/10 p-3 text-xs text-red-700 dark:text-red-400">{error}</pre>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)} disabled={loading}>
            Cancel
          </Button>
          <Button
            variant={action.destructive ? "destructive" : "default"}
            onClick={handleConfirm}
            disabled={loading}
          >
            {loading ? "Running..." : "Confirm"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function AdminActionsPanel({ adminKey }: { adminKey: string }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Admin Actions</CardTitle>
      </CardHeader>
      <CardContent>
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4">
          {ADMIN_ACTIONS.map((action) => (
            <AdminActionButton key={action.path} action={action} adminKey={adminKey} />
          ))}
        </div>
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
    return <AdminKeyForm onSubmit={handleKeySubmit} />;
  }

  return <StatusDashboard adminKey={adminKey} onSignOut={handleSignOut} />;
}

function StatusDashboard({ adminKey, onSignOut }: { adminKey: string; onSignOut: () => void }) {
  const { data, isLoading, error, refetch: refetchStatus, dataUpdatedAt: statusUpdatedAt } = useStatus(adminKey);
  const { data: healthData, refetch: refetchHealth, dataUpdatedAt: healthUpdatedAt } = useHealth();
  const { data: probes, isLoading: probesLoading, refetch: refetchProbes, dataUpdatedAt: probesUpdatedAt } = useEndpointProbes(adminKey);

  const lastUpdated = Math.max(statusUpdatedAt ?? 0, healthUpdatedAt ?? 0, probesUpdatedAt ?? 0);

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

  if (!data) return null;

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-extrabold tracking-tighter">Pharos System Status</h1>
        <div className="flex items-center gap-3">
          <RefreshCountdown key={lastUpdated} onRefresh={handleRefresh} />
          <Button variant="outline" size="sm" onClick={onSignOut}>Sign out</Button>
        </div>
      </div>

      <StatusBanner status={data.overallStatus} timestamp={data.timestamp} />

      {/* New sections */}
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

      {/* Existing sections unchanged */}
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

      <CacheFreshnessTable caches={data.caches} />
    </div>
  );
}
