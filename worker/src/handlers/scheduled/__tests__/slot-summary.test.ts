import { describe, expect, it } from "vitest";
import { buildScheduledSlotSummary, summarizeCronResult } from "../slot-summary";

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
});
