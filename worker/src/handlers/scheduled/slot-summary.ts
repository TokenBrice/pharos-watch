import type { CronTerminalAccountingStage, SchedulerSummaryOutcome } from "@shared/types/status/cron";
import { CronTerminalAccountingError, resolveCronDegradedReason, type CronProgressReporter, type CronResult } from "../../lib/cron-logger";
import { describeError } from "@shared/lib/error-utils";
import { stripSensitive } from "../../lib/safe-error-message";
import type { ScheduledRuntimeContext } from "./context";
import { foldScheduledOutcomes, projectCronResultOutcome } from "../../lib/cron-outcomes";

export type ScheduledSlotJobSummary = {
  job: string;
  outcome: SchedulerSummaryOutcome;
  status?: CronResult["status"];
  itemCount?: number;
  reason?: string;
  error?: string;
  neutral?: boolean;
  terminalAccountingError?: {
    stage: CronTerminalAccountingStage;
    outputPublishedAt: number | null;
    productive: boolean;
  };
};

export type ScheduledSlotSummary = {
  resultStatus: Exclude<SchedulerSummaryOutcome, "skipped">;
  jobsAttempted: number;
  jobsSucceeded: number;
  jobsRun: number;
  jobsSkipped: number;
  jobsNeutralSkipped: number;
  jobsDegraded: number;
  jobsErrored: number;
  budgetOnlyJobs: number;
  jobs: ScheduledSlotJobSummary[];
};

function truncateSummaryText(value: unknown): string {
  return String(value).slice(0, 300);
}

function readMetadataObject(metadata: string | undefined): Record<string, unknown> | null {
  if (!metadata) return null;
  try {
    const parsed = JSON.parse(metadata) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    return null;
  }
  return null;
}

function extractNeutralSkipReason(result: CronResult | null | void): string {
  const metadata = readMetadataObject(result?.metadata);
  const reason = metadata?.reason ?? metadata?.skipped;
  if (typeof reason === "string" && reason.trim()) {
    return truncateSummaryText(reason);
  }
  if (typeof result?.metadata === "string" && result.metadata.startsWith("skipped:")) {
    return truncateSummaryText(result.metadata.slice("skipped:".length).trim());
  }
  return "neutral-skip";
}

export function summarizeCronResult(job: string, result: CronResult | null | void): ScheduledSlotJobSummary {
  const status = result?.status ?? "ok";
  const projection = projectCronResultOutcome(status);
  return {
    job,
    outcome: projection.outcome,
    status,
    itemCount: result?.itemCount,
    ...(projection.neutral ? { neutral: true } : {}),
    ...(status === "skipped_locked" ? { reason: "lease-locked" }
      : status === "skipped_neutral" ? { reason: extractNeutralSkipReason(result) }
        : status === "degraded" || status === "error"
          ? { reason: resolveCronDegradedReason(job, status, result, readMetadataObject(result?.metadata)) ?? undefined }
          : {}),
    ...(status === "error" ? { error: result?.error ? truncateSummaryText(result.error) : undefined } : {}),
  };
}

export function summarizeThrownScheduledJob(job: string, err: unknown): ScheduledSlotJobSummary {
  const descriptor = describeError(err, stripSensitive);
  return {
    job,
    outcome: "error",
    status: "error",
    reason: err instanceof CronTerminalAccountingError ? err.reason
      : descriptor.code || (descriptor.name === "NonError" ? "non-error-throw" : descriptor.name),
    error: descriptor.message.slice(0, 300),
    ...(err instanceof CronTerminalAccountingError ? {
      terminalAccountingError: {
        stage: err.stage,
        outputPublishedAt: err.outputPublishedAt,
        productive: err.productive,
      },
    } : {}),
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
    resultStatus: foldScheduledOutcomes(jobs.map((job) => ({ outcome: job.outcome, neutral: job.neutral === true }))),
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
