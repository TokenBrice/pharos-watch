import { formatElapsedSeconds } from "@shared/lib/format";
import type { StatusDiscrepancyReason, StatusResponse, StatusSectionError } from "@shared/types";
import type { BrowserProbeSummary } from "@/lib/status-dashboard-model";

function discrepancyReasonLabel(reason: StatusDiscrepancyReason): string {
  switch (reason) {
    case "in-sync":
      return "in sync";
    case "probe-stale":
      return "probe stale";
    case "probe-disagrees":
      return "probe disagrees";
    case "probe-missing":
      return "probe missing";
  }
}

interface SystemDiagnosticsProps {
  state: StatusResponse["state"];
  staleness: StatusResponse["staleness"];
  probe: StatusResponse["probe"];
  discrepancy: StatusResponse["discrepancy"];
  browserProbe?: BrowserProbeSummary | null;
  browserProbeLabel?: string;
  error?: StatusSectionError;
  nowSeconds: number;
}

export function SystemDiagnostics({
  state,
  staleness,
  probe,
  discrepancy,
  browserProbe,
  browserProbeLabel = "Browser Probe Loop",
  error,
  nowSeconds,
}: SystemDiagnosticsProps) {
  const evalAge = state.lastEvaluatedAt > 0 ? Math.max(0, nowSeconds - state.lastEvaluatedAt) : null;
  const changedAge = state.lastChangedAt > 0 ? Math.max(0, nowSeconds - state.lastChangedAt) : null;
  const browserProbeAgeSeconds =
    browserProbe?.updatedAt != null ? Math.max(0, nowSeconds - browserProbe.updatedAt) : null;

  return (
    // Flat diagnostic bands (not nested cards): this grid renders inside the
    // Triage section shell, so each cell is a section band with divider rules.
    <div className="grid gap-x-4 gap-y-3 md:grid-cols-2 xl:grid-cols-5">
      <div className="min-w-0 border-y border-border/60 py-2">
        <div className="text-xs text-muted-foreground">State Machine</div>
        <div className="font-mono text-sm">
          {state.currentStatus} (raw: {state.rawStatus})
        </div>
        <div className="text-xs text-muted-foreground">
          evaluated {evalAge != null ? `${formatElapsedSeconds(evalAge)} ago` : "never"}
        </div>
        <div className="text-xs text-muted-foreground">
          changed {changedAge != null ? `${formatElapsedSeconds(changedAge)} ago` : "never"}
        </div>
        <div className="mt-1 text-xs text-muted-foreground">
          raw streak h/d/s {state.consecutiveRaw.healthy}/{state.consecutiveRaw.degraded}/{state.consecutiveRaw.stale}
        </div>
        {error && (
          <div className="mt-2 text-xs text-amber-600 dark:text-amber-300">
            {error.code}: {error.message}
          </div>
        )}
      </div>
      <div className="min-w-0 border-y border-border/60 py-2">
        <div className="text-xs text-muted-foreground">Status Freshness</div>
        <div
          className={`font-mono text-sm ${staleness.isStale ? "text-red-600 dark:text-red-400" : "text-green-600 dark:text-green-400"}`}
        >
          {staleness.isStale ? "stale" : "fresh"}
        </div>
        <div className="text-xs text-muted-foreground">
          age {formatElapsedSeconds(staleness.ageSeconds)} / max {formatElapsedSeconds(staleness.maxAgeSec)}
        </div>
      </div>
      <div className="min-w-0 border-y border-border/60 py-2">
        <div className="text-xs text-muted-foreground">Worker Self-Check</div>
        <div className="font-mono text-sm">
          {probe.status} ({probe.passCount}/{probe.sampleCount})
        </div>
        <div className="text-xs text-muted-foreground">
          p95 {probe.p95LatencyMs != null ? `${probe.p95LatencyMs}ms` : "—"}
        </div>
        <div className="text-xs text-muted-foreground">
          {probe.timestamp ? `${formatElapsedSeconds(Math.max(0, nowSeconds - probe.timestamp))} ago` : "no probe yet"}
        </div>
        {probe.bootstrapMissCount != null && probe.bootstrapMissCount > 0 && (
          <div className="text-xs text-muted-foreground">bootstrap misses {probe.bootstrapMissCount}</div>
        )}
      </div>
      <div className="min-w-0 border-y border-border/60 py-2">
        <div className="text-xs text-muted-foreground">{browserProbeLabel}</div>
        <div className="font-mono text-sm">
          {browserProbe ? `${browserProbe.passCount}/${browserProbe.sampleCount} (${browserProbe.status ?? "—"})` : "—"}
        </div>
        <div className="text-xs text-muted-foreground">
          p95 {browserProbe?.p95LatencyMs != null ? `${browserProbe.p95LatencyMs}ms` : "—"}
        </div>
        <div className="text-xs text-muted-foreground">
          {browserProbeAgeSeconds != null ? `${formatElapsedSeconds(browserProbeAgeSeconds)} ago` : "not sampled yet"}
        </div>
        {browserProbe && browserProbe.failCount > 0 && (
          <div className="text-xs text-muted-foreground">
            failures {browserProbe.failCount}
            {browserProbe.degradedCount != null || browserProbe.staleCount != null
              ? ` (${browserProbe.degradedCount ?? 0} degraded, ${browserProbe.staleCount ?? 0} stale)`
              : ""}
          </div>
        )}
      </div>
      <div className="min-w-0 border-y border-border/60 py-2">
        <div className="text-xs text-muted-foreground">Divergence</div>
        <div
          className={`font-mono text-sm ${
            discrepancy.hasDivergence ? "text-amber-600 dark:text-amber-400" : "text-green-600 dark:text-green-400"
          }`}
        >
          {discrepancy.hasDivergence ? "detected" : "none"}
        </div>
        <div className="text-xs text-muted-foreground">
          reason: {discrepancyReasonLabel(discrepancy.discrepancyReason)}
        </div>
        <div className="text-xs text-muted-foreground">streak: {discrepancy.consecutiveDivergent}</div>
        <div className="text-xs text-muted-foreground">
          delta {discrepancy.severityDelta} • probe age{" "}
          {discrepancy.probeAgeSeconds != null ? formatElapsedSeconds(discrepancy.probeAgeSeconds) : "—"}
        </div>
        {discrepancy.details && <div className="text-xs text-muted-foreground">{discrepancy.details}</div>}
      </div>
    </div>
  );
}
