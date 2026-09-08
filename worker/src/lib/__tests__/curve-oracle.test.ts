import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../evm-rpc", () => ({
  fetchEvmBlockNumber: vi.fn(),
  fetchEvmBlockTimestamp: vi.fn(),
  fetchEvmCallHexAtBlock: vi.fn(),
  fetchEvmUint256AtBlock: vi.fn(),
}));

import { fetchCurveOracleEma } from "../curve-onchain";
import { fetchEvmBlockNumber, fetchEvmBlockTimestamp, fetchEvmUint256AtBlock } from "../evm-rpc";

describe("fetchCurveOracleEma", () => {
  beforeEach(() => {
    vi.mocked(fetchEvmBlockNumber).mockReset();
    vi.mocked(fetchEvmBlockTimestamp).mockReset();
    vi.mocked(fetchEvmUint256AtBlock).mockReset();
  });

  it("returns price + block metadata when all calls succeed", async () => {
    vi.mocked(fetchEvmBlockNumber).mockResolvedValue(200);
    vi.mocked(fetchEvmBlockTimestamp).mockResolvedValue(1_700_000_000);
    vi.mocked(fetchEvmUint256AtBlock).mockResolvedValue(BigInt(1) * BigInt(1e18));
    const result = await fetchCurveOracleEma("ethereum", "0xaa", "0xbb", new Map());
    expect(result).toEqual({ price: 1, blockNumber: 200, blockTimestamp: 1_700_000_000 });
  });

  it("rejects the exact EMA bounds and missing RPC values", async () => {
    vi.mocked(fetchEvmBlockNumber).mockResolvedValue(200);
    for (const [raw, timestamp] of [
      [10n * 10n ** 18n, 1_700_000_000],
      [0n, 1_700_000_000],
      [null, 1_700_000_000],
      [10n ** 18n, null],
    ] as const) {
      vi.mocked(fetchEvmUint256AtBlock).mockResolvedValue(raw);
      vi.mocked(fetchEvmBlockTimestamp).mockResolvedValue(timestamp);
      expect(await fetchCurveOracleEma("ethereum", "0xaa", "0xbb", new Map())).toBeNull();
    }
  });

  it("accepts an EMA price just below the upper bound", async () => {
    vi.mocked(fetchEvmBlockNumber).mockResolvedValue(200);
    vi.mocked(fetchEvmBlockTimestamp).mockResolvedValue(1_700_000_000);
    vi.mocked(fetchEvmUint256AtBlock).mockResolvedValue(9_999_000_000_000_000_000n);
    const result = await fetchCurveOracleEma("ethereum", "0xaa", "0xbb", new Map());
    expect(result).toEqual({ price: 9.999, blockNumber: 200, blockTimestamp: 1_700_000_000 });
  });

  it("returns null when block number unavailable", async () => {
    vi.mocked(fetchEvmBlockNumber).mockResolvedValue(null);
    const result = await fetchCurveOracleEma("ethereum", "0xaa", "0xbb", new Map());
    expect(result).toBeNull();
  });
});
