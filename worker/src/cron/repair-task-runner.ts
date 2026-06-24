import type { CronResult } from "../lib/cron-logger";
import { runWorkerRepairTaskRunner } from "../lib/repair-tasks";

export function runRepairTaskRunner(
  db: D1Database,
  mode: string | undefined,
  signal?: AbortSignal,
): Promise<CronResult> {
  return runWorkerRepairTaskRunner(db, { mode, signal });
}
