import type { HealthResponse, StatusResponse } from "@shared/types";
import type { ReliabilityIssue, ReliabilityIssueKind } from "@/lib/reliability-workspace-model";
import { getPublicHealthWarningPresentation } from "@/lib/status/public-status";
import { cn } from "@/lib/utils";

const KIND_CLASS: Record<ReliabilityIssueKind, string> = {
  critical: "border-red-500/30 bg-red-500/10 text-red-700 dark:text-red-300",
  warning: "border-amber-500/30 bg-amber-500/10 text-amber-800 dark:text-amber-300",
  maintenance: "border-blue-500/30 bg-blue-500/10 text-blue-700 dark:text-blue-300",
  informational: "border-border bg-muted text-muted-foreground",
  unknown: "border-border bg-muted text-muted-foreground",
};

export function ReliabilityImpactPanel({
  data,
  healthData,
  issues,
}: {
  data: StatusResponse;
  healthData: HealthResponse | null | undefined;
  issues: ReliabilityIssue[];
}) {
  return (
    <div className="space-y-5">
      <div className="grid items-start gap-3 md:grid-cols-2">
        <section
          className="border-l-2 border-sky-500 bg-sky-500/[0.05] px-4 py-3"
          aria-labelledby="public-impact-title"
        >
          <h3 id="public-impact-title" className="text-sm font-semibold text-foreground">
            Public service impact
          </h3>
          <div className="mt-1 font-mono text-lg font-semibold text-foreground">{healthData?.status ?? "Unknown"}</div>
          <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
            {healthData
              ? healthData.warnings.length > 0
                ? healthData.warnings
                    .map((warning) => getPublicHealthWarningPresentation(warning, healthData).detail)
                    .join(" ")
                : "No public health warning is active."
              : "Public health evidence has not loaded; no healthy state is inferred."}
          </p>
        </section>
        <section
          className="border-l-2 border-amber-500 bg-amber-500/[0.05] px-4 py-3"
          aria-labelledby="operator-impact-title"
        >
          <h3 id="operator-impact-title" className="text-sm font-semibold text-foreground">
            Operator availability
          </h3>
          <div className="mt-1 font-mono text-lg font-semibold text-foreground">{data.availabilityStatus}</div>
          <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
            Raw overall state {data.rawOverallStatus}; held state {data.overallStatus}. Probe and cache detail remain in
            their focused views.
          </p>
        </section>
      </div>

      <section aria-labelledby="reliability-issues-title" className="space-y-3">
        <div>
          <h3 id="reliability-issues-title" className="text-base font-semibold text-foreground">
            Deduplicated impact issues
          </h3>
          <p className="mt-1 text-xs text-muted-foreground">
            Repeated overall, availability, and data-quality causes share one stable issue identity.
          </p>
        </div>
        {issues.length > 0 ? (
          <ul className="divide-y divide-border/60 border-y border-border/60">
            {issues.map((issue) => (
              <li key={issue.id} className="flex flex-col gap-2 py-3 sm:flex-row sm:items-start sm:justify-between">
                <div className="min-w-0">
                  <div className="text-sm font-medium text-foreground">{issue.label}</div>
                  <div className="mt-1 text-xs leading-relaxed text-muted-foreground">{issue.detail}</div>
                  <code className="mt-1 block break-all text-[10px] text-muted-foreground">{issue.rawCode}</code>
                </div>
                <span
                  className={cn("shrink-0 rounded border px-2 py-1 text-[11px] font-medium", KIND_CLASS[issue.kind])}
                >
                  {issue.kind}
                </span>
              </li>
            ))}
          </ul>
        ) : (
          <div className="border-y border-border/60 py-4 text-sm text-muted-foreground">
            No deduplicated reliability impact issues are active.
          </div>
        )}
      </section>
    </div>
  );
}
