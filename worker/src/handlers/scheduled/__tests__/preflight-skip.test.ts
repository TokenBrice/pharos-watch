import { afterEach, describe, expect, it, vi } from "vitest";
import { logSkippedCronRun } from "../preflight-skip";
import type { ScheduledRuntimeContext } from "../context";
import { makeScheduledRuntime } from "../../../test-helpers/scheduled-runtime.test-support";
import { makeNoopD1 } from "../../../test-helpers/noop-d1";

function buildRuntime(prepare: unknown): ScheduledRuntimeContext {
  return makeScheduledRuntime({
    db: makeNoopD1({ prepare }),
    cron: "16,46 * * * *",
    scheduleKey: "halfHourlyChartsOffset",
    scheduledTimeMs: null,
    slotStartedAt: 1_772_000_000,
    runLeasedCron: vi.fn() as ScheduledRuntimeContext["runLeasedCron"],
  });
}

describe("logSkippedCronRun", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("records skipped preflight runs as degraded by default", async () => {
    const run = vi.fn(async () => ({ meta: { changes: 1 } }));
    const bind = vi.fn((..._args: unknown[]) => {
      return { run };
    });
    const prepare = vi.fn(() => ({ bind }));

    await logSkippedCronRun(buildRuntime(prepare), {
      job: "sync-dex-liquidity",
      reason: "circuit-open",
      message: "DEX circuit open",
      metadata: { circuitSource: "dex-liquidity" },
    });

    expect(bind).toHaveBeenCalledWith(
      "sync-dex-liquidity",
      expect.any(Number),
      "degraded",
      expect.any(String),
      1_772_000_000,
      "scheduled-preflight:halfHourlyChartsOffset:1772000000:sync-dex-liquidity:circuit-open",
      "halfHourlyChartsOffset",
      "halfHourlyChartsOffset",
      "scheduled-job",
      "scheduled:halfHourlyChartsOffset:1772000000",
      null,
      null,
    );
    const cronRunBinds = bind.mock.calls[0];
    const metadata = JSON.parse(String(cronRunBinds[3])) as Record<string, unknown>;
    expect(metadata).toMatchObject({
      circuitSource: "dex-liquidity",
      skippedReason: "circuit-open",
      message: "DEX circuit open",
      slotStartedAt: 1_772_000_000,
      scheduleKey: "halfHourlyChartsOffset",
    });
    expect(metadata).not.toHaveProperty("skipped");
  });

  it("allows explicitly benign skip rows", async () => {
    const run = vi.fn(async () => ({ meta: { changes: 1 } }));
    const bind = vi.fn((..._args: unknown[]) => {
      return { run };
    });
    const prepare = vi.fn(() => ({ bind }));

    await logSkippedCronRun(buildRuntime(prepare), {
      job: "sync-dex-liquidity",
      reason: "manually-disabled",
      status: "ok",
    });

    expect(bind.mock.calls[0][2]).toBe("ok");
  });
});
