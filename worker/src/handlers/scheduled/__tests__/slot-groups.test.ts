import { describe, expect, it, vi } from "vitest";
import type { ScheduledRuntimeContext } from "../context";
import { flattenScheduledSlotGroupTasks, runScheduledSlotGroups } from "../slot-groups";

function buildRuntime(
  runLeasedCron: ScheduledRuntimeContext["runLeasedCron"],
): ScheduledRuntimeContext {
  return {
    db: {} as D1Database,
    env: {} as ScheduledRuntimeContext["env"],
    ctx: {} as ExecutionContext,
    cron: "0 8 * * *",
    scheduleKey: "daily0800Utc",
    scheduledTimeMs: null,
    slotStartedAt: 0,
    mintBurnDisabledIds: [],
    mintBurnDisabledSymbols: [],
    mintBurnFreshnessConfig: {} as ScheduledRuntimeContext["mintBurnFreshnessConfig"],
    coingeckoApiKey: null,
    alertWebhookUrl: null,
    chainRpcs: new Map(),
    runLeasedCron,
  };
}

describe("scheduled slot groups", () => {
  it("runs serial chains in parallel while preserving order within each chain", async () => {
    const order: string[] = [];
    let releaseA: (() => void) | null = null;
    const aCanFinish = new Promise<void>((resolve) => {
      releaseA = resolve;
    });

    const runLeasedCron = vi.fn(async (job: string, fn) => {
      order.push(`start:${job}`);
      const result = await fn(new AbortController().signal, async () => {});
      if (job === "a") {
        await aCanFinish;
      }
      if (job === "c") {
        releaseA?.();
      }
      order.push(`end:${job}`);
      return result;
    }) as ScheduledRuntimeContext["runLeasedCron"];

    await runScheduledSlotGroups(buildRuntime(runLeasedCron), "test slot", [
      {
        mode: "parallel-serial",
        label: "chains",
        chains: [
          {
            label: "left",
            tasks: [
              { job: "a", run: async () => ({ status: "ok" }) },
              { job: "b", run: async () => ({ status: "ok" }) },
            ],
          },
          {
            label: "right",
            tasks: [
              { job: "c", run: async () => ({ status: "ok" }) },
            ],
          },
        ],
      },
    ]);

    expect(order.indexOf("end:a")).toBeLessThan(order.indexOf("start:b"));
    expect(order.indexOf("start:c")).toBeLessThan(order.indexOf("start:b"));
  });

  it("flattens mixed group shapes for preflight accounting", () => {
    const tasks = flattenScheduledSlotGroupTasks([
      {
        mode: "serial",
        label: "serial",
        tasks: [{ job: "a", run: async () => undefined }],
      },
      {
        mode: "parallel-serial",
        label: "chains",
        chains: [
          { label: "left", tasks: [{ job: "b", run: async () => undefined }] },
          { label: "right", tasks: [{ job: "c", run: async () => undefined }] },
        ],
      },
    ]);

    expect(tasks.map((task) => task.job)).toEqual(["a", "b", "c"]);
  });
});
