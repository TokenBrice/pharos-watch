import { describe, expect, it, vi } from "vitest";

import type { CronProgressReporter, CronResult } from "../../../lib/cron-logger";
import { runHalfHourlyMeasuredExecutionSlot, settleMeasuredExecutionLane } from "../half-hourly-measured-execution";
import type { ScheduledRuntimeContext } from "../context";

const runners = vi.hoisted(() => ({ evm: vi.fn(), orca: vi.fn(), raydium: vi.fn(), sui: vi.fn(), meteora: vi.fn(), result: null as CronResult | null }));
vi.mock("../../../cron/measured-execution/sync", () => ({ syncDexMeasuredExecution: runners.evm }));
vi.mock("../../../cron/dex-liquidity/solana/whirlpool-shadow", () => ({ collectWhirlpoolShadowQuotes: runners.orca, collectRaydiumShadowQuotes: runners.raydium }));
vi.mock("../../../cron/dex-liquidity/sui/shadow", () => ({ collectSuiClmmShadowQuotes: runners.sui }));
vi.mock("../../../cron/dex-liquidity/solana/dlmm-shadow", () => ({ collectDlmmShadowQuotes: runners.meteora }));
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
  runners.raydium.mockImplementation(async () => { order.push("raydium"); return { persisted: 1, scoreEligible: false }; });
  runners.sui.mockImplementation(async () => { order.push("sui"); return { persisted: 1, scoreEligible: false }; });
  runners.meteora.mockImplementation(async () => { order.push("meteora"); return { persisted: 1, scoreEligible: false }; });
  const pending = runHalfHourlyMeasuredExecutionSlot({ db: {}, chainRpcs: new Map() } as ScheduledRuntimeContext);
  await Promise.resolve();
  expect(order).toEqual(["evm-start"]);
  release({ status: "degraded", itemCount: 2, metadata: JSON.stringify({ measuredCount: 2 }) });
  await pending;
  const result = runners.result!;
  expect(order).toEqual(["evm-start", "orca", "raydium", "sui", "meteora"]);
  expect(result).toMatchObject({ status: "degraded", itemCount: 2 });
  expect(JSON.parse(result.metadata!)).toEqual({
    measuredCount: 2,
    orcaShadow: { persisted: 1, scoreEligible: false },
    raydiumShadow: { persisted: 1, scoreEligible: false },
    suiShadow: { persisted: 1, scoreEligible: false },
    meteoraShadow: { persisted: 1, scoreEligible: false },
  });
});

it("retains active quote results when the diagnostic Sui pass fails", async () => {
  runners.evm.mockResolvedValue({ status: "ok", itemCount: 3, metadata: JSON.stringify({ measuredCount: 3 }) });
  runners.orca.mockResolvedValue({ persisted: 0, scoreEligible: false });
  runners.raydium.mockResolvedValue({ persisted: 0, scoreEligible: false });
  runners.sui.mockRejectedValue(new Error("sui-archive-response-failed"));
  runners.meteora.mockResolvedValue({ persisted: 1, scoreEligible: false });
  await runHalfHourlyMeasuredExecutionSlot({ db: {}, chainRpcs: new Map() } as ScheduledRuntimeContext);
  expect(runners.result).toMatchObject({ status: "ok", itemCount: 3 });
  expect(JSON.parse(runners.result!.metadata!)).toMatchObject({
    measuredCount: 3,
    suiShadow: { error: "sui-archive-response-failed", scoreEligible: false },
    meteoraShadow: { persisted: 1, scoreEligible: false },
  });
});

it("retains active quote results and Sui diagnostics when the Meteora pass fails", async () => {
  runners.evm.mockResolvedValue({ status: "ok", itemCount: 3, metadata: JSON.stringify({ measuredCount: 3 }) });
  runners.orca.mockResolvedValue({ persisted: 0, scoreEligible: false });
  runners.raydium.mockResolvedValue({ persisted: 0, scoreEligible: false });
  runners.sui.mockResolvedValue({ persisted: 1, scoreEligible: false });
  runners.meteora.mockRejectedValue(new Error("dlmm-native-inspection-failed"));
  await runHalfHourlyMeasuredExecutionSlot({ db: {}, chainRpcs: new Map() } as ScheduledRuntimeContext);
  expect(runners.result).toMatchObject({ status: "ok", itemCount: 3 });
  expect(JSON.parse(runners.result!.metadata!)).toMatchObject({
    measuredCount: 3,
    suiShadow: { persisted: 1, scoreEligible: false },
    meteoraShadow: { error: "dlmm-native-inspection-failed", scoreEligible: false },
  });
});

describe("half-hourly measured execution lane settlement", () => {
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
