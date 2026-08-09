import type { StatusResponse } from "@shared/types";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { formatElapsedSeconds } from "@shared/lib/format";
import { getStatusTone } from "@/lib/status-dashboard-model";
import { SEVERITY_TONE_CLASS } from "@/lib/severity-tone";
import { cn } from "@/lib/utils";

interface ReserveSyncHealthCardProps {
  health: StatusResponse["reserveComposition"];
  nowSeconds: number;
}

function formatLastSuccess(lastSuccessAt: number | null, nowSeconds: number): string {
  if (!lastSuccessAt) return "No successful live sync yet";
  return `${new Date(lastSuccessAt * 1000).toLocaleString()} (${formatElapsedSeconds(Math.max(0, nowSeconds - lastSuccessAt))} ago)`;
}

function formatPersistentStaleIndependentFeeds(
  coins: StatusResponse["reserveComposition"]["persistentlyStaleIndependentCoins"],
): string {
  const examples = coins
    .slice(0, 3)
    .map((coin) => coin.stablecoinId)
    .join(", ");
  const suffix = coins.length > 3 ? `, +${coins.length - 3} more` : "";
  return examples ? `${coins.length} (${examples}${suffix})` : String(coins.length);
}

function formatCoveragePct(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

export function ReserveSyncHealthCard({ health, nowSeconds }: ReserveSyncHealthCardProps) {
  // One definition of the healthy/degraded/stale badge palette: this used to be
  // a byte-identical re-implementation of `STATUS_TONE[...].badgeClassName`.
  const statusTone = getStatusTone(health.status).badgeClassName;
  const scoreInputHold =
    health.status !== "healthy" ||
    health.deferredCoins > 0 ||
    health.runBudgetTruncated ||
    health.writeTimeoutUncertain > 0 ||
    health.authoritativeFreshCoverageRatio < 1;

  return (
    <Card>
      <CardHeader>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <CardTitle as="h3" className="text-base">Live Reserve Sync</CardTitle>
          <span className={`rounded-full border px-2.5 py-1 text-[11px] font-medium ${statusTone}`}>
            {health.status}
          </span>
        </div>
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        {scoreInputHold ? (
          <div className={cn("rounded-lg border p-3 text-xs leading-relaxed text-amber-900 dark:text-amber-200", SEVERITY_TONE_CLASS.watch.banner)}>
            <div className="text-sm font-medium text-amber-950 dark:text-amber-100">
              Report-card inputs are conservative
            </div>
            <p className="mt-1">
              Safety scoring only trusts score-grade reserve evidence. While this lane is degraded or deferred, affected
              report cards can show lower reserve scores until a clean run completes.
            </p>
            <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 font-mono text-[11px]">
              <span>{formatCoveragePct(health.freshCoverageRatio)} fresh</span>
              <span>{formatCoveragePct(health.authoritativeFreshCoverageRatio)} score-grade</span>
              {health.deferredCoins > 0 ? <span>{health.deferredCoins} deferred</span> : null}
              {health.nextCursorStablecoinId ? <span>resume {health.nextCursorStablecoinId}</span> : null}
            </div>
          </div>
        ) : null}

        <div className="grid grid-cols-2 gap-3 md:grid-cols-7">
          <div>
            <div className="text-muted-foreground">Configured</div>
            <div className="font-mono text-lg">{health.configuredCoins}</div>
          </div>
          <div>
            <div className="text-muted-foreground">Fresh</div>
            <div className="font-mono text-lg text-emerald-600 dark:text-emerald-400">{health.freshCoins}</div>
          </div>
          <div>
            <div className="text-muted-foreground">Error</div>
            <div className="font-mono text-lg text-red-600 dark:text-red-400">{health.errorCoins}</div>
          </div>
          <div>
            <div className="text-muted-foreground">Corrupt</div>
            <div className="font-mono text-lg text-red-600 dark:text-red-400">{health.corruptCoins}</div>
          </div>
          <div>
            <div className="text-muted-foreground">Degraded</div>
            <div className="font-mono text-lg text-amber-600 dark:text-amber-400">{health.degradedCoins}</div>
          </div>
          <div>
            <div className="text-muted-foreground">Stale</div>
            <div className="font-mono text-lg text-orange-600 dark:text-orange-400">{health.staleCoins}</div>
          </div>
          <div>
            <div className="text-muted-foreground">Missing</div>
            <div className="font-mono text-lg text-red-600 dark:text-red-400">{health.missingCoins}</div>
          </div>
          <div>
            <div className="text-muted-foreground">Deferred</div>
            <div className="font-mono text-lg text-amber-600 dark:text-amber-400">{health.deferredCoins}</div>
          </div>
        </div>

        <div className="space-y-1 text-xs text-muted-foreground">
          <div>Last success: {formatLastSuccess(health.lastSuccessAt, nowSeconds)}</div>
          <div>
            Oldest fresh snapshot age:{" "}
            {health.oldestFreshAgeSec != null ? formatElapsedSeconds(health.oldestFreshAgeSec) : "—"}
          </div>
          <div>
            Coverage: {formatCoveragePct(health.freshCoverageRatio)} fresh,{" "}
            {formatCoveragePct(health.authoritativeFreshCoverageRatio)} score-grade
          </div>
          {health.nextCursorStablecoinId && <div>Next deferred cursor: {health.nextCursorStablecoinId}</div>}
          <div>
            Queue pressure:{" "}
            {health.runBudgetTruncated
              ? `run budget truncated${health.deferredAt ? ` at ${new Date(health.deferredAt * 1000).toLocaleString()}` : ""}`
              : "run budget clear"}
          </div>
        </div>

        <div className="space-y-2 rounded-lg border border-border/60 bg-muted/20 p-3">
          <div className="text-xs font-medium text-foreground">Fresh Evidence Mix</div>
          <div className="grid grid-cols-2 gap-3 md:grid-cols-5">
            <div>
              <div className="text-muted-foreground">Independent eligible</div>
              <div className="font-mono text-base text-emerald-600 dark:text-emerald-400">
                {health.independentFreshEligible}
              </div>
            </div>
            <div>
              <div className="text-muted-foreground">Independent unverified</div>
              <div className="font-mono text-base text-amber-600 dark:text-amber-400">
                {health.independentFreshUnverified}
              </div>
            </div>
            <div>
              <div className="text-muted-foreground">Static validated</div>
              <div className="font-mono text-base">{health.staticValidatedFresh}</div>
            </div>
            <div>
              <div className="text-muted-foreground">Weak probe</div>
              <div className="font-mono text-base">{health.weakProbeFresh}</div>
            </div>
            <div>
              <div className="text-muted-foreground">Write-timeout uncertain</div>
              <div className="font-mono text-base text-red-600 dark:text-red-400">{health.writeTimeoutUncertain}</div>
            </div>
          </div>
          {health.persistentlyStaleIndependentCoins.length > 0 ? (
            <div className="text-xs text-amber-700 dark:text-amber-300">
              Persistently stale independent feeds:{" "}
              {formatPersistentStaleIndependentFeeds(health.persistentlyStaleIndependentCoins)}
            </div>
          ) : null}
        </div>
      </CardContent>
    </Card>
  );
}
