import { formatElapsedSeconds } from "@shared/lib/format";
import type { EndpointProbeResult } from "@shared/types";
import { TableBody, TableCell, TableFrame, TableHead, TableHeader, TableRow } from "@/components/table";
import { LazyDetails } from "@/components/status/lazy-details";
import { ReliabilityCopyDiagnostics } from "@/components/status/reliability-copy-diagnostics";
import { StatusPill } from "@/components/status/severity-pill";
import type { ReliabilityEndpointModel } from "@/lib/reliability-workspace-model";
import { sanitizeReliabilityProbePath } from "@/lib/reliability-workspace-model";
import { getProbeStatusDetail, getProbeStatusLabel, isProbePassing } from "@/lib/status-dashboard-model";
import { formatStatusTimestamp } from "@/lib/status/dashboard-presentation";
import { cn } from "@/lib/utils";

function sampleLabel(timestamp: number | null): string {
  return formatStatusTimestamp(timestamp, { fallback: "Unknown" });
}

function ProbeRows({ probes }: { probes: EndpointProbeResult[] }) {
  return (
    <TableBody>
      {probes.map((probe) => {
        const healthy = isProbePassing(probe);
        const degraded = probe.semanticStatus === "degraded";
        const detail = getProbeStatusDetail(probe);
        return (
          <TableRow key={probe.path}>
            <TableCell className="min-w-56 whitespace-normal align-top">
              <code className="break-all text-xs text-foreground">{sanitizeReliabilityProbePath(probe.path)}</code>
              {detail ? <div className="mt-1 text-[11px] text-muted-foreground">{detail}</div> : null}
            </TableCell>
            <TableCell className="align-top">
              <StatusPill
                className={
                  healthy
                    ? "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300"
                    : degraded
                      ? "bg-amber-500/15 text-amber-800 dark:text-amber-300"
                      : "bg-red-500/15 text-red-700 dark:text-red-300"
                }
              >
                {getProbeStatusLabel(probe)}
              </StatusPill>
            </TableCell>
            <TableCell className="align-top font-mono text-xs tabular-nums">
              {probe.status == null ? "No HTTP" : `HTTP ${probe.status}`}
            </TableCell>
            <TableCell className="align-top font-mono text-xs tabular-nums">{probe.latencyMs}ms</TableCell>
            <TableCell className="min-w-44 whitespace-normal align-top text-xs text-muted-foreground">
              {probe.error
                ? "Transport error reported; raw error omitted from copied diagnostics."
                : (probe.semanticScope ?? "Transport")}
            </TableCell>
          </TableRow>
        );
      })}
    </TableBody>
  );
}

/**
 * One probe-plane summary card. The worker and browser planes rendered the same
 * 28-line card twice, differing only in accent hue, copy, and which model half
 * they read (WS8.9).
 */
function PlaneSummary({
  id,
  title,
  accentClassName,
  description,
  result,
  sampledAt,
  ageSeconds,
}: {
  id: string;
  title: string;
  /** Left-rule + tint pair; the two planes are deliberately different hues. */
  accentClassName: string;
  description: string;
  result: string;
  sampledAt: number | null;
  ageSeconds: number | null;
}) {
  return (
    <section className={cn("border-l-2 px-4 py-3", accentClassName)} aria-labelledby={`${id}-title`}>
      <h3 id={`${id}-title`} className="text-sm font-semibold text-foreground">
        {title}
      </h3>
      <p className="mt-1 text-xs leading-relaxed text-muted-foreground">{description}</p>
      <dl className="mt-3 grid grid-cols-2 gap-2 text-xs">
        <div>
          <dt className="text-muted-foreground">Result</dt>
          <dd className="font-mono text-foreground">{result}</dd>
        </div>
        <div>
          <dt className="text-muted-foreground">Last sample</dt>
          <dd className="text-foreground">
            {sampleLabel(sampledAt)}
            {ageSeconds != null ? ` (${formatElapsedSeconds(ageSeconds)} ago)` : ""}
          </dd>
        </div>
      </dl>
    </section>
  );
}

const probeHeader = (
  <TableHeader>
    <TableRow>
      <TableHead scope="col">Endpoint</TableHead>
      <TableHead scope="col">State</TableHead>
      <TableHead scope="col">Response</TableHead>
      <TableHead scope="col">Latency</TableHead>
      <TableHead scope="col">Diagnostic note</TableHead>
    </TableRow>
  </TableHeader>
);

export function ReliabilityEndpointsPanel({ model }: { model: ReliabilityEndpointModel }) {
  const workerAge =
    model.workerPlane.sampledAt == null ? null : Math.max(0, model.capturedAt - model.workerPlane.sampledAt);
  const browserAge =
    model.browserPlane?.updatedAt == null ? null : Math.max(0, model.capturedAt - model.browserPlane.updatedAt);

  return (
    <div className="space-y-5">
      <div className="grid items-start gap-3 md:grid-cols-2">
        <PlaneSummary
          id="worker-plane"
          title="Worker-origin self-check"
          accentClassName="border-indigo-500 bg-indigo-500/[0.05]"
          description="Runs inside the Worker to validate internal execution, bindings, and critical API behavior independently of this browser session. The status payload reports this plane as a summary and does not identify endpoint rows."
          result={`${model.workerPlane.passCount}/${model.workerPlane.sampleCount} passing · ${model.workerPlane.status}`}
          sampledAt={model.workerPlane.sampledAt}
          ageSeconds={workerAge}
        />
        <PlaneSummary
          id="browser-plane"
          title="Browser-origin endpoint probes"
          accentClassName="border-cyan-500 bg-cyan-500/[0.05]"
          description="Runs from this authenticated operator session to verify same-origin routing, Access proxy behavior, HTTP transport, and endpoint freshness semantics."
          result={
            model.browserPlane
              ? `${model.browserPlane.passCount}/${model.browserPlane.sampleCount} passing · ${model.browserPlane.status}`
              : "Unknown"
          }
          sampledAt={model.browserPlane?.updatedAt ?? null}
          ageSeconds={browserAge}
        />
      </div>

      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h3 className="text-base font-semibold text-foreground">Endpoint results</h3>
          <p className="mt-1 text-xs text-muted-foreground">
            Failed and degraded endpoints lead; healthy detail remains collapsed.
          </p>
        </div>
        <ReliabilityCopyDiagnostics text={model.diagnosticText} />
      </div>

      {model.unhealthyProbes.length > 0 ? (
        <TableFrame
          tableId="reliability-endpoints-unhealthy"
          chrome="content"
          density="compact"
          tableProps={{ "aria-label": "Failed and degraded endpoint probes" }}
        >
          {probeHeader}
          <ProbeRows probes={model.unhealthyProbes} />
        </TableFrame>
      ) : model.browserPlane ? (
        <div className="border-y border-border/60 py-3 text-sm text-muted-foreground">
          No failed or degraded browser endpoints are active.
        </div>
      ) : (
        <div className="border-y border-border/60 py-3 text-sm text-muted-foreground">
          Browser endpoint evidence is Unknown.
        </div>
      )}

      {model.healthyProbes.length > 0 ? (
        <LazyDetails
          summary={
            <summary className="pharos-focus-ring flex min-h-11 cursor-pointer items-center rounded-md text-sm font-medium text-muted-foreground">
              {model.healthyProbes.length} healthy endpoint{model.healthyProbes.length === 1 ? "" : "s"}
            </summary>
          }
        >
          <TableFrame
            tableId="reliability-endpoints-healthy"
            chrome="content"
            density="compact"
            className="mt-2"
            tableProps={{ "aria-label": "Healthy endpoint probes" }}
          >
            {probeHeader}
            <ProbeRows probes={model.healthyProbes} />
          </TableFrame>
        </LazyDetails>
      ) : null}
    </div>
  );
}
