import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../evm-rpc", () => ({
  fetchEvmBlockNumber: vi.fn(),
  fetchEvmBlockTimestamp: vi.fn(),
  fetchEvmCallHexAtBlock: vi.fn(),
}));

import { fetchCurveOracleEma } from "../curve-onchain";
import { fetchEvmBlockNumber, fetchEvmBlockTimestamp, fetchEvmCallHexAtBlock } from "../evm-rpc";

describe("fetchCurveOracleEma", () => {
  beforeEach(() => {
    vi.mocked(fetchEvmBlockNumber).mockReset();
    vi.mocked(fetchEvmBlockTimestamp).mockReset();
    vi.mocked(fetchEvmCallHexAtBlock).mockReset();
  });

  it("returns price + block metadata when all calls succeed", async () => {
    vi.mocked(fetchEvmBlockNumber).mockResolvedValue(200);
    vi.mocked(fetchEvmBlockTimestamp).mockResolvedValue(1_700_000_000);
    vi.mocked(fetchEvmCallHexAtBlock).mockResolvedValue(
      ("0x" + (BigInt(1) * BigInt(1e18)).toString(16).padStart(64, "0")) as `0x${string}`,
    );
    const result = await fetchCurveOracleEma("ethereum", "0xaa", "0xbb", new Map());
    expect(result).toEqual({ price: 1, blockNumber: 200, blockTimestamp: 1_700_000_000 });
  });

  it("returns null when parsed price >= 10 (sanity bound)", async () => {
    vi.mocked(fetchEvmBlockNumber).mockResolvedValue(200);
    vi.mocked(fetchEvmBlockTimestamp).mockResolvedValue(1_700_000_000);
    vi.mocked(fetchEvmCallHexAtBlock).mockResolvedValue(
      ("0x" + (BigInt(10_000) * BigInt(1e18)).toString(16).padStart(64, "0")) as `0x${string}`,
    );
    const result = await fetchCurveOracleEma("ethereum", "0xaa", "0xbb", new Map());
    expect(result).toBeNull();
  });

  it("returns null when block number unavailable", async () => {
    vi.mocked(fetchEvmBlockNumber).mockResolvedValue(null);
    const result = await fetchCurveOracleEma("ethereum", "0xaa", "0xbb", new Map());
    expect(result).toBeNull();
  });
});
