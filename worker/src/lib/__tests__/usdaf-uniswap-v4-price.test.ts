import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { encodeAbiParameters, parseAbiParameters } from "viem/utils";
import type { PeggedAsset } from "../../cron/sync-stablecoins/enrich-prices-shared";
import type { LivePriceContext } from "../authoritative-price-sources/helpers";
import { isPublicImpactCircuitKey } from "@shared/lib/public-health";
import { TRACKED_META_BY_ID } from "@shared/lib/stablecoins/registry";
const blockNumber = vi.fn(), blockHeader = vi.fn(), rpcBatch = vi.fn();
vi.mock("../evm-rpc", () => ({ fetchEvmRpcBatch: (...args: unknown[]) => rpcBatch(...args),
  fetchEvmBlockNumber: (...args: unknown[]) => blockNumber(...args), fetchEvmBlockHeader: (...args: unknown[]) => blockHeader(...args) }));
import { fetchUsdafUniswapV4Price, usdafUniswapV4Provider } from "../authoritative-price-sources/usdaf-uniswap-v4";
import { applyProtocolPriceOverrides, createValidationContextResolver } from "../../cron/sync-stablecoins/pricing";
import reviewedRuntime from "./fixtures/usdaf-uniswap-v4-runtime.json";
const NOW = 1_790_117_350;
const encode = (types: string, values: readonly unknown[]) => encodeAbiParameters(parseAbiParameters(types), values);
function context(): LivePriceContext {
  return { assetsById: new Map([["usdt-tether", { id: "usdt-tether", price: 0.999914, priceSource: "coingecko", priceConfidence: "single-source",
    priceObservedAt: NOW - 20, priceObservedAtMode: "upstream" } as PeggedAsset]]) };
}
function fixture(options: { reserve0?: bigint; depth?: bigint; snapshotBlock?: bigint; paused?: bigint; decimals?: bigint } = {}) {
  const rows = [
    encode("uint256,uint256,uint256,uint256,uint256,uint256,uint160,int24,uint128,uint256,address,uint16,bool,uint8", [
      options.reserve0 ?? 59690168536518584288795n, 28940292033n, 0n, 0n, 0n, 0n, 78796397255653201970872n, -276434,
      2973670129869840919n, options.snapshotBlock ?? 1n, "0x0000000000000000000000000000000000000000", 0, false, 0,
    ]),
    encode("uint256,uint256", [988511n, 43041n]), encode("uint256,uint256", [options.depth ?? 988181911n, 43073n]),
    encode("uint256", [options.decimals ?? 18n]), encode("uint256", [6n]), encode("uint256", [options.paused ?? 0n]), encode("uint256", [0n]),
  ];
  rpcBatch.mockImplementation(async (_chain, calls) => calls[0].method === "eth_getCode" ? reviewedRuntime.map((r) => r.code) : rows);
}
beforeEach(() => {
  vi.useFakeTimers(); vi.setSystemTime(NOW * 1000);
  blockNumber.mockResolvedValue(1); blockHeader.mockResolvedValue({ hash: "0xabc", timestamp: NOW - 5 }); fixture();
});
afterEach(() => { vi.useRealTimers(); vi.resetAllMocks(); });

describe("USDaf exact Uniswap v4 recovery", () => {
  it("recovers the registered USDaf deployment with trusted USDT normalization and conservative provenance", async () => {
    expect(usdafUniswapV4Provider.matches("usdaf-asymmetry")).toBe(true);
    expect(usdafUniswapV4Provider.matches("usdt-tether")).toBe(false);
    expect(TRACKED_META_BY_ID.get("usdaf-asymmetry")?.contracts).toContainEqual(expect.objectContaining({
      chain: "ethereum", address: "0x9cf12ccd6020b6888e4d4c4e4c7aca33c1eb91f8", decimals: 18,
    }));
    expect(await fetchUsdafUniswapV4Price(context())).toMatchObject({ price: 0.988425988054, source: "uniswap-v4-exact",
      confidence: "fallback", observedAt: NOW - 20, observedAtMode: "upstream" });
    expect(isPublicImpactCircuitKey(usdafUniswapV4Provider.liveCircuitSource!)).toBe(false);
  });
  it.each([
    { options: { reserve0: 10_000n * 10n ** 18n }, reason: "tvl-floor" },
    { options: { depth: 900_000_000n }, reason: "quote-depth" },
    { options: { snapshotBlock: 2n }, reason: "pool-state" },
    { options: { paused: 1n }, reason: "execution-disabled" },
    { options: { decimals: 6n }, reason: "decimals" },
  ])("rejects $reason without relaxing the guard", async ({ options, reason }) => {
    fixture(options); const ctx = context();
    expect(await fetchUsdafUniswapV4Price(ctx)).toBeNull();
    expect(ctx.lastRejectionReason).toBe(`uniswap-v4-exact:${reason}`);
  });
  it("rejects changed runtime and malformed state instead of admitting a quote", async () => {
    rpcBatch.mockResolvedValue(["0x1234", ...reviewedRuntime.slice(1).map((r) => r.code)]);
    const ctx = context(); expect(await fetchUsdafUniswapV4Price(ctx)).toBeNull();
    expect(ctx.lastRejectionReason).toBe("uniswap-v4-exact:runtime-code");
    rpcBatch.mockResolvedValueOnce(reviewedRuntime.map((r) => r.code)).mockResolvedValueOnce(["0x"]);
    expect(await fetchUsdafUniswapV4Price(ctx)).toBeNull(); expect(ctx.lastRejectionReason).toBe("uniswap-v4-exact:state-unavailable");
  });
  it("rejects a stale parent, stale block and a reorganized block", async () => {
    const ctx = context(); ctx.assetsById.get("usdt-tether")!.priceObservedAt = NOW - 300;
    expect(await fetchUsdafUniswapV4Price(ctx)).toBeNull(); expect(rpcBatch).not.toHaveBeenCalled();
    blockHeader.mockResolvedValue({ hash: "0xabc", timestamp: NOW - 300 });
    expect(await fetchUsdafUniswapV4Price(context())).toBeNull();
    blockHeader.mockResolvedValueOnce({ hash: "0xa", timestamp: NOW - 5 }).mockResolvedValueOnce({ hash: "0xb", timestamp: NOW - 5 });
    expect(await fetchUsdafUniswapV4Price(context())).toBeNull();
  });
  it("never replaces a publishable incumbent", async () => {
    const asset = { id: "usdaf-asymmetry", price: 0.99, priceSource: "coingecko", priceObservedAt: NOW, priceObservedAtMode: "upstream" } as PeggedAsset;
    expect(await usdafUniswapV4Provider.fetchLivePrice?.(asset, context())).toBeNull(); expect(rpcBatch).not.toHaveBeenCalled();
  });
  it("admits the ordinary recovered price while retaining severe-downside publication protection", () => {
    for (const [price, expected] of [[0.988425988054, 1], [0.2, 0]]) {
      const asset = { id: "usdaf-asymmetry", symbol: "USDaf", price: null, pegType: "peggedUSD" } as unknown as PeggedAsset;
      expect(applyProtocolPriceOverrides({ assets: [asset], overrides: new Map([[asset.id, { price, source: "uniswap-v4-exact",
        confidence: "fallback", observedAt: NOW - 20, observedAtMode: "upstream" }]]), validationContexts: createValidationContextResolver(), syncStartSec: NOW })).toBe(expected);
    }
  });
});
