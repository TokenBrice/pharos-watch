import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { formatAge, formatDuration, formatInterval } from "./format";

interface CronCardProps {
  job: string;
  cron: {
    lastRun: { startedAt: number; durationMs: number; status: string; error?: string; itemCount?: number } | null;
    recentRuns: Array<{ startedAt: number; durationMs: number; status: string; error?: string }>;
    expectedIntervalSec: number;
    healthy: boolean;
  };
  nowSeconds: number;
}

export function CronCard({ job, cron, nowSeconds }: CronCardProps) {
  const latestStatus = cron.lastRun?.status;
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
          </div>
        ) : (
          <span className="text-sm text-muted-foreground">No runs recorded</span>
        )}

        <div className="flex items-center gap-1">
          <span className="mr-1 text-xs text-muted-foreground">History:</span>
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
          {cron.recentRuns.length === 0 && <span className="text-xs text-muted-foreground">none</span>}
        </div>
      </CardContent>
    </Card>
  );
}
