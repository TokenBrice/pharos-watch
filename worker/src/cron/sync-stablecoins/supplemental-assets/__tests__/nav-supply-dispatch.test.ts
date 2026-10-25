import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TRACKED_META_BY_ID } from "@shared/lib/stablecoins/registry";
import { fetchCuratedAggregateOnChainMcap } from "../onchain-supply";

const readers = vi.hoisted(() => ({
  evm: vi.fn(), solana: vi.fn(), stellar: vi.fn(), noble: vi.fn(), sui: vi.fn(), aptos: vi.fn(), starknet: vi.fn(),
}));
vi.mock("../stellar-supply", () => ({ fetchStellarSupply: readers.stellar }));
vi.mock("../noble-supply", () => ({ fetchNobleSupply: readers.noble }));
vi.mock("../usdy-sui-supply", () => ({ fetchUsdySuiSupply: readers.sui }));
vi.mock("../usdy-aptos-supply", () => ({ fetchUsdyAptosSupply: readers.aptos }));
vi.mock("../../../reserve-adapters/helpers", () => ({
  fetchErc20TotalSupply: readers.evm, fetchSolanaTokenSupply: readers.solana, fetchStarknetTotalSupply: readers.starknet,
}));
beforeEach(() => {
  vi.clearAllMocks();
  for (const [family, reader] of Object.entries(readers)) reader.mockResolvedValue(family === "noble" ? 10n ** 18n : 10n ** 6n);
  readers.evm.mockImplementation(async (input: { chain: string }) => input.chain === "tempo" ? 10n ** 6n : 10n ** 18n);
  vi.spyOn(console, "info").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());
describe("USDY complete native supply dispatch", () => {
  const meta = TRACKED_META_BY_ID.get("usdy-ondo-finance")!;
  it("sums twelve native stocks once and never reads the three IBC representations", async () => {
    readers.stellar.mockResolvedValue(10n ** 7n);
    const result = await fetchCuratedAggregateOnChainMcap(meta, 1.2);
    expect(result?.mcap).toBeCloseTo(14.4);
    expect(result).toMatchObject({
      chainCirculating: { Noble: { current: 1.2 }, Stellar: { current: 1.2 } },
    });
    expect(readers.evm).toHaveBeenCalledTimes(7);
    for (const family of ["noble", "stellar", "sui", "aptos", "solana"] as const) expect(readers[family]).toHaveBeenCalledTimes(1);
  });
  it.each(["stellar", "noble", "sui", "aptos"] as const)("withholds the whole aggregate on an unreadable %s leg", async (family) => {
    readers[family].mockRejectedValue(new Error("unreadable"));
    expect(await fetchCuratedAggregateOnChainMcap(meta, 1.2)).toBeNull();
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('"reason":"supply-probe-failed"'));
  });
  it("propagates cancellation", async () => {
    const controller = new AbortController(); controller.abort(new Error("cancelled"));
    await expect(fetchCuratedAggregateOnChainMcap(meta, 1.2, undefined, controller.signal)).rejects.toThrow("cancelled");
    expect(readers.evm).not.toHaveBeenCalled();
  });
});
