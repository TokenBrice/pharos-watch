import { beforeEach, describe, expect, it, vi } from "vitest";

const cronMocks = vi.hoisted(() => ({
  syncStablecoins: vi.fn(async () => ({
    status: "ok",
    itemCount: 1,
    metadata: JSON.stringify({
      downstreamSafe: true,
      cacheWriteMode: "main-write",
      capabilities: {
        stablecoinsCache: true,
        depegPipeline: true,
      },
    }),
  })),
  syncStablecoinCharts: vi.fn(async () => ({ status: "ok", itemCount: 1, metadata: "{}" })),
  syncBlacklist: vi.fn(async () => ({ status: "ok", itemCount: 1, metadata: "{}" })),
  syncMintBurn: vi.fn(async () => ({ status: "ok", itemCount: 1, metadata: "{}" })),
  syncDexDiscovery: vi.fn(async () => ({ status: "ok", itemCount: 1, metadata: "{}" })),
  syncFxRates: vi.fn(async () => ({ status: "ok", itemCount: 1, metadata: "{}" })),
  computeAndStoreStabilityIndex: vi.fn(async () => ({ status: "ok", itemCount: 1, metadata: "{}" })),
  computeAndStoreDEWS: vi.fn(async () => ({ status: "ok", itemCount: 1, metadata: "{}" })),
  dispatchTelegramAlerts: vi.fn(async () => ({ status: "ok", itemCount: 1, metadata: "{}" })),
  runStatusSelfCheck: vi.fn(async () => ({ status: "ok", itemCount: 1, metadata: "{}" })),
  snapshotSupply: vi.fn(async () => ({ status: "ok", itemCount: 1, metadata: "{}" })),
  syncLiveReserves: vi.fn(async () => ({ status: "ok", itemCount: 1, metadata: "{}" })),
  syncRedemptionBackstops: vi.fn(async () => ({ status: "ok", itemCount: 1, metadata: "{}" })),
  syncDexLiquidity: vi.fn(async () => ({ status: "ok", itemCount: 1, metadata: "{}" })),
  syncYieldData: vi.fn(async () => ({ status: "ok", itemCount: 1, metadata: "{}" })),
  logCronRun: vi.fn(async (
    _db: D1Database,
    _job: string,
    fn: (signal: AbortSignal, reportProgress: (update: Record<string, unknown>) => Promise<void>) => Promise<unknown>,
  ) => (
    fn(new AbortController().signal, async () => undefined)
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
vi.mock("../cron/sync-blacklist", () => ({ syncBlacklist: cronMocks.syncBlacklist }));
vi.mock("../cron/sync-mint-burn", () => ({ syncMintBurn: cronMocks.syncMintBurn }));
vi.mock("../cron/dex-discovery", () => ({ syncDexDiscovery: cronMocks.syncDexDiscovery }));
vi.mock("../cron/sync-fx-rates", () => ({ syncFxRates: cronMocks.syncFxRates }));
vi.mock("../cron/stability-index", () => ({ computeAndStoreStabilityIndex: cronMocks.computeAndStoreStabilityIndex }));
vi.mock("../cron/compute-dews", () => ({ computeAndStoreDEWS: cronMocks.computeAndStoreDEWS }));
vi.mock("../cron/dispatch-telegram-alerts", () => ({ dispatchTelegramAlerts: cronMocks.dispatchTelegramAlerts }));
vi.mock("../cron/status-self-check", () => ({ runStatusSelfCheck: cronMocks.runStatusSelfCheck }));
vi.mock("../cron/snapshot-supply", () => ({ snapshotSupply: cronMocks.snapshotSupply }));
vi.mock("../cron/sync-live-reserves", () => ({ syncLiveReserves: cronMocks.syncLiveReserves }));
vi.mock("../cron/sync-redemption-backstops", () => ({ syncRedemptionBackstops: cronMocks.syncRedemptionBackstops }));
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

vi.mock("../lib/chain-registry", () => ({ initChainRpcs: vi.fn() }));
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

  it("runs 15-min cron fan-out and chained jobs (charts excluded)", async () => {
    const { ctx, waits } = makeCtx();
    const env = {
      DB: {} as D1Database,
      CORS_ORIGIN: "https://pharos.watch",
      TELEGRAM_BOT_TOKEN: "bot-token",
    } as const;

    await worker.scheduled(
      { cron: "*/15 * * * *" } as ScheduledEvent,
      env as never,
      ctx,
    );
    await Promise.all(waits);

    expect(cronMocks.syncStablecoins).toHaveBeenCalledTimes(1);
    expect(cronMocks.snapshotSupply).toHaveBeenCalledTimes(1);
    expect(cronMocks.syncFxRates).toHaveBeenCalledTimes(1);
    expect(cronMocks.computeAndStoreStabilityIndex).toHaveBeenCalledTimes(1);
    expect(cronMocks.computeAndStoreDEWS).toHaveBeenCalledTimes(1);
    expect(cronMocks.runStatusSelfCheck).toHaveBeenCalledTimes(1);
    // Telegram alerts now on dedicated 5-min trigger
    expect(cronMocks.dispatchTelegramAlerts).not.toHaveBeenCalled();
    // Charts now on the half-hourly offset trigger
    expect(cronMocks.syncStablecoinCharts).not.toHaveBeenCalled();
  });

  it("skips downstream-safe dependent jobs when sync-stablecoins finishes degraded without safe cache write", async () => {
    cronMocks.syncStablecoins.mockResolvedValueOnce({
      status: "degraded",
      itemCount: 0,
      metadata: JSON.stringify({
        downstreamSafe: false,
        cacheWriteMode: "blocked-invalid-payload",
      }),
    });

    const { ctx, waits } = makeCtx();
    const env = {
      DB: {} as D1Database,
      CORS_ORIGIN: "https://pharos.watch",
      TELEGRAM_BOT_TOKEN: "bot-token",
    } as const;

    await worker.scheduled(
      { cron: "*/15 * * * *" } as ScheduledEvent,
      env as never,
      ctx,
    );
    await Promise.all(waits);

    expect(cronMocks.syncStablecoins).toHaveBeenCalledTimes(1);
    expect(cronMocks.snapshotSupply).not.toHaveBeenCalled();
    expect(cronMocks.computeAndStoreStabilityIndex).not.toHaveBeenCalled();
    expect(cronMocks.computeAndStoreDEWS).not.toHaveBeenCalled();
    expect(cronMocks.syncFxRates).toHaveBeenCalledTimes(1);
    expect(cronMocks.runStatusSelfCheck).toHaveBeenCalledTimes(1);
  });

  it("runs cache-dependent jobs but skips depeg-dependent jobs when sync-stablecoins writes a safe cache with depeg failures", async () => {
    cronMocks.syncStablecoins.mockResolvedValueOnce({
      status: "degraded",
      itemCount: 1,
      metadata: JSON.stringify({
        downstreamSafe: true,
        cacheWriteMode: "main-write",
        depegErrorCount: 1,
        capabilities: {
          stablecoinsCache: true,
          depegPipeline: false,
        },
      }),
    });

    const { ctx, waits } = makeCtx();
    const env = {
      DB: {} as D1Database,
      CORS_ORIGIN: "https://pharos.watch",
      TELEGRAM_BOT_TOKEN: "bot-token",
    } as const;

    await worker.scheduled(
      { cron: "*/15 * * * *" } as ScheduledEvent,
      env as never,
      ctx,
    );
    await Promise.all(waits);

    expect(cronMocks.snapshotSupply).toHaveBeenCalledTimes(1);
    expect(cronMocks.computeAndStoreStabilityIndex).not.toHaveBeenCalled();
    expect(cronMocks.computeAndStoreDEWS).toHaveBeenCalledTimes(1);
  });

  it("runs charts → dex → yield on the 30-min cron", async () => {
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

    expect(cronMocks.syncStablecoinCharts).toHaveBeenCalledTimes(1);
    expect(cronMocks.syncDexLiquidity).toHaveBeenCalledTimes(1);
    expect(cronMocks.syncYieldData).toHaveBeenCalledTimes(1);
    expect(cronMocks.syncDexLiquidity.mock.invocationCallOrder[0]).toBeGreaterThan(
      cronMocks.syncStablecoinCharts.mock.invocationCallOrder[0],
    );
    expect(cronMocks.syncYieldData.mock.invocationCallOrder[0]).toBeGreaterThan(
      cronMocks.syncDexLiquidity.mock.invocationCallOrder[0],
    );
  });

  it("runs live reserve sync on the dedicated hourly trigger", async () => {
    const { ctx, waits } = makeCtx();
    const env = {
      DB: {} as D1Database,
      CORS_ORIGIN: "https://pharos.watch",
      ETHERSCAN_API_KEY: "etherscan",
      ALCHEMY_API_KEY: "alchemy",
    } as const;

    await worker.scheduled(
      { cron: "11 * * * *" } as ScheduledEvent,
      env as never,
      ctx,
    );
    await Promise.all(waits);

    expect(cronMocks.syncLiveReserves).toHaveBeenCalledTimes(1);
    expect(cronMocks.syncRedemptionBackstops).toHaveBeenCalledTimes(1);
    expect(cronMocks.snapshotSupply).not.toHaveBeenCalled();
    expect(cronMocks.syncStablecoinCharts).not.toHaveBeenCalled();
  });

  it("runs only blacklist on the dedicated :03/:23/:43 trigger", async () => {
    const { ctx, waits } = makeCtx();
    const env = {
      DB: {} as D1Database,
      CORS_ORIGIN: "https://pharos.watch",
    } as const;

    await worker.scheduled(
      { cron: "3,23,43 * * * *" } as ScheduledEvent,
      env as never,
      ctx,
    );
    await Promise.all(waits);

    expect(cronMocks.syncBlacklist).toHaveBeenCalledTimes(1);
    expect(cronMocks.syncMintBurn).not.toHaveBeenCalled();
    expect(cronMocks.syncDexDiscovery).not.toHaveBeenCalled();
  });

  it("runs only critical mint/burn on the dedicated :04/:24/:44 trigger", async () => {
    const { ctx, waits } = makeCtx();
    const env = {
      DB: {} as D1Database,
      CORS_ORIGIN: "https://pharos.watch",
      ALCHEMY_API_KEY: "alchemy-key",
    } as const;

    await worker.scheduled(
      { cron: "4,24,44 * * * *" } as ScheduledEvent,
      env as never,
      ctx,
    );
    await Promise.all(waits);

    expect(cronMocks.syncMintBurn).toHaveBeenCalledTimes(1);
    const criticalCall = cronMocks.syncMintBurn.mock.calls[0] as unknown[] | undefined;
    expect(criticalCall?.[2]).toMatchObject({
      lane: "critical",
      jobName: "sync-mint-burn",
    });
    expect(cronMocks.syncBlacklist).not.toHaveBeenCalled();
    expect(cronMocks.syncDexDiscovery).not.toHaveBeenCalled();
  });

  it("runs only DEX discovery on the dedicated :06/:26/:46 trigger", async () => {
    const { ctx, waits } = makeCtx();
    const env = {
      DB: {} as D1Database,
      CORS_ORIGIN: "https://pharos.watch",
      COINGECKO_API_KEY: "cg-key",
    } as const;

    await worker.scheduled(
      { cron: "6,26,46 * * * *" } as ScheduledEvent,
      env as never,
      ctx,
    );
    await Promise.all(waits);

    expect(cronMocks.syncDexDiscovery).toHaveBeenCalledTimes(1);
    expect(cronMocks.syncBlacklist).not.toHaveBeenCalled();
    expect(cronMocks.syncMintBurn).not.toHaveBeenCalled();
  });

  it("runs telegram dispatch on the dedicated 5-min trigger", async () => {
    const { ctx, waits } = makeCtx();
    const env = {
      DB: {} as D1Database,
      CORS_ORIGIN: "https://pharos.watch",
      TELEGRAM_BOT_TOKEN: "bot-token",
    } as const;

    await worker.scheduled(
      { cron: "2,7,12,17,22,27,32,37,42,47,52,57 * * * *" } as ScheduledEvent,
      env as never,
      ctx,
    );
    await Promise.all(waits);

    expect(cronMocks.dispatchTelegramAlerts).toHaveBeenCalledTimes(1);
    expect(cronMocks.syncStablecoins).not.toHaveBeenCalled();
    expect(cronMocks.computeAndStoreDEWS).not.toHaveBeenCalled();
  });

  it("runs the extended mint/burn lane on the offset 20-min slot", async () => {
    const { ctx, waits } = makeCtx();
    const env = {
      DB: {} as D1Database,
      CORS_ORIGIN: "https://pharos.watch",
      ALCHEMY_API_KEY: "alchemy-key",
    } as const;

    await worker.scheduled(
      { cron: "13,33,53 * * * *" } as ScheduledEvent,
      env as never,
      ctx,
    );
    await Promise.all(waits);

    expect(cronMocks.syncMintBurn).toHaveBeenCalledTimes(1);
    const extendedCall = cronMocks.syncMintBurn.mock.calls[0] as unknown[] | undefined;
    expect(extendedCall?.[2]).toMatchObject({
      lane: "extended",
      jobName: "sync-mint-burn-extended",
    });
    expect(cronMocks.syncBlacklist).not.toHaveBeenCalled();
    expect(cronMocks.syncDexDiscovery).not.toHaveBeenCalled();
  });
});
