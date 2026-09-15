import { encodeAbiParameters } from "viem/utils";
import { afterEach, describe, expect, it, vi } from "vitest";
import source from "@shared/data/stablecoins/coins/cusd-celo.json";
import type { LiveReserveAdapterParamsByKey } from "@shared/lib/live-reserve-adapters";
import { fetchMentoRedemptionMetadata } from "../mento-redemption";
import { fetchOnchainMulticall3, fetchOnchainUint256 } from "../helpers";
import { pinnedBlockPlan } from "../evm-observation-plan";

vi.mock("../helpers", async (original) => ({
  ...await original<typeof import("../helpers")>(),
  fetchOnchainMulticall3: vi.fn(),
  fetchOnchainUint256: vi.fn(),
}));
vi.mock("../evm-observation-plan", () => ({ pinnedBlockPlan: vi.fn() }));
const config = source.liveReservesConfig.params.redemption as NonNullable<LiveReserveAdapterParamsByKey["mento"]["redemption"]>;
const pools = source.liveReservesConfig.params.redemption.pools;
const self = source.liveReservesConfig.params.redemption.selfTokenAddress;
const uint = (n: bigint) => encodeAbiParameters([{ type: "uint256" }], [n]);
const address = (a: string) => encodeAbiParameters([{ type: "address" }], [a as `0x${string}`]);
const limits = (decimals: number, bound = 500_000n * 10n ** 15n, flow = 0n) => encodeAbiParameters(
  [{ type: "int120" }, { type: "int120" }, { type: "uint8" }, { type: "uint32" }, { type: "uint32" }, { type: "int96" }, { type: "int96" }],
  [bound, bound * 2n, decimals, 1, 1, flow, flow],
);
function setup(change: Record<string, `0x${string}` | null> = {}) {
  const observedBlock = { chain: "celo", number: 123, timestamp: 1789431241 };
  vi.mocked(pinnedBlockPlan).mockResolvedValue({ observedBlock, ctx: { observedBlock } });
  vi.mocked(fetchOnchainMulticall3).mockImplementation(async ({ calls }) => {
    const index = calls[0].contract.toLowerCase() === pools[0].poolAddress ? 0 : 1;
    const output = pools[index].counterAsset.address;
    const data: Record<string, `0x${string}` | null> = {
      token0: address(index === 0 ? self : output), token1: address(index === 0 ? output : self),
      reserves: encodeAbiParameters([{ type: "uint256" }, { type: "uint256" }, { type: "uint256" }], [1_000_000_000n, 1_000_000_000n, 1n]),
      balance: uint(1_000_000_000n), inputBalance: uint(1_000_000_000n), decimals: uint(6n), lp: uint(1n), protocol: uint(1n),
      inputLimits: limits(18), outputLimits: limits(6), unitQuote: uint(999800n * 10n ** 6n), ...change,
    };
    return calls.map(({ label }) => ({ label, success: data[label] != null, returnData: data[label] ?? "0x" }));
  });
  vi.mocked(fetchOnchainUint256).mockResolvedValue(999_999_999n);
}
afterEach(() => vi.resetAllMocks());
describe("USDm V3 output pools", () => {
  it("sums distinct six-decimal outputs below inventory, checks both directions at one block", async () => {
    setup();
    const result = await fetchMentoRedemptionMetadata(config, new AbortController().signal, undefined);
    expect(result.redemption).toMatchObject({ capacityUsd: 1999.999998, feeBps: 2, routeStatus: "open" });
    expect(pinnedBlockPlan).toHaveBeenCalledTimes(1);
    for (const [options] of vi.mocked(fetchOnchainMulticall3).mock.calls) expect(options.ctx?.observedBlock?.number).toBe(123);
    for (const [options] of vi.mocked(fetchOnchainUint256).mock.calls) expect(options.ctx?.observedBlock?.number).toBe(123);
  });
  it.each([
    ["token mismatch", { token1: address(self) }],
    ["unsynchronized input", { inputBalance: uint(1_000_000_001n) }],
    ["unsynchronized output", { balance: uint(1_000_000_001n) }],
    ["missing fee", { lp: null }],
    ["wrong decimals", { decimals: uint(18n) }],
    ["no inventory", { balance: uint(0n) }],
    ["oracle failure", { unitQuote: null }],
    ["output limit", { outputLimits: limits(6, 100n * 10n ** 15n) }],
    ["input limit", { inputLimits: limits(18, 100n * 10n ** 15n) }],
    ["unreset flow consumes headroom", { outputLimits: limits(6, 2000n * 10n ** 15n, -1500n * 10n ** 15n) }],
  ] as const)("fails closed for %s", async (_label, change) => {
    setup(change);
    await expect(fetchMentoRedemptionMetadata(config, new AbortController().signal, undefined)).rejects.toThrow();
  });
  it("rejects a zero input reserve even when its balance matches", async () => {
    setup({
      inputBalance: uint(0n),
      reserves: encodeAbiParameters(
        [{ type: "uint256" }, { type: "uint256" }, { type: "uint256" }],
        [0n, 1_000_000_000n, 1n],
      ),
    });
    await expect(fetchMentoRedemptionMetadata(config, new AbortController().signal, undefined)).rejects.toThrow("empty input reserve");
  });
  it("rejects duplicate pools before any RPC", async () => {
    setup();
    await expect(fetchMentoRedemptionMetadata({ ...config, pools: [pools[0], pools[0]] } as typeof config, new AbortController().signal, undefined)).rejects.toThrow("duplicate");
    expect(pinnedBlockPlan).not.toHaveBeenCalled();
  });
  it("rejects an actual quote above the output reserve", async () => {
    setup();
    vi.mocked(fetchOnchainUint256).mockResolvedValue(1_000_000_000n);
    await expect(fetchMentoRedemptionMetadata(config, new AbortController().signal, undefined)).rejects.toThrow("quote");
  });
  it("rejects a failed final quote rather than admitting partial inventory", async () => {
    setup();
    vi.mocked(fetchOnchainUint256).mockResolvedValueOnce(999_999_999n).mockResolvedValueOnce(null);
    await expect(fetchMentoRedemptionMetadata(config, new AbortController().signal, undefined)).rejects.toThrow("quote");
  });
});
