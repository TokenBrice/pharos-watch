import { TableBody, TableCell, TableFrame, TableHead, TableHeader, TableRow } from "@/components/table";
import { ReliabilityCopyDiagnostics } from "@/components/status/reliability-copy-diagnostics";
import { TechnicalDetail, Timestamp, VerdictPill } from "@/components/status/page-primitives";
import {
  getReliabilityStateVerdict,
  type ReliabilityCircuitRow,
  type ReliabilityDependenciesModel,
} from "@/lib/reliability-workspace-model";
import { PUBLIC_COMPONENT_LABEL } from "@shared/lib/classification";

type CanaryCheck = ReliabilityDependenciesModel["canaryChecks"][number];

function CanaryRow({ check }: { check: CanaryCheck }) {
  return (
    <div className="flex flex-col gap-2 py-3 sm:flex-row sm:items-start sm:justify-between">
      <div className="min-w-0">
        <div className="text-sm font-medium text-foreground">{check.label}</div>
        <p className="mt-1 text-xs text-muted-foreground">{check.error ?? check.description}</p>
        <TechnicalDetail className="mt-1">{check.checkId} · {check.status}</TechnicalDetail>
      </div>
      <VerdictPill verdict={getReliabilityStateVerdict(check.status)} className="shrink-0" />
    </div>
  );
}

function CircuitRow({ circuit }: { circuit: ReliabilityCircuitRow }) {
  return (
    <div className="flex items-start justify-between gap-3 py-3 text-xs">
      <div className="min-w-0 space-y-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="break-all font-medium text-foreground">{circuit.key}</span>
          {circuit.publicImpact ? (
            // An open public-scope breaker degrades this public component (shared projection).
            <span className="rounded-sm border border-border/70 px-1.5 py-0.5 text-xs text-foreground">
              Public: {PUBLIC_COMPONENT_LABEL["data-refresh"]}
            </span>
          ) : null}
        </div>
        <div className="text-muted-foreground">
          {circuit.family ? `${circuit.family} provider family` : "Provider family not reported"}
          {" · "}
          <span className="pharos-numeric">{circuit.consecutiveFailures}</span> consecutive failures
        </div>
        <div className="text-muted-foreground">
          {circuit.state === "open" ? "Open since " : "Opened "}
          <Timestamp epochSec={circuit.openedAt} fallback="an unreported time" />
          {" · last failure "}
          <Timestamp epochSec={circuit.lastFailureAt} fallback="not reported" />
        </div>
      </div>
      <VerdictPill
        verdict={circuit.state === "open" && circuit.publicImpact ? "act" : "watch"}
        label={circuit.state === "open" ? "Open" : circuit.state === "half-open" ? "Half-open" : "Closed"}
      />
    </div>
  );
}

export function ReliabilityDependenciesPanel({ model }: { model: ReliabilityDependenciesModel }) {
  const passingCanaries = model.canaryChecks.filter((check) => check.status === "ok");
  const failingCanaries = model.canaryChecks.filter((check) => check.status !== "ok");
  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="max-w-3xl">
          <h3 className="text-base font-semibold text-foreground">Dependencies and circuits</h3>
          <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
            Tripped circuits lead, then dependency root-cause groups and invariant canaries. Copied diagnostics contain only allowlisted status fields and omit raw
            error text, request headers, tokens, and query strings.
          </p>
        </div>
        <ReliabilityCopyDiagnostics text={model.diagnosticText} />
      </div>

      <section aria-labelledby="circuits-title" className="min-w-0 space-y-2">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h3 id="circuits-title" className="text-sm font-semibold text-foreground">
            Tripped circuits
          </h3>
          <span className="text-xs text-muted-foreground">
            {model.providerSummary
              ? `${model.providerSummary.openCount} open · ${model.providerSummary.halfOpenCount} half-open · ${model.providerSummary.closedCount} closed · ${model.providerSummary.invalidCount ?? "unknown"} invalid`
              : "Provider counts unknown"}
          </span>
        </div>
        {model.circuits.length > 0 ? (
          <div className="divide-y divide-border/60 border-y border-border/60">
            {model.circuits.map((circuit) => (
              <CircuitRow key={circuit.key} circuit={circuit} />
            ))}
          </div>
        ) : (
          <div className="border-y border-border/60 py-3 text-sm text-muted-foreground">
            {model.providerSummary || model.publicCircuitEvidenceAvailable
              ? "No open or half-open circuits."
              : "Circuit evidence is Unknown."}
          </div>
        )}
        {model.providerSummary && !model.publicCircuitEvidenceAvailable ? (
          <p className="text-xs text-muted-foreground">
            Public-health circuits are not loaded, so public-only breakers may be missing from this list.
          </p>
        ) : null}
      </section>

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
                    <TechnicalDetail>{root.id} · {root.status}</TechnicalDetail>
                  </TableCell>
                  <TableCell className="align-top">
                    <VerdictPill verdict={getReliabilityStateVerdict(root.status)} />
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
            {!model.dependencySummary
              ? "Dependency root-cause evidence is Unknown."
              : model.circuits.length > 0
                ? "The dependency graph reports no root-cause groups. The tripped circuits listed above are tracked by the circuit breakers, not the dependency graph."
                : "No dependency root-cause groups reported."}
          </div>
        )}
      </section>

      <section aria-labelledby="canaries-title" className="space-y-2">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h3 id="canaries-title" className="text-sm font-semibold text-foreground">
            Invariant canaries
          </h3>
          <span className="text-xs text-muted-foreground">
            {model.canarySummary
              ? (
                <>
                  {model.canarySummary.okCount}/{model.canarySummary.totalChecks} passing · sampled{" "}
                  <Timestamp epochSec={model.canarySummary.latestRunAt} fallback="at an unreported time" />
                </>
              )
              : "Unknown"}
          </span>
        </div>
        {model.canaryChecks.length > 0 ? (
          <>
            {failingCanaries.length > 0 ? (
              <div className="divide-y divide-border/60 border-y border-border/60">
                {failingCanaries.map((check) => (
                  <CanaryRow key={check.checkId} check={check} />
                ))}
              </div>
            ) : null}
            {passingCanaries.length > 0 ? (
              <details className="border-y border-border/60 text-sm">
                <summary className="pharos-focus-ring flex min-h-11 cursor-pointer items-center rounded-md text-muted-foreground">
                  <span className="pharos-numeric">
                    {passingCanaries.length}/{model.canaryChecks.length}
                  </span>
                  &nbsp;passing
                </summary>
                <div className="divide-y divide-border/60">
                  {passingCanaries.map((check) => (
                    <CanaryRow key={check.checkId} check={check} />
                  ))}
                </div>
              </details>
            ) : null}
          </>
        ) : (
          <div className="border-y border-border/60 py-3 text-sm text-muted-foreground">
            {model.canarySummary ? "No canary checks were reported." : "Invariant canary evidence is Unknown."}
          </div>
        )}
      </section>
    </div>
  );
}
