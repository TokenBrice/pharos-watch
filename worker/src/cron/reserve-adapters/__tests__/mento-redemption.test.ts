import { encodeAbiParameters } from "viem/utils";
import { afterEach, describe, expect, it, vi } from "vitest";
import source from "@shared/data/stablecoins/coins/cusd-celo.json";
import gbpmSource from "@shared/data/stablecoins/coins/gbpm-mento.json";
import type { LiveReserveAdapterParamsByKey } from "@shared/lib/live-reserve-adapters";
import {
  mentoSpreadToFeeBps,
  MENTO_POOL_SPREAD_FIXIDITY_SCALE,
  MENTO_GET_EXCHANGE_IDS_SELECTOR,
  MENTO_POOL_EXCHANGE_ABI_PARAMETERS,
} from "@shared/lib/mento-contracts";
import { fetchMentoRedemptionMetadata } from "../mento-redemption";
import { fetchErc20TotalSupply, fetchOnchainMulticall3, fetchOnchainRateBps, fetchOnchainRawCall, fetchOnchainUint256 } from "../helpers";
import type { AdapterContext } from "../types";
import { pinnedBlockPlan } from "../evm-observation-plan";
import type * as HelpersModule from "../helpers";
import type * as ObservationPlanModule from "../evm-observation-plan";

vi.mock("../helpers", async (original) => ({
  ...await original<typeof HelpersModule>(),
  fetchOnchainMulticall3: vi.fn(),
  fetchOnchainUint256: vi.fn(),
  fetchOnchainRawCall: vi.fn(),
  fetchOnchainRateBps: vi.fn(),
  fetchErc20TotalSupply: vi.fn(),
}));
vi.mock("../evm-observation-plan", async (original) => ({
  ...await original<typeof ObservationPlanModule>(),
  pinnedBlockPlan: vi.fn(),
}));
type RedemptionParams = NonNullable<LiveReserveAdapterParamsByKey["mento"]["redemption"]>;
const config = source.liveReservesConfig.params.redemption as Extract<RedemptionParams, { kind: "fpmm-pools" }>;
const liquity = gbpmSource.liveReservesConfig.params.redemption as Extract<RedemptionParams, { kind: "liquity-v2-cr" }>;
const pools = source.liveReservesConfig.params.redemption.pools;
const self = source.liveReservesConfig.params.redemption.selfTokenAddress;
const uint = (n: bigint) => encodeAbiParameters([{ type: "uint256" }], [n]);
const address = (a: string) => encodeAbiParameters([{ type: "address" }], [a as `0x${string}`]);
const limits = (decimals: number, bound = 500_000n * 10n ** 15n, flow = 0n) => encodeAbiParameters(
  [{ type: "int120" }, { type: "int120" }, { type: "uint8" }, { type: "uint32" }, { type: "uint32" }, { type: "int96" }, { type: "int96" }],
  [bound, bound * 2n, decimals, 1, 1, flow, flow],
);
const observedBlock = { chain: "celo", number: 123, timestamp: 1789431241 };
function setupPlan() {
  vi.mocked(pinnedBlockPlan).mockImplementation(async ({ ctx }) => {
    const block = ctx?.observedBlock ?? observedBlock;
    return { observedBlock: block, ctx: { ...ctx, observedBlock: block } };
  });
}
function setup(change: Partial<Record<string, `0x${string}` | null>> = {}, outputReserve = 1_000_000_000n) {
  setupPlan();
  vi.mocked(fetchOnchainMulticall3).mockImplementation(async ({ calls }) => {
    const index = calls[0].contract.toLowerCase() === pools[0].poolAddress ? 0 : 1;
    const output = pools[index].counterAsset.address;
    const data: Partial<Record<string, `0x${string}` | null>> = {
      token0: address(index === 0 ? self : output), token1: address(index === 0 ? output : self),
      reserves: encodeAbiParameters(
        [{ type: "uint256" }, { type: "uint256" }, { type: "uint256" }],
        index === 0 ? [1_000_000_000n, outputReserve, 1n] : [outputReserve, 1_000_000_000n, 1n],
      ),
      balance: uint(outputReserve), inputBalance: uint(1_000_000_000n), decimals: uint(6n), inputDecimals: uint(18n), lp: uint(1n), protocol: uint(1n),
      inputLimits: limits(18), outputLimits: limits(6), unitQuote: uint(999800n * 10n ** 6n), ...change,
    };
    return calls.map(({ label }) => ({ label, success: data[label] != null, returnData: data[label] ?? "0x" }));
  });
  vi.mocked(fetchOnchainUint256).mockResolvedValue(999_999_999n);
}
afterEach(() => vi.resetAllMocks());
describe("Mento spread fee conversion", () => {
  it("preserves fractional basis points", () => {
    expect(mentoSpreadToFeeBps(MENTO_POOL_SPREAD_FIXIDITY_SCALE / 4_000n)).toBe(2.5);
    expect(mentoSpreadToFeeBps(MENTO_POOL_SPREAD_FIXIDITY_SCALE / 25_000n)).toBe(0.4);
  });
});
describe("USDm V3 output pools", () => {
  it("sums distinct six-decimal outputs below inventory, checks both directions at one block", async () => {
    setup();
    const result = await fetchMentoRedemptionMetadata(config, new AbortController().signal, undefined);
    expect(result.redemption).toMatchObject({
      capacityUsd: 1999.999998, feeBps: 2, routeStatus: "open",
      blockNumber: observedBlock.number, sourceTimestamp: observedBlock.timestamp,
    });
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
    ["wrong input decimals", { inputDecimals: uint(6n) }],
    ["wrong output-limit decimals", { outputLimits: limits(18) }],
    ["wrong input-limit decimals", { inputLimits: limits(6) }],
    ["malformed uint", { unitQuote: "0x01" }],
    ["malformed reserves", { reserves: "0x01" }],
    ["malformed limits", { inputLimits: "0x01" }],
    ["no inventory", { balance: uint(0n) }],
    ["oracle failure", { unitQuote: null }],
    ["zero oracle quote", { unitQuote: uint(0n) }],
    ["excessive fee", { lp: uint(200n), protocol: uint(1n) }],
    ["output limit", { outputLimits: limits(6, 100n * 10n ** 15n) }],
    ["input limit", { inputLimits: limits(18, 100n * 10n ** 15n) }],
    ["unreset flow consumes headroom", { outputLimits: limits(6, 2000n * 10n ** 15n, -1500n * 10n ** 15n) }],
  ] as const)("fails closed for %s", async (_label, change) => {
    setup(change);
    await expect(fetchMentoRedemptionMetadata(config, new AbortController().signal, undefined)).rejects.toThrow();
  });
  it("names a measured FX market closure without emitting reserve-based capacity", async () => {
    setup();
    const implementation = vi.mocked(fetchOnchainMulticall3).getMockImplementation()!;
    vi.mocked(fetchOnchainMulticall3).mockImplementation(async (options) => {
      const rows = await implementation(options);
      return rows?.map((row) => row.label === "unitQuote"
        ? { ...row, success: false, returnData: "0xa407143a" as const }
        : row) ?? null;
    });
    await expect(fetchMentoRedemptionMetadata(config, new AbortController().signal, undefined))
      .rejects.toThrow("fx-market-closed");
    expect(fetchOnchainUint256).not.toHaveBeenCalled();
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
  it("retains a successful zero executable quote rather than treating it as unreadable", async () => {
    setup();
    vi.mocked(fetchOnchainUint256).mockResolvedValue(0n);
    const result = await fetchMentoRedemptionMetadata(config, new AbortController().signal, undefined);
    expect(result.redemption).toMatchObject({
      capacityUsd: 0, routeStatus: "open", blockNumber: observedBlock.number, sourceTimestamp: observedBlock.timestamp,
    });
  });
  it.each([0n, 1n])("retains verified zero strict output inventory (%s) only with complete guards", async (inventory) => {
    setup({}, inventory);
    const result = await fetchMentoRedemptionMetadata(config, new AbortController().signal, undefined);
    expect(result.redemption?.capacityUsd).toBe(0);
    expect(fetchOnchainUint256).not.toHaveBeenCalled();
  });
  it.each([
    { unitQuote: null },
    { unitQuote: uint(0n) },
    { inputDecimals: uint(6n) },
    { inputLimits: limits(6) },
    { lp: null },
    { token1: address(self) },
  ] as const)("does not turn zero inventory with incomplete guards into observed zero (%s)", async (change) => {
    setup(change, 0n);
    await expect(fetchMentoRedemptionMetadata(config, new AbortController().signal, undefined)).rejects.toThrow();
  });
  it("rejects a rounded-to-zero input rather than claiming a measured zero", async () => {
    setup({ unitQuote: uint(10n ** 70n) });
    await expect(fetchMentoRedemptionMetadata(config, new AbortController().signal, undefined)).rejects.toThrow("quote");
    expect(fetchOnchainUint256).not.toHaveBeenCalled();
  });
  it.each(["duplicate", "unknown", "missing"] as const)("rejects %s labeled results instead of trusting a partial pool", async (shape) => {
    setup();
    const implementation = vi.mocked(fetchOnchainMulticall3).getMockImplementation()!;
    vi.mocked(fetchOnchainMulticall3).mockImplementation(async (options) => {
      const rows = (await implementation(options))!;
      if (shape === "missing") return rows.slice(1);
      return rows.map((row, index) => index === 0
        ? { ...row, label: shape === "duplicate" ? rows[1].label : "unknown" }
        : row);
    });
    await expect(fetchMentoRedemptionMetadata(config, new AbortController().signal, undefined)).rejects.toThrow();
  });
});

describe("Mento Liquity branch guards", () => {
  function setupLiquity(shutdown: string | null = uint(0n), debt: bigint | null = 500n * 10n ** 18n, fee: number | null = 50) {
    setupPlan();
    vi.mocked(fetchOnchainUint256).mockResolvedValue(debt);
    vi.mocked(fetchOnchainRawCall).mockResolvedValue(shutdown);
    vi.mocked(fetchErc20TotalSupply).mockResolvedValue(1000n * 10n ** 18n);
    vi.mocked(fetchOnchainRateBps).mockResolvedValue(fee);
  }
  it("binds debt, guard, supply and fee to the source block and clock", async () => {
    setupLiquity();
    const result = await fetchMentoRedemptionMetadata(liquity, new AbortController().signal, undefined);
    expect(result.redemption).toMatchObject({
      capacityRatioOfSupply: 0.5, feeBps: 50, routeStatus: "open",
      blockNumber: observedBlock.number, sourceTimestamp: observedBlock.timestamp,
    });
    expect(pinnedBlockPlan).toHaveBeenCalledTimes(1);
    expect(vi.mocked(fetchOnchainUint256).mock.calls[0][0].ctx?.observedBlock).toEqual(observedBlock);
    expect(vi.mocked(fetchOnchainRawCall).mock.calls[0][0].ctx?.observedBlock).toEqual(observedBlock);
    expect(vi.mocked(fetchErc20TotalSupply).mock.calls[0][3]?.observedBlock).toEqual(observedBlock);
    expect(vi.mocked(fetchOnchainRateBps).mock.calls[0][3]?.observedBlock).toEqual(observedBlock);
  });
  it.each([null, "0x", "0x00", `${uint(0n)}00`, `0x${"g".repeat(64)}`])(
    "withholds positive debt when the shutdown guard is unreadable or malformed (%s)", async (shutdown) => {
      setupLiquity(shutdown);
      await expect(fetchMentoRedemptionMetadata(liquity, new AbortController().signal, undefined)).rejects.toThrow();
    },
  );
  it("withholds telemetry on a failed shutdown guard transport", async () => {
    setupLiquity();
    vi.mocked(fetchOnchainRawCall).mockRejectedValue(new Error("RPC guard failure"));
    await expect(fetchMentoRedemptionMetadata(liquity, new AbortController().signal, undefined)).rejects.toThrow();
  });
  it("keeps measured shutdown adverse and bounds its executable capacity to zero", async () => {
    setupLiquity(uint(BigInt(observedBlock.timestamp)));
    const result = await fetchMentoRedemptionMetadata(liquity, new AbortController().signal, undefined);
    expect(result.redemption).toMatchObject({
      capacityRatioOfSupply: 0, routeStatus: "degraded", routeStatusSource: "onchain",
      blockNumber: observedBlock.number, sourceTimestamp: observedBlock.timestamp,
    });
  });
  it("preserves a measured zero debt only with a readable open guard", async () => {
    setupLiquity(uint(0n), 0n);
    const result = await fetchMentoRedemptionMetadata(liquity, new AbortController().signal, undefined);
    expect(result.redemption).toMatchObject({ capacityRatioOfSupply: 0, routeStatus: "open" });
    vi.mocked(fetchOnchainRawCall).mockResolvedValue(null);
    await expect(fetchMentoRedemptionMetadata(liquity, new AbortController().signal, undefined)).rejects.toThrow();
  });
  it("retains independently proven capacity without assigning a missing fee zero cost", async () => {
    setupLiquity(uint(0n), 500n * 10n ** 18n, null);
    const result = await fetchMentoRedemptionMetadata(liquity, new AbortController().signal, undefined);
    expect(result.redemption?.capacityRatioOfSupply).toBe(0.5);
    expect(result.redemption?.feeBps).toBeUndefined();
  });
  it.each([null, 0n])("rejects unavailable/nonpositive supply (%s), not measured zero capacity", async (supply) => {
    setupLiquity();
    vi.mocked(fetchErc20TotalSupply).mockResolvedValue(supply);
    await expect(fetchMentoRedemptionMetadata(liquity, new AbortController().signal, undefined)).rejects.toThrow();
  });
});

describe("Mento Broker anchored inventory", () => {
  const broker: Extract<RedemptionParams, { kind: "broker-pool" }> = {
    kind: "broker-pool",
    pools: [{ selfTokenAddress: self, counterAsset: { address: pools[0].counterAsset.address } }],
  };
  const exchangeId = `0x${"11".repeat(32)}` as const;
  const zeroAddress = "0x0000000000000000000000000000000000000000";
  function poolExchange(capacity: bigint) {
    return encodeAbiParameters(MENTO_POOL_EXCHANGE_ABI_PARAMETERS, [{
      asset0: self as `0x${string}`, asset1: pools[0].counterAsset.address as `0x${string}`,
      pricingModule: zeroAddress, bucket0: 100n * 10n ** 18n, bucket1: capacity, lastBucketUpdate: 0n,
      config: {
        spread: 5n * 10n ** 20n, referenceRateFeedID: zeroAddress,
        referenceRateResetFrequency: 0n, minimumReports: 0n, stablePoolResetSize: 0n,
      },
    }]);
  }
  function setupBroker(capacity: bigint | null) {
    setupPlan();
    vi.mocked(fetchOnchainRawCall).mockImplementation(async ({ data }) =>
      data === MENTO_GET_EXCHANGE_IDS_SELECTOR
        ? encodeAbiParameters([{ type: "bytes32[]" }], [[exchangeId]])
        : capacity == null ? null : poolExchange(capacity),
    );
  }
  it.each([0n, 100n * 10n ** 18n])("retains fully matched inventory including measured zero (%s) at one pin", async (capacity) => {
    setupBroker(capacity);
    const result = await fetchMentoRedemptionMetadata(broker, new AbortController().signal, undefined);
    expect(result.redemption).toMatchObject({
      capacityUsd: Number(capacity / 10n ** 18n), feeBps: 5, routeStatus: "open",
      blockNumber: observedBlock.number, sourceTimestamp: observedBlock.timestamp,
    });
    expect(pinnedBlockPlan).toHaveBeenCalledTimes(1);
    for (const [options] of vi.mocked(fetchOnchainRawCall).mock.calls) {
      expect(options.ctx?.observedBlock).toEqual(observedBlock);
    }
  });
  it("does not equate an unreadable matching pool with observed zero", async () => {
    setupBroker(null);
    await expect(fetchMentoRedemptionMetadata(broker, new AbortController().signal, undefined)).rejects.toThrow();
  });
  it("withholds a partial configured output scope instead of publishing its readable subset", async () => {
    setupBroker(100n * 10n ** 18n);
    const partial = { ...broker, pools: [
      ...broker.pools,
      { selfTokenAddress: self, counterAsset: { address: pools[1].counterAsset.address } },
    ] };
    await expect(fetchMentoRedemptionMetadata(partial, new AbortController().signal, undefined)).rejects.toThrow();
  });
  it("reuses identical-anchor inventory but reads a changed block rather than inheriting cached capacity", async () => {
    setupBroker(100n * 10n ** 18n);
    const ctx: AdapterContext = { requestCache: new Map(), observedBlock };
    const signal = new AbortController().signal;
    const first = await fetchMentoRedemptionMetadata(broker, signal, ctx);
    setupBroker(200n * 10n ** 18n);
    const same = await fetchMentoRedemptionMetadata(broker, signal, ctx);
    const nextBlock = { ...observedBlock, number: observedBlock.number + 1, timestamp: observedBlock.timestamp + 1 };
    const next = await fetchMentoRedemptionMetadata(broker, signal, { ...ctx, observedBlock: nextBlock });
    expect(first.redemption?.capacityUsd).toBe(100);
    expect(same.redemption?.capacityUsd).toBe(100);
    expect(next.redemption).toMatchObject({
      capacityUsd: 200, blockNumber: nextBlock.number, sourceTimestamp: nextBlock.timestamp,
    });
  });
  it.each([broker, liquity, config])("withholds every branch when its source anchor fails (%s)", async (params) => {
    setupBroker(100n * 10n ** 18n);
    vi.mocked(pinnedBlockPlan).mockRejectedValue(new Error("missing numbered header"));
    await expect(fetchMentoRedemptionMetadata(params, new AbortController().signal, undefined)).rejects.toThrow();
    expect(fetchOnchainRawCall).not.toHaveBeenCalled();
    expect(fetchOnchainMulticall3).not.toHaveBeenCalled();
    expect(fetchOnchainUint256).not.toHaveBeenCalled();
  });
});
