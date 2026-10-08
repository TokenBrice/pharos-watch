import { beforeEach, describe, expect, it, vi } from "vitest";

import type { CronProgressReporter, CronResult } from "../../../lib/cron-logger";
import { runHalfHourlyMeasuredExecutionSlot, runSupplementalMeasuredExecutionSlot, settleMeasuredExecutionLane } from "../half-hourly-measured-execution";
import type { ScheduledRuntimeContext } from "../context";

const runners = vi.hoisted(() => ({ evm: vi.fn(), orca: vi.fn(), raydium: vi.fn(), native: vi.fn(), sui: vi.fn(), result: null as CronResult | null }));
vi.mock("../../../cron/measured-execution/sync", () => ({ syncDexMeasuredExecution: runners.evm }));
vi.mock("../../../cron/dex-liquidity/solana/whirlpool-shadow", () => ({ collectWhirlpoolShadowQuotes: runners.orca, collectRaydiumShadowQuotes: runners.raydium }));
vi.mock("../../../cron/dex-liquidity/sui/shadow", () => ({ collectSuiClmmShadowQuotes: runners.sui }));
vi.mock("../../../cron/measured-execution/join", () => ({ loadNativeDexExecutionDiagnostic: runners.native }));
vi.mock("../slot-groups", () => ({
  runSingleScheduledJob: async (_runtime: unknown, _label: string, job: { run: (signal: AbortSignal, progress?: CronProgressReporter) => Promise<CronResult> }) => {
    runners.result = await job.run(new AbortController().signal);
    return {};
  },
}));

beforeEach(() => {
  runners.native.mockImplementation(async ({ profileId }) => ({ profileId, status: "current", scoreEligible: false }));
});

it("awaits the EVM lane before collecting isolated shadow evidence and preserves EVM status", async () => {
  const order: string[] = [];
  let release!: (result: CronResult) => void;
  runners.evm.mockImplementation(() => new Promise<CronResult>((resolve) => { order.push("evm-start"); release = resolve; }));
  runners.orca.mockImplementation(async () => { order.push("orca"); return { persisted: 1, scoreEligible: false }; });
  runners.raydium.mockImplementation(async () => { order.push("raydium"); return { persisted: 1, scoreEligible: false }; });
  runners.sui.mockImplementation(async () => { order.push("sui"); return { persisted: 1, scoreEligible: false }; });
  const pending = runHalfHourlyMeasuredExecutionSlot({ db: {}, chainRpcs: new Map(), invocationId: "native-owner", jobAttemptNo: 2 } as ScheduledRuntimeContext);
  await Promise.resolve();
  expect(order).toEqual(["evm-start"]);
  release({ status: "degraded", itemCount: 2, metadata: JSON.stringify({ measuredCount: 2 }) });
  await pending;
  const result = runners.result!;
  expect(order).toEqual(["evm-start", "orca", "raydium", "sui"]);
  expect(result).toMatchObject({ status: "degraded", itemCount: 2 });
  expect(JSON.parse(result.metadata!)).toEqual({
    measuredCount: 2,
    orcaShadow: { persisted: 1, scoreEligible: false },
    raydiumShadow: { persisted: 1, scoreEligible: false },
    suiShadow: { persisted: 1, scoreEligible: false },
    nativeDiagnostics: [
      { profileId: "orca-whirlpool-exact-v1", status: "current", scoreEligible: false },
      { profileId: "raydium-clmm-exact-v1", status: "current", scoreEligible: false },
    ],
  });
  expect(runners.orca).toHaveBeenCalledWith(expect.objectContaining({ publisherInvocationId: "native-owner", publisherAttemptNo: 2 }));
  expect(runners.raydium).toHaveBeenCalledWith(expect.objectContaining({ publisherInvocationId: "native-owner", publisherAttemptNo: 2 }));
  expect(runners.native.mock.calls.map(([input]) => input.profileId)).toEqual(["orca-whirlpool-exact-v1", "raydium-clmm-exact-v1"]);
});

it("retains active quote results when the diagnostic Sui pass fails", async () => {
  runners.evm.mockResolvedValue({ status: "ok", itemCount: 3, metadata: JSON.stringify({ measuredCount: 3 }) });
  runners.orca.mockResolvedValue({ persisted: 0, scoreEligible: false });
  runners.raydium.mockResolvedValue({ persisted: 0, scoreEligible: false });
  runners.sui.mockRejectedValue(new Error("sui-archive-response-failed"));
  await runHalfHourlyMeasuredExecutionSlot({ db: {}, chainRpcs: new Map() } as ScheduledRuntimeContext);
  expect(runners.result).toMatchObject({ status: "ok", itemCount: 3 });
  expect(JSON.parse(runners.result!.metadata!)).toMatchObject({
    measuredCount: 3,
    suiShadow: { error: "sui-archive-response-failed", scoreEligible: false },
  });
});

it("adds an active EVM opportunity without repeating the native diagnostics", async () => {
  vi.clearAllMocks();
  const evmResult = { status: "ok", itemCount: 3, metadata: JSON.stringify({ measuredCount: 3 }) };
  runners.evm.mockResolvedValue(evmResult);
  const runtime = { db: {}, chainRpcs: new Map() } as ScheduledRuntimeContext;
  await runSupplementalMeasuredExecutionSlot(runtime);
  expect(runners.result).toEqual(evmResult);
  expect(runners.evm).toHaveBeenCalledWith(
    runtime.db, runtime.chainRpcs, expect.any(AbortSignal), undefined, "halfHourlyMeasuredExecutionSupplemental",
  );
  expect(runners.orca).not.toHaveBeenCalled();
  expect(runners.raydium).not.toHaveBeenCalled();
  expect(runners.sui).not.toHaveBeenCalled();
  expect(runners.native).not.toHaveBeenCalled();
});

it("records supplemental EVM failure without starting native collectors", async () => {
  vi.clearAllMocks();
  runners.evm.mockRejectedValue(new Error("supplemental-rpc-failed"));
  await runSupplementalMeasuredExecutionSlot({ db: {}, chainRpcs: new Map() } as ScheduledRuntimeContext);
  expect(runners.result).toMatchObject({ status: "error", itemCount: 0 });
  expect(JSON.parse(runners.result!.metadata!)).toEqual({ lane: "evm", error: "supplemental-rpc-failed" });
  expect(runners.orca).not.toHaveBeenCalled();
  expect(runners.raydium).not.toHaveBeenCalled();
  expect(runners.sui).not.toHaveBeenCalled();
  expect(runners.native).not.toHaveBeenCalled();
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
