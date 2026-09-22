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
const POOL = "0xffdf1e3160b60c2e499fa25e51b5c192b9b15e3b", FACTORY = "0x420dd381b31aef6683db6b902084cb0ffece40da";
const encode = (types: string, values: readonly unknown[]) => encodeAbiParameters(parseAbiParameters(types), values);
const uint = (n: bigint) => encode("uint256", [n]);
const bool = (x: boolean) => encode("bool", [x]);
const address = (x: string) => encode("address", [x]);
function context() { return { assetsById: new Map([["usdc-circle", { id: "usdc-circle", price: 1, priceSource: "coingecko", priceConfidence: "single-source", priceObservedAt: Math.floor(Date.now() / 1000) - 20, priceObservedAtMode: "upstream" } as PeggedAsset]]) }; }
function fixture(overrides: Record<string, `0x${string}`> = {}) {
  const values = { token0: address(BD), token1: address(USDC), factory: address(FACTORY), pool: address(POOL),
    stable: bool(true), registered: bool(true), paused: bool(false), outputPaused: bool(false), outputBlocked: bool(false),
    inputDecimals: uint(18n), outputDecimals: uint(6n), fee: uint(5n),
    reserves: encode("uint256,uint256,uint256", [120_000n * UNIT, 88_000n * 10n ** 6n, 1n]),
    inputBalance: uint(120_000n * UNIT), outputBalance: uint(88_000n * 10n ** 6n),
    small: uint(991_030n), depth: uint(990_263_417n), ...overrides };
  multicall.mockImplementation(async (_chain, calls) => calls.map((call: { label: string }) => ({ label: call.label, success: true, returnData: values[call.label as keyof typeof values] })));
}
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date("2026-09-22T18:30:00Z")); rpcBatch.mockResolvedValue(reviewedRuntime.map((entry) => entry.code)); blockNumber.mockResolvedValue(1); blockHeader.mockResolvedValue({ hash: "0xabc", timestamp: Math.floor(Date.now() / 1000) - 5 }); fixture(); });
afterEach(() => { vi.useRealTimers(); vi.resetAllMocks(); });
describe("BD guarded Aerodrome quote", () => {
  it("publishes fresh fee-inclusive quotes without elevating evidence authority", async () => {
    expect(bdAerodromeProvider.matches("bd-basedollar")).toBe(true);
    expect(bdAerodromeProvider.matches("usdc-circle")).toBe(false);
    expect(await fetchBdAerodromePrice(context())).toMatchObject({ price: 0.99103, source: "aerodrome-exact", confidence: "fallback", observedAtMode: "upstream", observedAt: Math.floor(Date.now() / 1000) - 20 });
  });
  it.each<Record<string, `0x${string}`>>([
    { token0: address(USDC) }, { stable: bool(false) }, { registered: bool(false) }, { pool: address(BD) },
    { paused: bool(true) }, { outputPaused: bool(true) }, { outputBlocked: bool(true) }, { fee: uint(201n) },
    { outputBalance: uint(0n) }, { inputDecimals: uint(6n) }, { small: uint(0n) }, { depth: uint(900_000_000n) },
    { token1: "0x" as `0x${string}` },
  ])("rejects invalid identity, executable inventory, or quotes: %s", async (overrides) => {
    fixture(overrides); expect(await fetchBdAerodromePrice(context())).toBeNull();
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
  it("keeps severe-downside publication guarded while admitting the fresh ordinary quote", () => {
    const run = (price: number) => {
      const asset = { id: "bd-basedollar", symbol: "BD", name: "Base Dollar", price: null, pegType: "peggedUSD" } as unknown as PeggedAsset;
      const applied = applyProtocolPriceOverrides({ assets: [asset], overrides: new Map([[asset.id, { price, source: "aerodrome-exact", confidence: "fallback" as const, observedAt: Math.floor(Date.now() / 1000) - 5, observedAtMode: "upstream" as const }]]), validationContexts: createValidationContextResolver(), syncStartSec: Math.floor(Date.now() / 1000) });
      return applied;
    };
    expect(run(0.99103)).toBe(1); expect(run(0.2)).toBe(0);
  });
});
