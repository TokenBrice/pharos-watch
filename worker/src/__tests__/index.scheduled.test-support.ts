import worker from "../index";
import { makeExecutionContext } from "../test-helpers/__shared/auth";
import { makeScheduledEnv } from "../test-helpers/scheduled-runtime.test-support";

export async function invokeScheduled(
  cron: string,
  env = makeScheduledEnv(),
  scheduledTime = Date.parse("2026-08-26T12:00:00Z"),
): Promise<void> {
  const { ctx, waits } = makeExecutionContext();
  try {
    await worker.scheduled({ cron, scheduledTime } as ScheduledEvent, env, ctx);
  } finally {
    await Promise.all(waits);
  }
}
