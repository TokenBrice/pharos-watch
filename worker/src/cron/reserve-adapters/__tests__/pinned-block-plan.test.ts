import { beforeEach, describe, expect, it, vi } from "vitest";
import type * as Rpc from "../../../lib/evm-rpc";

vi.mock("../../../lib/evm-rpc", async (importOriginal) => ({
  ...await importOriginal<typeof Rpc>(),
  fetchEvmBlockNumber: vi.fn(),
  fetchEvmBlockHeaderAtTag: vi.fn(),
  fetchEvmMulticall3Aggregate3AtBlock: vi.fn(),
  fetchEvmUint256AtBlock: vi.fn(),
  fetchEvmStorageAtBlock: vi.fn(),
}));

import { fetchEvmBlockNumber, fetchEvmBlockHeaderAtTag, fetchEvmMulticall3Aggregate3AtBlock, fetchEvmStorageAtBlock, fetchEvmUint256AtBlock } from "../../../lib/evm-rpc";
import { pinnedBlockPlan } from "../evm-observation-plan";
import { fetchOnchainMulticall3, makeOnchainCallers } from "../onchain";
import { EIP1967_IMPLEMENTATION_SLOT, readImplementationSlotAddress } from "../onchain-identity";

const chain = "ethereum";
const contract = "0x0000000000000000000000000000000000000001";
const calls = [{ label: "quantity", contract, data: "0x18160ddd" }];

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(fetchEvmBlockHeaderAtTag).mockResolvedValue({
    number: 100, timestamp: 1_800_000_000, hash: `0x${"11".repeat(32)}`,
  });
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
    expect(plan.ctx).not.toHaveProperty("recentStatePin");
    for (const [, , , , options] of vi.mocked(fetchEvmUint256AtBlock).mock.calls) {
      expect(options?.recentStatePin).toBeUndefined();
    }
    for (const [, , , options] of vi.mocked(fetchEvmMulticall3Aggregate3AtBlock).mock.calls) {
      expect(options?.recentStatePin).toBeUndefined();
    }
    expect(fetchEvmBlockNumber).not.toHaveBeenCalled();
    expect(fetchEvmBlockHeaderAtTag).toHaveBeenCalledTimes(1);
    expect(fetchEvmBlockHeaderAtTag).toHaveBeenCalledWith(chain, "latest", expect.objectContaining({ signal }));
  });

  it("reads implementation identity at the retained chain-local pin without claiming finality", async () => {
    vi.mocked(fetchEvmStorageAtBlock).mockResolvedValue(`0x${"0".repeat(63)}1`);
    const observedBlock = { chain, number: 77, timestamp: 1_700_000_000 };
    const plan = await pinnedBlockPlan({ chain, signal: new AbortController().signal, ctx: { observedBlock } });
    const implementation = await readImplementationSlotAddress({
      adapterKey: "test", input: { kind: "onchain-evm", chain, rpcMode: "public-rpc" }, contractAddress: contract,
      params: {}, signal: new AbortController().signal, ctx: plan.ctx,
    });
    expect(implementation).toBe(contract);
    expect(plan.observedBlock).toBe(observedBlock);
    expect(fetchEvmBlockHeaderAtTag).not.toHaveBeenCalled();
    expect(fetchEvmStorageAtBlock).toHaveBeenCalledWith(
      chain, contract, EIP1967_IMPLEMENTATION_SLOT, 77, expect.objectContaining({ timeoutMs: 10_000 }),
    );
    expect(vi.mocked(fetchEvmStorageAtBlock).mock.calls[0][4]?.recentStatePin).toBeUndefined();
  });

  it.each([
    [{}, /requires a pinned block/],
    [{ observedBlock: { chain: "arbitrum", number: 100, timestamp: 1_800_000_000 } }, /does not match ethereum/],
  ] as const)("rejects missing or foreign implementation pins before storage access (%j)", async (ctx, reason) => {
    await expect(readImplementationSlotAddress({
      adapterKey: "test", input: { kind: "onchain-evm", chain, rpcMode: "public-rpc" }, contractAddress: contract,
      params: {}, signal: new AbortController().signal, ctx,
    })).rejects.toThrow(reason);
    expect(fetchEvmStorageAtBlock).not.toHaveBeenCalled();
  });

  it("fails closed when the anchor header cannot be established", async () => {
    vi.mocked(fetchEvmBlockHeaderAtTag).mockResolvedValue(null);
    await expect(pinnedBlockPlan({ chain, signal: new AbortController().signal })).rejects.toThrow(/observation block header/);
    expect(fetchEvmMulticall3Aggregate3AtBlock).not.toHaveBeenCalled();
  });
});
