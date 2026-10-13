import { useState, type ReactNode } from "react";
import type { HealthResponse, StatusResponse } from "@shared/types";
import { hasReserveScoreInputHold } from "@shared/lib/status-thresholds";
import { FreshnessIndicator } from "@/components/status/freshness-indicator";
import { RecommendedActionStrip } from "@/components/status/recommended-action-strip";
import {
  CountValue,
  STATUS_PANEL_SHELL_CLASS,
  StatusSection,
  SummaryBadge,
  Timestamp,
  VerdictPill,
} from "@/components/status/page-primitives";
import { SystemDiagnostics } from "@/components/status/system-diagnostics";
import { Button } from "@/components/ui/button";
import {
  buildActionReadinessChecks,
  buildReserveRecoveryForecast,
  formatNextRunWindow,
} from "@/lib/status/admin-ops-insights";
import type { StatusActionRecommendation } from "@/lib/status/action-recommendations";
import { getAdminWorkspacePathForLegacyHash } from "@/lib/admin-workspaces";
import {
  type BrowserProbeSummary,
  type DashboardEvidence,
  type DashboardIssueGroups,
  type DashboardQuerySync,
  type DashboardSection,
  STATUS_DASHBOARD_FRESHNESS_POLICY,
  buildDashboardEvidence,
  buildPublicHealthStatusCauses,
  normalizeStatusIssues,
} from "@/lib/status-dashboard-model";
import {
  buildTriageHeadline,
  buildTriageInbox,
  describeRecoveryHold,
  formatRecurrence,
  readSlowestProbePath,
  type TriageInboxItem,
} from "@/lib/status/triage-inbox";
import { describePublicHeadline } from "@/lib/status/public-status";
import { PUBLIC_HEADLINE_TONE } from "@shared/lib/classification";
import { cn } from "@/lib/utils";
import { SEVERITY_TONE_CLASS } from "@/lib/severity-tone";

function formatReserveCoverage(value: number | null): string {
  return value == null ? "Unknown" : `${(value * 100).toFixed(1)}%`;
}

function CountChip({ label, value, tone }: { label: string; value: number | null | undefined; tone: string }) {
  return (
    <div className="rounded-full border border-border/60 bg-background/80 px-3 py-1.5 text-xs dark:bg-background/45">
      <span className="text-muted-foreground">{label}</span>
      <CountValue value={value} tone={tone} className="ml-1.5" />
    </div>
  );
}

function InboxRow({ item, nowSec }: { item: TriageInboxItem; nowSec: number }) {
  const { issue } = item;
  const recurrence = formatRecurrence(item.recurrence);
  return (
    <li className="py-3 first:pt-0 last:pb-0">
      <div className="flex flex-wrap items-center gap-2">
        <VerdictPill verdict={item.verdict} />
        <span className="text-xs text-muted-foreground">{issue.affectedSurface}</span>
        {issue.publicImpacting ? <span className="text-xs font-medium text-state-danger">Public impact</span> : null}
        {recurrence ? (
          <span
            className="rounded-full border border-border/60 px-2 py-0.5 text-xs font-medium text-foreground"
            title="Admin degrade transitions carrying this cause in the loaded status timeline"
          >
            {recurrence}
          </span>
        ) : null}
      </div>
      <p className="mt-1.5 break-words text-sm leading-relaxed text-foreground">{issue.message}</p>
      <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
        {item.sinceSec != null ? (
          <span>
            For <Timestamp epochSec={item.sinceSec} nowSec={nowSec} variant="duration" />
          </span>
        ) : item.lastSuccessSec != null ? (
          <span>
            No successful run for <Timestamp epochSec={item.lastSuccessSec} nowSec={nowSec} variant="duration" />
          </span>
        ) : null}
        {item.timing ? <span>{item.timing}</span> : null}
        <span className="break-all font-mono">{issue.code}</span>
        {item.link ? (
          <a
            href={item.link.href}
            {...(item.link.external ? { target: "_blank", rel: "noreferrer noopener" } : {})}
            className="pharos-focus-ring inline-flex min-h-11 items-center font-medium text-primary underline underline-offset-2 sm:min-h-0"
          >
            {item.link.label}
          </a>
        ) : null}
      </div>
    </li>
  );
}

function ClockRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="mt-0.5 text-foreground">{children}</dd>
    </div>
  );
}

export interface TriageSummaryProps {
  data: StatusResponse;
  healthData: HealthResponse | null | undefined;
  issueGroups?: DashboardIssueGroups;
  evidence?: DashboardEvidence;
  attentionSections: DashboardSection[];
  recommendedActions: StatusActionRecommendation[];
  isDiagnosticsOpen: boolean;
  setIsDiagnosticsOpen: (open: boolean) => void;
  diagnosticsHasNewSignal?: boolean;
  browserProbeSummary: BrowserProbeSummary | null;
  probeCoverageLabel?: string;
  querySyncs: DashboardQuerySync[];
  freshnessFloorMs: number | null;
  clientDataStale: boolean;
  lastUpdated: number;
  handleRefresh: () => void;
}

export function TriageSummary({
  data,
  healthData,
  issueGroups,
  evidence,
  attentionSections,
  recommendedActions,
  isDiagnosticsOpen,
  setIsDiagnosticsOpen,
  diagnosticsHasNewSignal = false,
  browserProbeSummary,
  probeCoverageLabel = "Browser probes",
  querySyncs,
  freshnessFloorMs,
  clientDataStale,
  lastUpdated,
  handleRefresh,
}: TriageSummaryProps) {
  const [isWatchingOpen, setIsWatchingOpen] = useState(false);
  const issues = issueGroups
    ? [...issueGroups.impacting, ...issueGroups.warnings, ...issueGroups.maintenance, ...issueGroups.watches]
    : normalizeStatusIssues(data.causes, buildPublicHealthStatusCauses(healthData));
  const resolvedEvidence = evidence ?? buildDashboardEvidence(querySyncs);
  const inbox = buildTriageInbox(issues, data);
  const headline = buildTriageHeadline(inbox, resolvedEvidence);
  const recoveryHold = describeRecoveryHold(data);
  const primaryItems = [...inbox.act, ...inbox.watch];
  const latestTransition = data.timeline[0] ?? null;
  const statusSync = querySyncs.find((s) => s.key === "status");
  const healthSync = querySyncs.find((s) => s.key === "health");
  const probeSync = querySyncs.find((s) => s.key === "probes");
  const reserveScoreInputHold = hasReserveScoreInputHold(data.reserveComposition);
  const reserveForecast = buildReserveRecoveryForecast(data);
  const actionReadinessChecks = buildActionReadinessChecks({
    data,
    healthData,
    clientDataStale,
    recommendedActions,
  });
  const reserveForecastTone =
    reserveForecast.state === "blocked"
      ? cn(SEVERITY_TONE_CLASS.alert.banner, "text-state-danger-strong")
      : reserveForecast.state === "clear"
        ? "border-state-positive bg-state-positive-subtle text-state-positive-strong"
        : cn(SEVERITY_TONE_CLASS.watch.banner, "text-state-warn-ink");
  const publicHeadline = describePublicHeadline(healthData, Boolean(healthSync?.errorMessage));

  return (
    <StatusSection
      id="overview"
      kicker="Operator overview"
      title="Triage"
      headingLevel="h1"
      variant="workspace"
      description="Open issues from the admin status model, what to do about them, and the evidence behind the verdict."
      summary={
        <>
          <CountChip label="Act now" value={inbox.act.length} tone="text-state-danger" />
          <CountChip label="Watching" value={inbox.watch.length + inbox.informational.length} tone="text-state-warn" />
          <CountChip label="Cron last-run errors" value={data.summary.cronErrors} tone="text-state-warn" />
          <SummaryBadge
            label="Public status"
            value={publicHeadline.label}
            className={
              publicHeadline.state && publicHeadline.state !== "operational"
                ? PUBLIC_HEADLINE_TONE[publicHeadline.state].pill
                : undefined
            }
          />
          <FreshnessIndicator
            updatedAtMs={lastUpdated}
            staleAfterMs={STATUS_DASHBOARD_FRESHNESS_POLICY.staleAfterMs}
            labelPrefix="Dashboard fetch"
          />
          <Button variant="outline" size="sm" className="min-h-11" onClick={handleRefresh}>
            Refresh now
          </Button>
        </>
      }
    >
      <div className="space-y-1.5">
        <div className="flex flex-wrap items-center gap-2">
          <VerdictPill verdict={headline.verdict} />
          <p className="text-base font-semibold leading-snug text-foreground">{headline.text}</p>
        </div>
        <p className="text-sm text-muted-foreground">
          {publicHeadline.title
            ? `Public status page: ${publicHeadline.title}.`
            : `Public status ${publicHeadline.label.toLowerCase()}.`}{" "}
          Evidence {resolvedEvidence.label.toLowerCase()}.
        </p>
        {recoveryHold ? <p className="text-sm text-muted-foreground">{recoveryHold}</p> : null}
      </div>

      {reserveScoreInputHold ? (
        <div className={cn("rounded-xl border px-4 py-3 text-sm", reserveForecastTone)}>
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="min-w-0 flex-1">
              <h3 className="text-sm font-semibold">Reserve recovery forecast</h3>
              <p className="mt-1 max-w-3xl leading-relaxed">
                {reserveForecast.headline}. Live reserve evidence is degraded, so report cards can use conservative
                reserve inputs until a clean reserve run catches up.
              </p>
            </div>
            <div className="flex flex-wrap gap-2">
              <SummaryBadge label="Reserve" value={data.reserveComposition.status} />
              <SummaryBadge label="Next" value={formatNextRunWindow(reserveForecast.nextRunAt, data.timestamp)} />
              <SummaryBadge
                label="Runs"
                value={reserveForecast.estimatedRunsToClear == null ? "—" : String(reserveForecast.estimatedRunsToClear)}
              />
              <SummaryBadge
                label="Score-grade"
                value={formatReserveCoverage(data.reserveComposition.authoritativeFreshCoverageRatio)}
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
              "The reserve lane is reporting degraded evidence; the next scheduled run should catch up unless coverage falls further."
            )}{" "}
            Manual intervention is only needed if truncation repeats or the deferred queue stops shrinking.
          </div>
        </div>
      ) : null}

      <div className="grid gap-4 xl:grid-cols-[minmax(0,1.6fr)_minmax(18rem,1fr)]">
        <section aria-labelledby="triage-issues-title" className={cn("min-w-0 rounded-xl p-4", STATUS_PANEL_SHELL_CLASS)}>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h3 id="triage-issues-title" className="text-sm font-semibold text-foreground">
              Issues
            </h3>
            <span className="text-xs text-muted-foreground">Sorted by verdict, then age</span>
          </div>
          {primaryItems.length > 0 ? (
            <ul className="mt-3 divide-y divide-border/60">
              {primaryItems.map((item) => (
                <InboxRow key={item.issue.id} item={item} nowSec={data.timestamp} />
              ))}
            </ul>
          ) : (
            <p className="mt-3 text-sm text-muted-foreground">
              {inbox.informational.length > 0 ? "No issue needs action or close watching." : "No open issues."}
            </p>
          )}
          {inbox.informational.length > 0 ? (
            <details
              open={isWatchingOpen}
              onToggle={(event) => setIsWatchingOpen(event.currentTarget.open)}
              className="mt-3 border-t border-border/60 pt-1"
            >
              <summary className="pharos-focus-ring flex min-h-11 cursor-pointer items-center rounded-md text-sm font-medium text-foreground">
                Informational ({inbox.informational.length})
              </summary>
              {isWatchingOpen ? (
                <ul className="mt-2 divide-y divide-border/60 pb-1">
                  {inbox.informational.map((item) => (
                    <InboxRow key={item.issue.id} item={item} nowSec={data.timestamp} />
                  ))}
                </ul>
              ) : null}
            </details>
          ) : null}
        </section>

        <div className="min-w-0 space-y-4">
          {recommendedActions.length > 0 ? (
            <RecommendedActionStrip
              recommendations={recommendedActions}
              readinessChecks={actionReadinessChecks}
              onActionFinished={handleRefresh}
            />
          ) : null}
          <section aria-labelledby="triage-lanes-title" className={cn("rounded-xl p-4", STATUS_PANEL_SHELL_CLASS)}>
            <h3 id="triage-lanes-title" className="text-sm font-semibold text-foreground">
              Workspaces with findings
            </h3>
            {attentionSections.length > 0 ? (
              <div className="mt-2 divide-y divide-border/60">
                {attentionSections.slice(0, 4).map((section) => (
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
                ))}
              </div>
            ) : (
              <p className="mt-2 text-sm text-muted-foreground">No workspace has open findings.</p>
            )}
          </section>
        </div>
      </div>

      <details
        open={isDiagnosticsOpen}
        onToggle={(event) => setIsDiagnosticsOpen(event.currentTarget.open)}
        className="border-y border-border/60 py-1"
      >
        <summary className="pharos-focus-ring flex min-h-11 cursor-pointer flex-wrap items-center gap-x-2 rounded-md text-sm font-medium text-foreground">
          Diagnostics
          <span className="text-xs font-normal text-muted-foreground">State machine, fetch clocks, divergence</span>
          {diagnosticsHasNewSignal && !isDiagnosticsOpen ? (
            <span className={cn("rounded-full border px-2 py-0.5 text-xs font-medium", SEVERITY_TONE_CLASS.watch.pill)}>
              New signal
            </span>
          ) : null}
        </summary>
        {isDiagnosticsOpen ? (
          <div className="mt-3 space-y-4 pb-3">
            <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-xs sm:grid-cols-3 xl:grid-cols-6">
              <ClockRow label="State evaluated">
                <Timestamp epochSec={data.state.lastEvaluatedAt} />
              </ClockRow>
              <ClockRow label="Status payload">
                <Timestamp epochSec={data.timestamp} />
              </ClockRow>
              <ClockRow label="Status fetch">
                <Timestamp epochSec={statusSync?.updatedAtSec} />
              </ClockRow>
              <ClockRow label="Health fetch">
                <Timestamp epochSec={healthSync?.updatedAtSec} />
              </ClockRow>
              <ClockRow label="Probe fetch">
                <Timestamp epochSec={probeSync?.updatedAtSec} />
              </ClockRow>
              <ClockRow label="Admin state">
                Held {data.overallStatus}, raw {data.rawOverallStatus}
                {healthData ? `, /api/health ${healthData.status}` : ""}
              </ClockRow>
              <ClockRow label="Last transition">
                {latestTransition ? (
                  <>
                    {latestTransition.from ?? "init"} to {latestTransition.to},{" "}
                    <Timestamp epochSec={latestTransition.at} />
                  </>
                ) : (
                  <span className="text-muted-foreground">None recorded</span>
                )}
              </ClockRow>
            </dl>
            <FreshnessIndicator
              updatedAtMs={freshnessFloorMs ?? 0}
              staleAfterMs={STATUS_DASHBOARD_FRESHNESS_POLICY.staleAfterMs}
              labelPrefix="Sync floor"
            />
            <SystemDiagnostics
              state={data.state}
              staleness={data.staleness}
              probe={data.probe}
              slowestProbePath={readSlowestProbePath(data.crons)}
              discrepancy={data.discrepancy}
              browserProbe={browserProbeSummary}
              browserProbeLabel={probeCoverageLabel}
              error={data.sectionErrors.statusState}
              nowSeconds={data.timestamp}
            />
          </div>
        ) : null}
      </details>
    </StatusSection>
  );
}
