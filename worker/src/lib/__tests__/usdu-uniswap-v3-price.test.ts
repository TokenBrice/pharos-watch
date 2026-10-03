import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { encodeAbiParameters, parseAbiParameters } from "viem/utils";
import type { PeggedAsset } from "../../cron/sync-stablecoins/enrich-prices-shared";
import type { LivePriceContext } from "../authoritative-price-sources/helpers";
import { isPublicImpactCircuitKey } from "@shared/lib/public-health";
const blockNumber = vi.fn(), blockHeader = vi.fn(), rpcBatch = vi.fn();
vi.mock("../evm-rpc", () => ({ fetchEvmRpcBatch: (...args: unknown[]) => rpcBatch(...args),
  fetchEvmBlockNumber: (...args: unknown[]) => blockNumber(...args), fetchEvmBlockHeader: (...args: unknown[]) => blockHeader(...args) }));
import { fetchUsduUniswapV3Price, usduUniswapV3Provider } from "../authoritative-price-sources/usdu-uniswap-v3";
import { applyProtocolPriceOverrides, createValidationContextResolver } from "../../cron/sync-stablecoins/pricing";
import reviewedRuntime from "./fixtures/usdu-uniswap-v3-runtime.json";

const NOW = 1_790_981_071;
const USDU = "0xe4ca6596d2c28014c6f89964f57838e0be9f369b", USDT = "0xdac17f958d2ee523a2206206994597c13d831ec7";
const POOL = "0x30bc4854086128ebb69ee6e67e2a51a87a0b41b0", FACTORY = "0x1f98431c8ad98523631ae4a59f267346ea31f984";
const IMPLEMENTATION = "0x7df0b1f63e0a467b6aa95b4ed6d299dab9f73750";
const SQRT = 79202244840415053109981579744n;
const SMALL_SQRT = 79205237831673328560433859375n;
const DEPTH_SQRT = 79259423742864703010706301454n;
const encode = (types: string, values: readonly unknown[]) => encodeAbiParameters(parseAbiParameters(types), values);
function context(): LivePriceContext {
  return { assetsById: new Map([["usdt-tether", { id: "usdt-tether", price: 0.999782, priceSource: "coingecko", priceConfidence: "single-source",
    priceObservedAt: NOW - 20, priceObservedAtMode: "upstream" } as PeggedAsset]]) };
}
function fixture(overrides: Record<number, `0x${string}`> = {}) {
  const rows = [
    encode("address", [USDT]), encode("address", [USDU]), encode("address", [FACTORY]), encode("uint256", [100n]),
    encode("address", [POOL]), encode("address", [FACTORY]),
    encode("uint160,int24,uint16,uint16,uint16,uint8,bool", [SQRT, -7, 0, 1, 1, 68, true]), encode("uint256", [26468583721711n]),
    encode("uint256", [6n]), encode("uint256", [6n]),
    encode("bool", [false]), encode("bool", [false]), encode("bool", [false]), encode("bool", [false]), encode("bool", [false]),
    encode("address", ["0x91462fc34e6b1fda7675e3729eeb1e762f5ac80d"]),
    encode("uint256", [313574426051n]), encode("uint256", [448864134050n]),
    encode("uint256,uint160,uint32,uint256", [1000516701n, SMALL_SQRT, 0, 103297n]),
    encode("uint256,uint160,uint32,uint256", [99956810760n, DEPTH_SQRT, 1, 141976n]),
    encode("address", [IMPLEMENTATION]),
  ];
  for (const [index, value] of Object.entries(overrides)) rows[Number(index)] = value;
  rpcBatch.mockImplementation(async (_chain, calls) => calls[0].method === "eth_getCode" ? reviewedRuntime.map((r) => r.code) : rows);
}
beforeEach(() => {
  vi.useFakeTimers(); vi.setSystemTime(NOW * 1000);
  blockNumber.mockResolvedValue(26107704); blockHeader.mockResolvedValue({ hash: "0xabc", timestamp: NOW - 5 }); fixture();
});
afterEach(() => { vi.useRealTimers(); vi.resetAllMocks(); });

describe("Universal USD exact Uniswap v3 recovery", () => {
  it("normalizes the bounded executable sell quote with fresh tracked USDT and conservative provenance", async () => {
    const result = await fetchUsduUniswapV3Price(context());
    expect(result).toMatchObject({ source: "uniswap-v3-exact", confidence: "fallback", observedAt: NOW - 20, observedAtMode: "upstream" });
    expect(result?.price).toBeCloseTo(1.000298588359182, 12);
    expect(isPublicImpactCircuitKey(usduUniswapV3Provider.liveCircuitSource!)).toBe(false);
  });
  it("limits recovery to Universal USD rather than other USDU deployments", () => {
    expect(usduUniswapV3Provider.matches("usdu-universal")).toBe(true);
    expect(usduUniswapV3Provider.matches("usdu-unitas")).toBe(false);
    expect(usduUniswapV3Provider.matches("usdu-usdu-finance")).toBe(false);
  });
  it.each([
    { overrides: { 0: encode("address", [USDU]) }, reason: "identity" },
    { overrides: { 3: encode("uint256", [500n]) }, reason: "identity" },
    { overrides: { 4: encode("address", [USDU]) }, reason: "identity" },
    { overrides: { 8: encode("uint256", [18n]) }, reason: "identity" },
    { overrides: { 20: encode("address", [USDU]) }, reason: "identity" },
    { overrides: { 6: encode("uint160,int24,uint16,uint16,uint16,uint8,bool", [SQRT, -7, 0, 1, 1, 68, false]) }, reason: "pool-state" },
    { overrides: { 7: encode("uint256", [0n]) }, reason: "pool-state" },
    ...[10, 11, 12, 13, 14].map((index) => ({ overrides: { [index]: encode("bool", [true]) }, reason: "execution-disabled" })),
    { overrides: { 15: encode("address", ["0x0000000000000000000000000000000000000000"]) }, reason: "execution-disabled" },
    { overrides: { 16: encode("uint256", [9999n * 10n ** 6n]) }, reason: "inventory" },
    { overrides: { 17: encode("uint256", [99956810760n]) }, reason: "quote-depth" },
    { overrides: { 19: encode("uint256,uint160,uint32,uint256", [90000000000n, DEPTH_SQRT, 1, 140000n]) }, reason: "quote-depth" },
    { overrides: { 19: encode("uint256,uint160,uint32,uint256", [106000000000n, DEPTH_SQRT, 1, 140000n]) }, reason: "quote-depth" },
    { overrides: { 18: encode("uint256,uint160,uint32,uint256", [1000516701n, SQRT, 0, 100000n]) }, reason: "quote-depth" },
    { overrides: { 16: encode("uint256", [10000n * 10n ** 6n]), 17: encode("uint256", [30000n * 10n ** 6n]),
      18: encode("uint256,uint160,uint32,uint256", [200000000n, SMALL_SQRT, 0, 100000n]),
      19: encode("uint256,uint160,uint32,uint256", [20000000000n, DEPTH_SQRT, 1, 140000n]) }, reason: "tvl-floor" },
    { overrides: { 6: encode("uint256", [1n]) }, reason: "state-malformed" },
  ])("fails closed for $reason", async ({ overrides, reason }) => {
    fixture(overrides); const ctx = context();
    expect(await fetchUsduUniswapV3Price(ctx)).toBeNull();
    expect(ctx.lastRejectionReason).toBe(`uniswap-v3-exact:${reason}`);
  });
  it("rejects changed reviewed runtime and missing batch results", async () => {
    rpcBatch.mockResolvedValue(["0x1234", ...reviewedRuntime.slice(1).map((r) => r.code)]);
    const ctx = context(); expect(await fetchUsduUniswapV3Price(ctx)).toBeNull();
    expect(ctx.lastRejectionReason).toBe("uniswap-v3-exact:runtime-code");
    rpcBatch.mockResolvedValueOnce(reviewedRuntime.map((r) => r.code)).mockResolvedValueOnce(null);
    expect(await fetchUsduUniswapV3Price(ctx)).toBeNull(); expect(ctx.lastRejectionReason).toBe("uniswap-v3-exact:state-unavailable");
  });
  it.each([NOW - 300, NOW + 1])("rejects an invalid parent observation clock %s before RPC", async (observedAt) => {
    const ctx = context(); ctx.assetsById.get("usdt-tether")!.priceObservedAt = observedAt;
    expect(await fetchUsduUniswapV3Price(ctx)).toBeNull(); expect(rpcBatch).not.toHaveBeenCalled();
  });
  it("does not substitute nominal par when the tracked parent is missing", async () => {
    const ctx = context(); ctx.assetsById.clear(); expect(await fetchUsduUniswapV3Price(ctx)).toBeNull();
    expect(ctx.lastRejectionReason).toBe("uniswap-v3-exact:parent-unavailable"); expect(blockNumber).not.toHaveBeenCalled();
  });
  it.each([NOW - 300, NOW + 1])("rejects an invalid block clock %s", async (timestamp) => {
    blockHeader.mockResolvedValue({ hash: "0xabc", timestamp }); const ctx = context();
    expect(await fetchUsduUniswapV3Price(ctx)).toBeNull(); expect(ctx.lastRejectionReason).toBe("uniswap-v3-exact:block-age");
  });
  it("rejects a reorganized pinned block", async () => {
    blockHeader.mockResolvedValueOnce({ hash: "0xa", timestamp: NOW - 5 }).mockResolvedValueOnce({ hash: "0xb", timestamp: NOW - 5 });
    const ctx = context(); expect(await fetchUsduUniswapV3Price(ctx)).toBeNull(); expect(ctx.lastRejectionReason).toBe("uniswap-v3-exact:canonical-check");
  });
  it("expires a dependency that becomes stale during execution", async () => {
    blockHeader.mockResolvedValueOnce({ hash: "0xa", timestamp: NOW - 5 }).mockImplementationOnce(async () => {
      vi.setSystemTime((NOW + 280) * 1000); return { hash: "0xa", timestamp: NOW - 5 };
    });
    const ctx = context(); expect(await fetchUsduUniswapV3Price(ctx)).toBeNull(); expect(ctx.lastRejectionReason).toBe("uniswap-v3-exact:dependency-age");
  });
  it("propagates cancellation instead of returning a price", async () => {
    const controller = new AbortController(); controller.abort();
    await expect(fetchUsduUniswapV3Price(context(), controller.signal)).rejects.toThrow();
  });
  it("never replaces a publishable incumbent", async () => {
    const asset = { id: "usdu-universal", price: 1.001, priceSource: "coingecko", priceObservedAt: NOW, priceObservedAtMode: "upstream" } as PeggedAsset;
    expect(await usduUniswapV3Provider.fetchLivePrice?.(asset, context())).toBeNull(); expect(rpcBatch).not.toHaveBeenCalled();
  });
  it("admits a normal recovered quote but retains severe-downside publication protection", () => {
    for (const [price, expected] of [[1.000298588359182, 1], [0.2, 0]]) {
      const asset = { id: "usdu-universal", symbol: "USDU", price: null, pegType: "peggedUSD" } as unknown as PeggedAsset;
      expect(applyProtocolPriceOverrides({ assets: [asset], overrides: new Map([[asset.id, { price, source: "uniswap-v3-exact",
        confidence: "fallback", observedAt: NOW - 20, observedAtMode: "upstream" }]]), validationContexts: createValidationContextResolver(), syncStartSec: NOW })).toBe(expected);
    }
  });
});
