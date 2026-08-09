import {
  CRON_TRIGGER_SCHEDULES,
} from "@shared/lib/cron-jobs";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { mockD1 } from "../test-helpers/__shared/mock-d1";

const cronMocks = vi.hoisted(() => ({
  syncStablecoins: vi.fn(async () => ({
    status: "ok",
    itemCount: 1,
    metadata: JSON.stringify({
      downstreamSafe: true,
      cacheWriteMode: "published",
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
  projectTape: vi.fn(async () => ({ status: "ok", itemCount: 1, metadata: "{}" })),
  cancelQueuedTelegramRecapsForRollout: vi.fn(async () => ({
    targetRowsCancelled: 0,
    pendingRowsDeleted: 0,
  })),
  dispatchTelegramAlerts: vi.fn(async () => ({ status: "ok", itemCount: 1, metadata: "{}" })),
  runTelegramDegradationWatchdog: vi.fn(async () => ({ status: "ok", itemCount: 1, metadata: "{}" })),
  cleanExpiredDisambiguations: vi.fn(async () => ({ status: "ok", itemCount: 1, metadata: "{}" })),
  publishTelegramPulseSnapshotWithOutcome: vi.fn(async () => ({
    pulse: { quality: { status: "complete", unavailableFields: [] } },
    status: "ok",
    snapshotPublished: true,
    heavySectionsRecomputed: false,
    heavyMarkerAdvanced: true,
    error: null,
  })),
  runStatusSelfCheck: vi.fn(async () => ({ status: "ok", itemCount: 1, metadata: "{}" })),
  runCronStalenessWatchdog: vi.fn(async () => ({ status: "ok", itemCount: 1, metadata: "{}" })),
  snapshotSupply: vi.fn(async () => ({ status: "ok", itemCount: 1, metadata: "{}" })),
  snapshotChainSupply: vi.fn(async () => ({ status: "ok", itemCount: 1, metadata: "{}" })),
  syncSafetyScoreV9SupplyAttribution: vi.fn(async () => ({ status: "ok", itemCount: 1, metadata: "{}" })),
  computeSafetyScoreV9: vi.fn(async () => ({ status: "ok", itemCount: 1, metadata: "{}" })),
  prepareSafetyScoreV9Input: vi.fn(async () => ({ status: "ok", itemCount: 1, metadata: "{}" })),
  computeDepegResolver: vi.fn(async () => ({ status: "ok", itemCount: 1, metadata: "{}" })),
  snapshotSafetyGradeHistory: vi.fn(async () => ({ status: "ok", itemCount: 1, metadata: "{}" })),
  fetchTbillRate: vi.fn(async () => ({ status: "ok", itemCount: 1, metadata: "{}" })),
  snapshotPsiDaily: vi.fn(async () => ({ status: "ok", itemCount: 1, metadata: "{}" })),
  snapshotPublicDataset: vi.fn(async () => ({ status: "ok", itemCount: 1, metadata: "{}" })),
  syncUsdsStatus: vi.fn(async () => ({ status: "ok", itemCount: 1, metadata: "{}" })),
  syncLiveReserves: vi.fn(async () => ({ status: "ok", itemCount: 1, metadata: "{}" })),
  syncRedemptionBackstops: vi.fn(async () => ({ status: "ok", itemCount: 1, metadata: "{}" })),
  syncKinesisSupply: vi.fn(async () => ({ status: "ok", itemCount: 2, metadata: "{}" })),
  stageDexLiquidityScoring: vi.fn(async () => ({ status: "ok", itemCount: 1, metadata: "{}" })),
  consumeDexLiquidityScoringStage: vi.fn(async () => ({
    status: "ok",
    itemCount: 1,
    metadata: JSON.stringify({
      persistence: { generationId: "dex-liquidity-1785060960" },
    }),
  })),
  syncYieldData: vi.fn(async () => ({ status: "ok", itemCount: 1, metadata: "{}" })),
  syncYieldSupplemental: vi.fn(async () => ({ status: "ok", itemCount: 1, metadata: "{}" })),
  syncBluechip: vi.fn(async () => ({ status: "ok", itemCount: 1, metadata: "{}" })),
  generateDailyDigest: vi.fn(async () => ({ status: "ok", itemCount: 1, metadata: "{}" })),
  generateWeeklyRecap: vi.fn(async () => ({ status: "ok", itemCount: 1, metadata: "{}" })),
  runPruneStatusProbeRuns: vi.fn(async () => ({ status: "ok", itemCount: 1, metadata: "{}" })),
  runPruneCronHistory: vi.fn(async () => ({ status: "ok", itemCount: 1, metadata: "{}" })),
  runRepairTaskRunner: vi.fn(async () => ({ status: "ok", itemCount: 0, metadata: "{}" })),
  runPruneDetailCache: vi.fn(async () => ({ status: "ok", itemCount: 1, metadata: "{}" })),
  runTelegramInactiveCleanup: vi.fn(async () => ({ status: "ok", itemCount: 1, metadata: "{}" })),
  runTelegramRetentionCleanup: vi.fn(async () => ({ status: "ok", itemCount: 1, metadata: "{}" })),
  runMintBurnGrowthWatchdog: vi.fn(async () => ({ status: "ok", itemCount: 1, metadata: "{}" })),
  runCronDurationWatchdog: vi.fn(async () => ({ status: "ok", itemCount: 1, metadata: "{}" })),
  runYieldCoverageAudit: vi.fn(async () => ({ status: "ok", itemCount: 1, metadata: "{}" })),
  refreshAggregateMintBurnFlowCache: vi.fn(async () => new Response("{}")),
  logCronRun: vi.fn(async (
    _db: D1Database,
    _job: string,
    fn: (signal: AbortSignal, reportProgress: (update: Record<string, unknown>) => Promise<void>) => Promise<unknown>,
    _options?: { slotStartedAt?: number | null },
  ) => (
    fn(new AbortController().signal, async () => undefined)
  )),
  runCronWithLease: vi.fn(async (
    _db: D1Database,
    _job: string,
    fn: (ctx: { signal: AbortSignal }) => Promise<unknown>,
    _opts?: {
      abortSignal?: AbortSignal;
      owner?: string;
      onLeaseState?: (state: {
        event: "acquired" | "renewed";
        job: string;
        leaseOwner: string;
        leaseUntil: number;
        heartbeatAt: number;
        ttlSec: number;
      }) => Promise<void> | void;
    },
  ) => ({
    status: "ok",
    leaseOwner: _opts?.owner ?? "test-lease",
    renewFailures: 0,
    leaseLost: false,
    leaseTtlSec: 360,
    leaseHeartbeatSec: 120,
    leaseMaxRenewFailures: 2,
    leaseRenewAttempts: 0,
    leaseRenewSuccesses: 0,
    leaseRenewFailuresTotal: 0,
    leaseLastRenewedAt: null,
    result: await (async () => {
      await _opts?.onLeaseState?.({
        event: "acquired",
        job: _job,
        leaseOwner: _opts?.owner ?? "test-lease",
        leaseUntil: 1_777_777_900,
        heartbeatAt: 1_777_777_540,
        ttlSec: 360,
      });
      return fn({ signal: new AbortController().signal });
    })(),
  })),
  runScheduledSlotWithFence: vi.fn(async (
    _db: D1Database,
    slotKey: string,
    fn: () => Promise<{ jobsErrored: number; jobsDegraded: number; jobsSkipped: number } | void>,
    opts: { slotStartedAt: number },
  ) => {
    const metadata = await fn();
    return {
      status: "ok",
      resultStatus:
        metadata && (metadata.jobsErrored > 0 || metadata.jobsDegraded > 0 || metadata.jobsSkipped > 0)
          ? "degraded"
          : "ok",
      slotKey,
      slotStartedAt: opts.slotStartedAt,
      owner: "slot-owner",
      metadata,
    };
  }),
  getCache: vi.fn(async () => null),
  setCache: vi.fn(async () => undefined),
  shouldAttemptFetch: vi.fn(async () => true),
  recordOutcome: vi.fn(async () => undefined),
  reconcileTelegramCommandRegistration: vi.fn(async () => ({ attempted: false })),
  reconcileTelegramMenuButton: vi.fn(async () => ({ attempted: false, miniAppUrl: null })),
  reconcileTelegramProfileRegistration: vi.fn(async () => ({ attempted: false })),
  reconcileTelegramWebhookRegistration: vi.fn(async () => ({ attempted: false, expectedUrl: null })),
}));

vi.mock("../cron/sync-stablecoins", () => ({ syncStablecoins: cronMocks.syncStablecoins }));
vi.mock("../cron/sync-stablecoin-charts", () => ({ syncStablecoinCharts: cronMocks.syncStablecoinCharts }));
vi.mock("../cron/sync-blacklist", () => ({ syncBlacklist: cronMocks.syncBlacklist }));
vi.mock("../cron/sync-mint-burn", () => ({ syncMintBurn: cronMocks.syncMintBurn }));
vi.mock("../cron/dex-discovery/orchestrator", () => ({ syncDexDiscovery: cronMocks.syncDexDiscovery }));
vi.mock("../cron/sync-fx-rates", () => ({ syncFxRates: cronMocks.syncFxRates }));
vi.mock("../cron/stability-index", () => ({ computeAndStoreStabilityIndex: cronMocks.computeAndStoreStabilityIndex }));
vi.mock("../cron/compute-dews", () => ({ computeAndStoreDEWS: cronMocks.computeAndStoreDEWS }));
vi.mock("../cron/project-tape", () => ({ projectTape: cronMocks.projectTape }));
vi.mock("../cron/telegram-recap-store", async (importOriginal) => {
  const original = await importOriginal<typeof import("../cron/telegram-recap-store")>();
  return {
    ...original,
    cancelQueuedTelegramRecapsForRollout: cronMocks.cancelQueuedTelegramRecapsForRollout,
  };
});
vi.mock("../cron/dispatch-telegram-alerts", () => ({ dispatchTelegramAlerts: cronMocks.dispatchTelegramAlerts }));
vi.mock("../cron/telegram-degradation-watchdog", () => ({
  runTelegramDegradationWatchdog: cronMocks.runTelegramDegradationWatchdog,
}));
vi.mock("../api/telegram-store/disambiguation", () => ({
  cleanExpiredDisambiguations: cronMocks.cleanExpiredDisambiguations,
}));
vi.mock("../api/telegram-pulse", () => ({
  publishTelegramPulseSnapshotWithOutcome: cronMocks.publishTelegramPulseSnapshotWithOutcome,
}));
vi.mock("../handlers/scheduled/preflight-skip", () => ({
  logSkippedCronRun: vi.fn(async () => undefined),
}));
vi.mock("../lib/budget-surface-telemetry", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/budget-surface-telemetry")>();
  return { ...actual, recordBudgetSurfaceTelemetry: vi.fn(async () => undefined) };
});
vi.mock("../lib/scheduled-recovery-checkpoint", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/scheduled-recovery-checkpoint")>();
  let latestCheckpoint: Record<string, unknown> | null = null;
  return {
    ...actual,
    beginScheduledCheckpoint: vi.fn(async (_db: D1Database, input: Record<string, unknown>) => {
      latestCheckpoint = {
        scheduleKey: input.scheduleKey,
        slotStartedAt: input.slotStartedAt,
        job: input.job,
        attemptNo: 1,
        executionGeneration: 1,
        invocationId: input.invocationId,
        workerVersion: input.workerVersion ?? null,
        queueHash: input.queueHash,
        state: "running",
        nextItemKey: input.nextItemKey ?? null,
        currentItemKey: null,
        currentDomainAttemptId: null,
        itemsDone: 0,
        itemsTotal: input.itemsTotal ?? 0,
        childDispositions: {},
        recoveryOwner: null,
        recoveryLeaseUntil: null,
        sourceAttemptNo: null,
        error: null,
        createdAt: 0,
        updatedAt: 0,
        completedAt: null,
      };
      return latestCheckpoint;
    }),
    loadScheduledCheckpoint: vi.fn(async () => latestCheckpoint == null ? null : {
      ...latestCheckpoint,
      nextItemKey: null,
      itemsDone: latestCheckpoint.itemsTotal,
    }),
    setScheduledCheckpointChildDisposition: vi.fn(async (
      _db: D1Database,
      _identity: Record<string, unknown>,
      job: string,
      disposition: string,
    ) => {
      if (!latestCheckpoint) return;
      latestCheckpoint = {
        ...latestCheckpoint,
        childDispositions: {
          ...(latestCheckpoint.childDispositions as Record<string, unknown>),
          [job]: disposition,
        },
      };
    }),
    finishScheduledCheckpoint: vi.fn(async () => undefined),
    claimNextScheduledCheckpointRecovery: vi.fn(async () => null),
  };
});
vi.mock("../lib/reserve-recovery-fault-injection", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/reserve-recovery-fault-injection")>();
  return {
    ...actual,
    loadReserveRecoveryFaultInjectionController: vi.fn(async () => null),
  };
});
vi.mock("../cron/status-self-check", () => ({ runStatusSelfCheck: cronMocks.runStatusSelfCheck }));
vi.mock("../cron/cron-staleness-watchdog", () => ({
  runCronStalenessWatchdog: cronMocks.runCronStalenessWatchdog,
}));
vi.mock("../cron/snapshot-supply", () => ({ snapshotSupply: cronMocks.snapshotSupply }));
vi.mock("../cron/snapshot-chain-supply", () => ({ snapshotChainSupply: cronMocks.snapshotChainSupply }));
vi.mock("../cron/sync-v9-supply-attribution", () => ({
  syncSafetyScoreV9SupplyAttribution: cronMocks.syncSafetyScoreV9SupplyAttribution,
}));
vi.mock("../cron/compute-safety-score-v9", () => ({
  computeSafetyScoreV9: cronMocks.computeSafetyScoreV9,
}));
vi.mock("../lib/v9-slot-window", () => ({
  waitForV9MemoryLaneRelease: vi.fn(async () => undefined),
  runV9AfterCoreWithinWindow: vi.fn(
    (
      _options: unknown,
      run: (signal: AbortSignal) => Promise<unknown>,
    ) => run(new AbortController().signal),
  ),
}));
vi.mock("../cron/prepare-safety-score-v9-input", () => ({
  prepareSafetyScoreV9Input: cronMocks.prepareSafetyScoreV9Input,
}));
vi.mock("../cron/compute-depeg-resolver", () => ({ computeDepegResolver: cronMocks.computeDepegResolver }));
vi.mock("../cron/snapshot-safety-grade-history", () => ({
  snapshotSafetyGradeHistory: cronMocks.snapshotSafetyGradeHistory,
}));
vi.mock("../cron/fetch-tbill-rate", () => ({ fetchTbillRate: cronMocks.fetchTbillRate }));
vi.mock("../cron/snapshot-psi", () => ({ snapshotPsiDaily: cronMocks.snapshotPsiDaily }));
vi.mock("../cron/snapshot-public-dataset", () => ({ snapshotPublicDataset: cronMocks.snapshotPublicDataset }));
vi.mock("../cron/sync-usds-status", () => ({ syncUsdsStatus: cronMocks.syncUsdsStatus }));
vi.mock("../cron/sync-live-reserves", () => ({ syncLiveReserves: cronMocks.syncLiveReserves }));
vi.mock("../cron/sync-redemption-backstops", () => ({ syncRedemptionBackstops: cronMocks.syncRedemptionBackstops }));
vi.mock("../cron/sync-kinesis-supply", () => ({ syncKinesisSupply: cronMocks.syncKinesisSupply }));
vi.mock("../cron/dex-liquidity/orchestrator", () => ({
  stageDexLiquidityScoring: cronMocks.stageDexLiquidityScoring,
  consumeDexLiquidityScoringStage: cronMocks.consumeDexLiquidityScoringStage,
}));
vi.mock("../cron/sync-yield-data", () => ({ syncYieldData: cronMocks.syncYieldData }));
vi.mock("../cron/sync-yield-supplemental", () => ({ syncYieldSupplemental: cronMocks.syncYieldSupplemental }));
vi.mock("../cron/sync-bluechip", () => ({ syncBluechip: cronMocks.syncBluechip }));
vi.mock("../cron/daily-digest", () => ({ generateDailyDigest: cronMocks.generateDailyDigest }));
vi.mock("../cron/weekly-recap", () => ({ generateWeeklyRecap: cronMocks.generateWeeklyRecap }));
vi.mock("../cron/prune-status-probe-runs", () => ({ runPruneStatusProbeRuns: cronMocks.runPruneStatusProbeRuns }));
vi.mock("../cron/prune-cron-history", () => ({ runPruneCronHistory: cronMocks.runPruneCronHistory }));
vi.mock("../cron/repair-task-runner", () => ({ runRepairTaskRunner: cronMocks.runRepairTaskRunner }));
vi.mock("../cron/prune-detail-cache", () => ({ runPruneDetailCache: cronMocks.runPruneDetailCache }));
vi.mock("../cron/telegram-inactive-cleanup", () => ({
  runTelegramInactiveCleanup: cronMocks.runTelegramInactiveCleanup,
}));
vi.mock("../cron/telegram-retention-cleanup", () => ({
  runTelegramRetentionCleanup: cronMocks.runTelegramRetentionCleanup,
}));
vi.mock("../cron/mint-burn-growth-watchdog", () => ({
  runMintBurnGrowthWatchdog: cronMocks.runMintBurnGrowthWatchdog,
}));
vi.mock("../cron/cron-duration-watchdog", () => ({ runCronDurationWatchdog: cronMocks.runCronDurationWatchdog }));
vi.mock("../cron/yield-coverage-audit", () => ({ runYieldCoverageAudit: cronMocks.runYieldCoverageAudit }));
vi.mock("../api/mint-burn-flows", () => ({
  refreshAggregateMintBurnFlowCache: cronMocks.refreshAggregateMintBurnFlowCache,
}));

vi.mock("../lib/db-cache", () => ({
  getCache: cronMocks.getCache,
  setCache: cronMocks.setCache,
  setCacheIfNewer: vi.fn(async () => ({ written: true, skippedBecauseNewer: false })),
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

vi.mock("../lib/circuit-breaker", async (importOriginal) => {
  const original = await importOriginal<typeof import("../lib/circuit-breaker")>();
  return {
    ...original,
    shouldAttemptFetch: cronMocks.shouldAttemptFetch,
    recordOutcome: cronMocks.recordOutcome,
  };
});

vi.mock("../lib/telegram-webhook-registration", async (importOriginal) => {
  const original = await importOriginal<typeof import("../lib/telegram-webhook-registration")>();
  return {
    ...original,
    reconcileTelegramCommandRegistration: cronMocks.reconcileTelegramCommandRegistration,
    reconcileTelegramMenuButton: cronMocks.reconcileTelegramMenuButton,
    reconcileTelegramProfileRegistration: cronMocks.reconcileTelegramProfileRegistration,
    reconcileTelegramWebhookRegistration: cronMocks.reconcileTelegramWebhookRegistration,
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
import {
  PUBLIC_DATASET_STABLECOINS_CACHE_RETRY_ATTEMPTS,
  PUBLIC_DATASET_STABLECOINS_CACHE_RETRY_DELAY_MS,
} from "../lib/public-dataset-snapshot-budget";

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

  it("smokes every configured scheduled trigger without live provider fetches", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
      throw new Error("scheduled smoke attempted a live fetch");
    });
    const db = mockD1();
    const env = {
      DB: db,
      CORS_ORIGIN: "https://pharos.watch",
      TELEGRAM_BOT_TOKEN: "bot-token",
      TELEGRAM_WEBHOOK_SECRET: "webhook-secret",
      ETHERSCAN_API_KEY: "etherscan",
      ALCHEMY_API_KEY: "alchemy",
      ANTHROPIC_API_KEY: "anthropic",
      TWITTER_API_KEY: "tw-key",
      TWITTER_API_SECRET: "tw-secret",
      TWITTER_ACCESS_TOKEN: "tw-token",
      TWITTER_ACCESS_TOKEN_SECRET: "tw-token-secret",
      COINGECKO_API_KEY: "coingecko",
    } as const;
    const schedules = Object.entries(CRON_TRIGGER_SCHEDULES).flatMap(
      ([scheduleKey, triggerSchedules]) =>
        triggerSchedules.map((cron) => [scheduleKey, cron] as const),
    );

    try {
      expect(new Set(schedules.map(([, cron]) => cron)).size).toBe(schedules.length);

      for (const [index, [, cron]] of schedules.entries()) {
        const { ctx, waits } = makeCtx();
        await worker.scheduled(
          {
            cron,
            scheduledTime: Date.parse("2026-06-12T08:00:00Z") + index * 60_000,
          } as ScheduledEvent,
          env as never,
          ctx,
        );
        await Promise.all(waits);
      }

      expect(cronMocks.runScheduledSlotWithFence).toHaveBeenCalledTimes(schedules.length);
      expect(cronMocks.runScheduledSlotWithFence.mock.calls.map((call) => call[1])).toEqual(
        schedules.map(([scheduleKey]) => scheduleKey),
      );
      for (const call of cronMocks.runScheduledSlotWithFence.mock.calls) {
        expect(call[0]).toBe(db);
        expect(call[2]).toEqual(expect.any(Function));
        expect(call[3]).toEqual(expect.objectContaining({ slotStartedAt: expect.any(Number) }));
      }
      expect(cronMocks.logCronRun).toHaveBeenCalled();
      for (const call of cronMocks.logCronRun.mock.calls) {
        expect(call[3]).toEqual(expect.objectContaining({ slotStartedAt: expect.any(Number) }));
      }
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
    }
  }, 15_000);

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
    expect(cronMocks.syncSafetyScoreV9SupplyAttribution).not.toHaveBeenCalled();
    expect(cronMocks.prepareSafetyScoreV9Input).not.toHaveBeenCalled();
    expect(cronMocks.syncFxRates).toHaveBeenCalledTimes(1);
    // stability-index and compute-dews run on the decoupled DEWS/PSI trigger
    expect(cronMocks.computeAndStoreStabilityIndex).not.toHaveBeenCalled();
    expect(cronMocks.computeAndStoreDEWS).not.toHaveBeenCalled();
    expect(cronMocks.runStatusSelfCheck).not.toHaveBeenCalled();
    // Telegram alerts now on dedicated 5-min trigger
    expect(cronMocks.dispatchTelegramAlerts).not.toHaveBeenCalled();
    // Charts now on the half-hourly offset trigger
    expect(cronMocks.syncStablecoinCharts).not.toHaveBeenCalled();
  });

  it("runs V9 attribution and compilation only on their dedicated triggers", async () => {
    const env = {
      DB: {} as D1Database,
      CORS_ORIGIN: "https://pharos.watch",
    } as const;
    const supply = makeCtx();

    await worker.scheduled(
      {
        cron: "8,23,38,53 * * * *",
        scheduledTime: Date.parse("2026-07-26T12:08:00Z"),
      } as ScheduledEvent,
      env as never,
      supply.ctx,
    );
    await Promise.all(supply.waits);

    expect(
      cronMocks.syncSafetyScoreV9SupplyAttribution,
    ).toHaveBeenCalledTimes(1);
    expect(cronMocks.computeSafetyScoreV9).not.toHaveBeenCalled();

    const publication = makeCtx();
    await worker.scheduled(
      {
        cron: "22,52 * * * *",
        scheduledTime: Date.parse("2026-07-26T12:22:00Z"),
      } as ScheduledEvent,
      env as never,
      publication.ctx,
    );
    await Promise.all(publication.waits);

    expect(cronMocks.computeSafetyScoreV9).toHaveBeenCalledTimes(1);
    expect(
      cronMocks.syncSafetyScoreV9SupplyAttribution,
    ).toHaveBeenCalledTimes(1);
    expect(cronMocks.prepareSafetyScoreV9Input).not.toHaveBeenCalled();
    expect(cronMocks.computeDepegResolver).not.toHaveBeenCalled();
  });

  it("runs status-self-check on the isolated offset trigger", async () => {
    const { ctx, waits } = makeCtx();
    const env = {
      DB: {} as D1Database,
      CORS_ORIGIN: "https://pharos.watch",
      TELEGRAM_BOT_TOKEN: "bot-token",
    } as const;

    await worker.scheduled(
      { cron: "9,24,39,54 * * * *" } as ScheduledEvent,
      env as never,
      ctx,
    );
    await Promise.all(waits);

    expect(cronMocks.runStatusSelfCheck).toHaveBeenCalledTimes(1);
    expect(cronMocks.syncStablecoins).not.toHaveBeenCalled();
    expect(cronMocks.syncFxRates).not.toHaveBeenCalled();
  });

  it("throws loudly when a scheduled trigger is unmapped", async () => {
    const { ctx } = makeCtx();
    const env = {
      DB: {} as D1Database,
      CORS_ORIGIN: "https://pharos.watch",
    } as const;

    await expect(
      worker.scheduled(
        { cron: "1 2 3 4 5" } as ScheduledEvent,
        env as never,
        ctx,
      ),
    ).rejects.toThrow("[cron-slot] Unknown scheduled trigger: 1 2 3 4 5");
    expect(cronMocks.runScheduledSlotWithFence).not.toHaveBeenCalled();
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
      expect.objectContaining({ slotStartedAt: expectedSlotStartedAt }),
    );
    expect(cronMocks.runCronWithLease).toHaveBeenCalledWith(
      expect.anything(),
      "sync-stablecoins",
      expect.any(Function),
      expect.objectContaining({ abortSignal: expect.any(AbortSignal) }),
    );
  });

  it("records worker job attempt lease_until from the lease acquisition callback", async () => {
    const { ctx, waits } = makeCtx();
    const db = mockD1();
    const env = {
      DB: db,
      CORS_ORIGIN: "https://pharos.watch",
      TELEGRAM_BOT_TOKEN: "bot-token",
      WORKER_JOB_LEDGER_MODE: "shadow",
      WORKER_JOB_LEDGER_ALLOWLIST: "sync-fx-rates",
    } as const;

    await worker.scheduled(
      { cron: "*/15 * * * *", scheduledTime: Date.parse("2026-04-01T00:15:00Z") } as ScheduledEvent,
      env as never,
      ctx,
    );
    await Promise.all(waits);

    const leaseUpdate = db.getHistory().find((entry) => entry.sql.includes("lease_until = ?"));
    expect(leaseUpdate?.binds[1]).toBe(1_777_777_900);
    expect(leaseUpdate?.binds[6]).toBe(
      "attempt|scheduled-job|quarterHourly|quarterHourly|1775002500|sync-fx-rates|1",
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
      resultStatus: "ok",
      metadata: undefined,
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
      resultStatus: "ok",
      metadata: undefined,
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
    expect(cronMocks.syncSafetyScoreV9SupplyAttribution).not.toHaveBeenCalled();
    expect(cronMocks.prepareSafetyScoreV9Input).not.toHaveBeenCalled();
    expect(cronMocks.syncFxRates).toHaveBeenCalledTimes(1);
    expect(cronMocks.runStatusSelfCheck).not.toHaveBeenCalled();
  });

  it("runs cache-dependent jobs but skips depeg-dependent jobs when sync-stablecoins writes a safe cache with depeg failures", async () => {
    cronMocks.syncStablecoins.mockResolvedValueOnce({
      status: "degraded",
      itemCount: 1,
      metadata: JSON.stringify({
        downstreamSafe: true,
        cacheWriteMode: "published",
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
    expect(cronMocks.syncSafetyScoreV9SupplyAttribution).not.toHaveBeenCalled();
    expect(cronMocks.prepareSafetyScoreV9Input).not.toHaveBeenCalled();
  });

  it("runs only DEX source staging on either hourly physical trigger", async () => {
    const { ctx, waits } = makeCtx();
    const env = {
      DB: {} as D1Database,
      CORS_ORIGIN: "https://pharos.watch",
    } as const;

    await worker.scheduled(
      { cron: "10 * * * *" } as ScheduledEvent,
      env as never,
      ctx,
    );
    await Promise.all(waits);

    expect(cronMocks.syncStablecoinCharts).not.toHaveBeenCalled();
    expect(cronMocks.stageDexLiquidityScoring).toHaveBeenCalledTimes(1);
    expect(cronMocks.consumeDexLiquidityScoringStage).not.toHaveBeenCalled();
    expect(cronMocks.computeAndStoreDEWS).not.toHaveBeenCalled();
    expect(cronMocks.computeAndStoreStabilityIndex).not.toHaveBeenCalled();
    expect(cronMocks.syncYieldData).not.toHaveBeenCalled();
  });

  it("runs staged DEX scoring before charts on either hourly physical trigger", async () => {
    const { ctx, waits } = makeCtx();
    const env = {
      DB: {} as D1Database,
      CORS_ORIGIN: "https://pharos.watch",
    } as const;

    await worker.scheduled(
      { cron: "16 * * * *" } as ScheduledEvent,
      env as never,
      ctx,
    );
    await Promise.all(waits);

    expect(cronMocks.syncStablecoinCharts).toHaveBeenCalledTimes(1);
    expect(cronMocks.consumeDexLiquidityScoringStage).toHaveBeenCalledTimes(1);
    expect(cronMocks.prepareSafetyScoreV9Input).toHaveBeenCalledTimes(1);
    expect(cronMocks.stageDexLiquidityScoring).not.toHaveBeenCalled();
    expect(cronMocks.syncStablecoinCharts.mock.invocationCallOrder[0]).toBeGreaterThan(
      cronMocks.prepareSafetyScoreV9Input.mock.invocationCallOrder[0],
    );
    expect(cronMocks.computeAndStoreDEWS).not.toHaveBeenCalled();
    expect(cronMocks.computeAndStoreStabilityIndex).not.toHaveBeenCalled();
  });

  it("runs dews → psi on the decoupled DB-only trigger", async () => {
    const { ctx, waits } = makeCtx();
    const env = {
      DB: {} as D1Database,
      CORS_ORIGIN: "https://pharos.watch",
    } as const;

    await worker.scheduled(
      { cron: "26,56 * * * *" } as ScheduledEvent,
      env as never,
      ctx,
    );
    await Promise.all(waits);

    expect(cronMocks.syncStablecoinCharts).not.toHaveBeenCalled();
    expect(cronMocks.consumeDexLiquidityScoringStage).not.toHaveBeenCalled();
    expect(cronMocks.computeAndStoreDEWS).toHaveBeenCalledTimes(1);
    expect(cronMocks.computeAndStoreStabilityIndex).toHaveBeenCalledTimes(1);
    expect(cronMocks.syncYieldData).not.toHaveBeenCalled();
    expect(cronMocks.computeAndStoreStabilityIndex.mock.invocationCallOrder[0]).toBeGreaterThan(
      cronMocks.computeAndStoreDEWS.mock.invocationCallOrder[0],
    );
  });

  it("contains DEX source-stage failures within its hourly physical cron", async () => {
    cronMocks.stageDexLiquidityScoring.mockRejectedValueOnce(new Error("dex stage failed"));

    const { ctx, waits } = makeCtx();
    const env = {
      DB: {} as D1Database,
      CORS_ORIGIN: "https://pharos.watch",
    } as const;

    await worker.scheduled(
      { cron: "40 * * * *" } as ScheduledEvent,
      env as never,
      ctx,
    );
    await Promise.all(waits);

    expect(cronMocks.stageDexLiquidityScoring).toHaveBeenCalledTimes(1);
    expect(cronMocks.consumeDexLiquidityScoringStage).not.toHaveBeenCalled();
    expect(cronMocks.computeAndStoreDEWS).not.toHaveBeenCalled();
    expect(cronMocks.computeAndStoreStabilityIndex).not.toHaveBeenCalled();
    expect(cronMocks.syncYieldData).not.toHaveBeenCalled();
  });

  it("runs yield publication on the dedicated hourly :20 trigger", async () => {
    const { ctx, waits } = makeCtx();
    const env = {
      DB: {} as D1Database,
      CORS_ORIGIN: "https://pharos.watch",
      ETHERSCAN_API_KEY: "etherscan",
    } as const;

    await worker.scheduled(
      { cron: "20 * * * *" } as ScheduledEvent,
      env as never,
      ctx,
    );
    await Promise.all(waits);

    expect(cronMocks.syncYieldData).toHaveBeenCalledTimes(1);
    expect(cronMocks.syncStablecoinCharts).not.toHaveBeenCalled();
    expect(cronMocks.consumeDexLiquidityScoringStage).not.toHaveBeenCalled();
    expect(cronMocks.syncYieldSupplemental).not.toHaveBeenCalled();
  });

  it("runs supplemental yield refresh on the dedicated 4-hour :25 trigger", async () => {
    const { ctx, waits } = makeCtx();
    const env = {
      DB: {} as D1Database,
      CORS_ORIGIN: "https://pharos.watch",
    } as const;

    await worker.scheduled(
      { cron: "25 */4 * * *" } as ScheduledEvent,
      env as never,
      ctx,
    );
    await Promise.all(waits);

    expect(cronMocks.syncYieldSupplemental).toHaveBeenCalledTimes(1);
    expect(cronMocks.syncYieldData).not.toHaveBeenCalled();
    expect(cronMocks.syncStablecoinCharts).not.toHaveBeenCalled();
  });

  it("continues sync-usds-status when fetch-tbill-rate throws in the daily 08:00 slot", async () => {
    cronMocks.fetchTbillRate.mockRejectedValueOnce(new Error("tbill failed"));
    const scheduledTime = Date.parse("2026-05-16T08:00:00Z");
    const slotStartedAt = Math.floor(scheduledTime / 1000);

    const { ctx, waits } = makeCtx();
    const env = {
      DB: {} as D1Database,
      CORS_ORIGIN: "https://pharos.watch",
      ETHERSCAN_API_KEY: "etherscan",
    } as const;

    await worker.scheduled(
      { cron: "0 8 * * *", scheduledTime } as ScheduledEvent,
      env as never,
      ctx,
    );
    await Promise.all(waits);

    expect(cronMocks.fetchTbillRate).toHaveBeenCalledTimes(1);
    expect(cronMocks.syncUsdsStatus).toHaveBeenCalledTimes(1);
    expect(cronMocks.snapshotSupply).toHaveBeenCalledTimes(1);
    expect(cronMocks.snapshotSafetyGradeHistory).toHaveBeenCalledTimes(1);
    expect(cronMocks.snapshotPsiDaily).toHaveBeenCalledTimes(1);
    expect(cronMocks.snapshotPublicDataset).toHaveBeenCalledTimes(1);
    expect(cronMocks.snapshotSupply).toHaveBeenCalledWith(
      env.DB,
      expect.any(AbortSignal),
      {
        minStablecoinsCacheUpdatedAtSec: slotStartedAt,
        freshnessGateLabel: "daily0800Utc",
      },
    );
    expect(cronMocks.snapshotPublicDataset).toHaveBeenCalledWith(
      env.DB,
      expect.any(AbortSignal),
      {
        minStablecoinsCacheUpdatedAtSec: slotStartedAt,
        freshnessGateLabel: "daily0800Utc",
        stablecoinsCacheRetryAttempts: PUBLIC_DATASET_STABLECOINS_CACHE_RETRY_ATTEMPTS,
        stablecoinsCacheRetryDelayMs: PUBLIC_DATASET_STABLECOINS_CACHE_RETRY_DELAY_MS,
      },
    );
    expect(cronMocks.snapshotSafetyGradeHistory.mock.invocationCallOrder[0]).toBeLessThan(
      cronMocks.snapshotPsiDaily.mock.invocationCallOrder[0],
    );
    expect(cronMocks.snapshotPsiDaily.mock.invocationCallOrder[0]).toBeLessThan(
      cronMocks.snapshotPublicDataset.mock.invocationCallOrder[0],
    );
  });

  it("contains individual daily 08:05 failures and continues the other jobs", async () => {
    cronMocks.generateDailyDigest.mockRejectedValueOnce(new Error("digest failed"));

    const { ctx, waits } = makeCtx();
    const env = {
      DB: {} as D1Database,
      CORS_ORIGIN: "https://pharos.watch",
      ANTHROPIC_API_KEY: "anthropic",
      TWITTER_API_KEY: "tw-key",
      TWITTER_API_SECRET: "tw-secret",
      TWITTER_ACCESS_TOKEN: "tw-token",
      TWITTER_ACCESS_TOKEN_SECRET: "tw-token-secret",
    } as const;

    await worker.scheduled(
      { cron: "5 8 * * *" } as ScheduledEvent,
      env as never,
      ctx,
    );
    await Promise.all(waits);

    expect(cronMocks.syncBluechip).toHaveBeenCalledTimes(1);
    expect(cronMocks.generateDailyDigest).toHaveBeenCalledTimes(1);
    const digestArgs = cronMocks.generateDailyDigest.mock.calls[0] as unknown[] | undefined;
    expect(digestArgs?.[2]).toEqual({
      apiKey: "tw-key",
      apiSecret: "tw-secret",
      accessToken: "tw-token",
      accessTokenSecret: "tw-token-secret",
    });
    expect(cronMocks.generateWeeklyRecap).not.toHaveBeenCalled();
  });

  it("runs weekly recap on the isolated daily 08:10 trigger", async () => {
    const { ctx, waits } = makeCtx();
    const env = {
      DB: {} as D1Database,
      CORS_ORIGIN: "https://pharos.watch",
      COINGECKO_API_KEY: "coingecko",
    } as const;

    await worker.scheduled(
      { cron: "10 8 * * *" } as ScheduledEvent,
      env as never,
      ctx,
    );
    await Promise.all(waits);

    expect(cronMocks.generateWeeklyRecap).toHaveBeenCalledTimes(1);
    expect(cronMocks.syncBluechip).not.toHaveBeenCalled();
    expect(cronMocks.generateDailyDigest).not.toHaveBeenCalled();
  });

  it("runs live reserve sync on the dedicated 4-hourly trigger", async () => {
    const { ctx, waits } = makeCtx();
    const env = {
      DB: {} as D1Database,
      CORS_ORIGIN: "https://pharos.watch",
      ETHERSCAN_API_KEY: "etherscan",
      ALCHEMY_API_KEY: "alchemy",
    } as const;

    await worker.scheduled(
      { cron: "11 */4 * * *" } as ScheduledEvent,
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

  it("runs only blacklist on the dedicated 6-hourly :03 trigger", async () => {
    const { ctx, waits } = makeCtx();
    const env = {
      DB: {} as D1Database,
      CORS_ORIGIN: "https://pharos.watch",
    } as const;

    await worker.scheduled(
      { cron: "3 */6 * * *" } as ScheduledEvent,
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
    const db = mockD1();
    const env = {
      DB: db,
      CORS_ORIGIN: "https://pharos.watch",
      ALCHEMY_API_KEY: "alchemy-key",
    } as const;

    await worker.scheduled(
      { cron: "4,34 * * * *" } as ScheduledEvent,
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
    expect(cronMocks.refreshAggregateMintBurnFlowCache).toHaveBeenCalledTimes(2);
    expect(cronMocks.refreshAggregateMintBurnFlowCache).toHaveBeenCalledWith(db, 24);
    expect(cronMocks.refreshAggregateMintBurnFlowCache).toHaveBeenCalledWith(db, 168);
    expect(db.getHistory().some((entry) => entry.sql.includes("FROM mint_burn_events"))).toBe(false);
    expect(cronMocks.syncBlacklist).not.toHaveBeenCalled();
    expect(cronMocks.syncDexDiscovery).not.toHaveBeenCalled();
  });

  it("runs only DEX discovery on the dedicated 2-hourly :06 trigger", async () => {
    const { ctx, waits } = makeCtx();
    const env = {
      DB: {} as D1Database,
      CORS_ORIGIN: "https://pharos.watch",
      COINGECKO_API_KEY: "cg-key",
    } as const;

    await worker.scheduled(
      { cron: "6 */2 * * *" } as ScheduledEvent,
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
      TELEGRAM_RECAP_ROLLOUT_MODE: "off",
    } as const;

    await worker.scheduled(
      { cron: "2,7,12,17,22,27,32,37,42,47,52,57 * * * *" } as ScheduledEvent,
      env as never,
      ctx,
    );
    await Promise.all(waits);

    expect(cronMocks.cancelQueuedTelegramRecapsForRollout).toHaveBeenCalledTimes(1);
    expect(cronMocks.cancelQueuedTelegramRecapsForRollout).toHaveBeenCalledWith(
      env.DB,
      expect.objectContaining({ mode: "off" }),
      expect.any(Number),
    );
    expect(cronMocks.dispatchTelegramAlerts).toHaveBeenCalledTimes(1);
    expect(cronMocks.cancelQueuedTelegramRecapsForRollout.mock.invocationCallOrder[0]).toBeLessThan(
      cronMocks.dispatchTelegramAlerts.mock.invocationCallOrder[0],
    );
    expect(cronMocks.syncStablecoins).not.toHaveBeenCalled();
    expect(cronMocks.computeAndStoreDEWS).not.toHaveBeenCalled();
  });

  it("fails telegram pending dispatch closed when recap rollout cleanup fails", async () => {
    cronMocks.cancelQueuedTelegramRecapsForRollout.mockRejectedValueOnce(new Error("cleanup failed"));
    const { ctx, waits } = makeCtx();
    const env = {
      DB: {} as D1Database,
      CORS_ORIGIN: "https://pharos.watch",
      TELEGRAM_BOT_TOKEN: "bot-token",
      TELEGRAM_RECAP_ROLLOUT_MODE: "off",
    } as const;

    await worker.scheduled(
      { cron: "2,7,12,17,22,27,32,37,42,47,52,57 * * * *" } as ScheduledEvent,
      env as never,
      ctx,
    );
    await Promise.all(waits);

    expect(cronMocks.cancelQueuedTelegramRecapsForRollout).toHaveBeenCalledTimes(2);
    expect(cronMocks.dispatchTelegramAlerts).not.toHaveBeenCalled();
    expect(cronMocks.runTelegramDegradationWatchdog).toHaveBeenCalledTimes(1);
    expect(cronMocks.publishTelegramPulseSnapshotWithOutcome).toHaveBeenCalledTimes(1);
  });

  it("polls the manual digest trigger on the shared 5-min trigger", async () => {
    const { ctx, waits } = makeCtx();
    const env = {
      DB: {} as D1Database,
      CORS_ORIGIN: "https://pharos.watch",
    } as const;

    await worker.scheduled(
      { cron: "*/5 * * * *" } as ScheduledEvent,
      env as never,
      ctx,
    );
    await Promise.all(waits);

    expect(cronMocks.getCache).toHaveBeenCalledTimes(1);
    expect(cronMocks.generateDailyDigest).not.toHaveBeenCalled();
    expect(cronMocks.dispatchTelegramAlerts).not.toHaveBeenCalled();
  });

  it("runs daily 03:00 housekeeping on its dedicated trigger", async () => {
    const { ctx, waits } = makeCtx();
    const env = {
      DB: {} as D1Database,
      CORS_ORIGIN: "https://pharos.watch",
      TELEGRAM_BOT_TOKEN: "bot-token",
    } as const;

    await worker.scheduled(
      { cron: "0 3 * * *" } as ScheduledEvent,
      env as never,
      ctx,
    );
    await Promise.all(waits);

    expect(cronMocks.runPruneStatusProbeRuns).toHaveBeenCalledTimes(1);
    expect(cronMocks.runPruneCronHistory).toHaveBeenCalledTimes(1);
    expect(cronMocks.runRepairTaskRunner).toHaveBeenCalledTimes(1);
    expect(cronMocks.runTelegramInactiveCleanup).toHaveBeenCalledTimes(1);
    expect(cronMocks.runTelegramRetentionCleanup).toHaveBeenCalledTimes(1);
    expect(cronMocks.syncStablecoins).not.toHaveBeenCalled();
  });

  it("runs the monthly yield coverage audit on its dedicated trigger", async () => {
    const { ctx, waits } = makeCtx();
    const env = {
      DB: {} as D1Database,
      CORS_ORIGIN: "https://pharos.watch",
    } as const;

    await worker.scheduled(
      { cron: "0 6 1 * *" } as ScheduledEvent,
      env as never,
      ctx,
    );
    await Promise.all(waits);

    expect(cronMocks.runYieldCoverageAudit).toHaveBeenCalledTimes(1);
    expect(cronMocks.syncYieldData).not.toHaveBeenCalled();
  });

  it("runs the extended mint/burn lane on the offset 30-min slot", async () => {
    const { ctx, waits } = makeCtx();
    const env = {
      DB: {} as D1Database,
      CORS_ORIGIN: "https://pharos.watch",
      ALCHEMY_API_KEY: "alchemy-key",
    } as const;

    await worker.scheduled(
      { cron: "18,48 * * * *" } as ScheduledEvent,
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
    expect(cronMocks.refreshAggregateMintBurnFlowCache).not.toHaveBeenCalled();
    expect(cronMocks.syncBlacklist).not.toHaveBeenCalled();
    expect(cronMocks.syncDexDiscovery).not.toHaveBeenCalled();
  });
});
