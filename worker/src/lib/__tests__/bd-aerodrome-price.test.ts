import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { encodeAbiParameters, parseAbiParameters } from "viem/utils";
import type { PeggedAsset } from "../../cron/sync-stablecoins/enrich-prices-shared";
const blockNumber = vi.fn(), blockHeader = vi.fn(), multicall = vi.fn(), rpcBatch = vi.fn();
vi.mock("../evm-rpc", () => ({ fetchEvmRpcBatch: (...args: unknown[]) => rpcBatch(...args), fetchEvmBlockNumber: (...args: unknown[]) => blockNumber(...args),
  fetchEvmBlockHeader: (...args: unknown[]) => blockHeader(...args),
  fetchEvmMulticall3Aggregate3AtBlock: (...args: unknown[]) => multicall(...args) }));
import { fetchBdAerodromePrice, bdAerodromeProvider } from "../authoritative-price-sources/bd-aerodrome";
import { applyProtocolPriceOverrides, createValidationContextResolver } from "../../cron/sync-stablecoins/pricing";
import reviewedRuntime from "./fixtures/bd-aerodrome-runtime.json";
const UNIT = 10n ** 18n;
const BD = "0x252d36f435582ecb01686448d21e8c9ea0b2ca65", USDC = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";
const POOL = "0x11cc6f32930c20e3cfb01fc35bd37ed20d3ed82f", FACTORY = "0x78589e876edcebdce72ee3436ab3c9ad3a7cef2d";
const FEE_MODULE = "0x0195fc76da986d66b2a468133a1be41e90893da6";
const V2_STABLE = "0x56325f535441424c450000000000000000000000000000000000000000000000";
const encode = (types: string, values: readonly unknown[]) => encodeAbiParameters(parseAbiParameters(types), values);
const uint = (n: bigint) => encode("uint256", [n]);
const bool = (x: boolean) => encode("bool", [x]);
const fee = (bps: bigint, toxic = false) => encode("uint256,uint256,bool", [bps, 0n, toxic]);
const address = (x: string) => encode("address", [x]);
function context() { return { assetsById: new Map([["usdc-circle", { id: "usdc-circle", price: 1, priceSource: "coingecko", priceConfidence: "single-source", priceObservedAt: Math.floor(Date.now() / 1000) - 20, priceObservedAtMode: "upstream" } as PeggedAsset]]) }; }
function fixture(overrides: Record<string, `0x${string}`> = {}) {
  const values = { token0: address(BD), token1: address(USDC), factory: address(FACTORY), pool: address(POOL),
    poolType: V2_STABLE as `0x${string}`, registered: bool(true), paused: bool(false), outputPaused: bool(false), outputBlocked: bool(false),
    inputDecimals: uint(18n), outputDecimals: uint(6n), feeModule: address(FEE_MODULE),
    smallFee: fee(5n), depthFee: fee(5n),
    reserves: encode("uint256,uint256,uint256", [120_000n * UNIT, 88_000n * 10n ** 6n, 1n]),
    inputBalance: uint(120_000n * UNIT), outputBalance: uint(88_000n * 10n ** 6n),
    small: uint(991_030n), depth: uint(990_263_417n), ...overrides };
  multicall.mockImplementation(async (_chain, calls) => calls.map((call: { label: string }) => ({ label: call.label, success: true, returnData: values[call.label as keyof typeof values] })));
}
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date("2026-09-22T18:30:00Z")); rpcBatch.mockResolvedValue(reviewedRuntime.map((entry) => entry.code)); blockNumber.mockResolvedValue(1); blockHeader.mockResolvedValue({ hash: "0xabc", timestamp: Math.floor(Date.now() / 1000) - 5 }); fixture(); });
afterEach(() => { vi.useRealTimers(); vi.resetAllMocks(); });
describe("BD guarded Aero quote", () => {
  it("publishes fresh fee-inclusive quotes without elevating evidence authority", async () => {
    expect(bdAerodromeProvider.matches("bd-basedollar")).toBe(true);
    expect(bdAerodromeProvider.matches("usdc-circle")).toBe(false);
    expect(await fetchBdAerodromePrice(context())).toMatchObject({ price: 0.99103, source: "aerodrome-exact", confidence: "fallback", observedAtMode: "upstream", observedAt: Math.floor(Date.now() / 1000) - 20 });
  });
  it.each<Record<string, `0x${string}`>>([
    { token0: address(USDC) }, { poolType: encode("bytes32", ["0x56325f564f4c4154494c45000000000000000000000000000000000000000000"]) },
    { registered: bool(false) }, { pool: address(BD) }, { feeModule: address(USDC) },
    { paused: bool(true) }, { outputPaused: bool(true) }, { outputBlocked: bool(true) }, { smallFee: fee(201n) },
    { depthFee: fee(150n, true) },
    { outputBalance: uint(0n) }, { inputDecimals: uint(6n) }, { small: uint(0n) }, { depth: uint(900_000_000n) },
    { token1: "0x" as `0x${string}` },
  ])("rejects invalid identity, executable inventory, or quotes: %s", async (overrides) => {
    fixture(overrides); expect(await fetchBdAerodromePrice(context())).toBeNull();
  });
  it("bounds the factory's effective fee at the pinned reserves for both quoted notionals", async () => {
    expect(await fetchBdAerodromePrice(context())).toMatchObject({ price: 0.99103 });
    const feeCalls = multicall.mock.calls[1]![1] as { label: string }[];
    expect(feeCalls.map((call) => call.label)).toEqual(["smallFee", "depthFee"]);
    expect(multicall.mock.calls[1]![2]).toBe(multicall.mock.calls[0]![2]);
  });
  it.each([null, ["0x"], ["0x1234", ...reviewedRuntime.slice(1).map((entry) => entry.code)]])("rejects missing or changed runtime code", async (codes) => {
    rpcBatch.mockResolvedValue(codes);
    expect(await fetchBdAerodromePrice(context())).toBeNull();
    expect(multicall).not.toHaveBeenCalled();
  });
  it("rejects stale parent and changed canonical block", async () => {
    const ctx = context(); ctx.assetsById.get("usdc-circle")!.priceObservedAt = Math.floor(Date.now() / 1000) - 301;
    expect(await fetchBdAerodromePrice(ctx)).toBeNull(); expect(multicall).not.toHaveBeenCalled();
    blockHeader.mockResolvedValueOnce({ hash: "0xa", timestamp: Math.floor(Date.now() / 1000) - 5 }).mockResolvedValueOnce({ hash: "0xb", timestamp: Math.floor(Date.now() / 1000) - 5 });
    expect(await fetchBdAerodromePrice(context())).toBeNull();
  });
  it.each([
    { assetFields: { id: "bd-basedollar", symbol: "BD", name: "Base Dollar" }, source: "aerodrome-exact",
      ordinaryPrice: 0.99103, nowMs: Date.parse("2026-09-22T18:30:00Z"), observationAge: 5 },
    { assetFields: { id: "usdaf-asymmetry", symbol: "USDaf" }, source: "uniswap-v4-exact",
      ordinaryPrice: 0.988425988054, nowMs: 1_790_117_350 * 1000, observationAge: 20 },
    { assetFields: { id: "usdu-universal", symbol: "USDU" }, source: "uniswap-v3-exact",
      ordinaryPrice: 1.000298588359182, nowMs: 1_790_981_071 * 1000, observationAge: 20 },
    { assetFields: { id: "usdv-solomon", symbol: "USDv" }, source: "jupiter-exact",
      ordinaryPrice: .998882, nowMs: 1790102400 * 1000, observationAge: 30 },
  ])("keeps $source severe-downside publication guarded while admitting the fresh ordinary quote", ({
    assetFields, source, ordinaryPrice, nowMs, observationAge,
  }) => {
    vi.setSystemTime(nowMs);
    const now = Math.floor(Date.now() / 1000);
    const run = (price: number) => {
      const asset = { ...assetFields, price: null, pegType: "peggedUSD" } as unknown as PeggedAsset;
      return applyProtocolPriceOverrides({ assets: [asset], overrides: new Map([[asset.id, { price, source, confidence: "fallback" as const, observedAt: now - observationAge, observedAtMode: "upstream" as const }]]), validationContexts: createValidationContextResolver(), syncStartSec: now });
    };
    expect(run(ordinaryPrice)).toBe(1); expect(run(0.2)).toBe(0);
  });
});
