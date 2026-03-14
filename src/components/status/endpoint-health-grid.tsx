import { ENDPOINT_GROUPS } from "@/hooks/use-endpoint-probes";
import type { EndpointProbeResult } from "@shared/types";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

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
  groups = ["public", "admin", "manual"],
  description,
  footnote,
}: EndpointHealthGridProps) {
  if (isLoading && !probes) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Browser Endpoint Probes</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground">Probing endpoints...</p>
        </CardContent>
      </Card>
    );
  }

  const probeMap = new Map<string, EndpointProbeResult>();
  if (probes) {
    for (const p of probes) probeMap.set(p.path, p);
  }

  const probeList = probes ?? [];
  const passCount = probeList.filter((probe) => probe.status != null && probe.status >= 200 && probe.status < 300).length;
  const failCount = probeList.filter((probe) => probe.status == null || probe.status >= 400).length;
  const isAdminView = groups.includes("admin");
  const summaryText =
    footnote ??
    (isAdminView
      ? "Skips endpoints without a probe group: digest-snapshot (date-specific), feedback and telegram-webhook (POST-only)."
      : "Shows public canary coverage only. Admin and manual action routes are intentionally excluded.");

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Browser Endpoint Probes</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <p className="text-xs text-muted-foreground">
          {description ??
            (isAdminView
              ? "Browser-origin probe loop from this admin session. Compare it with the worker self-check above when diagnosing divergence."
              : "Browser-origin probe loop from this session against the public API surface.")}
        </p>
        <p className="text-xs text-muted-foreground">
          {probeList.length > 0 ? `${passCount}/${probeList.length} passing, ${failCount} failing or unreachable.` : "No browser probe samples yet."} {summaryText}
        </p>
        {GROUP_LABELS.filter(({ key }) => groups.includes(key)).map(({ key, label }) => {
          const paths = [...ENDPOINT_GROUPS[key]];
          const isInline = key === "manual";

          if (!isInline) {
            paths.sort((a, b) => {
              const pa = probeMap.get(a);
              const pb = probeMap.get(b);
              const aErr = pa ? (pa.status === null || pa.status >= 400 ? 0 : 1) : 1;
              const bErr = pb ? (pb.status === null || pb.status >= 400 ? 0 : 1) : 1;
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

                  const isOk = probe?.status != null && probe.status >= 200 && probe.status < 300;
                  const isError = probe?.status != null && probe.status >= 400;

                  return (
                    <div key={path} className="flex items-center justify-between py-1">
                      <span className="font-mono text-xs">{display}</span>
                      <div className="flex items-center gap-2">
                        {probe ? (
                          <>
                            {isOk && (
                              <Badge className="bg-green-500/15 text-xs text-green-700 dark:text-green-400">
                                {probe.status}
                              </Badge>
                            )}
                            {isError && (
                              <Badge className="bg-red-500/15 text-xs text-red-700 dark:text-red-400">
                                {probe.status}
                              </Badge>
                            )}
                            {probe.status === null && (
                              <Badge className="bg-muted text-xs text-muted-foreground">—</Badge>
                            )}
                            <span className="text-xs tabular-nums text-muted-foreground">{probe.latencyMs}ms</span>
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
      </CardContent>
    </Card>
  );
}
