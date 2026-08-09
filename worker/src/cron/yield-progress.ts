import type { CronProgressReporter } from "../lib/cron-logger";
import { reportCronProgress } from "../lib/cron-progress";

interface YieldProgressCounts {
  yieldBearingCoins: number;
  opportunityCoins: number;
}

interface YieldProgressOptions {
  itemsDone?: number;
  itemsTotal?: number;
  metadata?: Record<string, unknown>;
}

interface YieldProgressReporter {
  progressTotal: number;
  reportYieldProgress: (
    stage: string,
    message: string,
    providerFamily: string,
    options?: YieldProgressOptions,
  ) => Promise<void>;
}

export function createYieldProgressReporter(
  reportProgress: CronProgressReporter | undefined,
  counts: YieldProgressCounts,
): YieldProgressReporter {
  const progressTotal = counts.yieldBearingCoins + counts.opportunityCoins;
  const defaultCountTotals = {
    yieldBearingCoins: counts.yieldBearingCoins,
    opportunityCoins: counts.opportunityCoins,
    totalTrackedForYield: progressTotal,
  };

  const reportYieldProgress: YieldProgressReporter["reportYieldProgress"] = async (
    stage,
    message,
    providerFamily,
    options = {},
  ) => {
    await reportCronProgress(reportProgress, {
      stage,
      message,
      providerFamily,
      itemsDone: options.itemsDone,
      itemsTotal: options.itemsTotal ?? progressTotal,
      metadata: {
        countTotals: defaultCountTotals,
        ...options.metadata,
      },
    });
  };

  return { progressTotal, reportYieldProgress };
}
