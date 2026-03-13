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

export async function reportCronProgress(
  reportProgress: CronProgressReporter | undefined,
  update: Omit<CronProgressUpdate, "metadata"> & { metadata?: Record<string, unknown> | null },
  budget?: Pick<SubrequestBudget, "count" | "limit">,
): Promise<void> {
  if (!reportProgress) return;
  await reportProgress({
    ...update,
    metadata: budget ? withBudgetMetadata(budget, update.metadata ?? {}) : (update.metadata ?? null),
  });
}
