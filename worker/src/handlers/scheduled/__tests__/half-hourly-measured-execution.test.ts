import { describe, expect, it, vi } from "vitest";

import type { CronProgressReporter, CronResult } from "../../../lib/cron-logger";
import { settleMeasuredExecutionLane } from "../half-hourly-measured-execution";
import { runHalfHourlyMeasuredExecutionSlot } from "../half-hourly-measured-execution";
import type { ScheduledRuntimeContext } from "../context";

const runners = vi.hoisted(() => ({ evm: vi.fn(), orca: vi.fn(), result: null as CronResult | null }));
vi.mock("../../../cron/measured-execution/sync", () => ({ syncDexMeasuredExecution: runners.evm }));
vi.mock("../../../cron/dex-liquidity/solana/whirlpool-shadow", () => ({ collectWhirlpoolShadowQuotes: runners.orca }));
vi.mock("../slot-groups", () => ({
  runSingleScheduledJob: async (_runtime: unknown, _label: string, job: { run: (signal: AbortSignal, progress?: CronProgressReporter) => Promise<CronResult> }) => {
    runners.result = await job.run(new AbortController().signal);
    return {};
  },
}));

it("awaits the EVM lane before collecting isolated shadow evidence and preserves EVM status", async () => {
  const order: string[] = [];
  let release!: (result: CronResult) => void;
  runners.evm.mockImplementation(() => new Promise<CronResult>((resolve) => { order.push("evm-start"); release = resolve; }));
  runners.orca.mockImplementation(async () => { order.push("orca"); return { persisted: 1, scoreEligible: false }; });
  const pending = runHalfHourlyMeasuredExecutionSlot({ db: {}, chainRpcs: new Map() } as ScheduledRuntimeContext);
  await Promise.resolve();
  expect(order).toEqual(["evm-start"]);
  release({ status: "degraded", itemCount: 2, metadata: JSON.stringify({ measuredCount: 2 }) });
  await pending;
  const result = runners.result!;
  expect(order).toEqual(["evm-start", "orca"]);
  expect(result).toMatchObject({ status: "degraded", itemCount: 2 });
  expect(JSON.parse(result.metadata!)).toEqual({ measuredCount: 2, orcaShadow: { persisted: 1, scoreEligible: false } });
});

describe("half-hourly measured execution lane settlement", () => {
  it("passes a settled lane result through unchanged with flat diagnostics", async () => {
    const lane: CronResult = {
      status: "ok",
      itemCount: 3,
      metadata: JSON.stringify({
        measuredCount: 3,
        rpcRequestCount: 7,
      }),
      productivity: { productive: true, reason: "published-measured-execution" },
    };

    const settled = await settleMeasuredExecutionLane("evm", Promise.resolve(lane));

    expect(settled).toBe(lane);
    expect(JSON.parse(settled.metadata!)).toEqual({
      measuredCount: 3,
      rpcRequestCount: 7,
    });
  });

  it("preserves degraded and error lane statuses", async () => {
    const degraded: CronResult = {
      status: "degraded",
      itemCount: 1,
      metadata: JSON.stringify({ attemptedFailureCount: 2 }),
      productivity: { productive: true, reason: "published-measured-execution" },
    };
    expect((await settleMeasuredExecutionLane("evm", Promise.resolve(degraded))).status).toBe("degraded");
  });

  it("converts a lane invocation rejection into a terminal error result", async () => {
    const settled = await settleMeasuredExecutionLane(
      "evm-shadow",
      Promise.reject(new Error("rpc unavailable")),
    );

    expect(settled.status).toBe("error");
    expect(settled.itemCount).toBe(0);
    expect(JSON.parse(settled.metadata!)).toEqual({
      lane: "evm-shadow",
      error: "rpc unavailable",
    });
    expect(settled.productivity).toEqual({
      productive: false,
      reason: "evm-shadow-measured-execution-failed",
    });
  });
});
