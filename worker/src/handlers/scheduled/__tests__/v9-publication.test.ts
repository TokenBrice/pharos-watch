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
vi.mock("../../../lib/safety-score-v9/publication-runner", () => ({
  recoverSafetyScoreV9PublicMaterialization: mocks.recoverSafetyScoreV9PublicMaterialization,
}));
vi.mock("../../../lib/structured-log", () => ({
  logWorkerEvent: mocks.logWorkerEvent,
}));
import { runV9PublicationSlot } from "../v9-publication";

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

  it.each([["on", true], ["off", false], ["ON", false]] as const)("defers public materialization only for literal %s", async (mode, expected) => {
    const { scheduledRuntime } = compilingRuntime();
    (scheduledRuntime.env as { SAFETY_V9_DEFERRED_MATERIALIZATION?: string }).SAFETY_V9_DEFERRED_MATERIALIZATION = mode;
    await runV9PublicationSlot(scheduledRuntime);
    expect(mocks.computeSafetyScoreV9.mock.calls[0]![3]).toMatchObject({ deferPublicMaterialization: expected });
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
