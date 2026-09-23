import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ScheduledRuntimeContext } from "../context";
import type { CronProgressReporter, CronResult } from "../../../lib/cron-logger";
import { buildScheduledSlotSummary, summarizeCronResult } from "../slot-summary";
import { makeScheduledRuntime } from "../../../test-helpers/scheduled-runtime.test-support";
import { makeNoopD1 } from "../../../test-helpers/noop-d1";
import { parseObjectMetadata } from "../../../lib/json-metadata";

const mocks = vi.hoisted(() => ({
  runScheduledSlotGroups: vi.fn(),

  runV9AfterCoreWithinWindow: vi.fn(),
  computeSafetyScoreV9: vi.fn(),
  logWorkerEvent: vi.fn(),
}));

vi.mock("../slot-groups", async (importOriginal) => ({
  ...await importOriginal<typeof import("../slot-groups")>(),
  runScheduledSlotGroups: mocks.runScheduledSlotGroups,
}));
vi.mock("../../../lib/v9-slot-window", () => ({
  runV9AfterCoreWithinWindow: mocks.runV9AfterCoreWithinWindow,
}));
vi.mock("../../../cron/compute-safety-score-v9", () => ({
  computeSafetyScoreV9: mocks.computeSafetyScoreV9,
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
    cron: "22,52 * * * *",
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
    cron: "22,52 * * * *",
    scheduleKey: "v9PublicationOffset",
    scheduledTimeMs: 1_800_000,
    slotStartedAt: 1_800,
    workerVersion: "worker-v1",
  });
}

describe("V9 publication scheduling", () => {
  const published = { jobsRun: 1, jobsSucceeded: 1, jobsErrored: 0, jobsDegraded: 0, jobsSkipped: 0 };
  const identities = { sourceGenerationId: "source-7", baseInputGenerationId: "base-9" };

  function compilingRuntime(mode = "shadow", metadata: Record<string, string> = identities) {
    const scheduledRuntime = runtime();
    const workflow = { create: vi.fn().mockResolvedValue({}), get: vi.fn() };
    scheduledRuntime.env = {
      ...scheduledRuntime.env, WORKER_V9_WORKFLOW_MODE: mode,
      SAFETY_SCORE_V9_WORKFLOW: workflow,
    } as unknown as ScheduledRuntimeContext["env"];
    mocks.computeSafetyScoreV9.mockResolvedValue({ status: "ok", metadata: JSON.stringify(metadata) });
    mocks.runV9AfterCoreWithinWindow.mockImplementation(async (_options, run) => run(new AbortController().signal));
    return { scheduledRuntime, workflow };
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
      groups: Array<{ tasks: Array<{
        run: (
          signal: AbortSignal,
          reportProgress: CronProgressReporter,
        ) => Promise<unknown>;
      }> }>,
    ) => {
      await groups[0]?.tasks[0]?.run(new AbortController().signal, vi.fn());
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
        minimumRemainingMs: 10_000,
        lane: "compute-safety-score-v9",
        currentSlotKey: "v9PublicationOffset",
      }),
      expect.any(Function),
    );
  });

  it("runs the compiler and triggers shadow work with the original slot identity", async () => {
    const { scheduledRuntime, workflow } = compilingRuntime();
    expect(await runV9PublicationSlot(scheduledRuntime)).toBe(published);
    expect(mocks.computeSafetyScoreV9).toHaveBeenCalledOnce();
    expect(workflow.create).toHaveBeenCalledExactlyOnceWith({
      id: "v9-publication-1800", params: { slotStartedAt: 1800 },
    });
  });

  it("requires both compiler identities and shadow mode", async () => {
    for (const [mode, metadata] of [
      ["shadow", { sourceGenerationId: "source-7" }],
      ["shadow", { baseInputGenerationId: "base-9" }],
      ["off", identities],
    ] as const) {
      const { scheduledRuntime, workflow } = compilingRuntime(mode, metadata);
      expect(await runV9PublicationSlot(scheduledRuntime)).toBe(published);
      expect(workflow.create).not.toHaveBeenCalled();
    }
  });

  it("accepts duplicate creation when the existing instance has a known status", async () => {
    const { scheduledRuntime, workflow } = compilingRuntime();
    workflow.create.mockRejectedValue(new Error("already exists"));
    workflow.get.mockResolvedValue({ status: async () => ({ status: "complete" }) });
    expect(await runV9PublicationSlot(scheduledRuntime)).toBe(published);
    expect(workflow.get).toHaveBeenCalledWith("v9-publication-1800");
    expect(mocks.logWorkerEvent).not.toHaveBeenCalled();
  });

  it.each(["unknown", "missing"])("reports %s instances without rejecting successful publication", async (state) => {
    const { scheduledRuntime, workflow } = compilingRuntime();
    workflow.create.mockRejectedValue(new Error("create failed"));
    if (state === "unknown") workflow.get.mockResolvedValue({ status: async () => ({ status: "unknown" }) });
    else workflow.get.mockRejectedValue(new Error("not found"));
    expect(await runV9PublicationSlot(scheduledRuntime)).toBe(published);
    expect(mocks.logWorkerEvent).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      event: "safety_score_v9_shadow_workflow_trigger_failed",
      metadata: { instanceId: "v9-publication-1800", slotStartedAt: 1800, errorName: "Error" },
    }));
  });


  function neutralComputeRuntime(compute: { status: string; metadata: Record<string, unknown> }) {
    const { scheduledRuntime, inserts } = capturingRuntime();
    const workflow = { create: vi.fn().mockResolvedValue({}), get: vi.fn() };
    scheduledRuntime.env = {
      ...scheduledRuntime.env,
      WORKER_V9_WORKFLOW_MODE: "shadow",
      SAFETY_SCORE_V9_WORKFLOW: workflow,
    } as unknown as ScheduledRuntimeContext["env"];
    mocks.runV9AfterCoreWithinWindow.mockImplementation(async (_options, run) => run(new AbortController().signal));
    const compiled = {
      status: compute.status as "skipped_neutral",
      metadata: JSON.stringify(compute.metadata),
    };
    mocks.computeSafetyScoreV9.mockResolvedValue(compiled);
    // A neutral or degraded compiler result must not count as a succeeded job,
    // which is what decides whether the Workflow trigger has work to shadow.
    mocks.runScheduledSlotGroups.mockImplementation(async (
      _scheduledRuntime: ScheduledRuntimeContext,
      _label: string,
      groups: Array<{ tasks: Array<{ run: (signal: AbortSignal) => Promise<unknown> }> }>,
    ) => {
      const result = await groups[0]?.tasks[0]?.run(new AbortController().signal);
      return buildScheduledSlotSummary([
        summarizeCronResult("compute-safety-score-v9", result as CronResult),
      ]);
    });
    return { scheduledRuntime, inserts, workflow };
  }
  it("records a neutral workflow row naming the upstream reason when compute publishes nothing", async () => {
    const { scheduledRuntime, inserts, workflow } = neutralComputeRuntime({
      status: "skipped_neutral",
      metadata: { reason: "v9-core-slot-not-ready" },
    });

    await runV9PublicationSlot(scheduledRuntime);

    expect(workflow.create).not.toHaveBeenCalled();
    expect(inserts).toHaveLength(1);
    const insert = inserts[0]!;
    expect(insert.sql).toContain("INSERT INTO cron_runs");
    expect(insert.sql).toContain("'skipped_neutral'");
    expect(insert.bindings[0]).toBe("compute-safety-score-v9-workflow");
    expect(parseObjectMetadata(String(insert.bindings[3]))).toMatchObject({
      reason: "upstream-compute-publication-absent",
      instanceId: "v9-publication-1800",
      slotStartedAt: 1_800,
      upstreamJob: "compute-safety-score-v9",
      upstreamStatus: "skipped_neutral",
      upstreamReason: "v9-core-slot-not-ready",
    });
    expect(insert.bindings[4]).toBe(1_800);
    expect(insert.bindings[5]).toBe(
      "workflow:compute-safety-score-v9-workflow:v9-publication-1800:upstream-absent",
    );
  });

  it("records a neutral workflow row for an identity-bearing cadence deferral", async () => {
    const { scheduledRuntime, inserts, workflow } = neutralComputeRuntime({
      status: "skipped_neutral",
      metadata: {
        stage: "supply-generation",
        reason: "supply-attribution-generation-cadence-deferred",
        ...identities,
      },
    });

    await runV9PublicationSlot(scheduledRuntime);

    expect(workflow.create).not.toHaveBeenCalled();
    expect(inserts).toHaveLength(1);
    expect(parseObjectMetadata(String(inserts[0]!.bindings[3]))).toMatchObject({
      reason: "upstream-compute-publication-absent",
      upstreamStatus: "skipped_neutral",
      upstreamReason: "supply-attribution-generation-cadence-deferred",
      upstreamStage: "supply-generation",
    });
  });

  it("records a neutral workflow row when the compiler fails closed on a stale input", async () => {
    const { scheduledRuntime, inserts, workflow } = neutralComputeRuntime({
      status: "degraded",
      metadata: {
        stage: "input-load",
        reason: "stablecoins-generation-mismatch",
      },
    });

    await runV9PublicationSlot(scheduledRuntime);

    expect(workflow.create).not.toHaveBeenCalled();
    expect(inserts).toHaveLength(1);
    expect(parseObjectMetadata(String(inserts[0]!.bindings[3]))).toMatchObject({
      reason: "upstream-compute-publication-absent",
      upstreamStatus: "degraded",
      upstreamReason: "stablecoins-generation-mismatch",
      upstreamStage: "input-load",
    });
  });

  it("stays silent while a competing invocation still owns the V9 lane", async () => {
    const { scheduledRuntime, inserts, workflow } = neutralComputeRuntime({
      status: "skipped_neutral",
      metadata: { reason: "v9-memory-lane-active" },
    });

    await runV9PublicationSlot(scheduledRuntime);

    expect(workflow.create).not.toHaveBeenCalled();
    expect(inserts).toHaveLength(0);
    expect(mocks.logWorkerEvent).not.toHaveBeenCalled();
  });

  it("does not record a workflow row when the execution window skipped the compiler", async () => {
    const { scheduledRuntime, inserts, workflow } = neutralComputeRuntime({
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
    expect(workflow.create).not.toHaveBeenCalled();
    expect(inserts).toHaveLength(0);
  });
});
