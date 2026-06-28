import type { CronProgressReporter, CronResult } from "../../lib/cron-logger";
import type { ScheduledRuntimeContext } from "./context";

export type ScheduledSlotJobOutcome = "ok" | "degraded" | "error" | "skipped";

export interface ScheduledSlotJobSummary {
  job: string;
  outcome: ScheduledSlotJobOutcome;
  status?: CronResult["status"];
  itemCount?: number;
  reason?: string;
  error?: string;
  neutral?: boolean;
}

export interface ScheduledSlotSummary {
  jobsAttempted: number;
  jobsSucceeded: number;
  jobsRun: number;
  jobsSkipped: number;
  jobsNeutralSkipped: number;
  jobsDegraded: number;
  jobsErrored: number;
  budgetOnlyJobs: number;
  jobs: ScheduledSlotJobSummary[];
}

function truncateSummaryText(value: unknown): string {
  return String(value).slice(0, 300);
}

export function summarizeCronResult(job: string, result: CronResult | null | void): ScheduledSlotJobSummary {
  const status = result?.status ?? "ok";
  if (status === "skipped_locked") {
    return {
      job,
      outcome: "skipped",
      status,
      itemCount: result?.itemCount,
      reason: "lease-locked",
    };
  }
  if (status === "degraded") {
    return {
      job,
      outcome: "degraded",
      status,
      itemCount: result?.itemCount,
    };
  }
  if (status === "error") {
    return {
      job,
      outcome: "error",
      status,
      itemCount: result?.itemCount,
      error: result?.error ? truncateSummaryText(result.error) : undefined,
    };
  }
  return {
    job,
    outcome: "ok",
    status,
    itemCount: result?.itemCount,
  };
}

export function summarizeThrownScheduledJob(job: string, err: unknown): ScheduledSlotJobSummary {
  return {
    job,
    outcome: "error",
    error: truncateSummaryText(err instanceof Error ? err.message : err),
  };
}

export function summarizeSkippedScheduledJob(
  job: string,
  reason: string,
  options: { neutral?: boolean } = {},
): ScheduledSlotJobSummary {
  return {
    job,
    outcome: "skipped",
    reason,
    ...(options.neutral ? { neutral: true } : {}),
  };
}

export function buildScheduledSlotSummary(
  jobs: readonly ScheduledSlotJobSummary[],
  options: { budgetOnlyJobs?: number } = {},
): ScheduledSlotSummary {
  const neutralSkippedJobs = jobs.filter((job) => job.outcome === "skipped" && job.neutral === true);
  const jobsSucceeded = jobs.filter((job) => job.outcome === "ok").length;
  const jobsAttempted = jobs.filter((job) =>
    job.outcome === "ok" || job.outcome === "degraded" || job.outcome === "error"
  ).length;
  return {
    jobsAttempted,
    jobsSucceeded,
    jobsRun: jobsSucceeded,
    jobsSkipped: jobs.filter((job) => job.outcome === "skipped" && job.neutral !== true).length,
    jobsNeutralSkipped: neutralSkippedJobs.length,
    jobsDegraded: jobs.filter((job) => job.outcome === "degraded").length,
    jobsErrored: jobs.filter((job) => job.outcome === "error").length,
    budgetOnlyJobs: options.budgetOnlyJobs ?? 0,
    jobs: [...jobs],
  };
}

/**
 * Runs a single leased cron job and returns a one-job slot summary.
 *
 * NOTE: errors propagate to the caller (event marked failed). This is
 * intentional — unlike runSingleScheduledJob which swallows errors into a
 * 'thrown' summary, these slots want the Cloudflare event itself to be marked
 * failed on unhandled rejection.
 */
export async function runSinglePropagatingSlotJob(
  runtime: ScheduledRuntimeContext,
  job: string,
  fn: (signal: AbortSignal, reportProgress: CronProgressReporter) => Promise<CronResult | void>,
): Promise<ScheduledSlotSummary> {
  const result = await runtime.runLeasedCron(job, fn);
  return buildScheduledSlotSummary([summarizeCronResult(job, result)]);
}

export function mergeScheduledSlotSummaries(
  summaries: readonly ScheduledSlotSummary[],
  options: { budgetOnlyJobs?: number } = {},
): ScheduledSlotSummary {
  const jobs = summaries.flatMap((summary) => summary.jobs);
  const budgetOnlyJobs =
    summaries.reduce((sum, summary) => sum + summary.budgetOnlyJobs, 0) + (options.budgetOnlyJobs ?? 0);
  return buildScheduledSlotSummary(jobs, { budgetOnlyJobs });
}
