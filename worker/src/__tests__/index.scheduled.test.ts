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
  snapshotSafetyGradeHistory: vi.fn(async () => ({ status: "ok", itemCount: 1, metadata: "{}" })),
  fetchTbillRate: vi.fn(async () => ({ status: "ok", itemCount: 1, metadata: "{}" })),
  snapshotPsiDaily: vi.fn(async () => ({ status: "ok", itemCount: 1, metadata: "{}" })),
  syncUsdsStatus: vi.fn(async () => ({ status: "ok", itemCount: 1, metadata: "{}" })),
  syncLiveReserves: vi.fn(async () => ({ status: "ok", itemCount: 1, metadata: "{}" })),
  syncRedemptionBackstops: vi.fn(async () => ({ status: "ok", itemCount: 1, metadata: "{}" })),
  syncKinesisSupply: vi.fn(async () => ({ status: "ok", itemCount: 2, metadata: "{}" })),
  syncDexLiquidity: vi.fn(async () => ({ status: "ok", itemCount: 1, metadata: "{}" })),
  syncYieldData: vi.fn(async () => ({ status: "ok", itemCount: 1, metadata: "{}" })),
  syncBluechip: vi.fn(async () => ({ status: "ok", itemCount: 1, metadata: "{}" })),
  generateDailyDigest: vi.fn(async () => ({ status: "ok", itemCount: 1, metadata: "{}" })),
  generateWeeklyRecap: vi.fn(async () => ({ status: "ok", itemCount: 1, metadata: "{}" })),
  runDiscoveryScan: vi.fn(async () => ({ status: "ok", itemCount: 1, metadata: "{}" })),
  logCronRun: vi.fn(async (
    _db: D1Database,
    _job: string,
    fn: (signal: AbortSignal, reportProgress: (update: Record<string, unknown>) => Promise<void>) => Promise<unknown>,
    _alertFn?: (title: string, message: string) => Promise<unknown> | void,
    _options?: { slotStartedAt?: number | null },
  ) => (
    fn(new AbortController().signal, async () => undefined)
  )),
  runCronWithLease: vi.fn(async (
    _db: D1Database,
    _job: string,
    fn: (ctx: { signal: AbortSignal }) => Promise<unknown>,
    _opts?: { abortSignal?: AbortSignal },
  ) => ({
    status: "ok",
    leaseOwner: "test-lease",
    renewFailures: 0,
    result: await fn({ signal: new AbortController().signal }),
  })),
  runScheduledSlotWithFence: vi.fn(async (
    _db: D1Database,
    slotKey: string,
    fn: () => Promise<void>,
    opts: { slotStartedAt: number },
  ) => {
    await fn();
    return {
      status: "ok",
      slotKey,
      slotStartedAt: opts.slotStartedAt,
      owner: "slot-owner",
    };
  }),
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
vi.mock("../cron/snapshot-safety-grade-history", () => ({
  snapshotSafetyGradeHistory: cronMocks.snapshotSafetyGradeHistory,
}));
vi.mock("../cron/fetch-tbill-rate", () => ({ fetchTbillRate: cronMocks.fetchTbillRate }));
vi.mock("../cron/snapshot-psi", () => ({ snapshotPsiDaily: cronMocks.snapshotPsiDaily }));
vi.mock("../cron/sync-usds-status", () => ({ syncUsdsStatus: cronMocks.syncUsdsStatus }));
vi.mock("../cron/sync-live-reserves", () => ({ syncLiveReserves: cronMocks.syncLiveReserves }));
vi.mock("../cron/sync-redemption-backstops", () => ({ syncRedemptionBackstops: cronMocks.syncRedemptionBackstops }));
vi.mock("../cron/sync-kinesis-supply", () => ({ syncKinesisSupply: cronMocks.syncKinesisSupply }));
vi.mock("../cron/dex-liquidity", () => ({ syncDexLiquidity: cronMocks.syncDexLiquidity }));
vi.mock("../cron/sync-yield-data", () => ({ syncYieldData: cronMocks.syncYieldData }));
vi.mock("../cron/sync-bluechip", () => ({ syncBluechip: cronMocks.syncBluechip }));
vi.mock("../cron/daily-digest", () => ({ generateDailyDigest: cronMocks.generateDailyDigest }));
vi.mock("../cron/weekly-recap", () => ({ generateWeeklyRecap: cronMocks.generateWeeklyRecap }));
vi.mock("../cron/discovery-scan", () => ({ runDiscoveryScan: cronMocks.runDiscoveryScan }));

vi.mock("../lib/db-cache", () => ({
  getCache: cronMocks.getCache,
  setCache: cronMocks.setCache,
  setCacheIfNewer: vi.fn(async () => undefined),
  shouldSkipFreshCache: vi.fn(async () => false),
  getPriceCache: vi.fn(async () => new Map()),
  savePriceCache: vi.fn(async () => undefined),
}));

vi.mock("../lib/cron-logger", async (importOriginal) => {
  const original = await importOriginal<typeof import("../lib/cron-logger")>();
  return {
    ...original,
    logCronRun: cronMocks.logCronRun,
  };
});

vi.mock("../lib/cron-lease", async (importOriginal) => {
  const original = await importOriginal<typeof import("../lib/cron-lease")>();
  return {
    ...original,
    runCronWithLease: cronMocks.runCronWithLease,
    runScheduledSlotWithFence: cronMocks.runScheduledSlotWithFence,
  };
});

vi.mock("../lib/alerts", async (importOriginal) => {
  const original = await importOriginal<typeof import("../lib/alerts")>();
  return {
    ...original,
    sendAlert: cronMocks.sendAlert,
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

vi.mock("../lib/chain-registry", async (importOriginal) => {
  const original = await importOriginal<typeof import("../lib/chain-registry")>();
  return {
    ...original,
    buildChainRpcs: vi.fn(() => new Map()),
    getChainRpc: vi.fn(() => undefined),
  };
});
vi.mock("../lib/coingecko", async (importOriginal) => {
  const original = await importOriginal<typeof import("../lib/coingecko")>();
  return { ...original };
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

    expect(cronMocks.syncFxRates.mock.invocationCallOrder[0]).toBeLessThan(
      cronMocks.syncStablecoins.mock.invocationCallOrder[0],
    );
    expect(cronMocks.syncStablecoins).toHaveBeenCalledTimes(1);
    expect(cronMocks.snapshotSupply).toHaveBeenCalledTimes(1);
    expect(cronMocks.syncFxRates).toHaveBeenCalledTimes(1);
    // stability-index and compute-dews now on the half-hourly trigger
    expect(cronMocks.computeAndStoreStabilityIndex).not.toHaveBeenCalled();
    expect(cronMocks.computeAndStoreDEWS).not.toHaveBeenCalled();
    expect(cronMocks.runStatusSelfCheck).toHaveBeenCalledTimes(1);
    // Telegram alerts now on dedicated 5-min trigger
    expect(cronMocks.dispatchTelegramAlerts).not.toHaveBeenCalled();
    // Charts now on the half-hourly offset trigger
    expect(cronMocks.syncStablecoinCharts).not.toHaveBeenCalled();
  });

  it("derives slot identity from scheduledTime and threads it through slot fencing and cron logging", async () => {
    const { ctx, waits } = makeCtx();
    const env = {
      DB: {} as D1Database,
      CORS_ORIGIN: "https://pharos.watch",
      TELEGRAM_BOT_TOKEN: "bot-token",
    } as const;
    const scheduledTime = Date.parse("2026-03-23T00:15:00Z");
    const expectedSlotStartedAt = Math.floor(scheduledTime / 1000);

    await worker.scheduled(
      { cron: "*/15 * * * *", scheduledTime } as ScheduledEvent,
      env as never,
      ctx,
    );
    await Promise.all(waits);

    expect(cronMocks.runScheduledSlotWithFence).toHaveBeenCalledWith(
      expect.anything(),
      "quarterHourly",
      expect.any(Function),
      expect.objectContaining({ slotStartedAt: expectedSlotStartedAt }),
    );
    expect(cronMocks.logCronRun).toHaveBeenCalledWith(
      expect.anything(),
      "sync-stablecoins",
      expect.any(Function),
      expect.any(Function),
      expect.objectContaining({ slotStartedAt: expectedSlotStartedAt }),
    );
    expect(cronMocks.runCronWithLease).toHaveBeenCalledWith(
      expect.anything(),
      "sync-stablecoins",
      expect.any(Function),
      expect.objectContaining({ abortSignal: expect.any(AbortSignal) }),
    );
  });

  it("logs and returns when the slot fence reports a duplicate delivery", async () => {
    const scheduledTime = Date.parse("2025-11-24T01:45:00Z");
    const expectedSlotStartedAt = Math.floor(scheduledTime / 1000);
    cronMocks.runScheduledSlotWithFence.mockResolvedValueOnce({
      status: "skipped_duplicate",
      slotKey: "quarterHourly",
      slotStartedAt: expectedSlotStartedAt,
      owner: "slot-owner",
    });
    const infoSpy = vi.spyOn(console, "info").mockImplementation(() => {});

    const { ctx, waits } = makeCtx();
    const env = {
      DB: {} as D1Database,
      CORS_ORIGIN: "https://pharos.watch",
      TELEGRAM_BOT_TOKEN: "bot-token",
    } as const;

    await worker.scheduled(
      { cron: "*/15 * * * *", scheduledTime } as ScheduledEvent,
      env as never,
      ctx,
    );
    await Promise.all(waits);

    expect(cronMocks.syncStablecoins).not.toHaveBeenCalled();
    expect(infoSpy).toHaveBeenCalledWith(
      `[cron-slot] Skipping duplicate slot quarterHourly@${expectedSlotStartedAt}`,
    );

    infoSpy.mockRestore();
  });

  it("logs when the slot fence reports an already-running delivery", async () => {
    const scheduledTime = Date.parse("2025-11-24T01:45:00Z");
    const expectedSlotStartedAt = Math.floor(scheduledTime / 1000);
    cronMocks.runScheduledSlotWithFence.mockResolvedValueOnce({
      status: "skipped_running",
      slotKey: "quarterHourly",
      slotStartedAt: expectedSlotStartedAt,
      owner: "slot-owner",
    });
    const infoSpy = vi.spyOn(console, "info").mockImplementation(() => {});

    const { ctx, waits } = makeCtx();
    const env = {
      DB: {} as D1Database,
      CORS_ORIGIN: "https://pharos.watch",
      TELEGRAM_BOT_TOKEN: "bot-token",
    } as const;

    await worker.scheduled(
      { cron: "*/15 * * * *", scheduledTime } as ScheduledEvent,
      env as never,
      ctx,
    );
    await Promise.all(waits);

    expect(cronMocks.syncStablecoins).not.toHaveBeenCalled();
    expect(infoSpy).toHaveBeenCalledWith(
      `[cron-slot] Slot already running quarterHourly@${expectedSlotStartedAt}`,
    );

    infoSpy.mockRestore();
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
    expect(cronMocks.computeAndStoreDEWS).toHaveBeenCalledTimes(1);
    expect(cronMocks.computeAndStoreStabilityIndex).toHaveBeenCalledTimes(1);
    expect(cronMocks.syncYieldData).toHaveBeenCalledTimes(1);
    expect(cronMocks.syncDexLiquidity.mock.invocationCallOrder[0]).toBeGreaterThan(
      cronMocks.syncStablecoinCharts.mock.invocationCallOrder[0],
    );
    expect(cronMocks.computeAndStoreDEWS.mock.invocationCallOrder[0]).toBeGreaterThan(
      cronMocks.syncDexLiquidity.mock.invocationCallOrder[0],
    );
    expect(cronMocks.computeAndStoreStabilityIndex.mock.invocationCallOrder[0]).toBeGreaterThan(
      cronMocks.computeAndStoreDEWS.mock.invocationCallOrder[0],
    );
    expect(cronMocks.syncYieldData.mock.invocationCallOrder[0]).toBeGreaterThan(
      cronMocks.computeAndStoreStabilityIndex.mock.invocationCallOrder[0],
    );
  });

  it("continues half-hourly downstream jobs when sync-dex-liquidity throws", async () => {
    cronMocks.syncDexLiquidity.mockRejectedValueOnce(new Error("dex failed"));

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
    expect(cronMocks.computeAndStoreDEWS).toHaveBeenCalledTimes(1);
    expect(cronMocks.computeAndStoreStabilityIndex).toHaveBeenCalledTimes(1);
    expect(cronMocks.syncYieldData).toHaveBeenCalledTimes(1);
  });

  it("continues sync-usds-status when fetch-tbill-rate throws in the daily 08:00 slot", async () => {
    cronMocks.fetchTbillRate.mockRejectedValueOnce(new Error("tbill failed"));

    const { ctx, waits } = makeCtx();
    const env = {
      DB: {} as D1Database,
      CORS_ORIGIN: "https://pharos.watch",
      ETHERSCAN_API_KEY: "etherscan",
    } as const;

    await worker.scheduled(
      { cron: "0 8 * * *" } as ScheduledEvent,
      env as never,
      ctx,
    );
    await Promise.all(waits);

    expect(cronMocks.fetchTbillRate).toHaveBeenCalledTimes(1);
    expect(cronMocks.syncUsdsStatus).toHaveBeenCalledTimes(1);
    expect(cronMocks.snapshotSupply).toHaveBeenCalledTimes(1);
    expect(cronMocks.snapshotSafetyGradeHistory).toHaveBeenCalledTimes(1);
    expect(cronMocks.snapshotPsiDaily).toHaveBeenCalledTimes(1);
  });

  it("contains individual daily 08:05 failures and continues the other jobs", async () => {
    cronMocks.generateDailyDigest.mockRejectedValueOnce(new Error("digest failed"));

    const { ctx, waits } = makeCtx();
    const env = {
      DB: {} as D1Database,
      CORS_ORIGIN: "https://pharos.watch",
      ANTHROPIC_API_KEY: "anthropic",
    } as const;

    await worker.scheduled(
      { cron: "5 8 * * *" } as ScheduledEvent,
      env as never,
      ctx,
    );
    await Promise.all(waits);

    expect(cronMocks.syncBluechip).toHaveBeenCalledTimes(1);
    expect(cronMocks.generateDailyDigest).toHaveBeenCalledTimes(1);
    expect(cronMocks.generateWeeklyRecap).toHaveBeenCalledTimes(1);
    expect(cronMocks.runDiscoveryScan).toHaveBeenCalledTimes(1);
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
    expect(cronMocks.syncKinesisSupply).toHaveBeenCalledTimes(1);
    expect(cronMocks.snapshotSupply).not.toHaveBeenCalled();
    expect(cronMocks.syncStablecoinCharts).not.toHaveBeenCalled();
  });

  it("runs only blacklist on the dedicated hourly :03 trigger", async () => {
    const { ctx, waits } = makeCtx();
    const env = {
      DB: {} as D1Database,
      CORS_ORIGIN: "https://pharos.watch",
    } as const;

    await worker.scheduled(
      { cron: "3 * * * *" } as ScheduledEvent,
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

  it("runs only DEX discovery on the dedicated :06/:36 trigger", async () => {
    const { ctx, waits } = makeCtx();
    const env = {
      DB: {} as D1Database,
      CORS_ORIGIN: "https://pharos.watch",
      COINGECKO_API_KEY: "cg-key",
    } as const;

    await worker.scheduled(
      { cron: "6,36 * * * *" } as ScheduledEvent,
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
