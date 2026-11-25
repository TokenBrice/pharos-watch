import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ScheduledRuntimeContext } from "../context";
import type { CronProgressReporter, CronResult } from "../../../lib/cron-logger";
import { buildScheduledSlotSummary, summarizeCronResult } from "../slot-summary";
import { makeScheduledRuntime } from "../../../test-helpers/scheduled-runtime.test-support";
import { makeNoopD1 } from "../../../test-helpers/noop-d1";

const mocks = vi.hoisted(() => ({
  runScheduledSlotGroups: vi.fn(),

  runV9AfterCoreWithinWindow: vi.fn(),
  computeSafetyScoreV9: vi.fn(),
  recoverSafetyScoreV9PublicMaterialization: vi.fn(),
  logWorkerEvent: vi.fn(),
  syncSupplyAttribution: vi.fn(),
}));

vi.mock("../slot-groups", async (importOriginal) => ({
  ...await importOriginal<typeof import("../slot-groups")>(),
  runScheduledSlotGroups: mocks.runScheduledSlotGroups,
}));
vi.mock("../../../lib/v9-slot-window", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../../lib/v9-slot-window")>(),
  runV9AfterCoreWithinWindow: mocks.runV9AfterCoreWithinWindow,
}));
vi.mock("../../../cron/compute-safety-score-v9", () => ({
  computeSafetyScoreV9: mocks.computeSafetyScoreV9,
}));
vi.mock("../../../lib/safety-score-v9/publication-materialization", () => ({
  recoverSafetyScoreV9PublicMaterialization: mocks.recoverSafetyScoreV9PublicMaterialization,
}));
vi.mock("../../../lib/structured-log", () => ({
  logWorkerEvent: mocks.logWorkerEvent,
}));
vi.mock("../../../cron/sync-v9-supply-attribution", () => ({
  syncSafetyScoreV9SupplyAttribution: mocks.syncSupplyAttribution, LANE_SCREENING_MINIMUM_REMAINING_MS: 60_000,
}));
import { getCronJobMeta } from "@shared/lib/cron-jobs";
import { createDwellirNativeCapability } from "../../../lib/dwellir-native";
import { runV9PublicationSlot } from "../v9-publication";
import { runV9SupplyAttributionSlot } from "../v9-supply-attribution";

interface CapturedInsert {
  sql: string;
  bindings: unknown[];
}

function capturingRuntime(): { scheduledRuntime: ScheduledRuntimeContext; inserts: CapturedInsert[] } {
  const inserts: CapturedInsert[] = [];
  const scheduledRuntime = makeScheduledRuntime({
    db: makeNoopD1({
      prepare: (sql: string) => ({
        bind: (...bindings: unknown[]) => ({
          run: async () => {
            inserts.push({ sql, bindings });
            return { success: true };
          },
        }),
      }),
    }),
    env: {} as ScheduledRuntimeContext["env"],
    cron: "22 * * * *",
    scheduleKey: "v9PublicationOffset",
    scheduledTimeMs: 1_800_000,
    slotStartedAt: 1_800,
    workerVersion: "worker-v1",
  });
  return { scheduledRuntime, inserts };
}

function runtime(): ScheduledRuntimeContext {
  return makeScheduledRuntime({
    db: {} as D1Database,
    env: {} as ScheduledRuntimeContext["env"],
    cron: "22 * * * *",
    scheduleKey: "v9PublicationOffset",
    scheduledTimeMs: 1_800_000,
    slotStartedAt: 1_800,
    workerVersion: "worker-v1",
  });
}

describe("V9 publication scheduling", () => {
  const published = { jobsRun: 1, jobsSucceeded: 1, jobsErrored: 0, jobsDegraded: 0, jobsSkipped: 0 };
  const identities = { sourceGenerationId: "source-7", baseInputGenerationId: "base-9" };

  function compilingRuntime(metadata: Record<string, string> = identities) {
    const scheduledRuntime = runtime();
    scheduledRuntime.env = {
      ...scheduledRuntime.env,
      CF_VERSION_METADATA: { id: "executing-worker", timestamp: "2026-10-07T20:00:00Z", tag: "" },
      SAFETY_CAPTURE_ARCHIVE: { put: vi.fn() },
    } as unknown as ScheduledRuntimeContext["env"];
    mocks.computeSafetyScoreV9.mockResolvedValue({ status: "ok", metadata: JSON.stringify(metadata) });
    mocks.runV9AfterCoreWithinWindow.mockImplementation(async (_options, run) =>
      run(new AbortController().signal, { slotStartedAtSec: scheduledRuntime.slotStartedAt, deadlineMs: 1_980_000, minimumRemainingMs: 25_000 }));
    return { scheduledRuntime };
  }

  afterEach(() => vi.restoreAllMocks());
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.runV9AfterCoreWithinWindow.mockResolvedValue({
      status: "skipped_neutral",
      itemCount: 0,
    });
    mocks.runScheduledSlotGroups.mockImplementation(async (
      _scheduledRuntime: ScheduledRuntimeContext,
      _label: string,
      stages: Array<Array<{ tasks: Array<{
        run: (
          signal: AbortSignal,
          reportProgress: CronProgressReporter,
        ) => Promise<unknown>;
      }> }>>,
    ) => {
      await stages[0]?.[0]?.tasks[0]?.run(new AbortController().signal, vi.fn());
      return published;
    });
  });

  it("admits the compiler timeout plus finalization headroom", async () => {
    const scheduledRuntime = runtime();

    await runV9PublicationSlot(scheduledRuntime);

    expect(mocks.runV9AfterCoreWithinWindow).toHaveBeenCalledWith(
      expect.objectContaining({
        db: scheduledRuntime.db,
        scheduledTimeMs: scheduledRuntime.scheduledTimeMs,
        slotStartedAt: scheduledRuntime.slotStartedAt,
        workerVersion: "worker-v1",
        deadlineOffsetMs: 3 * 60_000,
        minimumRemainingMs: 25_000,
        lane: "compute-safety-score-v9",
        currentSlotKey: "v9PublicationOffset",
      }),
      expect.any(Function),
    );
  });

  it.each([["22 * * * *", false], ["52 * * * *", true]] as const)(
    "marks only the %s delivery as the conditional second chance",
    async (cron, expected) => {
      const scheduledRuntime = runtime();
      scheduledRuntime.cron = cron;
      await runV9PublicationSlot(scheduledRuntime);
      expect(mocks.runV9AfterCoreWithinWindow).toHaveBeenCalledWith(
        expect.objectContaining({ v9PublicationSecondChance: expected }),
        expect.any(Function),
      );
    },
  );

  it("uses the accepted-hour branch only for materialization recovery", async () => {
    const scheduledRuntime = runtime();
    scheduledRuntime.cron = "52 * * * *";
    mocks.runV9AfterCoreWithinWindow.mockImplementation(async (options) =>
      options.onV9PublicationAlreadyAccepted(new AbortController().signal, { deadlineMs: 1_980_000 }));
    mocks.recoverSafetyScoreV9PublicMaterialization.mockResolvedValue({ status: "ok", itemCount: 1 });
    await runV9PublicationSlot(scheduledRuntime);
    expect(mocks.recoverSafetyScoreV9PublicMaterialization).toHaveBeenCalledWith(scheduledRuntime.db, expect.any(AbortSignal), 1_980_000);
    expect(mocks.computeSafetyScoreV9).not.toHaveBeenCalled();
  });

  it("tolerates malformed recovery metadata when WORKER_V9_QUEUE_MODE is on", async () => {
    const scheduledRuntime = runtime();
    scheduledRuntime.cron = "52 * * * *";
    (scheduledRuntime.env as { WORKER_V9_QUEUE_MODE?: string }).WORKER_V9_QUEUE_MODE = "on";
    mocks.runV9AfterCoreWithinWindow.mockImplementation(async (options) =>
      options.onV9PublicationAlreadyAccepted(new AbortController().signal, { deadlineMs: 1_980_000 }));
    mocks.recoverSafetyScoreV9PublicMaterialization.mockResolvedValue({ status: "ok", itemCount: 1, metadata: "{bad-json" });
    await expect(runV9PublicationSlot(scheduledRuntime)).resolves.toEqual(published);
  });

  it.each([["on", true], ["off", false], ["ON", false]] as const)("defers public materialization only for literal %s", async (mode, expected) => {
    const { scheduledRuntime } = compilingRuntime();
    (scheduledRuntime.env as { SAFETY_V9_DEFERRED_MATERIALIZATION?: string }).SAFETY_V9_DEFERRED_MATERIALIZATION = mode;
    await runV9PublicationSlot(scheduledRuntime);
    expect(mocks.computeSafetyScoreV9.mock.calls[0]![3]).toMatchObject({ deferPublicMaterialization: expected });
  });

  it("forwards literal WORKER_V9_QUEUE_MODE=on and returns any seeded continuation on the slot summary", async () => {
    const { scheduledRuntime } = compilingRuntime();
    (scheduledRuntime.env as { WORKER_V9_QUEUE_MODE?: string }).WORKER_V9_QUEUE_MODE = "on";
    const hint = {
      version: 1 as const,
      runId: "v9-eval:1800:base-9:abcd1234",
      scheduleKey: "v9PublicationOffset" as const,
      slotStartedAt: 1_800,
      stage: "eval" as const,
      chunkIndex: 0,
      quarantineEpoch: 0,
      attemptNo: 1,
      executionGeneration: 1,
      sourceInvocationId: "inv-1",
      evaluationBuildDigest: "a".repeat(64),
      registryFingerprint: "reg-1",
      policyDigest: "b".repeat(64),
    };
    mocks.computeSafetyScoreV9.mockImplementationOnce(async (_db, _sig, _prog, opts) => {
      opts.onContinuation?.(hint);
      return { status: "ok", metadata: JSON.stringify({ mode: "queue-seed" }) };
    });
    const summary = await runV9PublicationSlot(scheduledRuntime);
    expect(mocks.computeSafetyScoreV9.mock.calls[0]![3]).toMatchObject({
      queueMode: "on",
      isSecondChance: false,
      slotStartedAt: scheduledRuntime.slotStartedAt,
    });
    expect(summary).toMatchObject({ ...published, v9Continuation: hint });
  });

  it("runs only the canonical compiler with the original slot identity", async () => {
    const { scheduledRuntime } = compilingRuntime();
    expect(await runV9PublicationSlot(scheduledRuntime)).toBe(published);
    expect(mocks.computeSafetyScoreV9).toHaveBeenCalledOnce();
    expect(mocks.computeSafetyScoreV9).toHaveBeenCalledWith(scheduledRuntime.db, expect.any(AbortSignal), expect.any(Function), {
      workerMetadata: scheduledRuntime.env.CF_VERSION_METADATA,
      captureArchiveBucket: scheduledRuntime.env.SAFETY_CAPTURE_ARCHIVE,
      captureArchiveContext: scheduledRuntime.ctx,
      deferPublicMaterialization: false,
      executionWindow: { slotStartedAtSec: scheduledRuntime.slotStartedAt, deadlineMs: 1_980_000, minimumRemainingMs: 25_000 },
    });
  });



  function neutralComputeRuntime(compute: { status: string; metadata: Record<string, unknown> }) {
    const { scheduledRuntime, inserts } = capturingRuntime();
    mocks.runV9AfterCoreWithinWindow.mockImplementation(async (_options, run) => run(new AbortController().signal));
    const compiled = {
      status: compute.status as "skipped_neutral",
      metadata: JSON.stringify(compute.metadata),
    };
    mocks.computeSafetyScoreV9.mockResolvedValue(compiled);
    // Preserve the canonical neutral/degraded scheduling summary.
    mocks.runScheduledSlotGroups.mockImplementation(async (
      _scheduledRuntime: ScheduledRuntimeContext,
      _label: string,
      stages: Array<Array<{ tasks: Array<{ run: (signal: AbortSignal) => Promise<unknown> }> }>>,
    ) => {
      const result = await stages[0]?.[0]?.tasks[0]?.run(new AbortController().signal);
      return buildScheduledSlotSummary([
        summarizeCronResult("compute-safety-score-v9", result as CronResult),
      ]);
    });
    return { scheduledRuntime, inserts };
  }
  it("stays silent while a competing invocation still owns the V9 lane", async () => {
    const { scheduledRuntime, inserts } = neutralComputeRuntime({
      status: "skipped_neutral",
      metadata: { reason: "v9-memory-lane-active" },
    });

    await runV9PublicationSlot(scheduledRuntime);

    expect(inserts).toHaveLength(0);
    expect(mocks.logWorkerEvent).not.toHaveBeenCalled();
  });

  it("does not record extra rows when the execution window skipped the compiler", async () => {
    const { scheduledRuntime, inserts } = neutralComputeRuntime({
      status: "skipped_neutral",
      metadata: { reason: "v9-core-slot-not-ready" },
    });
    mocks.runV9AfterCoreWithinWindow.mockResolvedValue({
      status: "skipped_neutral",
      itemCount: 0,
    });
    mocks.computeSafetyScoreV9.mockClear();

    await runV9PublicationSlot(scheduledRuntime);

    expect(mocks.computeSafetyScoreV9).not.toHaveBeenCalled();
    expect(inserts).toHaveLength(0);
  });
});

describe("scheduled supply-attribution native context", () => {
  let lastResult: CronResult | undefined;
  const persisted = () => JSON.parse(lastResult?.metadata ?? "{}");
  const laneSkip = JSON.stringify({ laneScreening: { status: "skipped", reason: "lane-screening-window-insufficient", remainingMs: 30_000 } });
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.runScheduledSlotGroups.mockImplementation(async (
      _scheduledRuntime: ScheduledRuntimeContext,
      _label: string,
      stages: Array<Array<{ tasks: Array<{
        run: (
          signal: AbortSignal,
          reportProgress: CronProgressReporter,
        ) => Promise<unknown>;
      }> }>>,
    ) => {
      lastResult = await stages[0]?.[0]?.tasks[0]?.run(new AbortController().signal, vi.fn()) as CronResult;
      return { jobsRun: 1, jobsSucceeded: 1, jobsErrored: 0, jobsDegraded: 0, jobsSkipped: 0 };
    });
  });

  it.each([true, false])("forwards only the runtime's admitted native capability: %s", async admitted => {
    const signal = new AbortController().signal;
    const window = { slotStartedAtSec: 1000, deadlineMs: Date.now() + 180_000, minimumRemainingMs: 60_000 };
    mocks.runV9AfterCoreWithinWindow.mockImplementation(async (_input, run) => run(signal, window));
    mocks.syncSupplyAttribution.mockResolvedValue({ status: "ok", itemCount: 1 });
    const dwellirNative = admitted ? createDwellirNativeCapability("native-test-key-placeholder") : undefined;
    const job = getCronJobMeta("sync-v9-supply-attribution");
    if (!job) throw new Error("Supply-attribution job is missing from the cron registry");
    const runtime = makeScheduledRuntime({ dwellirNative, scheduleKey: job.scheduleKey });
    await runV9SupplyAttributionSlot(runtime);
    expect(mocks.syncSupplyAttribution).toHaveBeenCalledExactlyOnceWith(runtime.db, runtime.chainRpcs, signal, window, dwellirNative);
  });

  const attributionSlot = getCronJobMeta("sync-v9-supply-attribution")!.scheduleKey;

  it("runs D1-only public materialization recovery before attribution only on the :38 slot", async () => {
    vi.useFakeTimers();
    const nowMs = Date.parse("2026-11-22T12:38:01Z");
    vi.setSystemTime(nowMs);
    try {
      const order: string[] = [];
      const signal = new AbortController().signal;
      const window = { slotStartedAtSec: Date.parse("2026-11-22T12:38:00Z") / 1_000, deadlineMs: Date.parse("2026-11-22T12:41:00Z"), minimumRemainingMs: 60_000 };
      mocks.runV9AfterCoreWithinWindow.mockImplementation(async (_input, run) => run(signal, window));
      mocks.recoverSafetyScoreV9PublicMaterialization.mockImplementation(async () => {
        order.push("recover");
        vi.setSystemTime(nowMs + 40_000);
        return { status: "ok", itemCount: 1, metadata: JSON.stringify({ reason: "v9-public-materialization-retry-materialized", publicMaterialization: { publicationGenerationId: "gen-1" } }) };
      });
      mocks.syncSupplyAttribution.mockImplementation(async () => {
        order.push("attribution");
        return { status: "ok", itemCount: 1, metadata: laneSkip };
      });

      const runtime = makeScheduledRuntime({
        cron: "38 * * * *",
        scheduleKey: attributionSlot,
        scheduledTimeMs: Date.parse("2026-11-22T12:38:00Z"),
        slotStartedAt: Date.parse("2026-11-22T12:38:00Z") / 1_000,
      });
      await runV9SupplyAttributionSlot(runtime);

      expect(order).toEqual(["recover", "attribution"]);
      expect(mocks.recoverSafetyScoreV9PublicMaterialization).toHaveBeenCalledExactlyOnceWith(
        runtime.db,
        signal,
        nowMs + 60_000,
        { skipPriorFailedGeneration: true },
      );
      expect(mocks.syncSupplyAttribution).toHaveBeenCalledExactlyOnceWith(runtime.db, runtime.chainRpcs, signal, window, undefined);
      expect(mocks.logWorkerEvent).toHaveBeenCalledWith(expect.objectContaining({
        level: "info",
        event: "safety_score_v9_public_materialization_piggyback",
      }));
      // 30s left + 40s recovery would have met lane screening's 60s minimum.
      expect(persisted()).toEqual({
        laneScreening: expect.objectContaining({ reason: "lane-screening-window-consumed-by-materialization-recovery" }),
        publicMaterializationRecovery: { status: "ok", reason: "v9-public-materialization-retry-materialized",
          publicationGenerationId: "gen-1", budgetMs: 60_000, durationMs: 40_000, remainingMs: 139_000 },
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it.each([
    ["8 * * * *", "2026-11-22T12:08:00Z"],
    ["23 * * * *", "2026-11-22T12:23:00Z"],
    ["53 * * * *", "2026-11-22T12:53:00Z"],
  ] as const)("does not run materialization recovery on the %s attribution slot", async (cron, iso) => {
    const signal = new AbortController().signal;
    const scheduledTimeMs = Date.parse(iso);
    const window = { slotStartedAtSec: scheduledTimeMs / 1_000, deadlineMs: scheduledTimeMs + 180_000, minimumRemainingMs: 60_000 };
    mocks.runV9AfterCoreWithinWindow.mockImplementation(async (_input, run) => run(signal, window));
    mocks.syncSupplyAttribution.mockResolvedValue({ status: "ok", itemCount: 1 });

    const runtime = makeScheduledRuntime({
      cron,
      scheduleKey: attributionSlot,
      scheduledTimeMs,
      slotStartedAt: scheduledTimeMs / 1_000,
    });
    await runV9SupplyAttributionSlot(runtime);

    expect(mocks.recoverSafetyScoreV9PublicMaterialization).not.toHaveBeenCalled();
    expect(mocks.syncSupplyAttribution).toHaveBeenCalledOnce();
    expect(lastResult).toEqual({ status: "ok", itemCount: 1 });
  });

  it.each(["throws", "degraded"] as const)("continues attribution when :38 materialization recovery %s", async mode => {
    vi.useFakeTimers();
    const nowMs = Date.parse("2026-11-22T12:38:01Z");
    vi.setSystemTime(nowMs);
    try {
      const signal = new AbortController().signal;
      const window = { slotStartedAtSec: Date.parse("2026-11-22T12:38:00Z") / 1_000, deadlineMs: Date.parse("2026-11-22T12:41:00Z"), minimumRemainingMs: 60_000 };
      mocks.runV9AfterCoreWithinWindow.mockImplementation(async (_input, run) => run(signal, window));
      if (mode === "throws") {
        mocks.recoverSafetyScoreV9PublicMaterialization.mockRejectedValue(new Error("D1 read failed"));
      } else {
        mocks.recoverSafetyScoreV9PublicMaterialization.mockResolvedValue({
          status: "degraded", itemCount: 0, metadata: JSON.stringify({ reason: "v9-public-materialization-retry-failed" }),
        });
      }
      mocks.syncSupplyAttribution.mockResolvedValue({ status: "ok", itemCount: 1, metadata: laneSkip });

      const runtime = makeScheduledRuntime({
        cron: "38 * * * *",
        scheduleKey: attributionSlot,
        scheduledTimeMs: Date.parse("2026-11-22T12:38:00Z"),
        slotStartedAt: Date.parse("2026-11-22T12:38:00Z") / 1_000,
      });
      await runV9SupplyAttributionSlot(runtime);

      expect(mocks.syncSupplyAttribution).toHaveBeenCalledOnce();
      expect(mocks.logWorkerEvent).toHaveBeenCalledWith(expect.objectContaining({ level: "warn" }));
      // Zero recovery time did not cause the lane-screening skip.
      expect(persisted()).toMatchObject({
        laneScreening: { reason: "lane-screening-window-insufficient" },
        publicMaterializationRecovery: mode === "throws"
          ? { status: "failed", reason: "v9-public-materialization-piggyback-failed", durationMs: 0 }
          : { status: "degraded", reason: "v9-public-materialization-retry-failed", durationMs: 0 },
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("skips :38 materialization recovery when remaining window leaves insufficient slack above attribution minimum", async () => {
    vi.useFakeTimers();
    const nowMs = Date.parse("2026-11-22T12:39:40Z");
    vi.setSystemTime(nowMs);
    try {
      const signal = new AbortController().signal;
      // 80s remaining minus 60s attribution floor = 20s (< 50s needed for recovery).
      const window = { slotStartedAtSec: Date.parse("2026-11-22T12:38:00Z") / 1_000, deadlineMs: Date.parse("2026-11-22T12:41:00Z"), minimumRemainingMs: 60_000 };
      mocks.runV9AfterCoreWithinWindow.mockImplementation(async (_input, run) => run(signal, window));
      mocks.syncSupplyAttribution.mockResolvedValue({ status: "ok", itemCount: 1 });

      const runtime = makeScheduledRuntime({
        cron: "38 * * * *",
        scheduleKey: attributionSlot,
        scheduledTimeMs: Date.parse("2026-11-22T12:38:00Z"),
        slotStartedAt: Date.parse("2026-11-22T12:38:00Z") / 1_000,
      });
      await runV9SupplyAttributionSlot(runtime);

      expect(mocks.recoverSafetyScoreV9PublicMaterialization).not.toHaveBeenCalled();
      expect(mocks.syncSupplyAttribution).toHaveBeenCalledOnce();
      expect(persisted().publicMaterializationRecovery).toEqual({ status: "skipped", publicationGenerationId: null,
        reason: "v9-public-materialization-piggyback-window-insufficient", budgetMs: 20_000, durationMs: null, remainingMs: 80_000 });
    } finally {
      vi.useRealTimers();
    }
  });
});
