import { afterEach, describe, expect, it, vi } from "vitest";
import { logSkippedCronRun } from "../preflight-skip";
import type { ScheduledRuntimeContext } from "../context";

function buildRuntime(prepare: D1Database["prepare"]): ScheduledRuntimeContext {
  return {
    db: { prepare } as D1Database,
    env: {} as ScheduledRuntimeContext["env"],
    ctx: {} as ExecutionContext,
    cron: "17,47 * * * *",
    scheduleKey: "halfHourlyOffset",
    scheduledTimeMs: null,
    slotStartedAt: 1_772_000_000,
    mintBurnDisabledIds: [],
    mintBurnDisabledSymbols: [],
    mintBurnFreshnessConfig: {} as ScheduledRuntimeContext["mintBurnFreshnessConfig"],
    coingeckoApiKey: null,
    alertWebhookUrl: null,
    chainRpcs: new Map(),
    runLeasedCron: vi.fn(),
  };
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
    const prepare = vi.fn(() => ({ bind })) as unknown as D1Database["prepare"];

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
      "scheduled-preflight:halfHourlyOffset:1772000000:sync-dex-liquidity:circuit-open",
      "halfHourlyOffset",
      "halfHourlyOffset",
      "scheduled-job",
      "scheduled:halfHourlyOffset:1772000000",
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
      scheduleKey: "halfHourlyOffset",
    });
    expect(metadata).not.toHaveProperty("skipped");
  });

  it("allows explicitly benign skip rows", async () => {
    const run = vi.fn(async () => ({ meta: { changes: 1 } }));
    const bind = vi.fn((..._args: unknown[]) => {
      return { run };
    });
    const prepare = vi.fn(() => ({ bind })) as unknown as D1Database["prepare"];

    await logSkippedCronRun(buildRuntime(prepare), {
      job: "sync-dex-liquidity",
      reason: "manually-disabled",
      status: "ok",
    });

    expect(bind.mock.calls[0][2]).toBe("ok");
  });
});
