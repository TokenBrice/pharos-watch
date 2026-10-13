import { ENDPOINT_GROUPS } from "@/hooks/use-endpoint-probes";
import type { EndpointProbeResult } from "@shared/types";
import { Badge } from "@/components/ui/badge";
import { getProbeDisplayStatus, isProbePassing } from "@/lib/status-dashboard-model";
import { PublicSignalCard } from "./public-signal-card";

const GROUP_LABELS: Array<{ key: keyof typeof ENDPOINT_GROUPS; label: string }> = [
  { key: "public", label: "Public" },
  { key: "admin", label: "Admin" },
  { key: "manual", label: "Manual actions" },
];

/** Probe words, not raw status-machine words: "Stale" never labels a probe. */
const PROBE_SEMANTIC_LABEL = { healthy: "OK", degraded: "Slow data", stale: "Failed" } as const;

/** One status word per probe; the HTTP code is printed once, beside it. */
function probeBadgeLabel(probe: EndpointProbeResult): string {
  if (probe.status == null) return "Unreachable";
  // An HTTP failure counts as failed in the summary, so the badge says so too.
  if (probe.status >= 400) return "Failed";
  if (probe.semanticStatus) return PROBE_SEMANTIC_LABEL[probe.semanticStatus];
  return probe.status < 300 ? "OK" : "Failed";
}

interface EndpointHealthGridProps {
  probes: EndpointProbeResult[] | undefined;
  isLoading: boolean;
  /** A failed probe run is not "no samples yet" (R2). */
  error?: Error | null;
  groups?: readonly (keyof typeof ENDPOINT_GROUPS)[];
  description?: string;
  footnote?: string;
}

export function EndpointHealthGrid({
  probes,
  isLoading,
  error = null,
  groups = ["public", "admin"],
  description,
  footnote,
}: EndpointHealthGridProps) {
  if (isLoading && !probes) {
    return (
      <PublicSignalCard title="Browser endpoint probes" contentClassName="mt-3">
        <p className="text-sm text-muted-foreground">Probing endpoints</p>
      </PublicSignalCard>
    );
  }
  if (error && !probes) {
    return (
      <PublicSignalCard title="Browser endpoint probes" contentClassName="mt-3">
        <p className="text-sm text-muted-foreground">Browser probes could not run: {error.message}</p>
      </PublicSignalCard>
    );
  }

  const probeMap = new Map<string, EndpointProbeResult>();
  if (probes) {
    for (const p of probes) probeMap.set(p.path, p);
  }

  const probeList = probes ?? [];
  // One pass over the shared classifier: the three independent filters this
  // replaces overlapped, so a 4xx that was also semantically degraded was
  // counted twice and the sentence summed past the sample total.
  let passCount = 0;
  let degradedCount = 0;
  let staleCount = 0;
  for (const probe of probeList) {
    const displayStatus = getProbeDisplayStatus(probe);
    if (displayStatus === "healthy") passCount += 1;
    else if (displayStatus === "degraded") degradedCount += 1;
    else staleCount += 1;
  }
  const isAdminView = groups.includes("admin");
  const summaryText =
    footnote ??
    (isAdminView
      ? "Skips endpoints without a probe group: digest-snapshot (date-specific), feedback and telegram-webhook (POST-only)."
      : "Shows public canary coverage only. Admin and manual action routes are intentionally excluded.");

  return (
    <PublicSignalCard title="Browser endpoint probes">
        <p className="text-xs text-muted-foreground">
          {description ??
            (isAdminView
              ? "Browser-origin probe loop from this admin session. /api/health, /api/status, and freshness Warning headers are interpreted semantically; other 2xx probes are transport checks."
              : "Browser-origin probe loop from this session against the public API surface. Freshness Warning headers are interpreted as data-health signals; other 2xx probes are transport checks.")}
        </p>
        <p className="text-xs text-muted-foreground">
          {probeList.length > 0
            ? `${passCount} of ${probeList.length} passing${degradedCount > 0 ? `, ${degradedCount} with slow data` : ""}${staleCount > 0 ? `, ${staleCount} failed or unreachable` : ""}.`
            : "No browser probe samples yet."}{" "}
          {summaryText}
        </p>
        {GROUP_LABELS.filter(({ key }) => groups.includes(key)).map(({ key, label }) => {
          const paths = [...ENDPOINT_GROUPS[key]];
          const isInline = key === "manual";

          if (!isInline) {
            paths.sort((a, b) => {
              const pa = probeMap.get(a);
              const pb = probeMap.get(b);
              const aErr = pa ? (isProbePassing(pa) ? 1 : 0) : 1;
              const bErr = pb ? (isProbePassing(pb) ? 1 : 0) : 1;
              if (aErr !== bErr) return aErr - bErr;
              return a.localeCompare(b);
            });
          }

          // Unsampled routes are not failures: group them behind one explicit line instead of N "—" rows.
          const unsampled = isInline ? [] : paths.filter((path) => !probeMap.has(path));
          const sampled = isInline ? paths : paths.filter((path) => probeMap.has(path));

          return (
            <div key={key}>
              <h3 className="mb-2 text-sm font-medium text-muted-foreground">{label}</h3>
              <div className="space-y-1">
                {sampled.map((path) => {
                  const probe = probeMap.get(path);
                  const display = path.replace(/^\/api\//, "");

                  if (isInline) {
                    return (
                      <div key={path} className="flex items-center justify-between py-1">
                        <span className="font-mono text-xs">{display}</span>
                        <span className="text-xs text-muted-foreground">Not probed</span>
                      </div>
                    );
                  }

                  const displayStatus = probe ? getProbeDisplayStatus(probe) : null;
                  const isOk = displayStatus === "healthy";
                  const isSemanticDegraded = displayStatus === "degraded";
                  const isError = displayStatus === "stale";
                  const statusLabel = probe ? probeBadgeLabel(probe) : "—";
                  const statusDetail = probe ? probe.error ?? probe.semanticDetail ?? null : null;

                  return (
                    <div key={path} className="flex items-start justify-between gap-3 py-1">
                      <div className="min-w-0">
                        <div className="font-mono text-xs">{display}</div>
                        {statusDetail ? (
                          <div className="mt-1 text-xs leading-relaxed text-muted-foreground">
                            {statusDetail}
                          </div>
                        ) : null}
                      </div>
                      <div className="flex shrink-0 items-center gap-2">
                        {probe ? (
                          <>
                            {isOk && (
                              <Badge className="bg-state-positive-solid/15 text-xs text-state-positive">
                                {statusLabel}
                              </Badge>
                            )}
                            {isSemanticDegraded && (
                              <Badge className="bg-state-warn-solid/15 text-xs text-state-warn">
                                {statusLabel}
                              </Badge>
                            )}
                            {isError && (
                              <Badge className="bg-state-danger-solid/15 text-xs text-state-danger">
                                {statusLabel}
                              </Badge>
                            )}
                            <span className="pharos-numeric text-xs text-muted-foreground">
                              {probe.status != null ? `HTTP ${probe.status}` : "No HTTP"}
                            </span>
                            <span className="pharos-numeric text-xs text-muted-foreground">{probe.latencyMs}ms</span>
                          </>
                        ) : (
                          <Badge className="bg-muted text-xs text-muted-foreground">—</Badge>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
              {unsampled.length > 0 ? (
                <details className="mt-2 text-xs text-muted-foreground">
                  <summary className="pharos-focus-ring cursor-pointer rounded-sm py-1 hover:text-foreground">
                    {unsampled.length} {unsampled.length === 1 ? "route" : "routes"} not sampled this session
                  </summary>
                  <ul className="mt-1 space-y-1">
                    {unsampled.map((path) => (
                      <li key={path} className="flex items-center justify-between gap-3">
                        <span className="font-mono">{path.replace(/^\/api\//, "")}</span>
                        <span>Not probed</span>
                      </li>
                    ))}
                  </ul>
                </details>
              ) : null}
            </div>
          );
        })}
    </PublicSignalCard>
  );
}
