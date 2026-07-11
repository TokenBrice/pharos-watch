import { TableBody, TableCell, TableFrame, TableHead, TableHeader, TableRow } from "@/components/table";
import { ReliabilityCopyDiagnostics } from "@/components/status/reliability-copy-diagnostics";
import { StatusPill } from "@/components/status/severity-pill";
import type { ReliabilityDependenciesModel } from "@/lib/reliability-workspace-model";

function stateClass(state: string): string {
  if (state === "stale" || state === "open" || state === "error") return "bg-red-500/15 text-red-700 dark:text-red-300";
  if (state === "degraded" || state === "half-open") return "bg-amber-500/15 text-amber-800 dark:text-amber-300";
  if (state === "healthy" || state === "closed" || state === "ok")
    return "bg-green-500/15 text-green-700 dark:text-green-300";
  return "bg-muted text-muted-foreground";
}

function timeLabel(timestamp: number | null): string {
  return timestamp ? new Date(timestamp * 1_000).toLocaleString() : "Unknown";
}

export function ReliabilityDependenciesPanel({ model }: { model: ReliabilityDependenciesModel }) {
  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="max-w-3xl">
          <h3 className="text-base font-semibold text-foreground">Dependencies and provider circuits</h3>
          <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
            Root-cause groups lead symptom rows. Copied diagnostics contain only allowlisted status fields and omit raw
            error text, request headers, tokens, and query strings.
          </p>
        </div>
        <ReliabilityCopyDiagnostics text={model.diagnosticText} />
      </div>

      <section aria-labelledby="dependency-roots-title" className="space-y-2">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h3 id="dependency-roots-title" className="text-sm font-semibold text-foreground">
            Dependency root causes
          </h3>
          <span className="text-xs text-muted-foreground">
            {model.dependencySummary
              ? `${model.dependencySummary.rootCauseGroupCount} roots · ${model.dependencySummary.stale} stale · ${model.dependencySummary.degraded} degraded · ${model.dependencySummary.unknown} unknown`
              : "Unknown"}
          </span>
        </div>
        {model.roots.length > 0 ? (
          <TableFrame
            tableId="reliability-dependency-roots"
            chrome="content"
            density="compact"
            tableProps={{ "aria-label": "Dependency root causes" }}
          >
            <TableHeader>
              <TableRow>
                <TableHead scope="col">Root</TableHead>
                <TableHead scope="col">State</TableHead>
                <TableHead scope="col">Impact</TableHead>
                <TableHead scope="col">Evidence</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {model.roots.map((root) => (
                <TableRow key={root.id}>
                  <TableCell className="min-w-52 whitespace-normal align-top">
                    <div className="font-medium text-foreground">{root.label}</div>
                    <code className="text-[10px] text-muted-foreground">{root.id}</code>
                  </TableCell>
                  <TableCell className="align-top">
                    <StatusPill className={stateClass(root.status)}>{root.status}</StatusPill>
                  </TableCell>
                  <TableCell className="min-w-48 whitespace-normal align-top text-xs text-muted-foreground">
                    {root.impactedCount} dependencies · {root.consumers.join(", ") || "consumers unknown"}
                  </TableCell>
                  <TableCell className="min-w-64 whitespace-normal align-top text-xs text-muted-foreground">
                    {root.reason ?? "No root-cause reason reported."}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </TableFrame>
        ) : (
          <div className="border-y border-border/60 py-3 text-sm text-muted-foreground">
            {model.dependencySummary
              ? "No active dependency root causes."
              : "Dependency root-cause evidence is Unknown."}
          </div>
        )}
      </section>

      <div className="grid items-start gap-5 xl:grid-cols-2">
        <section aria-labelledby="provider-circuits-title" className="min-w-0 space-y-2">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <h3 id="provider-circuits-title" className="text-sm font-semibold text-foreground">
              Provider circuits
            </h3>
            <span className="text-xs text-muted-foreground">
              {model.providerSummary
                ? `${model.providerSummary.openCount} open · ${model.providerSummary.halfOpenCount} half-open · ${model.providerSummary.closedCount} closed`
                : "Unknown"}
            </span>
          </div>
          {model.providerCircuits.length > 0 ? (
            <div className="divide-y divide-border/60 border-y border-border/60">
              {model.providerCircuits.map((circuit) => (
                <div key={circuit.providerId} className="flex items-start justify-between gap-3 py-3 text-xs">
                  <div className="min-w-0">
                    <div className="font-medium text-foreground">{circuit.providerId}</div>
                    <div className="text-muted-foreground">
                      {circuit.family} · last failure {timeLabel(circuit.lastFailureAt)}
                    </div>
                  </div>
                  <StatusPill className={stateClass(circuit.state)}>{circuit.state}</StatusPill>
                </div>
              ))}
            </div>
          ) : (
            <div className="border-y border-border/60 py-3 text-sm text-muted-foreground">
              {model.providerSummary
                ? "No open or half-open provider circuits."
                : "Provider circuit evidence is Unknown."}
            </div>
          )}
        </section>

        <section aria-labelledby="public-circuits-title" className="min-w-0 space-y-2">
          <h3 id="public-circuits-title" className="text-sm font-semibold text-foreground">
            Public service circuit breakers
          </h3>
          {model.publicCircuits.length > 0 ? (
            <div className="divide-y divide-border/60 border-y border-border/60">
              {model.publicCircuits.map(([name, circuit]) => (
                <div key={name} className="flex items-start justify-between gap-3 py-3 text-xs">
                  <div className="min-w-0">
                    <div className="font-medium text-foreground">{name}</div>
                    <div className="text-muted-foreground">
                      {circuit.consecutiveFailures} failures · opened {timeLabel(circuit.openedAt)}
                    </div>
                  </div>
                  <StatusPill className={stateClass(circuit.state)}>{circuit.state}</StatusPill>
                </div>
              ))}
            </div>
          ) : (
            <div className="border-y border-border/60 py-3 text-sm text-muted-foreground">
              {model.publicCircuitEvidenceAvailable
                ? "No tripped public service circuit breakers."
                : "Public circuit evidence depends on the public-health response."}
            </div>
          )}
        </section>
      </div>

      <section aria-labelledby="canaries-title" className="space-y-2">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h3 id="canaries-title" className="text-sm font-semibold text-foreground">
            Invariant canaries
          </h3>
          <span className="text-xs text-muted-foreground">
            {model.canarySummary
              ? `${model.canarySummary.okCount}/${model.canarySummary.totalChecks} passing · sampled ${timeLabel(model.canarySummary.latestRunAt)}`
              : "Unknown"}
          </span>
        </div>
        {model.canaryChecks.length > 0 ? (
          <div className="divide-y divide-border/60 border-y border-border/60">
            {model.canaryChecks.map((check) => (
              <div
                key={check.checkId}
                className="flex flex-col gap-2 py-3 sm:flex-row sm:items-start sm:justify-between"
              >
                <div className="min-w-0">
                  <div className="text-sm font-medium text-foreground">{check.label}</div>
                  <p className="mt-1 text-xs text-muted-foreground">{check.error ?? check.description}</p>
                  <code className="mt-1 block text-[10px] text-muted-foreground">{check.checkId}</code>
                </div>
                <StatusPill className={stateClass(check.status)}>{check.status}</StatusPill>
              </div>
            ))}
          </div>
        ) : (
          <div className="border-y border-border/60 py-3 text-sm text-muted-foreground">
            {model.canarySummary ? "No canary checks were reported." : "Invariant canary evidence is Unknown."}
          </div>
        )}
      </section>
    </div>
  );
}
