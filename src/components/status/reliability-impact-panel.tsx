import type { HealthResponse, StatusResponse } from "@shared/types";
import { PUBLIC_HEADLINE_TONE } from "@shared/lib/classification";
import { TechnicalDetail, VerdictPill } from "@/components/status/page-primitives";
import { RELIABILITY_KIND_VERDICT, type ReliabilityIssue } from "@/lib/reliability-workspace-model";
import { describePublicHeadline, getPublicHealthWarningPresentation } from "@/lib/status/public-status";
import { cn } from "@/lib/utils";

const AVAILABILITY_VERDICT = { healthy: "ok", degraded: "watch", stale: "act" } as const;

/** Neutral by default; a left accent only when the state is not OK. */
const ACCENT = {
  neutral: "border-l-2 border-border/60",
  info: "border-l-2 border-state-info-solid bg-state-info-solid/[0.05]",
  warn: "border-l-2 border-state-warn-solid bg-state-warn-solid/[0.05]",
  danger: "border-l-2 border-state-danger-solid bg-state-danger-solid/[0.05]",
} as const;

export function ReliabilityImpactPanel({
  data,
  healthData,
  healthLoadFailed = false,
  issues,
}: {
  data: StatusResponse;
  healthData: HealthResponse | null | undefined;
  /** The health read failed: a missing payload reads "Unavailable", not "Loading" (R2). */
  healthLoadFailed?: boolean;
  issues: ReliabilityIssue[];
}) {
  const publicHeadline = describePublicHeadline(healthData, healthLoadFailed);
  const publicAccent =
    publicHeadline.state == null || publicHeadline.state === "operational"
      ? ACCENT.neutral
      : publicHeadline.state === "delayed"
        ? ACCENT.info
        : publicHeadline.state === "degraded"
          ? ACCENT.warn
          : ACCENT.danger;
  const availabilityVerdict = AVAILABILITY_VERDICT[data.availabilityStatus];
  const availabilityAccent =
    availabilityVerdict === "ok" ? ACCENT.neutral : availabilityVerdict === "watch" ? ACCENT.warn : ACCENT.danger;
  return (
    <div className="space-y-5">
      <div className="grid items-start gap-3 md:grid-cols-2">
        <section className={cn("px-4 py-3", publicAccent)} aria-labelledby="public-impact-title">
          <h3 id="public-impact-title" className="text-sm font-semibold text-foreground">
            Public service impact
          </h3>
          <div
            className={cn(
              "mt-1 text-lg font-semibold",
              publicHeadline.state ? PUBLIC_HEADLINE_TONE[publicHeadline.state].text : "text-muted-foreground",
            )}
          >
            {publicHeadline.label}
          </div>
          {publicHeadline.title ? <p className="text-sm text-foreground">{publicHeadline.title}</p> : null}
          <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
            {healthData
              ? healthData.warnings.length > 0
                ? healthData.warnings
                    .map((warning) => getPublicHealthWarningPresentation(warning, healthData).detail)
                    .join(" ")
                : "No public health warning is active."
              : healthLoadFailed
                ? "Public health could not be read; no healthy state is inferred."
                : "Public health is loading; no healthy state is inferred."}
          </p>
          {healthData ? <TechnicalDetail className="mt-1">/api/health status: {healthData.status}</TechnicalDetail> : null}
        </section>
        <section className={cn("px-4 py-3", availabilityAccent)} aria-labelledby="operator-impact-title">
          <h3 id="operator-impact-title" className="text-sm font-semibold text-foreground">
            Operator availability
          </h3>
          <div className="mt-1">
            <VerdictPill verdict={availabilityVerdict} />
          </div>
          <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
            Probe and cache detail remain in their focused views.
          </p>
          <TechnicalDetail className="mt-1">
            availability {data.availabilityStatus} · raw overall {data.rawOverallStatus} · held {data.overallStatus}
          </TechnicalDetail>
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
                  <TechnicalDetail className="mt-1">{issue.rawCode} · {issue.kind}</TechnicalDetail>
                </div>
                <VerdictPill verdict={RELIABILITY_KIND_VERDICT[issue.kind]} className="shrink-0 self-start" />
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
