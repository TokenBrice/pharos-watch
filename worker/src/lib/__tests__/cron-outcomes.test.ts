import { describe, expect, it } from "vitest";
import { projectCronResultOutcome, projectChildDisposition, foldScheduledOutcomes } from "../cron-outcomes";
import { CronRunStatusSchema, SchedulerChildDispositionSchema } from "@shared/types/status/cron";

describe("canonical scheduler outcomes", () => {
  it.each(CronRunStatusSchema.exclude(["skipped_duplicate", "skipped_running"]).options)("projects %s exhaustively", (status) => {
    expect(projectCronResultOutcome(status)).toEqual(status === "skipped_locked"
      ? { outcome: "skipped", neutral: false } : status === "skipped_neutral"
        ? { outcome: "skipped", neutral: true } : { outcome: status, neutral: false });
  });
  it.each(SchedulerChildDispositionSchema.options)("projects %s without new producer vocabulary", (disposition) => {
    expect(projectChildDisposition(disposition)).toEqual(disposition === "completed"
      ? { status: "ok", producerOutcome: "ok" } : disposition === "interrupted-by-deploy"
        ? { status: "skipped_neutral", producerOutcome: "skipped_neutral" }
        : { status: "error", producerOutcome: disposition === "not_started" ? "not_started" : "abandoned" });
  });
  it("folds errors above degradation and nonneutral skips without counting neutral skips", () => {
    expect(foldScheduledOutcomes([])).toBe("ok");
    expect(foldScheduledOutcomes([projectCronResultOutcome("skipped_neutral"), projectCronResultOutcome("ok")])).toBe("ok");
    expect(foldScheduledOutcomes([projectCronResultOutcome("skipped_locked")])).toBe("degraded");
    expect(foldScheduledOutcomes([projectCronResultOutcome("degraded"), projectCronResultOutcome("ok")])).toBe("degraded");
    expect(foldScheduledOutcomes([projectCronResultOutcome("degraded"), projectCronResultOutcome("error")])).toBe("error");
  });
  it("keeps accounting failures and superseded child outcomes errors", () => {
    for (const reason of ["cron-terminal-accounting-failed", "cron-child-terminal-superseded"]) {
      const summary = { ...projectCronResultOutcome("error"), reason };
      expect(foldScheduledOutcomes([projectCronResultOutcome("skipped_neutral"), summary])).toBe("error");
    }
  });
});
