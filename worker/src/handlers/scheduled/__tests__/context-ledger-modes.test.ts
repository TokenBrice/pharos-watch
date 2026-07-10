import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  createWorkerJobAttempt: vi.fn(),
  finishWorkerJobAttempt: vi.fn(),
  heartbeatWorkerJobAttempt: vi.fn(),
  recordWorkerJobAttemptLease: vi.fn(),
  runCronWithLease: vi.fn(),
  reportAlertCondition: vi.fn(),
  alertBrokerMode: "off" as "off" | "shadow" | "status" | "alert",
  cronRunTerminalStatus: null as string | null,
  callbackError: null as unknown,
}));

vi.mock("../../../lib/job-ledger", () => ({
  createWorkerJobAttempt: mocks.createWorkerJobAttempt,
  finishWorkerJobAttempt: mocks.finishWorkerJobAttempt,
  heartbeatWorkerJobAttempt: mocks.heartbeatWorkerJobAttempt,
  normalizeWorkerJobLedgerMode: (value: string | undefined) => (
    value === "write" || value === "shadow" ? value : "off"
  ),
  recordWorkerJobAttemptLease: mocks.recordWorkerJobAttemptLease,
  shouldRecordWorkerJobAttempt: ({ mode }: { mode: string }) => mode !== "off",
}));

vi.mock("../../../lib/cron-lease", () => ({
  createLeaseOwner: () => "lease-owner",
  getCronTimeoutBudgetMetadata: () => null,
  resolveCronTimeoutBudget: () => ({
    configuredTimeoutMs: 300_000,
    effectiveTimeoutMs: 300_000,
    remainingSlotBudgetMs: 300_000,
    slotBudgetTruncated: false,
    slotBudgetExhausted: false,
    exhausted: false,
  }),
  runCronWithLease: mocks.runCronWithLease,
}));

vi.mock("../../../lib/cron-logger", () => ({
  logCronRun: vi.fn(async (
    _db: D1Database,
    _job: string,
    fn: (signal: AbortSignal, reportProgress: (update: unknown) => Promise<void>) => Promise<unknown>,
  ) => {
    try {
      const result = await fn(new AbortController().signal, async () => {});
      mocks.cronRunTerminalStatus = (result as { status?: string } | undefined)?.status ?? "ok";
      return result;
    } catch (error) {
      mocks.cronRunTerminalStatus = "error";
      mocks.callbackError = error;
      throw error;
    }
  }),
}));

vi.mock("../../../lib/alert-broker", () => ({
  normalizeAlertBrokerMode: () => mocks.alertBrokerMode,
  reportAlertCondition: mocks.reportAlertCondition,
}));

import { createScheduledRuntimeContext } from "../context";
import { runSinglePropagatingSlotJob } from "../slot-summary";

function buildRuntime(mode: "shadow" | "write") {
  return createScheduledRuntimeContext(
    {
      DB: {} as D1Database,
      WORKER_JOB_LEDGER_MODE: mode,
      WORKER_JOB_LEDGER_ALLOWLIST: "snapshot-supply",
    } as Parameters<typeof createScheduledRuntimeContext>[0],
    { waitUntil: vi.fn(), passThroughOnException: vi.fn() } as unknown as ExecutionContext,
    {
      cron: "*/15 * * * *",
      scheduleKey: "quarterHourly",
      scheduledTimeMs: 1_000_000,
      slotStartedAt: 1_000,
    },
  );
}

describe("scheduled runtime job-ledger modes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.alertBrokerMode = "off";
    mocks.cronRunTerminalStatus = null;
    mocks.callbackError = null;
    mocks.reportAlertCondition.mockReset().mockResolvedValue(undefined);
    mocks.createWorkerJobAttempt.mockReset().mockResolvedValue({
      attemptId: "attempt-1",
      scheduleKey: "quarterHourly",
      job: "snapshot-supply",
      slotStartedAt: 1_000,
      attemptNo: 1,
    });
    mocks.finishWorkerJobAttempt.mockReset().mockResolvedValue(undefined);
    mocks.heartbeatWorkerJobAttempt.mockReset().mockResolvedValue(undefined);
    mocks.recordWorkerJobAttemptLease.mockReset().mockResolvedValue(undefined);
    mocks.runCronWithLease.mockReset().mockImplementation(async (
      _db: D1Database,
      _job: string,
      fn: (input: { signal: AbortSignal }) => Promise<unknown>,
      options: {
        onLeaseState?: (state: { leaseOwner: string; leaseUntil: number }) => Promise<void>;
        leaseStateObserverMode?: "best-effort" | "required";
      },
    ) => {
      try {
        await options.onLeaseState?.({ leaseOwner: "lease-owner", leaseUntil: 2_000 });
      } catch (error) {
        if (options.leaseStateObserverMode === "required") throw error;
      }
      const result = await fn({ signal: new AbortController().signal });
      return {
        status: "ok",
        result,
        leaseOwner: "lease-owner",
        renewFailures: 0,
        leaseLost: false,
        leaseTtlSec: 360,
        leaseHeartbeatSec: 120,
        leaseMaxRenewFailures: 2,
        leaseRenewAttempts: 0,
        leaseRenewSuccesses: 0,
        leaseRenewFailuresTotal: 0,
        leaseLastRenewedAt: null,
      };
    });
  });

  it("makes bootstrap persistence part of write mode before job execution", async () => {
    const bootstrapError = new Error("attempt create failed");
    mocks.createWorkerJobAttempt.mockRejectedValue(bootstrapError);
    const runJob = vi.fn(async () => ({ status: "ok" as const }));

    await expect(buildRuntime("write").runLeasedCron("snapshot-supply", runJob)).rejects.toBe(bootstrapError);

    expect(runJob).not.toHaveBeenCalled();
    expect(mocks.callbackError).toBe(bootstrapError);
  });

  it("does not create a queued attempt when fetch-budget waiting is aborted", async () => {
    const runtime = buildRuntime("write");
    const releaseBudget = await runtime.fetchBudget!.acquire(runtime.fetchBudget!.capacity);
    const controller = new AbortController();
    const allocationAbort = new Error("slot allocation aborted");
    const runJob = vi.fn(async () => ({ status: "ok" as const }));
    runtime.slotSignal = controller.signal;

    try {
      const pendingRun = runtime.runLeasedCron("sync-stablecoins", runJob);
      expect(runtime.fetchBudget!.snapshot().waiting).toBe(1);

      controller.abort(allocationAbort);

      await expect(pendingRun).rejects.toBe(allocationAbort);
      expect(mocks.createWorkerJobAttempt).not.toHaveBeenCalled();
      expect(mocks.finishWorkerJobAttempt).not.toHaveBeenCalled();
      expect(runJob).not.toHaveBeenCalled();
    } finally {
      releaseBudget();
    }
  });

  it("makes acquisition lease-state persistence required only in write mode", async () => {
    const leaseWriteError = new Error("lease state failed");
    mocks.recordWorkerJobAttemptLease.mockRejectedValue(leaseWriteError);
    const writeJob = vi.fn(async () => ({ status: "ok" as const }));

    await expect(buildRuntime("write").runLeasedCron("snapshot-supply", writeJob)).rejects.toBe(leaseWriteError);
    expect(writeJob).not.toHaveBeenCalled();
    expect(mocks.callbackError).toBe(leaseWriteError);

    mocks.callbackError = null;
    const shadowJob = vi.fn(async () => ({ status: "ok" as const }));
    await expect(buildRuntime("shadow").runLeasedCron("snapshot-supply", shadowJob)).resolves.toMatchObject({
      status: "ok",
    });
    expect(shadowJob).toHaveBeenCalledTimes(1);
    expect(mocks.callbackError).toBeNull();
  });

  it("fails write mode when a progress heartbeat cannot be persisted", async () => {
    const heartbeatError = new Error("heartbeat failed");
    mocks.heartbeatWorkerJobAttempt.mockRejectedValue(heartbeatError);
    const runJob = vi.fn(async () => ({ status: "ok" as const }));

    await expect(buildRuntime("write").runLeasedCron("snapshot-supply", runJob)).rejects.toBe(heartbeatError);

    expect(runJob).not.toHaveBeenCalled();
    expect(mocks.callbackError).toBe(heartbeatError);
  });

  it("keeps terminal persistence best-effort in shadow mode", async () => {
    mocks.finishWorkerJobAttempt.mockRejectedValue(new Error("terminal write failed"));
    const runtime = buildRuntime("shadow");

    await expect(runtime.runLeasedCron(
      "snapshot-supply",
      async () => ({ status: "ok", itemCount: 1 }),
    )).resolves.toMatchObject({ status: "ok", itemCount: 1 });

    expect(mocks.finishWorkerJobAttempt).toHaveBeenCalledTimes(1);
    expect(mocks.callbackError).toBeNull();
  });

  it.each(["status", "alert"] as const)(
    "keeps slot and durable terminal success aligned when %s-mode recovery reporting fails",
    async (alertBrokerMode) => {
      const recoveryError = new Error("recovery observation failed");
      mocks.alertBrokerMode = alertBrokerMode;
      mocks.reportAlertCondition.mockImplementation(async (
        _db: D1Database,
        input: { active: boolean },
      ) => {
        if (!input.active) throw recoveryError;
      });
      const runtime = buildRuntime("write");

      const slot = await runSinglePropagatingSlotJob(
        runtime,
        "snapshot-supply",
        async () => ({ status: "ok", itemCount: 1 }),
      );

      expect(slot.jobs).toEqual([expect.objectContaining({
        job: "snapshot-supply",
        outcome: "ok",
        status: "ok",
      })]);
      expect(slot.jobsSucceeded).toBe(1);
      expect(slot.jobsErrored).toBe(0);
      expect(mocks.cronRunTerminalStatus).toBe("ok");
      expect(mocks.finishWorkerJobAttempt).toHaveBeenCalledTimes(1);
      expect(mocks.finishWorkerJobAttempt).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          result: expect.objectContaining({ status: "ok", itemCount: 1 }),
        }),
      );
      expect(mocks.finishWorkerJobAttempt.mock.calls[0]?.[1]).not.toHaveProperty("error");
      expect(mocks.callbackError).toBeNull();
      expect(mocks.reportAlertCondition).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ active: false }),
      );
    },
  );

  it("fails inside cron accounting when terminal persistence fails in write mode", async () => {
    const terminalError = new Error("terminal write failed");
    mocks.finishWorkerJobAttempt.mockRejectedValue(terminalError);
    const runtime = buildRuntime("write");

    await expect(runtime.runLeasedCron(
      "snapshot-supply",
      async () => ({ status: "ok", itemCount: 1 }),
    )).rejects.toBeInstanceOf(AggregateError);

    expect(mocks.callbackError).toBe(terminalError);
    expect(mocks.finishWorkerJobAttempt).toHaveBeenCalledTimes(2);
  });

  it.each(["skipped-locked", "no-result"] as const)(
    "enforces terminal persistence for the %s path in write mode",
    async (path) => {
      const terminalError = new Error("terminal write failed");
      mocks.finishWorkerJobAttempt.mockRejectedValue(terminalError);
      if (path === "skipped-locked") {
        mocks.runCronWithLease.mockResolvedValueOnce({
          status: "skipped_locked",
          leaseOwner: "other-owner",
          renewFailures: 0,
          leaseTtlSec: 360,
          leaseHeartbeatSec: 120,
          leaseMaxRenewFailures: 2,
          leaseRenewAttempts: 0,
          leaseRenewSuccesses: 0,
          leaseRenewFailuresTotal: 0,
          leaseLastRenewedAt: null,
        });
      }
      const runtime = buildRuntime("write");

      await expect(runtime.runLeasedCron(
        "snapshot-supply",
        async () => path === "no-result" ? undefined : { status: "ok" as const },
      )).rejects.toBeInstanceOf(AggregateError);

      expect(mocks.callbackError).toBe(terminalError);
      expect(mocks.finishWorkerJobAttempt).toHaveBeenCalledTimes(2);
    },
  );

  it("preserves the primary failure and terminal persistence failure in write mode", async () => {
    const primaryError = new Error("job failed");
    const terminalError = new Error("terminal write failed");
    mocks.finishWorkerJobAttempt.mockRejectedValue(terminalError);
    const runtime = buildRuntime("write");

    const rejection = runtime.runLeasedCron("snapshot-supply", async () => {
      throw primaryError;
    });
    await expect(rejection).rejects.toSatisfy((error: unknown) => (
      error instanceof AggregateError
      && error.errors[0] === primaryError
      && error.errors[1] === terminalError
    ));

    expect(mocks.callbackError).toBe(primaryError);
    expect(mocks.finishWorkerJobAttempt).toHaveBeenCalledTimes(1);
  });
});
