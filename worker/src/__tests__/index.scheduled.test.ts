import { beforeEach, describe, expect, it, vi } from "vitest";

const cronMocks = vi.hoisted(() => ({
  syncStablecoins: vi.fn(async () => ({ status: "ok", itemCount: 1, metadata: "{}" })),
  syncStablecoinCharts: vi.fn(async () => ({ status: "ok", itemCount: 1, metadata: "{}" })),
  syncFxRates: vi.fn(async () => ({ status: "ok", itemCount: 1, metadata: "{}" })),
  computeAndStoreStabilityIndex: vi.fn(async () => ({ status: "ok", itemCount: 1, metadata: "{}" })),
  computeAndStoreDEWS: vi.fn(async () => ({ status: "ok", itemCount: 1, metadata: "{}" })),
  runStatusSelfCheck: vi.fn(async () => ({ status: "ok", itemCount: 1, metadata: "{}" })),
  snapshotSupply: vi.fn(async () => ({ status: "ok", itemCount: 1, metadata: "{}" })),
  syncDexLiquidity: vi.fn(async () => ({ status: "ok", itemCount: 1, metadata: "{}" })),
  syncYieldData: vi.fn(async () => ({ status: "ok", itemCount: 1, metadata: "{}" })),
  logCronRun: vi.fn(async (_db: D1Database, _job: string, fn: (signal: AbortSignal) => Promise<unknown>) => (
    fn(new AbortController().signal)
  )),
  runCronWithLease: vi.fn(async (
    _db: D1Database,
    _job: string,
    fn: (ctx: { signal: AbortSignal }) => Promise<unknown>,
  ) => ({
    status: "ok",
    leaseOwner: "test-lease",
    renewFailures: 0,
    result: await fn({ signal: new AbortController().signal }),
  })),
  getCache: vi.fn(async () => null),
  setCache: vi.fn(async () => undefined),
  sendAlert: vi.fn(async () => true),
  shouldAttemptFetch: vi.fn(async () => true),
  recordOutcome: vi.fn(async () => undefined),
}));

vi.mock("../cron/sync-stablecoins", () => ({ syncStablecoins: cronMocks.syncStablecoins }));
vi.mock("../cron/sync-stablecoin-charts", () => ({ syncStablecoinCharts: cronMocks.syncStablecoinCharts }));
vi.mock("../cron/sync-fx-rates", () => ({ syncFxRates: cronMocks.syncFxRates }));
vi.mock("../cron/stability-index", () => ({ computeAndStoreStabilityIndex: cronMocks.computeAndStoreStabilityIndex }));
vi.mock("../cron/compute-dews", () => ({ computeAndStoreDEWS: cronMocks.computeAndStoreDEWS }));
vi.mock("../cron/status-self-check", () => ({ runStatusSelfCheck: cronMocks.runStatusSelfCheck }));
vi.mock("../cron/snapshot-supply", () => ({ snapshotSupply: cronMocks.snapshotSupply }));
vi.mock("../cron/dex-liquidity", () => ({ syncDexLiquidity: cronMocks.syncDexLiquidity }));
vi.mock("../cron/sync-yield-data", () => ({ syncYieldData: cronMocks.syncYieldData }));

vi.mock("../lib/db", async (importOriginal) => {
  const original = await importOriginal<typeof import("../lib/db")>();
  return {
    ...original,
    logCronRun: cronMocks.logCronRun,
    runCronWithLease: cronMocks.runCronWithLease,
    getCache: cronMocks.getCache,
    setCache: cronMocks.setCache,
  };
});

vi.mock("../lib/alerts", async (importOriginal) => {
  const original = await importOriginal<typeof import("../lib/alerts")>();
  return {
    ...original,
    sendAlert: cronMocks.sendAlert,
    initAlerts: vi.fn(),
  };
});

vi.mock("../lib/circuit-breaker", async (importOriginal) => {
  const original = await importOriginal<typeof import("../lib/circuit-breaker")>();
  return {
    ...original,
    shouldAttemptFetch: cronMocks.shouldAttemptFetch,
    recordOutcome: cronMocks.recordOutcome,
  };
});

vi.mock("../lib/chain-rpcs", () => ({ initChainRpcs: vi.fn() }));
vi.mock("../lib/coingecko", async (importOriginal) => {
  const original = await importOriginal<typeof import("../lib/coingecko")>();
  return { ...original, initCoinGecko: vi.fn() };
});

import worker from "../index";

function makeCtx() {
  const waits: Promise<unknown>[] = [];
  return {
    waits,
    ctx: {
      waitUntil: vi.fn((promise: Promise<unknown>) => {
        waits.push(Promise.resolve(promise));
      }),
      passThroughOnException: vi.fn(),
    } as unknown as ExecutionContext,
  };
}

describe("worker.scheduled", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("runs 15-min cron fan-out and chained jobs", async () => {
    const { ctx, waits } = makeCtx();
    const env = {
      DB: {} as D1Database,
      CORS_ORIGIN: "https://pharos.watch",
    } as const;

    await worker.scheduled(
      { cron: "*/15 * * * *" } as ScheduledEvent,
      env as never,
      ctx,
    );
    await Promise.all(waits);

    expect(cronMocks.syncStablecoins).toHaveBeenCalledTimes(1);
    expect(cronMocks.snapshotSupply).toHaveBeenCalledTimes(1);
    expect(cronMocks.syncStablecoinCharts).toHaveBeenCalledTimes(1);
    expect(cronMocks.syncFxRates).toHaveBeenCalledTimes(1);
    expect(cronMocks.computeAndStoreStabilityIndex).toHaveBeenCalledTimes(1);
    expect(cronMocks.computeAndStoreDEWS).toHaveBeenCalledTimes(1);
    expect(cronMocks.runStatusSelfCheck).toHaveBeenCalledTimes(1);
  });

  it("runs dex then yield on the 30-min cron", async () => {
    const { ctx, waits } = makeCtx();
    const env = {
      DB: {} as D1Database,
      CORS_ORIGIN: "https://pharos.watch",
    } as const;

    await worker.scheduled(
      { cron: "10,40 * * * *" } as ScheduledEvent,
      env as never,
      ctx,
    );
    await Promise.all(waits);

    expect(cronMocks.syncDexLiquidity).toHaveBeenCalledTimes(1);
    expect(cronMocks.syncYieldData).toHaveBeenCalledTimes(1);
    expect(cronMocks.syncYieldData.mock.invocationCallOrder[0]).toBeGreaterThan(
      cronMocks.syncDexLiquidity.mock.invocationCallOrder[0],
    );
  });
});
