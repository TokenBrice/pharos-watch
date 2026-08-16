import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CronResult } from "../../../lib/cron-logger";
import {
  mapCronStatusToCircuitOutcome,
  recordOutcomeDecision,
  shouldAttemptFetch,
} from "../../../lib/circuit-breaker";
import { runCircuitGatedLeasedScheduledJob } from "../run-circuit-gated-job";
import type { ScheduledRuntimeContext } from "../context";

vi.mock("../../../lib/circuit-breaker", () => ({
  shouldAttemptFetch: vi.fn(),
  recordOutcomeDecision: vi.fn(async () => {}),
  mapCronStatusToCircuitOutcome: vi.fn((status: string | null | undefined) => {
    if (status === "error") return "failure";
    if (status === "ok" || status == null) return "success";
    return "neutral";
  }),
}));
vi.mock("../preflight-skip", () => ({
  logSkippedCronRun: vi.fn(async () => undefined),
}));

describe("runCircuitGatedLeasedScheduledJob", () => {
  let runLeasedCron: ReturnType<typeof vi.fn>;
  let warnSpy: ReturnType<typeof vi.spyOn>;

  function buildRuntime(): ScheduledRuntimeContext {
    return {
      db: {} as D1Database,
      env: {} as ScheduledRuntimeContext["env"],
      ctx: {} as ExecutionContext,
      cron: "*/30 * * * *",
      scheduleKey: "halfHourlyOffset",
      scheduledTimeMs: null,
      slotStartedAt: 0,
      mintBurnDisabledIds: [],
      mintBurnDisabledSymbols: [],
      mintBurnFreshnessConfig: {} as ScheduledRuntimeContext["mintBurnFreshnessConfig"],
      coingeckoApiKey: null,
      chainRpcs: new Map(),
      runLeasedCron: runLeasedCron as unknown as ScheduledRuntimeContext["runLeasedCron"],
    };
  }

  beforeEach(() => {
    runLeasedCron = vi.fn();
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.mocked(shouldAttemptFetch).mockResolvedValue(true);
    vi.mocked(recordOutcomeDecision).mockResolvedValue(undefined);
  });

  afterEach(() => {
    warnSpy.mockRestore();
    vi.clearAllMocks();
  });

  it("skips the leased cron when the circuit is open", async () => {
    vi.mocked(shouldAttemptFetch).mockResolvedValue(false);

    const result = await runCircuitGatedLeasedScheduledJob(buildRuntime(), {
      circuitSource: "dex-liquidity",
      outcomeLabel: "DEX liquidity",
      skipMessage: "DEX circuit open",
      job: "sync-dex-liquidity",
      fn: async () => ({ status: "ok" }) as CronResult,
    });

    expect(result).toBeNull();
    expect(runLeasedCron).not.toHaveBeenCalled();
    expect(recordOutcomeDecision).not.toHaveBeenCalled();
    expect(JSON.parse(String(warnSpy.mock.calls[0]?.[0]))).toMatchObject({
      event: "scheduled_job_circuit_open",
      message: "DEX circuit open",
      job: "sync-dex-liquidity",
      provider: "dex-liquidity",
    });
    const { logSkippedCronRun } = await import("../preflight-skip");
    expect(logSkippedCronRun).toHaveBeenCalledWith(expect.anything(), {
      job: "sync-dex-liquidity",
      reason: "circuit-open",
      message: "DEX circuit open",
      metadata: {
        circuitSource: "dex-liquidity",
      },
    });
  });

  it("records the mapped circuit outcome after a settled cron run", async () => {
    const cronResult = { status: "ok", itemCount: 12, metadata: "" } as CronResult;
    runLeasedCron.mockResolvedValue(cronResult);

    const result = await runCircuitGatedLeasedScheduledJob(buildRuntime(), {
      circuitSource: "dex-liquidity",
      outcomeLabel: "DEX liquidity",
      skipMessage: "DEX circuit open",
      job: "sync-dex-liquidity",
      fn: async () => cronResult,
    });

    expect(result).toBe(cronResult);
    expect(mapCronStatusToCircuitOutcome).toHaveBeenCalledWith("ok");
    expect(recordOutcomeDecision).toHaveBeenCalledWith(
      expect.anything(),
      "dex-liquidity",
      "success",
    );
  });

  it("records failure and rethrows when the leased cron fails", async () => {
    const error = new Error("upstream failed");
    runLeasedCron.mockRejectedValue(error);

    await expect(runCircuitGatedLeasedScheduledJob(buildRuntime(), {
      circuitSource: "dex-liquidity",
      outcomeLabel: "DEX liquidity",
      skipMessage: "DEX circuit open",
      job: "sync-dex-liquidity",
      fn: async () => ({ status: "ok" }) as CronResult,
    })).rejects.toThrow("upstream failed");

    expect(recordOutcomeDecision).toHaveBeenCalledWith(
      expect.anything(),
      "dex-liquidity",
      "failure",
    );
  });
});
