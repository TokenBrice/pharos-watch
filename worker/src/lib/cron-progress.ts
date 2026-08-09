import type { CronProgressReporter, CronProgressUpdate } from "./cron-logger";
import type { SubrequestBudget } from "./evm-logs";

export function withBudgetMetadata(
  budget: Pick<SubrequestBudget, "count" | "limit">,
  metadata: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    ...metadata,
    budgetUsed: budget.count,
    budgetLimit: budget.limit,
  };
}

/**
 * `providerFamily` is the one metadata convention every progress-reporting cron
 * shares: the family is stamped into `metadata.providerFamily` alongside
 * `metadata.phase` (always the stage). Caller metadata still wins on key
 * collision, exactly as the per-job wrappers this replaced did.
 */
export async function reportCronProgress(
  reportProgress: CronProgressReporter | undefined,
  update: Omit<CronProgressUpdate, "metadata"> & {
    metadata?: Record<string, unknown> | null;
    providerFamily?: string;
  },
  budget?: Pick<SubrequestBudget, "count" | "limit">,
): Promise<void> {
  if (!reportProgress) return;
  const { providerFamily, metadata, ...rest } = update;
  const composed = providerFamily === undefined
    ? (metadata ?? null)
    : { providerFamily, phase: rest.stage, ...metadata };
  await reportProgress({
    ...rest,
    metadata: budget ? withBudgetMetadata(budget, composed ?? {}) : composed,
  });
}
