import { Card, CardContent } from "@/components/ui/card";
import { formatAge } from "./format";

interface SystemDiagnosticsProps {
  state: {
    currentStatus: "healthy" | "degraded" | "stale";
    rawStatus: "healthy" | "degraded" | "stale";
    lastEvaluatedAt: number;
    lastChangedAt: number;
  };
  staleness: { ageSeconds: number; maxAgeSec: number; isStale: boolean };
  probe: {
    timestamp: number | null;
    status: "healthy" | "degraded" | "stale" | "unknown";
    sampleCount: number;
    passCount: number;
    failCount: number;
    p95LatencyMs: number | null;
  };
  discrepancy: {
    hasDivergence: boolean;
    severityDelta: number;
    details: string | null;
    probeAgeSeconds: number | null;
    consecutiveDivergent: number;
  };
  nowSeconds: number;
}

export function SystemDiagnostics({
  state,
  staleness,
  probe,
  discrepancy,
  nowSeconds,
}: SystemDiagnosticsProps) {
  const evalAge = Math.max(0, nowSeconds - state.lastEvaluatedAt);
  const changedAge = Math.max(0, nowSeconds - state.lastChangedAt);

  return (
    <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
      <Card>
        <CardContent className="pt-4">
          <div className="text-xs text-muted-foreground">State Machine</div>
          <div className="font-mono text-sm">
            {state.currentStatus} (raw: {state.rawStatus})
          </div>
          <div className="text-xs text-muted-foreground">evaluated {formatAge(evalAge)} ago</div>
          <div className="text-xs text-muted-foreground">changed {formatAge(changedAge)} ago</div>
        </CardContent>
      </Card>
      <Card>
        <CardContent className="pt-4">
          <div className="text-xs text-muted-foreground">Status Freshness</div>
          <div className={`font-mono text-sm ${staleness.isStale ? "text-red-600 dark:text-red-400" : "text-green-600 dark:text-green-400"}`}>
            {staleness.isStale ? "stale" : "fresh"}
          </div>
          <div className="text-xs text-muted-foreground">
            age {formatAge(staleness.ageSeconds)} / max {formatAge(staleness.maxAgeSec)}
          </div>
        </CardContent>
      </Card>
      <Card>
        <CardContent className="pt-4">
          <div className="text-xs text-muted-foreground">Synthetic Probe</div>
          <div className="font-mono text-sm">
            {probe.status} ({probe.passCount}/{probe.sampleCount})
          </div>
          <div className="text-xs text-muted-foreground">p95 {probe.p95LatencyMs != null ? `${probe.p95LatencyMs}ms` : "—"}</div>
          <div className="text-xs text-muted-foreground">
            {probe.timestamp ? `${formatAge(Math.max(0, nowSeconds - probe.timestamp))} ago` : "no probe yet"}
          </div>
        </CardContent>
      </Card>
      <Card>
        <CardContent className="pt-4">
          <div className="text-xs text-muted-foreground">Divergence</div>
          <div
            className={`font-mono text-sm ${
              discrepancy.hasDivergence ? "text-amber-600 dark:text-amber-400" : "text-green-600 dark:text-green-400"
            }`}
          >
            {discrepancy.hasDivergence ? "detected" : "none"}
          </div>
          <div className="text-xs text-muted-foreground">streak: {discrepancy.consecutiveDivergent}</div>
          {discrepancy.details && <div className="text-xs text-muted-foreground">{discrepancy.details}</div>}
        </CardContent>
      </Card>
    </div>
  );
}
