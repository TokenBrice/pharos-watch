import { describe, expect, it, vi } from "vitest";
import { buildScheduledSlotSummary, summarizeCronResult, summarizeSkippedScheduledJob, summarizeThrownScheduledJob } from "../slot-summary";
import { CronTerminalAccountingError } from "../../../lib/cron-logger";
import { runBestEffortScheduledJobWithOutcome } from "../run-best-effort-job";
import type { ScheduledRuntimeContext } from "../context";

describe("slot-summary", () => {
  it("counts skipped_neutral cron results as neutral skipped jobs", () => {
    const job = summarizeCronResult("weekly-recap", {
      status: "skipped_neutral",
      itemCount: 0,
      metadata: JSON.stringify({ reason: "not-monday" }),
    });

    expect(job).toMatchObject({
      job: "weekly-recap",
      outcome: "skipped",
      status: "skipped_neutral",
      itemCount: 0,
      reason: "not-monday",
      neutral: true,
    });

    const summary = buildScheduledSlotSummary([job]);
    expect(summary.jobsAttempted).toBe(0);
    expect(summary.jobsSucceeded).toBe(0);
    expect(summary.jobsSkipped).toBe(0);
    expect(summary.jobsNeutralSkipped).toBe(1);
  });

  it("folds neutral skips, locked skips, degraded and error outcomes without changing counts", () => {
    const neutral = summarizeCronResult("neutral", { status: "skipped_neutral" });
    const locked = summarizeCronResult("locked", { status: "skipped_locked" });
    const degraded = summarizeCronResult("degraded", { status: "degraded" });
    const error = summarizeCronResult("error", { status: "error" });
    expect(buildScheduledSlotSummary([neutral]).resultStatus).toBe("ok");
    expect(buildScheduledSlotSummary([neutral, locked])).toMatchObject({
      resultStatus: "degraded", jobsAttempted: 0, jobsSkipped: 1, jobsNeutralSkipped: 1,
    });
    expect(buildScheduledSlotSummary([degraded, error])).toMatchObject({
      resultStatus: "error", jobsAttempted: 2, jobsDegraded: 1, jobsErrored: 1,
    });
    expect(buildScheduledSlotSummary([summarizeSkippedScheduledJob("preflight", "unsafe")]))
      .toMatchObject({ resultStatus: "degraded", jobsSkipped: 1, jobsAttempted: 0 });
  });

  it.each(["degraded", "error"] as const)("projects %s child reasons", (status) => {
    expect(summarizeCronResult("job", { status, metadata: '{"reason":"publication-held"}' }))
      .toMatchObject({ outcome: status, reason: "publication-held" });
  });

  it("counts accounting failure as an error while retaining publication diagnostics", async () => {
    const result = { status: "ok" as const, itemCount: 12 };
    const error = new CronTerminalAccountingError({
      cause: new Error("history failed"), stage: "producer-history",
      completedResult: result, outputPublishedAt: 123, productive: true,
    });
    const summary = summarizeThrownScheduledJob("job", error);
    expect(summary).toMatchObject({
      outcome: "error", status: "error", reason: "cron-terminal-accounting-failed",
      terminalAccountingError: { stage: "producer-history", outputPublishedAt: 123, productive: true },
    });
    expect(summary).not.toHaveProperty("completedResult");
    expect(buildScheduledSlotSummary([summary])).toMatchObject({ jobsErrored: 1, jobsSucceeded: 0 });
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const runtime = { runLeasedCron: vi.fn(async () => { throw error; }) } as unknown as ScheduledRuntimeContext;
      const outcome = await runBestEffortScheduledJobWithOutcome(runtime, "slot", "job", async () => result);
      expect(outcome.result).toBe(result);
      expect(outcome.summary).toEqual(summary);
    } finally { log.mockRestore(); }
  });
});
