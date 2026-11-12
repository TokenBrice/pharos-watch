import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TRACKED_META_BY_ID } from "@shared/lib/stablecoins/registry";
import { fetchCuratedAggregateOnChainMcap } from "../onchain-supply";

const readers = vi.hoisted(() => ({
  evm: vi.fn(), solana: vi.fn(), stellar: vi.fn(), noble: vi.fn(), sui: vi.fn(), aptos: vi.fn(), starknet: vi.fn(),
}));
vi.mock("../stellar-supply", () => ({ fetchStellarSupply: readers.stellar }));
vi.mock("../noble-supply", () => ({ fetchNobleSupply: readers.noble }));
vi.mock("../usdy-sui-supply", () => ({ fetchUsdySuiSupply: readers.sui }));
vi.mock("../usdy-aptos-supply", () => ({ fetchAptosSupply: readers.aptos }));
vi.mock("../../../reserve-adapters/helpers", () => ({
  fetchErc20TotalSupply: readers.evm, fetchStarknetTotalSupply: readers.starknet,
  probeTrackedTokenSupply: (_meta: unknown, input: { kind: string }) => input.kind === "onchain-solana" ? readers.solana() : readers.evm(input),
}));
vi.mock("../../../../lib/chain-observation", () => ({ fetchSolanaTokenSupply: readers.solana }));
beforeEach(() => {
  vi.clearAllMocks();
  for (const [family, reader] of Object.entries(readers)) reader.mockResolvedValue(family === "noble" ? 10n ** 18n : 10n ** 6n);
  vi.spyOn(console, "info").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());
describe.each([["usdy-ondo-finance", 12, 7], ["buidl-blackrock", 10, 8]] as const)("%s native supply dispatch", (id, count, evmCount) => {
  const meta = TRACKED_META_BY_ID.get(id)!;
  beforeEach(() => { readers.evm.mockImplementation(async (input: { chain: string }) =>
    10n ** BigInt(meta.contracts!.find(c => c.chain === input.chain)!.decimals!)); });
  it("sums complete stock with the oldest clock", async () => {
    vi.spyOn(Date, "now").mockReturnValueOnce(20_000).mockReturnValueOnce(10_000).mockReturnValue(20_000);
    readers.stellar.mockResolvedValue(10n ** 7n);
    const result = await fetchCuratedAggregateOnChainMcap(meta, 1.2);
    expect(result?.mcap).toBeCloseTo(count * 1.2);
    expect(result?.observedAt).toBe(10);
    expect(result).toMatchObject({
      chainCirculating: id === "usdy-ondo-finance" ? { Noble: { current: 1.2 }, Stellar: { current: 1.2 } } : { Ethereum: { current: 2.4 } },
    });
    expect(readers.evm).toHaveBeenCalledTimes(evmCount);
    for (const family of ["noble", "stellar", "sui", "aptos", "solana"] as const) expect(readers[family]).toHaveBeenCalledTimes(Number(meta.contracts!.some(c => c.chain === family)));
  });
  it.each((["evm", "solana", "stellar", "noble", "sui", "aptos"] as const).filter(f => f === "evm" || meta.contracts!.some(c => c.chain === f)))("withholds the whole aggregate on an unreadable %s leg", async (family) => {
    if (id === "buidl-blackrock") {
      readers[family].mockResolvedValueOnce(0n);
      expect(await fetchCuratedAggregateOnChainMcap(meta, 1.2)).toBeNull();
    }
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
