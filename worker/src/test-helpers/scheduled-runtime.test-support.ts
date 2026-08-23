import { vi } from "vitest";
import type { ScheduledRuntimeContext } from "../handlers/scheduled/context";
import { createWorkerEnv } from "./__shared/worker-env";
import { mockD1 } from "./__shared/mock-d1";

/** Build the stable runtime context used by scheduled-handler unit tests. */
export function makeScheduledRuntime(
  overrides: Partial<ScheduledRuntimeContext> = {},
): ScheduledRuntimeContext {
  const signal = new AbortController().signal;
  const runLeasedCron = vi.fn(async (_job: string, fn: Parameters<ScheduledRuntimeContext["runLeasedCron"]>[1]) =>
    fn(signal, vi.fn()),
  );

  return {
    db: mockD1([], { allowUnmatched: true }),
    env: createWorkerEnv(),
    ctx: {} as ExecutionContext,
    cron: "0 * * * *",
    scheduleKey: "quarterHourly",
    scheduledTimeMs: 1_735_689_600_000,
    slotStartedAt: 1_735_689_600,
    mintBurnDisabledIds: [],
    mintBurnDisabledSymbols: [],
    mintBurnFreshnessConfig: {} as ScheduledRuntimeContext["mintBurnFreshnessConfig"],
    coingeckoApiKey: null,
    chainRpcs: new Map(),
    runLeasedCron: runLeasedCron as ScheduledRuntimeContext["runLeasedCron"],
    ...overrides,
  };
}
