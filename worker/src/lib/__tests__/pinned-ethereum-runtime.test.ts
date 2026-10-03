import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { keccak256 } from "viem/utils";
import { fetchPinnedEthereumRuntime } from "../authoritative-price-sources/pinned-ethereum-runtime";
import type { LivePriceContext } from "../authoritative-price-sources/helpers";

const { blockNumber, blockHeader, rpcBatch } = vi.hoisted(() => ({
  blockNumber: vi.fn(), blockHeader: vi.fn(), rpcBatch: vi.fn(),
}));
vi.mock("../evm-rpc", () => ({
  fetchEvmBlockNumber: blockNumber, fetchEvmBlockHeader: blockHeader, fetchEvmRpcBatch: rpcBatch,
}));

const NOW = 1_790_981_071;
const CODE = "0x6000";
const REVIEWED_RUNTIME = [["0x0000000000000000000000000000000000000001", keccak256(CODE)]] as const;
const context: LivePriceContext = { assetsById: new Map() };
const reject = vi.fn((_reason: string): null => null);

beforeEach(() => {
  vi.useFakeTimers(); vi.setSystemTime(NOW * 1000);
  blockNumber.mockResolvedValue(42);
  blockHeader.mockResolvedValue({ number: 42, hash: "0xabc", timestamp: NOW - 299 });
  rpcBatch.mockResolvedValue([CODE]);
});
afterEach(() => { vi.useRealTimers(); vi.resetAllMocks(); });

describe("pinned Ethereum runtime contract", () => {
  it("admits reviewed runtime at the last fresh second and pins its block identity", async () => {
    const pinned = await fetchPinnedEthereumRuntime(context, REVIEWED_RUNTIME, reject);
    expect(pinned).toMatchObject({ block: 42, tag: "0x2a", head: { hash: "0xabc", timestamp: NOW - 299 } });
    expect(reject).not.toHaveBeenCalled();
  });
  it.each([NOW - 300, NOW + 1])("rejects an invalid block timestamp %s before reading runtime", async (timestamp) => {
    blockHeader.mockResolvedValue({ number: 42, hash: "0xabc", timestamp });
    expect(await fetchPinnedEthereumRuntime(context, REVIEWED_RUNTIME, reject)).toBeNull();
    expect(reject).toHaveBeenCalledWith("block-age");
    expect(rpcBatch).not.toHaveBeenCalled();
  });
  it("rejects a missing block number without attempting pinned reads", async () => {
    blockNumber.mockResolvedValue(null);
    expect(await fetchPinnedEthereumRuntime(context, REVIEWED_RUNTIME, reject)).toBeNull();
    expect(reject).toHaveBeenCalledWith("block-unavailable");
    expect(blockHeader).not.toHaveBeenCalled();
  });
  it.each([null, [], ["0x6001"], ["0x1"], ["0xzz"], [1]])("rejects unavailable, changed or malformed runtime %j", async (codes) => {
    rpcBatch.mockResolvedValue(codes);
    expect(await fetchPinnedEthereumRuntime(context, REVIEWED_RUNTIME, reject)).toBeNull();
    expect(reject).toHaveBeenCalledWith("runtime-code");
  });
  it("propagates cancellation rather than accepting reviewed runtime", async () => {
    const controller = new AbortController(); controller.abort();
    await expect(fetchPinnedEthereumRuntime(context, REVIEWED_RUNTIME, reject, controller.signal)).rejects.toThrow();
    expect(reject).not.toHaveBeenCalled();
  });
});
