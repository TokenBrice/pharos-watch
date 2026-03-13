import { Card, CardContent } from "@/components/ui/card";
import { formatElapsedSeconds } from "@shared/lib/format";

interface SystemDiagnosticsProps {
  state: {
    currentStatus: "healthy" | "degraded" | "stale";
    rawStatus: "healthy" | "degraded" | "stale";
    lastEvaluatedAt: number;
    lastChangedAt: number;
    consecutiveRaw: {
      healthy: number;
      degraded: number;
      stale: number;
    };
    thresholds: {
      escalateToDegraded: number;
      escalateToStale: number;
      recoverToDegraded: number;
      recoverToHealthy: number;
    };
  };
  staleness: { ageSeconds: number; maxAgeSec: number; isStale: boolean };
  probe: {
    timestamp: number | null;
    status: "healthy" | "degraded" | "stale" | "unknown";
    sampleCount: number;
    passCount: number;
    failCount: number;
    bootstrapMissCount?: number;
    p95LatencyMs: number | null;
  };
  discrepancy: {
    hasDivergence: boolean;
    severityDelta: number;
    details: string | null;
    probeAgeSeconds: number | null;
    consecutiveDivergent: number;
  };
  browserProbe?: {
    sampleCount: number;
    passCount: number;
    failCount: number;
    p95LatencyMs: number | null;
    updatedAt: number | null;
  } | null;
  nowSeconds: number;
}

export function SystemDiagnostics({
  state,
  staleness,
  probe,
  discrepancy,
  browserProbe,
  nowSeconds,
}: SystemDiagnosticsProps) {
  const evalAge = state.lastEvaluatedAt > 0 ? Math.max(0, nowSeconds - state.lastEvaluatedAt) : null;
  const changedAge = state.lastChangedAt > 0 ? Math.max(0, nowSeconds - state.lastChangedAt) : null;
  const browserProbeAgeSeconds = browserProbe?.updatedAt != null
    ? Math.max(0, nowSeconds - browserProbe.updatedAt)
    : null;

  return (
    <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-5">
      <Card>
        <CardContent className="pt-4">
          <div className="text-xs text-muted-foreground">State Machine</div>
          <div className="font-mono text-sm">
            {state.currentStatus} (raw: {state.rawStatus})
          </div>
          <div className="text-xs text-muted-foreground">evaluated {evalAge != null ? `${formatElapsedSeconds(evalAge)} ago` : "never"}</div>
          <div className="text-xs text-muted-foreground">changed {changedAge != null ? `${formatElapsedSeconds(changedAge)} ago` : "never"}</div>
          <div className="mt-1 text-xs text-muted-foreground">
            raw streak h/d/s {state.consecutiveRaw.healthy}/{state.consecutiveRaw.degraded}/{state.consecutiveRaw.stale}
          </div>
        </CardContent>
      </Card>
      <Card>
        <CardContent className="pt-4">
          <div className="text-xs text-muted-foreground">Status Freshness</div>
          <div className={`font-mono text-sm ${staleness.isStale ? "text-red-600 dark:text-red-400" : "text-green-600 dark:text-green-400"}`}>
            {staleness.isStale ? "stale" : "fresh"}
          </div>
          <div className="text-xs text-muted-foreground">
            age {formatElapsedSeconds(staleness.ageSeconds)} / max {formatElapsedSeconds(staleness.maxAgeSec)}
          </div>
        </CardContent>
      </Card>
      <Card>
        <CardContent className="pt-4">
          <div className="text-xs text-muted-foreground">Worker Self-Check</div>
          <div className="font-mono text-sm">
            {probe.status} ({probe.passCount}/{probe.sampleCount})
          </div>
          <div className="text-xs text-muted-foreground">p95 {probe.p95LatencyMs != null ? `${probe.p95LatencyMs}ms` : "—"}</div>
          <div className="text-xs text-muted-foreground">
            {probe.timestamp ? `${formatElapsedSeconds(Math.max(0, nowSeconds - probe.timestamp))} ago` : "no probe yet"}
          </div>
          {probe.bootstrapMissCount != null && probe.bootstrapMissCount > 0 && (
            <div className="text-xs text-muted-foreground">bootstrap misses {probe.bootstrapMissCount}</div>
          )}
        </CardContent>
      </Card>
      <Card>
        <CardContent className="pt-4">
          <div className="text-xs text-muted-foreground">Browser Probe Loop</div>
          <div className="font-mono text-sm">
            {browserProbe ? `${browserProbe.passCount}/${browserProbe.sampleCount}` : "—"}
          </div>
          <div className="text-xs text-muted-foreground">
            p95 {browserProbe?.p95LatencyMs != null ? `${browserProbe.p95LatencyMs}ms` : "—"}
          </div>
          <div className="text-xs text-muted-foreground">
            {browserProbeAgeSeconds != null ? `${formatElapsedSeconds(browserProbeAgeSeconds)} ago` : "not sampled yet"}
          </div>
          {browserProbe && browserProbe.failCount > 0 && (
            <div className="text-xs text-muted-foreground">failures {browserProbe.failCount}</div>
          )}
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
          <div className="text-xs text-muted-foreground">
            delta {discrepancy.severityDelta} • probe age {discrepancy.probeAgeSeconds != null ? formatElapsedSeconds(discrepancy.probeAgeSeconds) : "—"}
          </div>
          {discrepancy.details && <div className="text-xs text-muted-foreground">{discrepancy.details}</div>}
        </CardContent>
      </Card>
    </div>
  );
}
