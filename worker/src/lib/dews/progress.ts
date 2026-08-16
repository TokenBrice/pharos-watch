import type { CronProgressReporter, CronResult } from "../cron-logger";

export type DewsProgressMetadata = {
  rowsComputed?: number;
  rowsWritten?: number;
  sourceFailures?: number;
  validationFailures: number;
};

export async function reportDewsProgress(
  reportProgress: CronProgressReporter | undefined,
  stage: string,
  metadata: DewsProgressMetadata,
): Promise<void> {
  if (!reportProgress) return;
  await reportProgress({
    stage,
    message: `DEWS ${stage}`,
    metadata,
  });
}

export function buildStablecoinsCacheFailureResult(reason: string): CronResult {
  return {
    itemCount: 0,
    status: "degraded",
    metadata: JSON.stringify({
      rowsRead: 0,
      rowsWritten: 0,
      rowsDropped: 0,
      sourceCoverage: { stablecoins: 0 },
      sourceFailures: [{ source: "stablecoins-cache", reason, bootstrapAllowed: false }],
      fallbackMode: "stablecoins-cache-unavailable",
      validationFailures: 1,
    }),
  };
}
