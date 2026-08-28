import { vi } from "vitest";
import type { ScheduledRuntimeContext } from "../handlers/scheduled/context";
import { createWorkerEnv } from "./__shared/worker-env";
import { mockD1 } from "@shared/test-utils/mock-d1";

/** Make a mocked memory-lane lease execute its callback immediately. */
export function mockSuccessfulCronLease(
  leaseMock: ReturnType<typeof vi.fn>,
): void {
  leaseMock.mockImplementation(async (
    _db: D1Database,
    _job: string,
    run: (input: { signal: AbortSignal }) => Promise<unknown>,
    leaseOptions?: { abortSignal?: AbortSignal },
  ) => ({
    status: "ok",
    result: await run({
      signal: leaseOptions?.abortSignal ?? new AbortController().signal,
    }),
  }));
}

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
