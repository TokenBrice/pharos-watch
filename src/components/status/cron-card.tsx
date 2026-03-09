import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { formatAge, formatDuration, formatInterval } from "./format";

interface CronCardProps {
  job: string;
  cron: {
    lastRun: {
      startedAt: number;
      durationMs: number;
      status: string;
      error?: string;
      itemCount?: number;
      metadata?: Record<string, unknown>;
    } | null;
    recentRuns: Array<{ startedAt: number; durationMs: number; status: string; error?: string }>;
    expectedIntervalSec: number;
    healthy: boolean;
  };
  nowSeconds: number;
}

function readNumber(value: unknown): number | null {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function readRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function readArray(value: unknown): unknown[] | null {
  return Array.isArray(value) ? value : null;
}

function formatApiErrorClasses(value: unknown): string | null {
  const record = readRecord(value);
  if (!record) return null;
  const parts = Object.entries(record)
    .map(([key, raw]) => {
      const count = readNumber(raw);
      return count != null ? `${key} x${count}` : null;
    })
    .filter((item): item is string => item != null)
    .sort((a, b) => a.localeCompare(b));
  return parts.length > 0 ? parts.join(", ") : null;
}

function formatSlowestProbes(value: unknown): string | null {
  const probes = readArray(value);
  if (!probes || probes.length === 0) return null;

  const parts = probes
    .map((probe) => {
      const record = readRecord(probe);
      const path = readString(record?.path);
      const latencyMs = readNumber(record?.latencyMs);
      if (!path || latencyMs == null) return null;
      return `${path} ${latencyMs}ms`;
    })
    .filter((item): item is string => item != null)
    .slice(0, 2);

  return parts.length > 0 ? `slowest ${parts.join(", ")}` : null;
}

function summarizeMetadata(job: string, metadata: Record<string, unknown> | undefined): string[] {
  if (!metadata) return [];

  if (job === "status-self-check") {
    const sampleCount = readNumber(metadata.sampleCount);
    const failCount = readNumber(metadata.failCount);
    const probeStatus = readString(metadata.probeStatus);
    const rawOverallStatus = readString(metadata.rawOverallStatus);
    const effectiveStatus = readString(metadata.effectiveStatus);
    const discrepancyStreak = readNumber(metadata.discrepancyStreak);
    const probeFailureStreak = readNumber(metadata.probeFailureStreak);
    const p95LatencyMs = readNumber(metadata.p95LatencyMs);
    const probeMode = readString(metadata.probeMode);
    const latencySummary = readRecord(metadata.latencySummary);
    const medianLatencyMs = readNumber(latencySummary?.medianMs);
    const maxLatencyMs = readNumber(latencySummary?.maxMs);
    const slowestProbes = formatSlowestProbes(metadata.slowestProbes);

    const lines = [
      sampleCount != null && failCount != null && probeStatus
        ? `probes ${sampleCount - failCount}/${sampleCount} ok, ${failCount} failed (${probeStatus})`
        : null,
      rawOverallStatus && effectiveStatus ? `status raw ${rawOverallStatus} -> effective ${effectiveStatus}` : null,
      probeMode ? `probe mode ${probeMode}` : null,
      p95LatencyMs != null
        ? `latency${medianLatencyMs != null ? ` median ${medianLatencyMs}ms,` : ""} p95 ${p95LatencyMs}ms${maxLatencyMs != null ? `, max ${maxLatencyMs}ms` : ""}`
        : null,
      slowestProbes,
      discrepancyStreak != null && discrepancyStreak > 0 ? `divergence streak ${discrepancyStreak}` : null,
      probeFailureStreak != null && probeFailureStreak > 0 ? `probe failure streak ${probeFailureStreak}` : null,
    ];
    return lines.filter((line): line is string => line != null);
  }

  if (job === "sync-blacklist") {
    const apiErrors = readNumber(metadata.apiErrors);
    const contractsSkipped = readNumber(metadata.contractsSkipped);
    const budgetUsed = readNumber(metadata.budgetUsed);
    const budgetLimit = readNumber(metadata.budgetLimit);
    const rpcLogConfigs = readNumber(metadata.rpcLogConfigs);
    const apiErrorClasses = formatApiErrorClasses(metadata.apiErrorClasses);

    const lines = [
      apiErrors != null ? `api errors ${apiErrors}` : null,
      contractsSkipped != null && contractsSkipped > 0 ? `contracts skipped ${contractsSkipped}` : null,
      budgetUsed != null && budgetLimit != null ? `budget ${budgetUsed}/${budgetLimit}` : null,
      rpcLogConfigs != null && rpcLogConfigs > 0 ? `rpc-log configs ${rpcLogConfigs}` : null,
      apiErrorClasses ? `error classes ${apiErrorClasses}` : null,
    ];
    return lines.filter((line): line is string => line != null);
  }

  return [];
}

export function CronCard({ job, cron, nowSeconds }: CronCardProps) {
  const latestStatus = cron.lastRun?.status;
  const metadataSummary = summarizeMetadata(job, cron.lastRun?.metadata);
  const borderColor = !cron.healthy
    ? "border-red-500/30"
    : latestStatus === "degraded"
      ? "border-amber-500/30"
      : "border-green-500/30";

  const badgeClassByStatus: Record<string, string> = {
    ok: "bg-green-500/15 text-green-700 dark:text-green-400",
    degraded: "bg-amber-500/15 text-amber-700 dark:text-amber-400",
    skipped_locked: "bg-muted text-muted-foreground",
    error: "bg-red-500/15 text-red-700 dark:text-red-400",
  };

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
              <Badge
                className={`text-xs ${badgeClassByStatus[cron.lastRun.status] ?? "bg-red-500/15 text-red-700 dark:text-red-400"}`}
              >
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
            {metadataSummary.length > 0 && (
              <div className="space-y-1 rounded border border-amber-500/20 bg-amber-500/5 p-2 text-xs text-amber-700 dark:text-amber-300">
                {metadataSummary.map((line) => (
                  <div key={line}>{line}</div>
                ))}
              </div>
            )}
            {cron.lastRun.metadata && Object.keys(cron.lastRun.metadata).length > 0 && (
              <details className="text-xs">
                <summary className="cursor-pointer text-muted-foreground">Run metadata</summary>
                <pre className="mt-1 max-h-40 overflow-auto rounded bg-muted p-2 text-xs">
                  {JSON.stringify(cron.lastRun.metadata, null, 2)}
                </pre>
              </details>
            )}
          </div>
        ) : (
          <span className="text-sm text-muted-foreground">No runs recorded</span>
        )}

        <div className="flex items-center gap-1">
          <span className="mr-1 text-xs text-muted-foreground">History:</span>
          <span className="mr-2 text-xs text-muted-foreground">
            {cron.recentRuns.length > 0 ? `${cron.recentRuns.length} runs` : "none"}
          </span>
          {cron.recentRuns.map((run, i) => (
            <div
              key={i}
              className={`h-2.5 w-2.5 rounded-full ${
                run.status === "ok"
                  ? "bg-green-500"
                  : run.status === "degraded"
                    ? "bg-amber-500"
                    : run.status === "skipped_locked"
                      ? "bg-zinc-500"
                      : "bg-red-500"
              }`}
              title={`${run.status} — ${new Date(run.startedAt * 1000).toLocaleString()} (${formatDuration(run.durationMs)})`}
            />
          ))}
        </div>
      </CardContent>
    </Card>
  );
}
