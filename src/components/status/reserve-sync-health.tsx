import type { StatusResponse } from "@shared/types";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { formatElapsedSeconds } from "@shared/lib/format";

interface ReserveSyncHealthCardProps {
  health: StatusResponse["reserveComposition"];
  nowSeconds: number;
}

function formatLastSuccess(lastSuccessAt: number | null, nowSeconds: number): string {
  if (!lastSuccessAt) return "No successful live sync yet";
  return `${new Date(lastSuccessAt * 1000).toLocaleString()} (${formatElapsedSeconds(Math.max(0, nowSeconds - lastSuccessAt))} ago)`;
}

export function ReserveSyncHealthCard({ health, nowSeconds }: ReserveSyncHealthCardProps) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Live Reserve Sync</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        <div className="grid grid-cols-2 gap-3 md:grid-cols-7">
          <div>
            <div className="text-muted-foreground">Configured</div>
            <div className="font-mono text-lg">{health.configuredCoins}</div>
          </div>
          <div>
            <div className="text-muted-foreground">Fresh</div>
            <div className="font-mono text-lg text-green-600 dark:text-green-400">{health.freshCoins}</div>
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
        </div>

        <div className="space-y-1 text-xs text-muted-foreground">
          <div>Last success: {formatLastSuccess(health.lastSuccessAt, nowSeconds)}</div>
          <div>
            Oldest fresh snapshot age: {health.oldestFreshAgeSec != null ? formatElapsedSeconds(health.oldestFreshAgeSec) : "—"}
          </div>
        </div>

        <div className="space-y-2 rounded-lg border border-border/60 bg-muted/20 p-3">
          <div className="text-xs font-medium text-foreground">Fresh Evidence Mix</div>
          <div className="grid grid-cols-2 gap-3 md:grid-cols-5">
            <div>
              <div className="text-muted-foreground">Independent eligible</div>
              <div className="font-mono text-base text-green-600 dark:text-green-400">{health.independentFreshEligible}</div>
            </div>
            <div>
              <div className="text-muted-foreground">Independent unverified</div>
              <div className="font-mono text-base text-amber-600 dark:text-amber-400">{health.independentFreshUnverified}</div>
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
        </div>
      </CardContent>
    </Card>
  );
}
