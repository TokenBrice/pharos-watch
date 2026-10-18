import type { CronResult } from "../../../lib/cron-logger";
import type { D1CostTracker } from "../../../lib/d1-cost";

export const DEX_D1_COST_EXCLUSIONS = [
  "outer-lease-and-progress-queries-excluded",
  "cron-logger-and-terminal-writes-excluded",
  "failed-run-cost-not-recorded",
] as const;

export function withDexD1CostMetadata(result: CronResult, tracker: D1CostTracker): CronResult {
  const metadata = JSON.parse(result.metadata ?? "{}") as Record<string, unknown>;
  metadata.d1Cost = tracker.snapshot();
  return { ...result, metadata: JSON.stringify(metadata) };
}
