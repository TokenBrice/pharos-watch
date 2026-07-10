import { useState } from "react";
import type { HealthResponse, StatusResponse, StatusTransition } from "@shared/types";
import { formatElapsedSeconds } from "@shared/lib/format";
import { FreshnessIndicator } from "@/components/status/freshness-indicator";
import { RecommendedActionStrip } from "@/components/status/recommended-action-strip";
import { RefreshControl } from "@/components/status/refresh-countdown";
import { SummaryBadge } from "@/components/status/page-primitives";
import { SystemDiagnostics } from "@/components/status/system-diagnostics";
import { getTopFoldCopy, isRecoveryHold as isRecoveryHoldState } from "@/components/status/top-fold-copy";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import {
  buildActionReadinessChecks,
  buildReserveRecoveryForecast,
  formatNextRunWindow,
} from "@/lib/status/admin-ops-insights";
import type { StatusActionRecommendation } from "@/lib/status/action-recommendations";
import { getAdminWorkspacePathForLegacyHash } from "@/lib/admin-workspaces";
import {
  type BrowserProbeSummary,
  type DashboardDecision,
  type DashboardEvidence,
  type DashboardIssueGroups,
  type DashboardQuerySync,
  type DashboardSection,
  STATUS_DASHBOARD_FRESHNESS_POLICY,
  buildDashboardDecision,
  buildDashboardEvidence,
  formatTransitionLabel,
  formatTimestampSeconds,
  getIssueKindBadgeClass,
  getStatusTone,
  groupDashboardIssues,
  normalizeStatusIssues,
} from "@/lib/status-dashboard-model";
import { cn } from "@/lib/utils";

function formatReserveCoverage(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

function getEvidenceBadgeClass(state: DashboardEvidence["state"]): string {
  if (state === "current") return "border-green-500/30 bg-green-500/10 text-green-700 dark:text-green-300";
  if (state === "stale" || state === "unavailable") {
    return "border-red-500/30 bg-red-500/10 text-red-700 dark:text-red-300";
  }
  return "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300";
}

export interface TriageSummaryProps {
  data: StatusResponse;
  healthData: HealthResponse | null | undefined;
  overallTone: ReturnType<typeof getStatusTone>;
  statusHoldingAge: number;
  issueGroups?: DashboardIssueGroups;
  evidence?: DashboardEvidence;
  decision?: DashboardDecision;
  latestTransition: StatusTransition | null;
  attentionSections: DashboardSection[];
  recommendedActions: StatusActionRecommendation[];
  isDiagnosticsOpen: boolean;
  setIsDiagnosticsOpen: (open: boolean) => void;
  browserProbeSummary: BrowserProbeSummary | null;
  probeCoverageLabel?: string;
  querySyncs: DashboardQuerySync[];
  clientDataAgeSec: number | null;
  clientDataStale: boolean;
  lastUpdated: number;
  handleRefresh: () => void;
  onSignOut?: () => void;
  showSignOut?: boolean;
}

export function TriageSummary({
  data,
  healthData,
  overallTone,
  statusHoldingAge,
  issueGroups,
  evidence,
  decision,
  latestTransition,
  attentionSections,
  recommendedActions,
  isDiagnosticsOpen,
  setIsDiagnosticsOpen,
  browserProbeSummary,
  probeCoverageLabel = "Browser probes",
  querySyncs,
  clientDataAgeSec,
  clientDataStale,
  lastUpdated,
  handleRefresh,
  onSignOut,
  showSignOut = true,
}: TriageSummaryProps) {
  const [areIssuesExpanded, setAreIssuesExpanded] = useState(false);
  const topFoldCopy = getTopFoldCopy(data.overallStatus, data.rawOverallStatus);
  const isRecoveryHold = isRecoveryHoldState(data.overallStatus, data.rawOverallStatus);
  const resolvedIssueGroups = issueGroups ?? groupDashboardIssues(normalizeStatusIssues(data.causes));
  const resolvedEvidence = evidence ?? buildDashboardEvidence(querySyncs);
  const resolvedDecision =
    decision ??
    buildDashboardDecision({
      data,
      healthData,
      evidence: resolvedEvidence,
      issueGroups: resolvedIssueGroups,
      recommendedActions,
    });
  const activeIssues = [
    ...resolvedIssueGroups.impacting,
    ...resolvedIssueGroups.warnings,
    ...resolvedIssueGroups.maintenance,
    ...resolvedIssueGroups.watches,
  ];
  const evidenceNeedsRefresh =
    resolvedDecision.nextStep === "refresh-evidence" || resolvedDecision.nextStep === "action-blocked";
  const statusSync = querySyncs.find((s) => s.key === "status");
  const healthSync = querySyncs.find((s) => s.key === "health");
  const probeSync = querySyncs.find((s) => s.key === "probes");
  const requestSourceSync = querySyncs.find((s) => s.key === "requestSource");
  const reserveScoreInputHold =
    data.reserveComposition.status !== "healthy" ||
    data.reserveComposition.deferredCoins > 0 ||
    data.reserveComposition.runBudgetTruncated ||
    data.reserveComposition.writeTimeoutUncertain > 0;
  const reserveForecast = buildReserveRecoveryForecast(data);
  const actionReadinessChecks = buildActionReadinessChecks({
    data,
    healthData,
    clientDataStale,
    recommendedActions,
  });
  const reserveForecastTone =
    reserveForecast.state === "blocked"
      ? "border-red-500/30 bg-red-500/10 text-red-900 dark:text-red-200"
      : reserveForecast.state === "clear"
        ? "border-green-500/30 bg-green-500/10 text-green-900 dark:text-green-200"
        : "border-amber-500/30 bg-amber-500/10 text-amber-950 dark:text-amber-100";

  return (
    <section
      id="overview"
      aria-labelledby="triage-title"
      className={cn("scroll-mt-36 rounded-xl border px-4 py-4 sm:px-5 lg:px-6", topFoldCopy.shell)}
    >
      <div className="space-y-4">
        {/* Triage header: status + key metrics + controls */}
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex flex-wrap items-center gap-3">
            <h1 id="triage-title" className="mr-1 text-lg font-semibold text-foreground">
              Triage
            </h1>
            <span
              className={cn(
                "inline-flex items-center gap-2 rounded-full border px-3 py-1.5 text-xs font-medium uppercase tracking-[0.14em]",
                overallTone.badgeClassName,
              )}
            >
              <span
                className={cn(
                  "h-2 w-2 rounded-full",
                  resolvedDecision.systemState === "stale" || resolvedDecision.systemState === "unknown"
                    ? "bg-[var(--severity-severe)]"
                    : resolvedDecision.systemState === "degraded"
                      ? "bg-[var(--severity-mild)]"
                      : "bg-[var(--severity-healthy)]",
                )}
                aria-hidden="true"
              />
              {resolvedDecision.systemLabel}
            </span>
            <span
              className={cn(
                "inline-flex items-center rounded-full border px-2.5 py-1 text-[11px] font-medium",
                getEvidenceBadgeClass(resolvedEvidence.state),
              )}
            >
              Evidence: {resolvedEvidence.label}
            </span>
            {isRecoveryHold && (
              <TooltipProvider>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <span className="cursor-help rounded-full border border-amber-500/30 bg-amber-500/10 px-2.5 py-1 text-[11px] font-medium text-amber-700 dark:text-amber-300">
                      recovery hold — raw {data.rawOverallStatus}
                    </span>
                  </TooltipTrigger>
                  <TooltipContent className="max-w-xs">
                    The state machine is holding at a higher severity than the raw signal so that improvements must hold
                    for {data.state.minDwellSec}s before the overall status is downgraded. Prevents flap.
                  </TooltipContent>
                </Tooltip>
              </TooltipProvider>
            )}
            <span className="text-sm text-muted-foreground">
              Admin state holding {formatElapsedSeconds(statusHoldingAge)}
            </span>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <FreshnessIndicator
              updatedAtMs={lastUpdated}
              staleAfterMs={STATUS_DASHBOARD_FRESHNESS_POLICY.staleAfterMs}
              labelPrefix="Dashboard fetch"
            />
            <RefreshControl key={lastUpdated} onRefresh={handleRefresh} />
            {showSignOut && onSignOut ? (
              <Button variant="outline" size="sm" className="min-h-11" onClick={onSignOut}>
                Sign out
              </Button>
            ) : null}
          </div>
        </div>

        <h2 className="sr-only">Operational overview</h2>
        <p className="max-w-4xl text-sm font-medium leading-relaxed text-foreground">{resolvedDecision.summary}</p>

        {/* Tier 1: the numbers that decide "do I act?" */}
        <div className="flex flex-wrap gap-2">
          <SummaryBadge
            label="Impacting"
            value={String(resolvedIssueGroups.impacting.length)}
            className={
              resolvedIssueGroups.impacting.length > 0
                ? "border-red-500/30 bg-red-500/10 text-red-700 dark:text-red-300"
                : undefined
            }
          />
          <SummaryBadge label="Warnings" value={String(resolvedIssueGroups.warnings.length)} />
          <SummaryBadge label="Maintenance" value={String(resolvedIssueGroups.maintenance.length)} />
          <SummaryBadge label="Watches" value={String(resolvedIssueGroups.watches.length)} />
          <SummaryBadge
            label="Cron last-run errors"
            value={String(data.summary.cronErrors)}
            className={
              data.summary.availabilityImpactingCronErrors > 0
                ? "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300"
                : undefined
            }
          />
          <SummaryBadge
            label="Public Health"
            value={healthData?.status ?? "unknown"}
            className={healthData ? getStatusTone(healthData.status).badgeClassName : undefined}
          />
          <span className="mx-1 hidden self-center border-l border-border/40 py-2 sm:block" />
          <SummaryBadge label="Reserve Drift" value={String(data.reserveDrift?.length ?? 0)} />
          <SummaryBadge label="Class Warnings" value={String(data.classificationWarnings?.length ?? 0)} />
        </div>

        {reserveScoreInputHold ? (
          <div className={cn("rounded-xl border px-4 py-3 text-sm", reserveForecastTone)}>
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="min-w-0 flex-1">
                <div className="text-xs font-semibold uppercase tracking-[0.14em] opacity-80">
                  Reserve recovery forecast
                </div>
                <p className="mt-1 max-w-3xl leading-relaxed">
                  {reserveForecast.headline}. Live reserve evidence is degraded, so report cards can use conservative
                  reserve inputs until a clean reserve run catches up.
                </p>
              </div>
              <div className="flex flex-wrap gap-2">
                <SummaryBadge
                  label="Reserve"
                  value={data.reserveComposition.status}
                  className="border-amber-500/30 bg-background/60 text-amber-800 dark:text-amber-200"
                />
                <SummaryBadge
                  label="Next"
                  value={formatNextRunWindow(reserveForecast.nextRunAt, data.timestamp)}
                  className="border-amber-500/30 bg-background/60 text-amber-800 dark:text-amber-200"
                />
                <SummaryBadge
                  label="Runs"
                  value={
                    reserveForecast.estimatedRunsToClear == null ? "—" : String(reserveForecast.estimatedRunsToClear)
                  }
                  className="border-amber-500/30 bg-background/60 text-amber-800 dark:text-amber-200"
                />
                <SummaryBadge
                  label="Score-grade"
                  value={formatReserveCoverage(data.reserveComposition.authoritativeFreshCoverageRatio)}
                  className="border-amber-500/30 bg-background/60 text-amber-800 dark:text-amber-200"
                />
              </div>
            </div>
            <div className="mt-2 text-xs leading-relaxed opacity-90">
              {reserveForecast.detail}{" "}
              {data.reserveComposition.runBudgetTruncated ? (
                <>
                  The cursor should resume at{" "}
                  <span className="font-mono">
                    {data.reserveComposition.nextCursorStablecoinId ?? "the next configured coin"}
                  </span>
                  .
                </>
              ) : (
                "The reserve lane is reporting degraded evidence; wait for the next scheduled run unless coverage falls further."
              )}{" "}
              Manual intervention is only needed if truncation repeats or the deferred queue stops shrinking.
            </div>
          </div>
        ) : null}

        <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_minmax(18rem,0.7fr)_minmax(18rem,0.7fr)]">
          <div className="rounded-xl border border-border/60 bg-background/35 p-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h3 className="text-sm font-semibold text-foreground">Current issues</h3>
              <span className="text-[11px] text-muted-foreground">
                {activeIssues.length > 0
                  ? areIssuesExpanded
                    ? `${activeIssues.length} shown`
                    : `${Math.min(activeIssues.length, 4)} of ${activeIssues.length}`
                  : "clear"}
              </span>
            </div>

            <div id="triage-issue-list" className="mt-3 divide-y divide-border/60">
              {activeIssues.length > 0 ? (
                (areIssuesExpanded ? activeIssues : activeIssues.slice(0, 4)).map((issue) => (
                  <div key={issue.id} className="py-3 first:pt-0 last:pb-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <span
                        className={cn(
                          "rounded-full px-2 py-0.5 text-[11px] font-medium",
                          getIssueKindBadgeClass(issue.kind),
                        )}
                      >
                        {issue.impactLabel}
                      </span>
                      <span className="text-[11px] text-muted-foreground">{issue.affectedSurface}</span>
                      <span className="font-mono tabular-nums text-[11px] text-muted-foreground">{issue.code}</span>
                    </div>
                    <div className="mt-1.5 text-sm leading-relaxed text-foreground">{issue.message}</div>
                    {issue.runbookUrl && (
                      <a
                        href={issue.runbookUrl}
                        target="_blank"
                        rel="noreferrer noopener"
                        className="pharos-focus-ring mt-2 inline-flex items-center gap-1 text-[11px] font-medium text-primary underline underline-offset-2"
                      >
                        Runbook →
                      </a>
                    )}
                  </div>
                ))
              ) : (
                <div className="border-y border-border/60 py-3 text-sm text-muted-foreground">
                  No active incidents, warnings, maintenance debt, or informational watches.
                </div>
              )}
              {activeIssues.length > 4 && (
                <button
                  type="button"
                  onClick={() => setAreIssuesExpanded((value) => !value)}
                  aria-expanded={areIssuesExpanded}
                  aria-controls="triage-issue-list"
                  className="pharos-focus-ring mt-1 inline-flex min-h-11 items-center gap-1 rounded-md px-3 text-xs font-medium text-muted-foreground hover:text-foreground"
                >
                  {areIssuesExpanded ? "Show top 4" : `+${activeIssues.length - 4} more`}
                </button>
              )}
            </div>

            <div className="mt-3 flex flex-wrap gap-2 border-t border-border/60 pt-3">
              <SummaryBadge label="Last Transition" value={formatTransitionLabel(latestTransition)} />
              <SummaryBadge
                label="Changed"
                value={
                  latestTransition
                    ? `${formatElapsedSeconds(Math.max(0, data.timestamp - latestTransition.at))} ago`
                    : "—"
                }
              />
            </div>
          </div>

          <div className="rounded-xl border border-border/60 bg-background/35 p-4">
            <div className="flex items-center justify-between gap-2">
              <h3 className="text-sm font-semibold text-foreground">Needs attention</h3>
              <span className="text-[11px] text-muted-foreground">
                {attentionSections.length > 0 ? `${attentionSections.length} lanes` : "clear"}
              </span>
            </div>
            <div className="mt-3 divide-y divide-border/60">
              {attentionSections.length > 0 ? (
                attentionSections.slice(0, 4).map((section) => (
                  <a
                    key={section.id}
                    href={getAdminWorkspacePathForLegacyHash(section.id) ?? "/admin/"}
                    className="pharos-focus-ring flex min-h-11 items-start justify-between gap-3 rounded-md px-1 py-2 text-left hover:bg-background/45"
                  >
                    <span className="min-w-0">
                      <span className="block text-sm font-medium text-foreground">{section.title}</span>
                      <span className="line-clamp-2 text-xs leading-relaxed text-muted-foreground">
                        {section.summary}
                      </span>
                    </span>
                    <span className={cn("shrink-0 font-mono text-xs tabular-nums", section.valueClassName)}>
                      {section.value}
                    </span>
                  </a>
                ))
              ) : (
                <div className="rounded-lg border border-border/60 bg-background/45 p-3 text-sm text-muted-foreground">
                  No operator lanes need attention.
                </div>
              )}
            </div>
          </div>

          {evidenceNeedsRefresh ? (
            <div className="rounded-xl border border-amber-500/30 bg-amber-500/10 p-4">
              <p className="pharos-kicker">Recommended now</p>
              <h3 className="mt-2 text-lg font-semibold text-foreground">{resolvedDecision.nextStepLabel}</h3>
              <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
                Required status evidence is {resolvedEvidence.state}. Current operational actions remain secondary until
                the missing or delayed signals refresh.
              </p>
              <Button variant="outline" size="sm" className="mt-4 min-h-11" onClick={handleRefresh}>
                Refresh evidence
              </Button>
            </div>
          ) : resolvedDecision.nextStep === "manual-action" ? (
            <RecommendedActionStrip
              recommendations={recommendedActions}
              readinessChecks={actionReadinessChecks}
              onActionFinished={handleRefresh}
            />
          ) : (
            <div className="rounded-xl border border-border/60 bg-background/35 p-4">
              <p className="pharos-kicker">Recommended now</p>
              <h3 className="mt-2 text-lg font-semibold text-foreground">{resolvedDecision.nextStepLabel}</h3>
              <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
                {resolvedDecision.nextStep === "observe-next-run"
                  ? "Keep the current schedule in place and confirm whether the warning clears on the next producer run."
                  : resolvedDecision.nextStep === "investigate"
                    ? "Inspect the highest-severity source lane before promoting a production mutation."
                    : "No production mutation is promoted from the current state and evidence."}
              </p>
            </div>
          )}
        </div>

        <details
          open={isDiagnosticsOpen}
          onToggle={(event) => setIsDiagnosticsOpen(event.currentTarget.open)}
          className="border-y border-border/60 py-1"
        >
          <summary className="pharos-focus-ring flex min-h-11 cursor-pointer items-center rounded-md text-sm font-medium text-foreground">
            State machine, probe, and discrepancy diagnostics
          </summary>
          {isDiagnosticsOpen ? (
            <div className="mt-3 space-y-4 pb-3">
              <div className="flex flex-wrap gap-2">
                <SummaryBadge label="State Eval" value={formatTimestampSeconds(data.state.lastEvaluatedAt)} />
                <SummaryBadge label="Status Payload" value={formatTimestampSeconds(data.timestamp)} />
                <SummaryBadge label="Status Fetch" value={formatTimestampSeconds(statusSync?.updatedAtSec)} />
                <SummaryBadge label="Health Fetch" value={formatTimestampSeconds(healthSync?.updatedAtSec)} />
                <SummaryBadge label="Probe Fetch" value={formatTimestampSeconds(probeSync?.updatedAtSec)} />
                <SummaryBadge label="API Mix Fetch" value={formatTimestampSeconds(requestSourceSync?.updatedAtSec)} />
                <SummaryBadge
                  label="Sync Floor"
                  value={clientDataAgeSec == null ? "unknown" : `${clientDataAgeSec}s`}
                  className={clientDataStale ? "border-amber-500/30 bg-amber-500/10" : undefined}
                />
              </div>
              <SystemDiagnostics
                state={data.state}
                staleness={data.staleness}
                probe={data.probe}
                discrepancy={data.discrepancy}
                browserProbe={browserProbeSummary}
                browserProbeLabel={probeCoverageLabel}
                error={data.sectionErrors.statusState}
                nowSeconds={data.timestamp}
              />
            </div>
          ) : null}
        </details>
      </div>
    </section>
  );
}
