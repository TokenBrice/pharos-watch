import { formatElapsedSeconds } from "@shared/lib/format";
import type { EndpointProbeResult } from "@shared/types";
import { TableBody, TableCell, TableFrame, TableHead, TableHeader, TableRow } from "@/components/table";
import { ReliabilityCopyDiagnostics } from "@/components/status/reliability-copy-diagnostics";
import { StatusPill } from "@/components/status/severity-pill";
import type { ReliabilityEndpointModel } from "@/lib/reliability-workspace-model";
import { sanitizeReliabilityProbePath } from "@/lib/reliability-workspace-model";
import { getProbeStatusDetail, getProbeStatusLabel, isProbePassing } from "@/lib/status-dashboard-model";

function sampleLabel(timestamp: number | null): string {
  return timestamp ? new Date(timestamp * 1_000).toLocaleString() : "Unknown";
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
                    ? "bg-green-500/15 text-green-700 dark:text-green-300"
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
        <section
          className="border-l-2 border-indigo-500 bg-indigo-500/[0.05] px-4 py-3"
          aria-labelledby="worker-plane-title"
        >
          <h3 id="worker-plane-title" className="text-sm font-semibold text-foreground">
            Worker-origin self-check
          </h3>
          <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
            Runs inside the Worker to validate internal execution, bindings, and critical API behavior independently of
            this browser session. The status payload reports this plane as a summary and does not identify endpoint
            rows.
          </p>
          <dl className="mt-3 grid grid-cols-2 gap-2 text-xs">
            <div>
              <dt className="text-muted-foreground">Result</dt>
              <dd className="font-mono text-foreground">
                {model.workerPlane.passCount}/{model.workerPlane.sampleCount} passing · {model.workerPlane.status}
              </dd>
            </div>
            <div>
              <dt className="text-muted-foreground">Last sample</dt>
              <dd className="text-foreground">
                {sampleLabel(model.workerPlane.sampledAt)}
                {workerAge != null ? ` (${formatElapsedSeconds(workerAge)} ago)` : ""}
              </dd>
            </div>
          </dl>
        </section>
        <section
          className="border-l-2 border-cyan-500 bg-cyan-500/[0.05] px-4 py-3"
          aria-labelledby="browser-plane-title"
        >
          <h3 id="browser-plane-title" className="text-sm font-semibold text-foreground">
            Browser-origin endpoint probes
          </h3>
          <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
            Runs from this authenticated operator session to verify same-origin routing, Access proxy behavior, HTTP
            transport, and endpoint freshness semantics.
          </p>
          <dl className="mt-3 grid grid-cols-2 gap-2 text-xs">
            <div>
              <dt className="text-muted-foreground">Result</dt>
              <dd className="font-mono text-foreground">
                {model.browserPlane
                  ? `${model.browserPlane.passCount}/${model.browserPlane.sampleCount} passing · ${model.browserPlane.status}`
                  : "Unknown"}
              </dd>
            </div>
            <div>
              <dt className="text-muted-foreground">Last sample</dt>
              <dd className="text-foreground">
                {sampleLabel(model.browserPlane?.updatedAt ?? null)}
                {browserAge != null ? ` (${formatElapsedSeconds(browserAge)} ago)` : ""}
              </dd>
            </div>
          </dl>
        </section>
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
        <details>
          <summary className="pharos-focus-ring flex min-h-11 cursor-pointer items-center rounded-md text-sm font-medium text-muted-foreground">
            {model.healthyProbes.length} healthy endpoint{model.healthyProbes.length === 1 ? "" : "s"}
          </summary>
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
        </details>
      ) : null}
    </div>
  );
}
