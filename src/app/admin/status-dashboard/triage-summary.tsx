import { useState } from "react";
import type { HealthResponse, StatusCause, StatusResponse, StatusTransition } from "@shared/types";
import { formatElapsedSeconds } from "@shared/lib/format";
import { FreshnessIndicator } from "@/components/status/freshness-indicator";
import { RecommendedActionStrip } from "@/components/status/recommended-action-strip";
import { RefreshControl } from "@/components/status/refresh-countdown";
import { SummaryBadge } from "@/components/status/page-primitives";
import { SystemDiagnostics } from "@/components/status/system-diagnostics";
import { getTopFoldCopy, isRecoveryHold as isRecoveryHoldState } from "@/components/status/top-fold-copy";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { buildReserveRecoveryForecast, formatNextRunWindow } from "@/lib/status/admin-ops-insights";
import type { StatusActionRecommendation } from "@/lib/status/action-recommendations";
import {
  type BrowserProbeSummary,
  type DashboardQuerySync,
  type DashboardSection,
  formatTransitionLabel,
  formatTimestampSeconds,
  getStatusTone,
  getSeverityBadgeClass,
} from "@/lib/status-dashboard-model";
import { cn } from "@/lib/utils";

const ADMIN_STALE_AFTER_MS = 180_000;

function formatReserveCoverage(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

export interface TriageSummaryProps {
  data: StatusResponse;
  healthData: HealthResponse | null | undefined;
  overallTone: ReturnType<typeof getStatusTone>;
  statusHoldingAge: number;
  overallCauseCount: number;
  watchCauseCount: number;
  blockerCauses: StatusCause[];
  latestTransition: StatusTransition | null;
  attentionSections: DashboardSection[];
  recommendedActions: StatusActionRecommendation[];
  isDiagnosticsOpen: boolean;
  setIsDiagnosticsOpen: (open: boolean) => void;
  browserProbeSummary: BrowserProbeSummary | null;
  querySyncs: DashboardQuerySync[];
  clientDataAgeSec: number;
  clientDataStale: boolean;
  lastUpdated: number;
  handleRefresh: () => void;
  onSignOut: () => void;
}

export function TriageSummary({
  data,
  healthData,
  overallTone,
  statusHoldingAge,
  overallCauseCount,
  watchCauseCount,
  blockerCauses,
  latestTransition,
  attentionSections,
  recommendedActions,
  isDiagnosticsOpen,
  setIsDiagnosticsOpen,
  browserProbeSummary,
  querySyncs,
  clientDataAgeSec,
  clientDataStale,
  lastUpdated,
  handleRefresh,
  onSignOut,
}: TriageSummaryProps) {
  const [isBlockersExpanded, setIsBlockersExpanded] = useState(false);
  const topFoldCopy = getTopFoldCopy(data.overallStatus, data.rawOverallStatus);
  const isRecoveryHold = isRecoveryHoldState(data.overallStatus, data.rawOverallStatus);
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
  const reserveForecastTone =
    reserveForecast.state === "blocked"
      ? "border-red-500/30 bg-red-500/10 text-red-900 dark:text-red-200"
      : reserveForecast.state === "clear"
        ? "border-green-500/30 bg-green-500/10 text-green-900 dark:text-green-200"
        : "border-amber-500/30 bg-amber-500/10 text-amber-950 dark:text-amber-100";

  return (
    <section
      id="overview"
      className={cn("scroll-mt-36 rounded-xl border px-4 py-4 sm:px-5 lg:px-6", topFoldCopy.shell)}
    >
      <div className="space-y-4">
        {/* Triage header: status + key metrics + controls */}
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex flex-wrap items-center gap-3">
            <span
              className={cn(
                "inline-flex items-center gap-2 rounded-full border px-3 py-1.5 text-xs font-medium uppercase tracking-[0.14em]",
                overallTone.badgeClassName,
              )}
            >
              <span
                className={cn(
                  "h-2 w-2 rounded-full",
                  data.overallStatus === "stale"
                    ? "bg-red-400"
                    : data.overallStatus === "degraded"
                      ? "bg-amber-400"
                      : "bg-emerald-400",
                )}
              />
              {overallTone.label}
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
              {topFoldCopy.eyebrow} · holding {formatElapsedSeconds(statusHoldingAge)}
            </span>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <FreshnessIndicator
              updatedAtMs={lastUpdated}
              staleAfterMs={ADMIN_STALE_AFTER_MS}
              labelPrefix="Dashboard fetch"
            />
            <RefreshControl key={lastUpdated} onRefresh={handleRefresh} />
            <Button variant="outline" size="sm" onClick={onSignOut}>
              Sign out
            </Button>
          </div>
        </div>

        {/* Tier 1: the numbers that decide "do I act?" */}
        <div className="flex flex-wrap gap-2">
          <SummaryBadge
            label="Blockers"
            value={String(overallCauseCount)}
            className={
              overallCauseCount > 0
                ? "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300"
                : undefined
            }
          />
          <SummaryBadge
            label="Cron Errors"
            value={String(data.summary.cronErrors)}
            className={
              data.summary.cronErrors > 0 ? "border-red-500/30 bg-red-500/10 text-red-700 dark:text-red-300" : undefined
            }
          />
          <SummaryBadge
            label="Public Health"
            value={healthData?.status ?? "—"}
            className={healthData ? getStatusTone(healthData.status).badgeClassName : undefined}
          />
          <span className="mx-1 hidden self-center border-l border-border/40 py-2 sm:block" />
          <SummaryBadge label="Watch" value={String(watchCauseCount)} />
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
              <h3 className="text-sm font-semibold text-foreground">Blockers</h3>
              <span className="text-[11px] text-muted-foreground">
                {overallCauseCount > 0
                  ? isBlockersExpanded
                    ? `${overallCauseCount} shown`
                    : `${Math.min(overallCauseCount, 3)} of ${overallCauseCount}`
                  : watchCauseCount > 0
                    ? "watch-only"
                    : "clear"}
              </span>
            </div>

            <div className="mt-3 space-y-2">
              {blockerCauses.length > 0 ? (
                (isBlockersExpanded ? blockerCauses : blockerCauses.slice(0, 3)).map((cause) => (
                  <div
                    key={`${cause.layer}-${cause.code}-${cause.message}`}
                    className="rounded-lg border border-border/60 bg-background/30 p-3"
                  >
                    <div className="flex flex-wrap items-center gap-2">
                      <span
                        className={cn(
                          "rounded-full px-2 py-0.5 text-[11px] font-medium",
                          getSeverityBadgeClass(cause.severity),
                        )}
                      >
                        {cause.severity}
                      </span>
                      <span className="text-[11px] text-muted-foreground">{cause.layer}</span>
                      <span className="font-mono tabular-nums text-[11px] text-muted-foreground">{cause.code}</span>
                    </div>
                    <div className="mt-1.5 text-sm leading-relaxed text-foreground">{cause.message}</div>
                    {cause.runbookUrl && (
                      <a
                        href={cause.runbookUrl}
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
                <div className="rounded-lg border border-border/60 bg-background/45 p-3 text-sm text-muted-foreground">
                  {watchCauseCount > 0
                    ? `No active blockers. ${watchCauseCount} watch item(s) remain.`
                    : "No active blockers."}
                </div>
              )}
              {overallCauseCount > 3 && (
                <button
                  type="button"
                  onClick={() => setIsBlockersExpanded((v) => !v)}
                  className="pharos-focus-ring mt-1 inline-flex items-center gap-1 rounded-md px-2 py-1 text-[11px] font-medium text-muted-foreground hover:text-foreground"
                >
                  {isBlockersExpanded ? "Show top 3" : `+${overallCauseCount - 3} more`}
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
                    href={`#${section.id}`}
                    className="pharos-focus-ring flex items-start justify-between gap-3 rounded-md px-1 py-2 text-left hover:bg-background/45"
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

          <RecommendedActionStrip recommendations={recommendedActions} onActionFinished={handleRefresh} />
        </div>

        <details
          open={isDiagnosticsOpen}
          onToggle={(event) => setIsDiagnosticsOpen(event.currentTarget.open)}
          className="rounded-xl border border-border/60 bg-background/30 p-4"
        >
          <summary className="cursor-pointer text-sm font-medium text-foreground">
            State machine, probe, and discrepancy diagnostics
          </summary>
          <div className="mt-4 space-y-4">
            <div className="flex flex-wrap gap-2">
              <SummaryBadge label="State Eval" value={formatTimestampSeconds(data.state.lastEvaluatedAt)} />
              <SummaryBadge label="Status Payload" value={formatTimestampSeconds(data.timestamp)} />
              <SummaryBadge label="Status Fetch" value={formatTimestampSeconds(statusSync?.updatedAtSec)} />
              <SummaryBadge label="Health Fetch" value={formatTimestampSeconds(healthSync?.updatedAtSec)} />
              <SummaryBadge label="Probe Fetch" value={formatTimestampSeconds(probeSync?.updatedAtSec)} />
              <SummaryBadge label="API Mix Fetch" value={formatTimestampSeconds(requestSourceSync?.updatedAtSec)} />
              <SummaryBadge
                label="Sync Floor"
                value={`${clientDataAgeSec}s`}
                className={clientDataStale ? "border-amber-500/30 bg-amber-500/10" : undefined}
              />
            </div>
            <SystemDiagnostics
              state={data.state}
              staleness={data.staleness}
              probe={data.probe}
              discrepancy={data.discrepancy}
              browserProbe={browserProbeSummary}
              error={data.sectionErrors.statusState}
              nowSeconds={data.timestamp}
            />
          </div>
        </details>
      </div>
    </section>
  );
}
