import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { getStatusCronDisplay } from "./cron-config";
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
    inFlight?: {
      startedAt: number;
      updatedAt: number;
      stage?: string;
      itemsDone?: number;
      itemsTotal?: number;
      message?: string;
      metadata?: Record<string, unknown>;
      stale: boolean;
    } | null;
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

function readBoolean(value: unknown): boolean | null {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    if (value === "true") return true;
    if (value === "false") return false;
  }
  return null;
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

function formatStringList(value: unknown): string | null {
  const items = readArray(value)
    ?.filter((item): item is string => typeof item === "string" && item.length > 0);
  return items && items.length > 0 ? items.join(", ") : null;
}

function formatTierBreakdown(value: unknown): string | null {
  const record = readRecord(value);
  if (!record) return null;

  const orderedKeys = ["t1", "t2", "t3", "dormant"] as const;
  const parts = orderedKeys
    .map((key) => {
      const count = readNumber(record[key]);
      return count != null && count > 0 ? `${key} ${count}` : null;
    })
    .filter((item): item is string => item != null);

  return parts.length > 0 ? `eligible tiers ${parts.join(", ")}` : null;
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

  if (job === "sync-dex-discovery") {
    const coinsCrawled = readNumber(metadata.coinsCrawled);
    const poolsDiscovered = readNumber(metadata.poolsDiscovered);
    const runSeq = readNumber(metadata.runSeq);
    const budgetExhausted = readBoolean(metadata.budgetExhausted);
    const failedCoins = readArray(metadata.failedCoins)?.filter((coin): coin is string => typeof coin === "string");

    const lines = [
      coinsCrawled != null && poolsDiscovered != null
        ? `crawled ${coinsCrawled} coins, discovered ${poolsDiscovered} pools${runSeq != null ? ` (run #${runSeq})` : ""}`
        : null,
      formatTierBreakdown(metadata.tierBreakdown),
      budgetExhausted ? "budget exhausted before the full discovery queue finished" : null,
      failedCoins && failedCoins.length > 0 ? `coin crawl failures ${failedCoins.length}` : null,
    ];
    return lines.filter((line): line is string => line != null);
  }

  if (job === "sync-dex-liquidity") {
    const stagedPoolsMerged = readNumber(metadata.stagedPoolsMerged);
    const stagedPoolsSkipped = readNumber(metadata.stagedPoolsSkipped);
    const stagedPoolsSkippedByAddress = readNumber(metadata.stagedPoolsSkippedByAddress);
    const stagedPoolsSkippedByFingerprint = readNumber(metadata.stagedPoolsSkippedByFingerprint);
    const failedSources = formatStringList(metadata.failedSources);
    const fallbackMode = formatStringList(metadata.fallbackMode);
    const sourceCoverage = readRecord(metadata.sourceCoverage);
    const currentCoverage = readNumber(sourceCoverage?.currentCoverage);
    const previousCoverage = readNumber(sourceCoverage?.previousCoverage);
    const minExpectedCoverage = readNumber(sourceCoverage?.minExpectedCoverage);
    const priceObservationCoins = readNumber(sourceCoverage?.priceObservationCoins);
    const nearCoverageGuard = readBoolean(sourceCoverage?.nearCoverageGuard);
    const skipBreakdown =
      stagedPoolsSkippedByAddress != null || stagedPoolsSkippedByFingerprint != null
        ? [
            stagedPoolsSkippedByFingerprint != null ? `fp ${stagedPoolsSkippedByFingerprint}` : null,
            stagedPoolsSkippedByAddress != null ? `addr ${stagedPoolsSkippedByAddress}` : null,
          ].filter((part): part is string => part != null).join(", ")
        : null;

    const lines = [
      stagedPoolsMerged != null
        ? `staged pools merged ${stagedPoolsMerged}${stagedPoolsSkipped != null ? `, skipped ${stagedPoolsSkipped}${skipBreakdown ? ` (${skipBreakdown})` : ""}` : ""}`
        : null,
      currentCoverage != null
        ? `coverage ${currentCoverage}${previousCoverage != null ? ` vs ${previousCoverage} previous` : ""}${minExpectedCoverage != null ? `, floor ${minExpectedCoverage}` : ""}`
        : null,
      priceObservationCoins != null ? `dex price observations ${priceObservationCoins} coins` : null,
      failedSources ? `failed sources ${failedSources}` : null,
      fallbackMode ? `fallback mode ${fallbackMode}` : null,
      nearCoverageGuard ? "coverage near guardrail band" : null,
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

  if (job === "sync-mint-burn" || job === "sync-mint-burn-extended") {
    const lane = readString(metadata.lane);
    const contractsProcessed = readNumber(metadata.contractsProcessed);
    const contractsSkipped = readNumber(metadata.contractsSkipped);
    const contractsDeferredExtended = readNumber(metadata.contractsDeferredExtended);
    const degradedStreak = readNumber(metadata.degradedStreak);
    const budgetUsed = readNumber(metadata.budgetUsed);
    const budgetLimit = readNumber(metadata.budgetLimit);
    const criticalCoverage = readRecord(metadata.criticalCoverage);
    const criticalSatisfied = readNumber(criticalCoverage?.contractsSatisfied);
    const criticalEnabled = readNumber(criticalCoverage?.contractsEnabled);
    const laggingConfigs = readArray(metadata.laggingConfigs)?.length ?? 0;

    const lines = [
      lane ? `lane ${lane}` : null,
      contractsProcessed != null
        ? `processed ${contractsProcessed}${contractsSkipped != null ? `, skipped ${contractsSkipped}` : ""}`
        : null,
      budgetUsed != null && budgetLimit != null ? `budget ${budgetUsed}/${budgetLimit}` : null,
      criticalEnabled != null && criticalSatisfied != null && criticalEnabled > 0
        ? `critical coverage ${criticalSatisfied}/${criticalEnabled}`
        : null,
      contractsDeferredExtended != null && contractsDeferredExtended > 0
        ? `extended deferred ${contractsDeferredExtended}`
        : null,
      laggingConfigs > 0 ? `lagging configs tracked ${laggingConfigs}` : null,
      degradedStreak != null && degradedStreak > 0 ? `degraded streak ${degradedStreak}` : null,
    ];
    return lines.filter((line): line is string => line != null);
  }

  return [];
}

function countConsecutiveStatus(
  runs: CronCardProps["cron"]["recentRuns"],
  status: string,
): number {
  let count = 0;
  for (const run of runs) {
    if (run.status !== status) break;
    count += 1;
  }
  return count;
}

function getLastSuccessfulRun(
  runs: CronCardProps["cron"]["recentRuns"],
): CronCardProps["cron"]["recentRuns"][number] | null {
  return runs.find((run) => run.status === "ok" || run.status === "degraded") ?? null;
}

export function CronCard({ job, cron, nowSeconds }: CronCardProps) {
  const display = getStatusCronDisplay(job);
  const latestStatus = cron.lastRun?.status;
  const metadataSummary = summarizeMetadata(job, cron.lastRun?.metadata);
  const lastSuccessfulRun = getLastSuccessfulRun(cron.recentRuns);
  const errorStreak = countConsecutiveStatus(cron.recentRuns, "error");
  const skippedStreak = countConsecutiveStatus(cron.recentRuns, "skipped_locked");
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
  const metadataSummaryClass = !cron.healthy || latestStatus === "error"
    ? "border-red-500/20 bg-red-500/5 text-red-700 dark:text-red-300"
    : latestStatus === "degraded"
      ? "border-amber-500/20 bg-amber-500/5 text-amber-700 dark:text-amber-300"
      : "border-border/60 bg-muted/30 text-muted-foreground";

  return (
    <Card className={`border-2 ${borderColor}`}>
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between">
          <div className="space-y-1">
            <CardTitle className="text-sm">{display.label}</CardTitle>
            {display.label !== job && <CardDescription className="font-mono text-xs">{job}</CardDescription>}
            {display.schedule && (
              <CardDescription className="text-xs text-muted-foreground">
                {display.triggerMode === "isolated" ? "isolated trigger" : "shared trigger"} · {display.schedule}
              </CardDescription>
            )}
          </div>
          <span className="text-xs text-muted-foreground">every {formatInterval(cron.expectedIntervalSec)}</span>
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        {cron.lastRun ? (
          <div className="space-y-1">
            {cron.inFlight && (
              <div className={`space-y-1 rounded border p-2 text-xs ${cron.inFlight.stale ? "border-red-500/20 bg-red-500/5 text-red-700 dark:text-red-300" : "border-sky-500/20 bg-sky-500/5 text-sky-700 dark:text-sky-300"}`}>
                <div className="flex flex-wrap items-center gap-2">
                  <Badge className={`text-xs ${cron.inFlight.stale ? "bg-red-500/15 text-red-700 dark:text-red-300" : "bg-sky-500/15 text-sky-700 dark:text-sky-300"}`}>
                    {cron.inFlight.stale ? "running-stale" : "running"}
                  </Badge>
                  <span>started {formatAge(nowSeconds - cron.inFlight.startedAt)} ago</span>
                  <span>heartbeat {formatAge(nowSeconds - cron.inFlight.updatedAt)} ago</span>
                  {cron.inFlight.stage && <span>stage {cron.inFlight.stage}</span>}
                  {cron.inFlight.itemsDone != null && (
                    <span>
                      progress {cron.inFlight.itemsDone}
                      {cron.inFlight.itemsTotal != null ? `/${cron.inFlight.itemsTotal}` : ""}
                    </span>
                  )}
                </div>
                {cron.inFlight.message && <div>{cron.inFlight.message}</div>}
                {cron.inFlight.metadata && Object.keys(cron.inFlight.metadata).length > 0 && (
                  <details className="text-xs">
                    <summary className="cursor-pointer text-current/80">Active run metadata</summary>
                    <pre className="mt-1 max-h-40 overflow-auto rounded bg-background/60 p-2 text-xs">
                      {JSON.stringify(cron.inFlight.metadata, null, 2)}
                    </pre>
                  </details>
                )}
              </div>
            )}
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
            <div className="flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground">
              {lastSuccessfulRun && (
                <span>last good {formatAge(nowSeconds - lastSuccessfulRun.startedAt)} ago</span>
              )}
              {errorStreak > 0 && <span>error streak {errorStreak}</span>}
              {skippedStreak > 0 && <span>lease skips {skippedStreak}</span>}
            </div>
            {cron.lastRun.error && (
              <details className="text-xs">
                <summary className="cursor-pointer text-red-600 dark:text-red-400">Error details</summary>
                <pre className="mt-1 max-h-24 overflow-auto rounded bg-muted p-2 text-xs">{cron.lastRun.error}</pre>
              </details>
            )}
            {metadataSummary.length > 0 && (
              <div className={`space-y-1 rounded border p-2 text-xs ${metadataSummaryClass}`}>
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
          cron.inFlight ? (
            <div className={`space-y-1 rounded border p-2 text-xs ${cron.inFlight.stale ? "border-red-500/20 bg-red-500/5 text-red-700 dark:text-red-300" : "border-sky-500/20 bg-sky-500/5 text-sky-700 dark:text-sky-300"}`}>
              <div className="flex flex-wrap items-center gap-2">
                <Badge className={`text-xs ${cron.inFlight.stale ? "bg-red-500/15 text-red-700 dark:text-red-300" : "bg-sky-500/15 text-sky-700 dark:text-sky-300"}`}>
                  {cron.inFlight.stale ? "running-stale" : "running"}
                </Badge>
                <span>started {formatAge(nowSeconds - cron.inFlight.startedAt)} ago</span>
                <span>heartbeat {formatAge(nowSeconds - cron.inFlight.updatedAt)} ago</span>
              </div>
              {cron.inFlight.stage && <div>stage {cron.inFlight.stage}</div>}
              {cron.inFlight.message && <div>{cron.inFlight.message}</div>}
            </div>
          ) : (
            <span className="text-sm text-muted-foreground">No runs recorded</span>
          )
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
