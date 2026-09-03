import { vi } from "vitest";
import type { ScheduledRuntimeContext } from "../handlers/scheduled/context";
import { createWorkerEnv } from "./__shared/worker-env";
import { makeNoopD1 } from "./noop-d1";

/** Build the common environment used by scheduled-handler tests. */
export function makeScheduledEnv(
  overrides: Parameters<typeof createWorkerEnv>[0] = {},
): ReturnType<typeof createWorkerEnv> {
  return createWorkerEnv({
    DB: makeNoopD1(),
    CORS_ORIGIN: "https://pharos.watch",
    ...overrides,
  });
}

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
    db: makeNoopD1(),
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
