import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { getStatusCronDisplay } from "@/lib/status/cron-config";
import { summarizeCronMetadata } from "./cron-metadata-summary";
import { formatElapsedSeconds } from "@shared/lib/format";
import { formatLatency, formatInterval } from "./format";

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
  const metadataSummary = summarizeCronMetadata(job, cron.lastRun?.metadata);
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
                  <span>started {formatElapsedSeconds(nowSeconds - cron.inFlight.startedAt)} ago</span>
                  <span>heartbeat {formatElapsedSeconds(nowSeconds - cron.inFlight.updatedAt)} ago</span>
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
              <span className="text-muted-foreground">{formatElapsedSeconds(nowSeconds - cron.lastRun.startedAt)} ago</span>
              <span className="text-muted-foreground">({formatLatency(cron.lastRun.durationMs)})</span>
              {cron.lastRun.itemCount != null && (
                <span className="text-muted-foreground">{cron.lastRun.itemCount} items</span>
              )}
            </div>
            <div className="flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground">
              {lastSuccessfulRun && (
                <span>last good {formatElapsedSeconds(nowSeconds - lastSuccessfulRun.startedAt)} ago</span>
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
                <span>started {formatElapsedSeconds(nowSeconds - cron.inFlight.startedAt)} ago</span>
                <span>heartbeat {formatElapsedSeconds(nowSeconds - cron.inFlight.updatedAt)} ago</span>
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
              title={`${run.status} — ${new Date(run.startedAt * 1000).toLocaleString()} (${formatLatency(run.durationMs)})`}
            />
          ))}
        </div>
      </CardContent>
    </Card>
  );
}
