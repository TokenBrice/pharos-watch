import type { CronProgressReporter, CronResult } from "../cron-logger";
import type { StablecoinsDependencyDiagnostics } from "./contracts";

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

export function buildStablecoinsCacheFailureResult(
  reason: string,
  stablecoins: StablecoinsDependencyDiagnostics,
): CronResult {
  return {
    itemCount: 0,
    status: "degraded",
    productivity: { productive: false, reason: "dews-generation-withheld-degraded", publications: [] },
    metadata: JSON.stringify({
      rowsRead: 0,
      rowsWritten: 0,
      rowsDropped: 0,
      reason: "dews-cohort-dependency-unavailable",
      dependencies: { stablecoins },
      degradedSources: ["stablecoins-cache"],
      publicationPointerWritten: false,
      freshnessSentinelPublished: false,
      sourceCoverage: { stablecoins: 0 },
      sourceFailures: [{ source: "stablecoins-cache", reason }],
      fallbackMode: "stablecoins-cache-unavailable",
      validationFailures: 1,
    }),
  };
}
