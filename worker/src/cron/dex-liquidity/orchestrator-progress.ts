import type { CronProgressReporter } from "../../lib/cron-logger";
import { reportCronProgress } from "../../lib/cron-progress";

export interface DexProgressReportDetails {
  message: string;
  providerFamily?: string;
  done?: number;
  total?: number;
  counts?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
}

export type DexProgressReporter = (
  stage: string,
  details: DexProgressReportDetails,
) => Promise<void>;

export function createDexProgressReporter(
  reportProgress: CronProgressReporter | undefined,
  { totalStablecoins }: { totalStablecoins: number },
): DexProgressReporter {
  return async (stage, details) => {
    const hasExplicitTotal = Object.prototype.hasOwnProperty.call(details, "total");
    const total = hasExplicitTotal ? details.total : totalStablecoins;
    const metadata = details.counts === undefined
      ? details.metadata
      : { countTotals: details.counts, ...details.metadata };

    await reportCronProgress(reportProgress, {
      stage,
      message: details.message,
      providerFamily: details.providerFamily,
      itemsDone: details.done ?? 0,
      ...(total === undefined ? {} : { itemsTotal: total }),
      ...(metadata === undefined ? {} : { metadata }),
    });
  };
}
