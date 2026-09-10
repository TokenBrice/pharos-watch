import { beforeEach, describe, expect, it, vi } from "vitest";
import type * as Rpc from "../../../lib/evm-rpc";

vi.mock("../../../lib/evm-rpc", async (importOriginal) => ({
  ...await importOriginal<typeof Rpc>(),
  fetchEvmBlockNumber: vi.fn(),
  fetchEvmBlockTimestamp: vi.fn(),
  fetchEvmMulticall3Aggregate3AtBlock: vi.fn(),
  fetchEvmUint256AtBlock: vi.fn(),
}));

import { fetchEvmBlockNumber, fetchEvmBlockTimestamp, fetchEvmMulticall3Aggregate3AtBlock, fetchEvmUint256AtBlock } from "../../../lib/evm-rpc";
import { pinnedBlockPlan } from "../evm-observation-plan";
import { fetchOnchainMulticall3, makeOnchainCallers } from "../onchain";
import { validateAdapterOutput } from "../validate";

const chain = "ethereum";
const contract = "0x0000000000000000000000000000000000000001";
const calls = [{ label: "quantity", contract, data: "0x18160ddd" }];

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(fetchEvmBlockNumber).mockResolvedValue(100);
  vi.mocked(fetchEvmBlockTimestamp).mockResolvedValue(1_800_000_000);
});

describe("pinnedBlockPlan", () => {
  it("keeps dependent waves and individual fallback values coherent while latest advances", async () => {
    let latest = 100;
    vi.mocked(fetchEvmMulticall3Aggregate3AtBlock).mockImplementation(async (_chain, entries, block) => {
      const value = block === "latest" || block === undefined ? latest++ : block;
      return entries.map((entry) => ({ label: entry.label, success: true, returnData: `0x${value.toString(16).padStart(64, "0")}` }));
    });
    vi.mocked(fetchEvmUint256AtBlock).mockImplementation(async (_chain, _contract, _data, block) => BigInt(block === "latest" || block === undefined ? latest++ : block));
    const signal = new AbortController().signal;
    // Reproduce the old independent-latest failure before exercising the binding.
    const oldFirst = await fetchOnchainMulticall3({ chain, calls, signal });
    const oldSecond = await fetchOnchainMulticall3({ chain, calls, signal });
    expect(oldFirst).not.toEqual(oldSecond);
    const plan = await pinnedBlockPlan({ chain, signal });
    const first = await fetchOnchainMulticall3({ chain, calls, signal, ctx: plan.ctx });
    const second = await fetchOnchainMulticall3({ chain, calls, signal, ctx: plan.ctx });
    expect(first).toEqual(second);
    expect(BigInt(first![0].returnData)).toBe(100n);
    const caller = makeOnchainCallers({ chain }, { signal, ctx: plan.ctx });
    expect(await caller.uint256(contract, calls[0].data)).toBe(100n);
    expect((await pinnedBlockPlan({ chain, signal, ctx: plan.ctx })).observedBlock).toEqual(plan.observedBlock);
    expect(fetchEvmBlockNumber).toHaveBeenCalledTimes(1);
    expect(fetchEvmBlockTimestamp).toHaveBeenCalledWith(chain, 100, expect.objectContaining({ signal }));
  });

  it("fails closed when the anchor timestamp cannot be established", async () => {
    vi.mocked(fetchEvmBlockTimestamp).mockResolvedValue(null);
    await expect(pinnedBlockPlan({ chain, signal: new AbortController().signal })).rejects.toThrow("observation block timestamp");
    expect(fetchEvmMulticall3Aggregate3AtBlock).not.toHaveBeenCalled();
  });

  it("reports block lag only above ten minutes without rejecting the snapshot", () => {
    const snapshot = { slices: [{ name: "Cash", pct: 100, risk: "very-low" as const }], metadata: { observedBlock: { chain, number: 100, timestamp: 1_800_000_000 } } };
    expect(validateAdapterOutput(snapshot, { now: 1_800_000_600 })).toEqual({ valid: true, warnings: [] });
    const lagged = validateAdapterOutput(snapshot, { now: 1_800_000_601 });
    expect(lagged.valid).toBe(true);
    expect(lagged.warnings).toEqual([expect.objectContaining({ code: "observed-block-lag", severity: "info" })]);
  });
});
