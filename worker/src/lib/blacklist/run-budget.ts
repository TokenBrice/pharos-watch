import { budgetExhausted, createBudget, type SubrequestBudget } from "../evm-logs";

export interface BlacklistRunBudget {
  subrequestBudget: SubrequestBudget;
  deadlineMs: number;
  minimumConfigWindowMs: number;
}

export function createBlacklistRunBudget(options: {
  subrequestLimit: number;
  runtimeBudgetMs: number;
  minimumConfigWindowMs?: number;
}): BlacklistRunBudget {
  return {
    subrequestBudget: createBudget(options.subrequestLimit),
    deadlineMs: Date.now() + options.runtimeBudgetMs,
    minimumConfigWindowMs: options.minimumConfigWindowMs ?? 0,
  };
}

export function blacklistRuntimeBudgetReached(runBudget: Pick<BlacklistRunBudget, "deadlineMs">): boolean {
  return Date.now() >= runBudget.deadlineMs;
}

export function blacklistSubrequestBudgetReached(
  runBudget: Pick<BlacklistRunBudget, "subrequestBudget">,
): boolean {
  return budgetExhausted(runBudget.subrequestBudget);
}

export function blacklistShouldStopBeforeNextConfig(
  runBudget: Pick<BlacklistRunBudget, "deadlineMs" | "minimumConfigWindowMs">,
): boolean {
  return Date.now() + runBudget.minimumConfigWindowMs >= runBudget.deadlineMs;
}
