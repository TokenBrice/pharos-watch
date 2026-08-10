import { ENDPOINT_GROUPS } from "@/hooks/use-endpoint-probes";
import type { EndpointProbeResult } from "@shared/types";
import { Badge } from "@/components/ui/badge";
import { getProbeStatusDetail, getProbeStatusLabel, isProbePassing } from "@/lib/status-dashboard-model";
import { PublicSignalCard } from "./public-signal-card";

const GROUP_LABELS: Array<{ key: keyof typeof ENDPOINT_GROUPS; label: string }> = [
  { key: "public", label: "Public" },
  { key: "admin", label: "Admin" },
  { key: "manual", label: "Manual Actions" },
];

interface EndpointHealthGridProps {
  probes: EndpointProbeResult[] | undefined;
  isLoading: boolean;
  groups?: readonly (keyof typeof ENDPOINT_GROUPS)[];
  description?: string;
  footnote?: string;
}

export function EndpointHealthGrid({
  probes,
  isLoading,
  groups = ["public", "admin"],
  description,
  footnote,
}: EndpointHealthGridProps) {
  if (isLoading && !probes) {
    return (
      <PublicSignalCard title="Browser Endpoint Probes" contentClassName="mt-3">
        <p className="text-sm text-muted-foreground">Probing endpoints...</p>
      </PublicSignalCard>
    );
  }

  const probeMap = new Map<string, EndpointProbeResult>();
  if (probes) {
    for (const p of probes) probeMap.set(p.path, p);
  }

  const probeList = probes ?? [];
  const passCount = probeList.filter((probe) => isProbePassing(probe)).length;
  const degradedCount = probeList.filter((probe) => probe.semanticStatus === "degraded").length;
  const staleCount = probeList.filter(
    (probe) => probe.semanticStatus === "stale" || probe.status == null || probe.status >= 400,
  ).length;
  const isAdminView = groups.includes("admin");
  const summaryText =
    footnote ??
    (isAdminView
      ? "Skips endpoints without a probe group: digest-snapshot (date-specific), feedback and telegram-webhook (POST-only)."
      : "Shows public canary coverage only. Admin and manual action routes are intentionally excluded.");

  return (
    <PublicSignalCard title="Browser Endpoint Probes">
        <p className="text-xs text-muted-foreground">
          {description ??
            (isAdminView
              ? "Browser-origin probe loop from this admin session. `/api/health`, `/api/status`, and freshness Warning headers are interpreted semantically; other 2xx probes are transport checks."
              : "Browser-origin probe loop from this session against the public API surface. Freshness Warning headers are interpreted as data-health signals; other 2xx probes are transport checks.")}
        </p>
        <p className="text-xs text-muted-foreground">
          {probeList.length > 0
            ? `${passCount}/${probeList.length} healthy or reachable, ${degradedCount} degraded, ${staleCount} stale or unreachable.`
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

          return (
            <div key={key}>
              <h3 className="mb-2 text-sm font-medium text-muted-foreground">{label}</h3>
              <div className="space-y-1">
                {paths.map((path) => {
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

                  const isOk = probe ? isProbePassing(probe) : false;
                  const isSemanticDegraded = probe?.semanticStatus === "degraded";
                  const isError = probe?.status == null || probe.status >= 400 || probe?.semanticStatus === "stale";
                  const statusLabel = probe ? getProbeStatusLabel(probe) : "—";
                  const statusDetail = probe ? getProbeStatusDetail(probe) : null;

                  return (
                    <div key={path} className="flex items-start justify-between gap-3 py-1">
                      <div className="min-w-0">
                        <div className="font-mono text-xs">{display}</div>
                        {statusDetail ? (
                          <div className="mt-1 text-[11px] leading-relaxed text-muted-foreground">
                            {statusDetail}
                          </div>
                        ) : null}
                      </div>
                      <div className="flex shrink-0 items-center gap-2">
                        {probe ? (
                          <>
                            {isOk && (
                              <Badge className="bg-emerald-500/15 text-xs text-emerald-700 dark:text-emerald-400">
                                {statusLabel}
                              </Badge>
                            )}
                            {isSemanticDegraded && (
                              <Badge className="bg-amber-500/15 text-xs text-amber-700 dark:text-amber-400">
                                {statusLabel}
                              </Badge>
                            )}
                            {isError && (
                              <Badge className="bg-red-500/15 text-xs text-red-700 dark:text-red-400">
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
            </div>
          );
        })}
    </PublicSignalCard>
  );
}
