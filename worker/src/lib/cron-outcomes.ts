import type { CronResultStatus, ProducerOutcome, SchedulerChildDisposition, SchedulerSummaryOutcome } from "@shared/types/status/cron";

export interface ScheduledOutcomeProjection {
  outcome: SchedulerSummaryOutcome;
  neutral: boolean;
}
export function projectCronResultOutcome(status: CronResultStatus = "ok"): ScheduledOutcomeProjection {
  switch (status) {
    case "ok": return { outcome: "ok", neutral: false };
    case "degraded": return { outcome: "degraded", neutral: false };
    case "error": return { outcome: "error", neutral: false };
    case "skipped_locked": return { outcome: "skipped", neutral: false };
    case "skipped_neutral": return { outcome: "skipped", neutral: true };
    default: return assertNever(status);
  }
}
export function projectChildDisposition(disposition: SchedulerChildDisposition): { status: CronResultStatus; producerOutcome: ProducerOutcome } {
  switch (disposition) {
    case "completed": return { status: "ok", producerOutcome: "ok" };
    case "abandoned":
    case "execution_unknown": return { status: "error", producerOutcome: "abandoned" };
    case "not_started": return { status: "error", producerOutcome: "not_started" };
    case "interrupted-by-deploy": return { status: "skipped_neutral", producerOutcome: "skipped_neutral" };
    default: return assertNever(disposition);
  }
}
export function foldScheduledOutcomes(outcomes: readonly ScheduledOutcomeProjection[]): "ok" | "degraded" | "error" {
  let result: "ok" | "degraded" | "error" = "ok";
  for (const entry of outcomes) {
    switch (entry.outcome) {
      case "error": return "error";
      case "degraded": result = "degraded"; break;
      case "skipped": if (!entry.neutral) result = "degraded"; break;
      case "ok": break;
      default: assertNever(entry.outcome);
    }
  }
  return result;
}
function assertNever(value: never): never {
  throw new Error(`Unknown scheduler outcome: ${String(value)}`);
}
