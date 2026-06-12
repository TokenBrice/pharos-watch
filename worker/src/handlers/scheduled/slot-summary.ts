import type { CronResult } from "../../lib/cron-logger";

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
  return {
    jobsRun: jobs.filter((job) => job.outcome === "ok").length,
    jobsSkipped: jobs.filter((job) => job.outcome === "skipped" && job.neutral !== true).length,
    jobsNeutralSkipped: neutralSkippedJobs.length,
    jobsDegraded: jobs.filter((job) => job.outcome === "degraded").length,
    jobsErrored: jobs.filter((job) => job.outcome === "error").length,
    budgetOnlyJobs: options.budgetOnlyJobs ?? 0,
    jobs: [...jobs],
  };
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
