import type { OperatorVerdict } from "@shared/lib/classification";
import { getCronJobMeta } from "@shared/lib/cron-jobs";
import { formatElapsedSeconds, timeAgo } from "@shared/lib/format";
import { STATUS_PROBE_THRESHOLDS } from "@shared/lib/status-thresholds";
import { transitionHasPublicImpact } from "@shared/lib/status-public-impact";
import { readRecord } from "@shared/lib/type-guards";
import type { CronStatus, StatusCause, StatusResponse } from "@shared/types";
import { CRON_STALE_BUDGET_MULTIPLIER, getCronNextExpected } from "@/lib/cron-workbench-model";
import { getRecommendedActionsForCause } from "@/lib/status/action-recommendations";
import { STATUS_PRIORITY } from "@/lib/status/dashboard-presentation";
import type { DashboardEvidence, DashboardIssue } from "@/lib/status/dashboard-types";

/** Window for the recurrence chip ("5× in 48h"). */
const TRIAGE_RECURRENCE_WINDOW_SEC = 48 * 3600;

const SELF_CHECK_JOB = "status-self-check";

export interface TriagePrimaryLink {
  href: string;
  label: string;
  external: boolean;
}

export interface TriageInboxItem {
  issue: DashboardIssue;
  verdict: Extract<OperatorVerdict, "act" | "watch">;
  /** Short name of the thing: named cron jobs when the cause lists them, else the cause message. */
  subject: string;
  /** Oldest transition of the current unbroken run of transitions that carried this cause. */
  sinceSec: number | null;
  /**
   * When `sinceSec` is unknown and the first named cron job's latest run did not
   * succeed: start of its most recent successful run ("No successful run for X").
   */
  lastSuccessSec: number | null;
  /** Next primary trigger opportunity and freshness budget of the first named cron job. */
  timing: string | null;
  /** Degrade transitions carrying this cause code inside the recurrence window. */
  recurrence: number;
  link: TriagePrimaryLink | null;
  /** Info-severity watches collapse under "Watching (N)". */
  informational: boolean;
}

export interface TriageInbox {
  items: TriageInboxItem[];
  act: TriageInboxItem[];
  watch: TriageInboxItem[];
  informational: TriageInboxItem[];
}

function stripJobsSuffix(message: string): string {
  return message.replace(/\s*Jobs: .*$/u, "").replace(/\.$/u, "");
}

function getCronSubjects(issue: DashboardIssue): string[] {
  return (issue.subjects ?? []).filter((subject) => getCronJobMeta(subject) != null);
}

function getSubject(issue: DashboardIssue, cronSubjects: readonly string[]): string {
  if (cronSubjects.length === 0) return stripJobsSuffix(issue.message);
  const labels = cronSubjects.map((job) => getCronJobMeta(job)?.label ?? job);
  return labels.length > 2 ? `${labels.slice(0, 2).join(", ")} and ${labels.length - 2} more` : labels.join(", ");
}

function getPrimaryLink(issue: DashboardIssue, cronSubjects: readonly string[]): TriagePrimaryLink | null {
  const job = cronSubjects[0];
  if (job) {
    return { href: `/admin/crons/?job=${encodeURIComponent(job)}`, label: "Open cron", external: false };
  }
  const action = getRecommendedActionsForCause(issue)[0];
  if (action) return { href: "/admin/actions/", label: `Action: ${action.label}`, external: false };
  if (issue.runbookUrl) return { href: issue.runbookUrl, label: "Runbook", external: true };
  return null;
}

function transitionHasCode(transition: StatusResponse["timeline"][number], code: string): boolean {
  return transition.causes.some((cause) => cause.code === code);
}

function getSince(timeline: StatusResponse["timeline"], code: string): number | null {
  // Timeline is newest first; walk back while consecutive transitions carry the cause.
  let since: number | null = null;
  for (const transition of timeline) {
    if (!transitionHasCode(transition, code)) break;
    since = transition.at;
  }
  return since;
}

function countRecurrence(timeline: StatusResponse["timeline"], code: string, nowSec: number): number {
  return timeline.filter(
    (transition) =>
      transition.transitionType === "degrade" &&
      nowSec - transition.at <= TRIAGE_RECURRENCE_WINDOW_SEC &&
      transitionHasCode(transition, code),
  ).length;
}

const VERDICT_RANK = { act: 0, watch: 1 } as const;

function describeCronTiming(cron: CronStatus | undefined, nowSec: number, job?: string): string | null {
  if (!cron) return null;
  const next = getCronNextExpected(cron, nowSec, job);
  if (next.kind === "running") return next.label;
  if (next.kind === "scheduled") {
    return `Next primary opportunity ${next.label} (budget ${formatElapsedSeconds(cron.expectedIntervalSec * CRON_STALE_BUDGET_MULTIPLIER)})`;
  }
  if (next.kind === "due" || next.kind === "overdue") {
    return `${next.label} (budget ${formatElapsedSeconds(cron.expectedIntervalSec * CRON_STALE_BUDGET_MULTIPLIER)})`;
  }
  return null;
}

function getLastSuccessSec(cron: CronStatus | undefined): number | null {
  if (!cron?.runs[0] || cron.runs[0].status === "ok") return null;
  return cron.runs.find((run) => run.status === "ok")?.startedAt ?? null;
}

/**
 * The triage rule applied to a set of causes (an incident episode, a
 * transition): any critical or public-impacting non-info cause is `act`;
 * warnings and info-only causes are `watch`.
 */
export function getCausesVerdict(causes: readonly StatusCause[]): "act" | "watch" {
  return causes.some((cause) => cause.severity === "critical") || transitionHasPublicImpact([...causes]) ? "act" : "watch";
}

/**
 * Turns normalized status issues into the Triage inbox: one verdict per item
 * (act = public impact or critical severity, watch = everything else),
 * sorted by verdict then age, with the recurrence count and one primary link.
 */
export function buildTriageInbox(
  issues: readonly DashboardIssue[],
  data: Pick<StatusResponse, "timeline" | "crons" | "timestamp">,
): TriageInbox {
  const items = issues.map((issue, index) => {
    const cronSubjects = getCronSubjects(issue);
    const recurrence = countRecurrence(data.timeline, issue.code, data.timestamp);
    const informational = issue.kind === "watch";
    // Timeline co-occurrence cannot prove a diagnostic caused the degradation.
    const verdict = getCausesVerdict([issue]);
    const firstCron = cronSubjects[0] ? data.crons[cronSubjects[0]] : undefined;
    const sinceSec = getSince(data.timeline, issue.code);
    return {
      index,
      item: {
        issue,
        verdict,
        subject: getSubject(issue, cronSubjects),
        sinceSec,
        lastSuccessSec: sinceSec == null ? getLastSuccessSec(firstCron) : null,
        timing: describeCronTiming(firstCron, data.timestamp, cronSubjects[0]),
        recurrence,
        link: getPrimaryLink(issue, cronSubjects),
        informational,
      } satisfies TriageInboxItem,
    };
  });
  items.sort((a, b) => {
    const verdictDelta = VERDICT_RANK[a.item.verdict] - VERDICT_RANK[b.item.verdict];
    if (verdictDelta !== 0) return verdictDelta;
    // Older first; unknown age keeps the normalized severity order after dated items.
    const aSince = a.item.sinceSec ?? Number.POSITIVE_INFINITY;
    const bSince = b.item.sinceSec ?? Number.POSITIVE_INFINITY;
    if (aSince !== bSince) return aSince - bSince;
    return a.index - b.index;
  });
  const sorted = items.map(({ item }) => item);
  return {
    items: sorted,
    act: sorted.filter((item) => item.verdict === "act"),
    watch: sorted.filter((item) => item.verdict === "watch" && !item.informational),
    informational: sorted.filter((item) => item.informational),
  };
}

export function formatRecurrence(count: number): string | null {
  return count >= 2 ? `${count}× in ${TRIAGE_RECURRENCE_WINDOW_SEC / 3600}h` : null;
}

/** The Triage top line: answers "do I need to act?" before any evidence. */
export function buildTriageHeadline(
  inbox: TriageInbox,
  evidence: Pick<DashboardEvidence, "state" | "staleLabels" | "missingLabels">,
): { verdict: OperatorVerdict; text: string } {
  if (evidence.state === "unavailable") {
    const labels = evidence.missingLabels.join(", ") || "Status evidence";
    return { verdict: "unavailable", text: `Cannot answer: ${labels} unavailable. Showing the last good read.` };
  }
  if (evidence.state === "stale") {
    return {
      verdict: "unavailable",
      text: `Cannot answer: ${evidence.staleLabels.join(", ") || "status evidence"} is out of date. Showing the last good read.`,
    };
  }
  const watching = inbox.watch.length + inbox.informational.length;
  const watchingText = watching > 0 ? ` Watching ${watching}.` : "";
  const first = inbox.act[0];
  if (first) {
    const more = inbox.act.length > 1 ? ` and ${inbox.act.length - 1} more` : "";
    return { verdict: "act", text: `Act on ${inbox.act.length}: ${first.subject}${more}.${watchingText}` };
  }
  return { verdict: watching > 0 ? "watch" : "ok", text: `Nothing needs action.${watchingText}` };
}

/**
 * Recovery-hold line: the admin state is held above the raw signal until the
 * state machine sees enough consecutive improved checks. Returns null when no
 * hold is active.
 */
export function describeRecoveryHold(
  data: Pick<StatusResponse, "state" | "crons" | "timestamp">,
): string | null {
  const { state } = data;
  if (state == null) return null;
  if (STATUS_PRIORITY[state.currentStatus] <= STATUS_PRIORITY[state.rawStatus]) return null;
  const target = state.rawStatus === "healthy" ? "healthy" : "degraded";
  const needed = target === "healthy" ? state.thresholds.recoverToHealthy : state.thresholds.recoverToDegraded;
  const streak = Math.max(0, state.consecutiveRaw[target]);
  // Each status self-check run is one state-machine check, newest first.
  const streakStart = streak > 0 ? data.crons[SELF_CHECK_JOB]?.runs[streak - 1]?.startedAt : undefined;
  const verb = target === "healthy" ? "Recovered" : "Improved to degraded";
  const when = streakStart != null ? ` ${timeAgo(streakStart, data.timestamp)}` : "";
  if (streak >= needed) {
    const dwellSec = state.currentStatus === "stale" ? state.staleMinDwellSec : state.minDwellSec;
    return `${verb}${when}; ${needed}/${needed} ${target} checks done, waiting for the ${formatElapsedSeconds(dwellSec)} minimum hold.`;
  }
  return `${verb}${when}; confirming (needs ${needed} consecutive ${target} checks, ${streak}/${needed}).`;
}

function formatSeconds(ms: number): string {
  return `${Number((ms / 1000).toFixed(1))} s`;
}

/** Slowest probe path from the latest status self-check run's summary facts, when recorded. */
export function readSlowestProbePath(crons: StatusResponse["crons"]): string | null {
  const slowest = crons[SELF_CHECK_JOB]?.latestRunFacts?.slowestProbes;
  const first = Array.isArray(slowest) ? readRecord(slowest[0]) : null;
  return typeof first?.path === "string" && first.path ? first.path : null;
}

/** Worker self-check label that names the failing dimension instead of "degraded (17/17)". */
export function describeSelfCheck(probe: StatusResponse["probe"], slowestPath: string | null): string {
  if (probe.timestamp == null || probe.sampleCount === 0) return "No self-check result yet";
  if (probe.failCount > 0) return `${probe.failCount} of ${probe.sampleCount} probes failing`;
  const base = probe.passCount === probe.sampleCount
    ? `All ${probe.sampleCount} probes pass`
    : `${probe.passCount} transport passes; no transport failures (${probe.sampleCount} total samples)`;
  if (probe.status === "healthy") return base;
  const budget = STATUS_PROBE_THRESHOLDS.healthyLatencyMaxMs;
  if (probe.p95LatencyMs != null && probe.p95LatencyMs > budget) {
    const where = slowestPath ? ` on ${slowestPath}` : "";
    return `${base}; slow: p95 ${formatSeconds(probe.p95LatencyMs)} (budget ${formatSeconds(budget)})${where}`;
  }
  if (probe.internalExternalDiscrepancy?.hasDivergence) return `${base}; internal and external probes disagree`;
  return probe.status === "unknown" ? `${base}; aggregate status unknown` : `${base}; aggregate reports ${probe.status}`;
}
