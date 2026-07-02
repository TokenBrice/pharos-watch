import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../../lib/evm-rpc", () => ({
  fetchEvmUint256AtBlock: vi.fn(),
}));

import { fetchEvmUint256AtBlock } from "../../lib/evm-rpc";
import { fetchOndoUsdyOracleSource } from "../yield-sync/sources";

const mockEvmCall = vi.mocked(fetchEvmUint256AtBlock);

describe("fetchOndoUsdyOracleSource", () => {
  afterEach(() => { vi.restoreAllMocks(); });

  it("derives APY from USDY oracle price vs prior price", async () => {
    mockEvmCall.mockResolvedValue(1_085_000_000_000_000_000n);
    const result = await fetchOndoUsdyOracleSource(
      1.0835, 7, 1_771_000_000,
    );
    expect(result).toEqual(expect.objectContaining({
      dataSource: "protocol-api",
      sourceKey: "protocol-api:ondo-usdy-oracle",
    }));
    expect(result!.currentApy).toBeGreaterThan(0);
  });

  it("returns seed row when no prior price exists", async () => {
    mockEvmCall.mockResolvedValue(1_085_000_000_000_000_000n);
    const result = await fetchOndoUsdyOracleSource(null, 0, null);
    expect(result).toEqual(expect.objectContaining({
      currentApy: 0,
      exchangeRate: expect.closeTo(1.085, 2),
      sourceKey: "protocol-api:ondo-usdy-oracle",
    }));
  });

  it("returns null when oracle call fails", async () => {
    mockEvmCall.mockResolvedValue(null);
    const result = await fetchOndoUsdyOracleSource(null, 7, null);
    expect(result).toBeNull();
  });
});
