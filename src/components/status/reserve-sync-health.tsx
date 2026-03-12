import type { StatusResponse } from "@shared/types";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { formatAge } from "./format";

interface ReserveSyncHealthCardProps {
  health: StatusResponse["reserveComposition"];
  nowSeconds: number;
}

function formatLastSuccess(lastSuccessAt: number | null, nowSeconds: number): string {
  if (!lastSuccessAt) return "No successful live sync yet";
  return `${new Date(lastSuccessAt * 1000).toLocaleString()} (${formatAge(Math.max(0, nowSeconds - lastSuccessAt))} ago)`;
}

export function ReserveSyncHealthCard({ health, nowSeconds }: ReserveSyncHealthCardProps) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Live Reserve Sync</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        <div className="grid grid-cols-2 gap-3 md:grid-cols-5">
          <div>
            <div className="text-muted-foreground">Configured</div>
            <div className="font-mono text-lg">{health.configuredCoins}</div>
          </div>
          <div>
            <div className="text-muted-foreground">Fresh</div>
            <div className="font-mono text-lg text-green-600 dark:text-green-400">{health.freshCoins}</div>
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
            Oldest fresh snapshot age: {health.oldestFreshAgeSec != null ? formatAge(health.oldestFreshAgeSec) : "—"}
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
