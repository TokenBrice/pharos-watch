import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ScheduledRuntimeContext } from "../context";
import { makeScheduledRuntime } from "../../../test-helpers/scheduled-runtime.test-support";
import { makeNoopD1 } from "../../../test-helpers/noop-d1";
import { createDwellirNativeCapability } from "../../../lib/dwellir-native";

const mocks = vi.hoisted(() => ({
  consumeDexLiquidityScoringStage: vi.fn(),
  runCronSentinel: vi.fn(),
  prepareSafetyScoreV9Input: vi.fn(),
  syncStablecoinCharts: vi.fn(),
  loadStablecoinsCache: vi.fn(),
  derivePegAnalyticsSnapshot: vi.fn(),
  publishPegAnalyticsCache: vi.fn(),
}));

vi.mock("../../../cron/dex-liquidity/orchestrator", () => ({
  consumeDexLiquidityScoringStage: mocks.consumeDexLiquidityScoringStage,
}));
vi.mock("../../../cron/prepare-safety-score-v9-input", () => ({
  prepareSafetyScoreV9Input: mocks.prepareSafetyScoreV9Input,
}));
vi.mock("../../../cron/cron-sentinel", () => ({
  runCronSentinel: mocks.runCronSentinel,
}));
vi.mock("../../../cron/sync-stablecoin-charts", () => ({
  syncStablecoinCharts: mocks.syncStablecoinCharts,
}));
vi.mock("../../../lib/stablecoins-cache", () => ({
  loadStablecoinsCache: mocks.loadStablecoinsCache,
}));
vi.mock("../../../lib/peg-analytics", () => ({
  derivePegAnalyticsSnapshot: mocks.derivePegAnalyticsSnapshot,
}));
vi.mock("../../../lib/peg-analytics-cache", () => ({
  publishPegAnalyticsCache: mocks.publishPegAnalyticsCache,
}));

import type { CronProgressReporter, CronResult } from "../../../lib/cron-logger";
import { ACTIVE_STABLECOINS } from "@shared/lib/stablecoins/registry";

import { runHalfHourlyChartsSlot } from "../half-hourly-charts";

function runtime(dbOverride?: D1Database): ScheduledRuntimeContext {
  const signal = new AbortController().signal;
  return makeScheduledRuntime({
    db:
      dbOverride
      ?? makeNoopD1({
        prepare: () => ({
          bind: () => ({ run: async () => ({ meta: { changes: 1 } }) }),
        }),
      }),
    cron: "16,46 * * * *",
    scheduleKey: "halfHourlyChartsOffset",
    scheduledTimeMs: 960_000,
    slotStartedAt: 960,
    workerVersion: "worker-v1",
    runLeasedCron: vi.fn(async (_job, fn) => fn(signal, vi.fn())),
  });
}

function dexGenerationRows(updatedAt: number) {
  return ACTIVE_STABLECOINS.map((coin) => ({
    stablecoin_id: coin.id,
    publication_generation_id: `dex-liquidity-${updatedAt}`,
    updated_at: updatedAt,
  }));
}

function dexPublicationDb(updatedAt: number): D1Database {
  const rows = dexGenerationRows(updatedAt);
  return makeNoopD1({
    // loadExactDexPublicationGeneration() binds no parameters.
    prepare: () => ({
      bind: () => ({ all: async () => ({ results: rows }) }),
      all: async () => ({ results: rows }),
    }),
  });
}

// The :46 gate reads only the capture-control row's commit clock.
function captureControlDb(updatedAt: number | null | Error): D1Database {
  return makeNoopD1({
    prepare: () => ({
      bind: () => ({
        first: async () => {
          if (updatedAt instanceof Error) throw updatedAt;
          return updatedAt === null ? null : { updated_at: updatedAt };
        },
      }),
    }),
  });
}

function captureJobResults(scheduledRuntime: ScheduledRuntimeContext) {
  const results = new Map<string, CronResult>();
  scheduledRuntime.runLeasedCron = vi.fn(async (job: string, fn: (signal: AbortSignal, reportProgress: CronProgressReporter) => Promise<CronResult>) => {
    const result = await fn(new AbortController().signal, vi.fn());
    results.set(job, result);
    return result;
  }) as unknown as ScheduledRuntimeContext["runLeasedCron"];
  return results;
}

function jobMetadata(results: Map<string, CronResult>, job: string): Record<string, unknown> {
  const metadata = results.get(job)?.metadata;
  return metadata === undefined ? {} : JSON.parse(metadata) as Record<string, unknown>;
}

function producerRunningResult(): CronResult {
  return {
    status: "skipped_neutral",
    itemCount: 0,
    metadata: JSON.stringify({
      reason: "scoring-stage-producer-running",
      persistence: { generationId: null, skipped: true, skippedReason: "scoring-stage-producer-running" },
    }),
  };
}

describe("half-hourly charts scheduling", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.loadStablecoinsCache.mockResolvedValue({
      kind: "ok", updatedAt: 900, payload: { peggedAssets: [], fxFallbackRates: {} },
    });
    mocks.derivePegAnalyticsSnapshot.mockResolvedValue({ nowSec: 900, allEvents: [], pegDataById: new Map() });
    mocks.publishPegAnalyticsCache.mockResolvedValue(true);
    mocks.consumeDexLiquidityScoringStage.mockResolvedValue({
      status: "skipped_neutral",
      itemCount: 0,
      metadata: JSON.stringify({
        persistence: {
          generationId: "dex-liquidity-current",
          skipped: false,
          skippedReason: "liquidity-cadence-reuse",
        },
      }),
    });
    mocks.runCronSentinel.mockResolvedValue({ status: "ok", itemCount: 1 });
    mocks.prepareSafetyScoreV9Input.mockResolvedValue({ status: "ok", itemCount: 1 });
    mocks.syncStablecoinCharts.mockResolvedValue({ status: "ok", itemCount: 1 });
  });

  it("passes heavy's configured Graph key and inherited deadline to inline recovery", async () => {
    const scheduledRuntime = runtime();
    scheduledRuntime.dwellirNative = createDwellirNativeCapability("native-test-key-placeholder");
    scheduledRuntime.env.GRAPH_API_KEY = "heavy-graph-key";
    mocks.consumeDexLiquidityScoringStage.mockResolvedValue({
      status: "ok", itemCount: 1,
      metadata: JSON.stringify({ persistence: { generationId: "dex-liquidity-recovered", skipped: false } }),
    });
    await runHalfHourlyChartsSlot(scheduledRuntime);
    expect(mocks.consumeDexLiquidityScoringStage).toHaveBeenCalledWith(
      scheduledRuntime.db, expect.any(AbortSignal), expect.any(Function), scheduledRuntime.slotStartedAt,
      expect.objectContaining({
        deadline: scheduledRuntime.deadline,
        stageRecovery: expect.objectContaining({ graphApiKey: "heavy-graph-key" }),
      }),
    );
    expect(mocks.runCronSentinel).toHaveBeenCalledOnce();
    expect(mocks.prepareSafetyScoreV9Input).toHaveBeenCalledWith(
      scheduledRuntime.db, expect.any(AbortSignal), "dex-liquidity-recovered",
      scheduledRuntime.chainRpcs, scheduledRuntime.env.CF_VERSION_METADATA, scheduledRuntime.deadline,
      scheduledRuntime.dwellirNative,
      900,
    );
  });

  it("skips V9 input after a DEX failure while keeping charts independent", async () => {
    mocks.consumeDexLiquidityScoringStage.mockRejectedValue(new Error("stale DEX stage"));
    const scheduledRuntime = runtime();

    const summary = await runHalfHourlyChartsSlot(scheduledRuntime);

    expect(mocks.prepareSafetyScoreV9Input).not.toHaveBeenCalled();
    expect(mocks.syncStablecoinCharts).toHaveBeenCalledWith(
      scheduledRuntime.db,
      expect.any(AbortSignal),
      { scheduledAtSec: scheduledRuntime.slotStartedAt },
    );
    expect(summary.jobs.map((job) => [job.job, job.outcome, job.reason])).toEqual([
      ["sync-dex-liquidity", "error", "Error"],
      ["cron-sentinel", "skipped", "upstream-dex-publication-unavailable"],
      ["prepare-safety-score-v9-input", "skipped", "upstream-dex-publication-unavailable"],
      ["sync-stablecoin-charts", "ok", undefined],
    ]);
    expect(summary.jobs[0]?.error).toBe("stale DEX stage");
    expect(summary.jobs[1]?.neutral).toBe(true);
    expect(summary.jobs[2]?.neutral).toBe(true);
  });

  it("skips V9 input neutrally when degraded DEX scoring withholds publication", async () => {
    mocks.consumeDexLiquidityScoringStage.mockResolvedValue({
      status: "degraded",
      itemCount: 1,
      metadata: JSON.stringify({
        reason: "defillama-yields-unavailable",
        persistence: {
          generationId: null,
          skipped: true,
          skippedReason: "defillama-yields-unavailable",
        },
      }),
    });
    const scheduledRuntime = runtime();

    const summary = await runHalfHourlyChartsSlot(scheduledRuntime);

    expect(mocks.prepareSafetyScoreV9Input).not.toHaveBeenCalled();
    expect(mocks.syncStablecoinCharts).toHaveBeenCalled();
    expect(summary.jobs.map((job) => [job.job, job.outcome, job.reason])).toEqual([
      ["sync-dex-liquidity", "degraded", "defillama-yields-unavailable"],
      ["cron-sentinel", "skipped", "upstream-dex-publication-unavailable"],
      ["prepare-safety-score-v9-input", "skipped", "upstream-dex-publication-unavailable"],
      ["sync-stablecoin-charts", "ok", undefined],
    ]);
    expect(summary.jobs[1]?.neutral).toBe(true);
    expect(summary.jobs[2]?.neutral).toBe(true);
  });

  it.each([
    { status: "error", skipped: false },
    { status: "degraded", skipped: true },
  ] as const)(
    "does not trust a retained generation on a $status DEX result with skipped=$skipped",
    async ({ status, skipped }) => {
      mocks.consumeDexLiquidityScoringStage.mockResolvedValue({
        status,
        itemCount: 1,
        metadata: JSON.stringify({
          persistence: {
            generationId: "dex-liquidity-stale",
            skipped,
            skippedReason: skipped ? "publication-withheld" : null,
          },
        }),
      });
      const scheduledRuntime = runtime();

      const summary = await runHalfHourlyChartsSlot(scheduledRuntime);

      expect(mocks.prepareSafetyScoreV9Input).not.toHaveBeenCalled();
      expect(mocks.syncStablecoinCharts).toHaveBeenCalled();
      expect(summary.jobs[2]).toMatchObject({
        job: "prepare-safety-score-v9-input",
        outcome: "skipped",
        reason: "upstream-dex-publication-unavailable",
        neutral: true,
      });
    },
  );

  it("skips V9 input neutrally when the DEX consumer lease is locked", async () => {
    const scheduledRuntime = runtime();
    vi.mocked(scheduledRuntime.runLeasedCron).mockImplementation(async (job, fn) => {
      if (job === "sync-dex-liquidity") {
        return { status: "skipped_locked" };
      }
      return fn(new AbortController().signal, vi.fn());
    });

    const summary = await runHalfHourlyChartsSlot(scheduledRuntime);

    expect(mocks.consumeDexLiquidityScoringStage).not.toHaveBeenCalled();
    expect(mocks.prepareSafetyScoreV9Input).not.toHaveBeenCalled();
    expect(mocks.syncStablecoinCharts).toHaveBeenCalled();
    expect(summary.jobs.map((job) => [job.job, job.outcome, job.reason])).toEqual([
      ["sync-dex-liquidity", "skipped", "lease-locked"],
      ["cron-sentinel", "skipped", "upstream-dex-publication-unavailable"],
      ["prepare-safety-score-v9-input", "skipped", "upstream-dex-publication-unavailable"],
      ["sync-stablecoin-charts", "ok", undefined],
    ]);
    expect(summary.jobs[1]?.neutral).toBe(true);
    expect(summary.jobs[2]?.neutral).toBe(true);
  });

  it("fails closed when a successful DEX result omits its generation", async () => {
    mocks.consumeDexLiquidityScoringStage.mockResolvedValue({
      status: "ok",
      itemCount: 1,
      metadata: JSON.stringify({
        persistence: {
          generationId: null,
          skipped: false,
        },
      }),
    });
    const scheduledRuntime = runtime();

    const summary = await runHalfHourlyChartsSlot(scheduledRuntime);

    expect(mocks.prepareSafetyScoreV9Input).not.toHaveBeenCalled();
    expect(mocks.syncStablecoinCharts).toHaveBeenCalled();
    expect(summary.jobs[2]).toMatchObject({
      job: "prepare-safety-score-v9-input",
      outcome: "error",
      error: "DEX publication result omitted its exact generation id",
    });
  });

  it.each(["{malformed", "null", "[]"])(
    "keeps the DEX outcome intact and fails V9 closed for metadata %s",
    async (metadata) => {
      mocks.consumeDexLiquidityScoringStage.mockResolvedValue({
        status: "ok",
        itemCount: 1,
        metadata,
      });
      const scheduledRuntime = runtime();

      const summary = await runHalfHourlyChartsSlot(scheduledRuntime);

      expect(mocks.prepareSafetyScoreV9Input).not.toHaveBeenCalled();
      expect(mocks.syncStablecoinCharts).toHaveBeenCalled();
      expect(summary.jobs[0]).toMatchObject({
        job: "sync-dex-liquidity",
        outcome: "ok",
      });
      expect(summary.jobs[2]).toMatchObject({
        job: "prepare-safety-score-v9-input",
        outcome: "error",
        error: "DEX publication result omitted its exact generation id",
      });
    },
  );

  it("binds V9 input to the generation returned by a successful DEX publication", async () => {
    mocks.consumeDexLiquidityScoringStage.mockResolvedValue({
      status: "ok",
      itemCount: 1,
      metadata: JSON.stringify({
        persistence: { generationId: "dex-liquidity-123" },
      }),
    });
    const scheduledRuntime = runtime();
    scheduledRuntime.env.CF_VERSION_METADATA = { id: "executing-worker", timestamp: "2026-10-07T20:00:00Z", tag: "" };

    await runHalfHourlyChartsSlot(scheduledRuntime);

    expect(mocks.prepareSafetyScoreV9Input).toHaveBeenCalledWith(
      scheduledRuntime.db,
      expect.any(AbortSignal),
      "dex-liquidity-123",
      scheduledRuntime.chainRpcs,
      scheduledRuntime.env.CF_VERSION_METADATA,
      scheduledRuntime.deadline,
      scheduledRuntime.dwellirNative,
      900,
    );
    expect(mocks.syncStablecoinCharts).toHaveBeenCalled();
    expect(mocks.runCronSentinel).toHaveBeenCalledWith(scheduledRuntime.db, {
      mode: "turnover",
      signal: expect.any(AbortSignal),
    });
  });

  it("publishes recovered quote evidence with liquidity on odd-hour :16", async () => {
    mocks.consumeDexLiquidityScoringStage.mockResolvedValue({
      status: "ok",
      itemCount: 1,
      metadata: JSON.stringify({ persistence: { generationId: "dex-liquidity-current" } }),
    });
    const scheduledRuntime = runtime();
    scheduledRuntime.slotStartedAt = 4_560; // 1970-01-01 01:16 UTC

    await runHalfHourlyChartsSlot(scheduledRuntime);

    expect(mocks.consumeDexLiquidityScoringStage).toHaveBeenCalledWith(
      scheduledRuntime.db,
      expect.any(AbortSignal),
      expect.any(Function),
      scheduledRuntime.slotStartedAt,
      {
        deadline: scheduledRuntime.deadline,
        publishShadowTargets: false,
        stageReadyDeadlineMs: scheduledRuntime.scheduledTimeMs! + 90_000,
        stageRecovery: {
          graphApiKey: null,
          coingeckoApiKey: scheduledRuntime.coingeckoApiKey,
          chainRpcs: scheduledRuntime.chainRpcs,
        },
      },
    );
    expect(mocks.runCronSentinel).toHaveBeenCalledWith(scheduledRuntime.db, {
      mode: "turnover",
      signal: expect.any(AbortSignal),
    });
  });

  it("reuses the exact accepted generation at :46 without re-preparing the hourly V9 input", async () => {
    // The hour's :16 (960) preparation committed its capture.
    const scheduledRuntime = runtime(captureControlDb(1_000));
    scheduledRuntime.slotStartedAt = 2_760; // 1970-01-01 00:46 UTC
    const results = captureJobResults(scheduledRuntime);

    await runHalfHourlyChartsSlot(scheduledRuntime);

    expect(mocks.consumeDexLiquidityScoringStage).toHaveBeenCalledWith(
      scheduledRuntime.db,
      expect.any(AbortSignal),
      expect.any(Function),
      scheduledRuntime.slotStartedAt,
      {
        deadline: scheduledRuntime.deadline,
        publishShadowTargets: false,
        stageReadyDeadlineMs: scheduledRuntime.scheduledTimeMs! + 90_000,
        stageRecovery: {
          graphApiKey: null,
          coingeckoApiKey: scheduledRuntime.coingeckoApiKey,
          chainRpcs: scheduledRuntime.chainRpcs,
        },
      },
    );
    expect(mocks.prepareSafetyScoreV9Input).not.toHaveBeenCalled();
    // The skipped preparation still keeps the 30-minute peg-analytics cache fresh.
    expect(mocks.derivePegAnalyticsSnapshot).toHaveBeenCalledWith(scheduledRuntime.db, {
      peggedAssets: [], fxFallbackRates: {}, methodologyAsOf: 900, includeNavTokens: true,
    });
    expect(mocks.publishPegAnalyticsCache).toHaveBeenCalledOnce();
    expect(jobMetadata(results, "prepare-safety-score-v9-input")).toEqual({
      reason: "v9-input-hourly-cadence", pegAnalyticsPublished: true,
    });
    expect(mocks.runCronSentinel).not.toHaveBeenCalled();
    expect(jobMetadata(results, "cron-sentinel")).toMatchObject({
      reason: "upstream-dex-publication-unavailable",
      upstreamStatus: "skipped_neutral",
      upstreamSkippedReason: "liquidity-cadence-reuse",
    });
  });

  it.each([
    ["missing", 960 - 1_800],
    ["missing", null],
    ["unreadable", new Error("D1_ERROR: internal error")],
  ] as const)("re-prepares at :46 when the hour's :16 capture is %s", async (state, updatedAt) => {
    const scheduledRuntime = runtime(captureControlDb(updatedAt));
    scheduledRuntime.slotStartedAt = 2_760;
    const results = captureJobResults(scheduledRuntime);
    mocks.prepareSafetyScoreV9Input.mockResolvedValue({
      status: "ok", itemCount: 1, metadata: JSON.stringify({ dexGenerationId: "dex-liquidity-current" }),
    });

    await runHalfHourlyChartsSlot(scheduledRuntime);

    expect(mocks.prepareSafetyScoreV9Input).toHaveBeenCalledWith(
      scheduledRuntime.db,
      expect.any(AbortSignal),
      "dex-liquidity-current",
      scheduledRuntime.chainRpcs,
      scheduledRuntime.env.CF_VERSION_METADATA,
      scheduledRuntime.deadline,
      scheduledRuntime.dwellirNative,
      2_700,
    );
    expect(jobMetadata(results, "prepare-safety-score-v9-input")).toEqual({
      dexGenerationId: "dex-liquidity-current", hourlyCaptureRecovery: state,
    });
  });

  it("runs the charts chain only after the DEX scoring chain completes", async () => {
    const order: string[] = [];
    mocks.consumeDexLiquidityScoringStage.mockImplementation(async () => {
      order.push("consume");
      return {
        status: "ok",
        itemCount: 1,
        metadata: JSON.stringify({ persistence: { generationId: "dex-liquidity-123" } }),
      };
    });
    mocks.runCronSentinel.mockImplementation(async () => {
      order.push("turnover");
      return { status: "ok", itemCount: 1 };
    });
    mocks.prepareSafetyScoreV9Input.mockImplementation(async () => {
      order.push("prepare");
      return { status: "ok", itemCount: 1 };
    });
    mocks.syncStablecoinCharts.mockImplementation(async () => {
      order.push("charts");
      return { status: "ok", itemCount: 1 };
    });

    await runHalfHourlyChartsSlot(runtime());

    expect(order).toEqual(["consume", "turnover", "prepare", "charts"]);
  });

  it("prepares V9 input from the last in-budget accepted DEX generation after a DEX error", async () => {
    mocks.consumeDexLiquidityScoringStage.mockRejectedValue(
      new Error("D1_ERROR: internal error; reference = nug416i4dsl"),
    );
    mocks.prepareSafetyScoreV9Input.mockResolvedValue({
      status: "ok",
      itemCount: 239,
      metadata: JSON.stringify({ dexGenerationId: "dex-liquidity-recovered" }),
    });
    // Slot 960 (:16); the accepted publication is one hour old, inside the
    // four-hour DEX evidence budget.
    const scheduledRuntime = runtime(dexPublicationDb(960 - 3_600));
    const results = captureJobResults(scheduledRuntime);

    const summary = await runHalfHourlyChartsSlot(scheduledRuntime);

    expect(mocks.prepareSafetyScoreV9Input).toHaveBeenCalledWith(
      scheduledRuntime.db,
      expect.any(AbortSignal),
      `dex-liquidity-${960 - 3_600}`,
      scheduledRuntime.chainRpcs,
      scheduledRuntime.env.CF_VERSION_METADATA,
      scheduledRuntime.deadline,
      scheduledRuntime.dwellirNative,
      900,
    );
    expect(summary.jobs[2]).toMatchObject({
      job: "prepare-safety-score-v9-input",
      outcome: "ok",
    });
    expect(jobMetadata(results, "prepare-safety-score-v9-input")).toMatchObject({
      dexPublicationRecovery: {
        upstreamJob: "sync-dex-liquidity",
        upstreamStatus: "error",
        reusedGenerationId: `dex-liquidity-${960 - 3_600}`,
        publicationAgeSec: 3_600,
        budgetSec: 4 * 3_600,
      },
    });
  });

  it("fails V9 closed when the last accepted DEX generation is outside the evidence budget", async () => {
    mocks.consumeDexLiquidityScoringStage.mockRejectedValue(new Error("stale DEX stage"));
    const scheduledRuntime = runtime(dexPublicationDb(960 - 4 * 3_600 - 1));
    const results = captureJobResults(scheduledRuntime);

    const summary = await runHalfHourlyChartsSlot(scheduledRuntime);

    expect(mocks.prepareSafetyScoreV9Input).not.toHaveBeenCalled();
    expect(summary.jobs[2]).toMatchObject({
      job: "prepare-safety-score-v9-input",
      outcome: "skipped",
      reason: "upstream-dex-publication-unavailable",
      neutral: true,
    });
    expect(jobMetadata(results, "prepare-safety-score-v9-input")).toMatchObject({
      reason: "upstream-dex-publication-unavailable",
      upstreamStatus: "error",
      upstreamRecovery: {
        outcome: "outside-freshness-budget",
        publicationAgeSec: 4 * 3_600 + 1,
        budgetSec: 4 * 3_600,
      },
    });
  });

  it("fails V9 closed when the accepted DEX generation cannot be read after a DEX error", async () => {
    mocks.consumeDexLiquidityScoringStage.mockRejectedValue(new Error("stale DEX stage"));
    const failingReadsDb = makeNoopD1({
      prepare: () => ({
        bind: () => ({
          all: async () => {
            throw new TypeError("Exact fixed-input capture missing active DEX rows");
          },
        }),
      }),
    });
    const scheduledRuntime = runtime(failingReadsDb);
    const results = captureJobResults(scheduledRuntime);

    const summary = await runHalfHourlyChartsSlot(scheduledRuntime);

    expect(mocks.prepareSafetyScoreV9Input).not.toHaveBeenCalled();
    expect(summary.jobs[2]).toMatchObject({
      job: "prepare-safety-score-v9-input",
      outcome: "skipped",
      reason: "upstream-dex-publication-unavailable",
      neutral: true,
    });
    expect(jobMetadata(results, "prepare-safety-score-v9-input")).toMatchObject({
      upstreamRecovery: {
        outcome: "generation-unavailable",
        code: "TypeError",
      },
    });
  });

  it.each(["ok", "degraded"] as const)("checks turnover after a real %s :46 publication before preparation", async (status) => {
    const order: string[] = [];
    mocks.consumeDexLiquidityScoringStage.mockImplementation(async () => {
      order.push("reuse");
      return {
        status,
        itemCount: 1,
        metadata: JSON.stringify({
          reason: status === "degraded" ? "source-incomplete" : undefined,
          persistence: { generationId: "dex-liquidity-late", skipped: false },
          stageRecovery: { reason: "stage-unconsumed" },
        }),
      };
    });
    mocks.runCronSentinel.mockImplementation(async () => {
      order.push("turnover");
      return { status: "ok", itemCount: 1 };
    });
    mocks.prepareSafetyScoreV9Input.mockImplementation(async () => {
      order.push("prepare");
      return { status: "ok", itemCount: 1 };
    });
    mocks.syncStablecoinCharts.mockImplementation(async () => {
      order.push("charts");
      return { status: "ok", itemCount: 1 };
    });
    const scheduledRuntime = runtime();
    scheduledRuntime.slotStartedAt = 2_760;
    await runHalfHourlyChartsSlot(scheduledRuntime);
    expect(order).toEqual(["reuse", "turnover", "prepare", "charts"]);
    expect(mocks.runCronSentinel).toHaveBeenCalledOnce();
    expect(mocks.prepareSafetyScoreV9Input).toHaveBeenCalledWith(
      scheduledRuntime.db, expect.any(AbortSignal), "dex-liquidity-late",
      scheduledRuntime.chainRpcs, scheduledRuntime.env.CF_VERSION_METADATA, scheduledRuntime.deadline,
      scheduledRuntime.dwellirNative,
      2_700,
    );
  });

  it.each([
    { status: "error", skipped: false, generationId: "old" },
    { status: "skipped_locked", skipped: false, generationId: "old" },
    { status: "skipped_neutral", skipped: false, generationId: "old" },
    { status: "degraded", skipped: true, generationId: "old" },
    { status: "ok", skipped: false, generationId: null },
  ] as const)("does not check turnover for an unavailable :46 publication ($status/$skipped/$generationId)", async ({ status, skipped, generationId }) => {
    mocks.consumeDexLiquidityScoringStage.mockResolvedValue({
      status, itemCount: 0, metadata: JSON.stringify({ persistence: { generationId, skipped } }),
    });
    const scheduledRuntime = runtime();
    scheduledRuntime.slotStartedAt = 2_760;
    const results = captureJobResults(scheduledRuntime);
    await runHalfHourlyChartsSlot(scheduledRuntime);
    expect(mocks.runCronSentinel).not.toHaveBeenCalled();
    expect(jobMetadata(results, "cron-sentinel")).toMatchObject({
      reason: "upstream-dex-publication-unavailable", upstreamStatus: status,
    });
    expect(mocks.syncStablecoinCharts).toHaveBeenCalled();
  });

  it("preserves accepted-generation preparation after a live-source neutral wait", async () => {
    mocks.consumeDexLiquidityScoringStage.mockResolvedValue(producerRunningResult());
    const scheduledRuntime = runtime(dexPublicationDb(960 - 3_600));
    const results = captureJobResults(scheduledRuntime);
    const summary = await runHalfHourlyChartsSlot(scheduledRuntime);
    expect(mocks.runCronSentinel).not.toHaveBeenCalled();
    expect(mocks.prepareSafetyScoreV9Input).toHaveBeenCalledExactlyOnceWith(
      scheduledRuntime.db, expect.any(AbortSignal), `dex-liquidity-${960 - 3_600}`,
      scheduledRuntime.chainRpcs, scheduledRuntime.env.CF_VERSION_METADATA, scheduledRuntime.deadline,
      scheduledRuntime.dwellirNative,
      900,
    );
    expect(summary.jobs.map((job) => [job.job, job.outcome])).toEqual([
      ["sync-dex-liquidity", "skipped"], ["cron-sentinel", "skipped"],
      ["prepare-safety-score-v9-input", "ok"], ["sync-stablecoin-charts", "ok"],
    ]);
    expect(summary.jobs[0]).toMatchObject({ reason: "scoring-stage-producer-running", neutral: true });
    expect(jobMetadata(results, "prepare-safety-score-v9-input")).toMatchObject({
      dexPublicationRecovery: {
        upstreamJob: "sync-dex-liquidity", upstreamStatus: "skipped_neutral",
        reusedGenerationId: `dex-liquidity-${960 - 3_600}`, publicationAgeSec: 3_600, budgetSec: 4 * 3_600,
      },
    });
  });

  it.each(["stale", "unreadable"] as const)("keeps live-source neutral preparation fail-closed for %s output", async (outcome) => {
    mocks.consumeDexLiquidityScoringStage.mockResolvedValue(producerRunningResult());
    const db = outcome === "stale" ? dexPublicationDb(960 - 4 * 3_600 - 1) : makeNoopD1({
      prepare: () => ({
        all: async () => { throw new TypeError("accepted generation unreadable"); },
      }),
    });
    const scheduledRuntime = runtime(db);
    const results = captureJobResults(scheduledRuntime);
    await runHalfHourlyChartsSlot(scheduledRuntime);
    expect(mocks.prepareSafetyScoreV9Input).not.toHaveBeenCalled();
    expect(mocks.syncStablecoinCharts).toHaveBeenCalled();
    expect(jobMetadata(results, "prepare-safety-score-v9-input")).toMatchObject({
      reason: "upstream-dex-publication-unavailable", upstreamStatus: "skipped_neutral",
      upstreamRecovery: { outcome: outcome === "stale" ? "outside-freshness-budget" : "generation-unavailable" },
    });
  });

  it.each([
    { generationId: null, skipped: true, skippedReason: "unrelated-neutral" },
    { generationId: null, skipped: true, skippedReason: null },
    { generationId: "untrusted", skipped: true, skippedReason: "scoring-stage-producer-running" },
    { generationId: null, skipped: false, skippedReason: "scoring-stage-producer-running" },
  ])("does not recover an unrelated or malformed neutral publication (%j)", async (persistence) => {
    mocks.consumeDexLiquidityScoringStage.mockResolvedValue({
      status: "skipped_neutral", itemCount: 0, metadata: JSON.stringify({ persistence }),
    });
    const readAccepted = vi.fn(async () => ({ results: dexGenerationRows(960 - 3_600) }));
    const scheduledRuntime = runtime(makeNoopD1({ prepare: () => ({ all: readAccepted }) }));
    await runHalfHourlyChartsSlot(scheduledRuntime);
    expect(readAccepted).not.toHaveBeenCalled();
    expect(mocks.prepareSafetyScoreV9Input).not.toHaveBeenCalled();
    expect(mocks.syncStablecoinCharts).toHaveBeenCalled();
  });
});
