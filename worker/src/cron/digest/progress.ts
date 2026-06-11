import type { CronProgressReporter } from "../../lib/cron-logger";
import { reportCronProgress } from "../../lib/cron-progress";

export async function reportDigestProgress(
  reportProgress: CronProgressReporter | undefined,
  update: {
    stage: string;
    message: string;
    providerFamily: string;
    itemsDone?: number;
    itemsTotal?: number;
    metadata?: Record<string, unknown>;
  },
): Promise<void> {
  await reportCronProgress(reportProgress, {
    stage: update.stage,
    message: update.message,
    itemsDone: update.itemsDone,
    itemsTotal: update.itemsTotal,
    metadata: {
      providerFamily: update.providerFamily,
      phase: update.stage,
      ...update.metadata,
    },
  });
}
