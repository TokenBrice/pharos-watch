import { beforeEach, describe, expect, it, vi } from "vitest";
import type { StablecoinMeta } from "@shared/types/core";
import type * as EvmRpc from "../../../../lib/evm-rpc";

const { header, uint256 } = vi.hoisted(() => ({ header: vi.fn(), uint256: vi.fn() }));
vi.mock("../../../../lib/evm-rpc", async (importOriginal) => ({
  ...(await importOriginal<typeof EvmRpc>()),
  fetchEvmBlockHeader: header,
  fetchEvmUint256AtBlock: uint256,
}));
import { fetchPinnedNativeShares } from "../onchain-supply";
import { DECIMALS_SELECTOR, TOTAL_SUPPLY_SELECTOR } from "../../../../lib/evm-selectors";

const coin: StablecoinMeta = {
  id: "jltxx-jpmorgan", symbol: "JLTXX", name: "JLTXX",
  flags: { backing: "rwa-backed", governance: "centralized", pegCurrency: "USD", yieldBearing: true, rwa: true, navToken: true },
  contracts: [{ chain: "ethereum", address: "0x09864f52b035ae22ee739dfa5c748fa080d07bd8", decimals: 2 }],
};
const block = { number: 100, hash: `0x${"a".repeat(64)}`, timestamp: Math.floor(Date.now() / 1000) - 900 };

describe("JLTXX native-share observation", () => {
  beforeEach(() => {
    header.mockReset().mockResolvedValue(block);
    uint256.mockReset().mockResolvedValueOnce(62_671_284_229n).mockResolvedValueOnce(2n);
  });

  it("retains the raw getter, actual decimals and canonical hash/time", async () => {
    expect(await fetchPinnedNativeShares(coin)).toEqual({
      chain: "ethereum", contractAddress: coin.contracts![0].address,
      rawShares: "62671284229", decimals: 2,
      blockNumber: 100, blockHash: block.hash, observedAt: block.timestamp,
    });
    expect(header).toHaveBeenNthCalledWith(1, "ethereum", "finalized", expect.any(Object));
    expect(header).toHaveBeenNthCalledWith(2, "ethereum", 100, expect.any(Object));
    for (const selector of [TOTAL_SUPPLY_SELECTOR, DECIMALS_SELECTOR]) {
      expect(uint256).toHaveBeenCalledWith("ethereum", coin.contracts![0].address, selector, 100,
        expect.objectContaining({ stateBlockHash: block.hash }));
    }
  });

  it.each([0n, null])("withholds unavailable or zero raw supply (%s)", async (raw) => {
    uint256.mockReset().mockResolvedValueOnce(raw).mockResolvedValueOnce(2n);
    expect(await fetchPinnedNativeShares(coin)).toBeNull();
  });

  it.each([18n, null])("requires observed decimals, not catalog substitution (%s)", async (decimals) => {
    uint256.mockReset().mockResolvedValueOnce(100n).mockResolvedValueOnce(decimals);
    expect(await fetchPinnedNativeShares(coin)).toBeNull();
  });

  it("rejects a reorg instead of combining incompatible reads", async () => {
    header.mockReset().mockResolvedValueOnce(block).mockResolvedValueOnce({ ...block, hash: `0x${"b".repeat(64)}` });
    expect(await fetchPinnedNativeShares(coin)).toBeNull();
  });

  it.each(["header", "supply", "decimals", "closing-header"] as const)(
    "withholds the complete share observation when the %s request throws",
    async (stage) => {
      const failure = new Error("RPC transport unavailable");
      if (stage === "header") header.mockReset().mockRejectedValue(failure);
      if (stage === "closing-header") header.mockReset().mockResolvedValueOnce(block).mockRejectedValueOnce(failure);
      if (stage === "supply") uint256.mockReset().mockRejectedValue(failure);
      if (stage === "decimals") uint256.mockReset().mockResolvedValueOnce(62_671_284_229n).mockRejectedValueOnce(failure);

      await expect(fetchPinnedNativeShares(coin)).resolves.toBeNull();
      expect(header).toHaveBeenCalledTimes(stage === "closing-header" ? 2 : 1);
      expect(uint256).toHaveBeenCalledTimes(stage === "header" ? 0 : stage === "supply" ? 1 : 2);
    },
  );

  it("propagates caller cancellation during a failed read instead of returning missing shares", async () => {
    const controller = new AbortController();
    const reason = new Error("sync cancelled");
    uint256.mockReset().mockImplementation(async () => {
      controller.abort(reason);
      throw new Error("transport closed");
    });

    await expect(fetchPinnedNativeShares(coin, undefined, controller.signal)).rejects.toBe(reason);
    expect(header).toHaveBeenCalledTimes(1);
    expect(uint256).toHaveBeenCalledTimes(1);
  });

  it.each([null, { ...block, timestamp: 0 }, { ...block, timestamp: Math.floor(Date.now() / 1000) + 3600 }, { ...block, timestamp: 1 }])(
    "withholds malformed, future or stale original block clocks (%s)", async (value) => {
      header.mockReset().mockResolvedValue(value);
      expect(await fetchPinnedNativeShares(coin)).toBeNull();
      expect(uint256).not.toHaveBeenCalled();
    },
  );

  it("rejects extra deployments and identity/decimal drift before making requests", async () => {
    for (const contracts of [
      [...coin.contracts!, ...coin.contracts!],
      [{ ...coin.contracts![0], address: `0x${"b".repeat(40)}` }],
      [{ ...coin.contracts![0], decimals: 18 }],
    ]) {
      expect(await fetchPinnedNativeShares({ ...coin, contracts })).toBeNull();
    }
    expect(header).not.toHaveBeenCalled();
  });
});
