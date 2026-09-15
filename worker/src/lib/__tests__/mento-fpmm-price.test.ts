import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { encodeAbiParameters, parseAbiParameters } from "viem/utils";
import type { PeggedAsset } from "../../cron/sync-stablecoins/enrich-prices-shared";
const blockNumber = vi.fn();
const blockHeader = vi.fn();
const multicall = vi.fn();
const storage = vi.fn();
vi.mock("../evm-rpc", () => ({
  fetchEvmBlockNumber: (...args: unknown[]) => blockNumber(...args),
  fetchEvmBlockHeader: (...args: unknown[]) => blockHeader(...args),
  fetchEvmMulticall3Aggregate3AtBlock: (...args: unknown[]) => multicall(...args),
  fetchEvmStorageAtBlock: (...args: unknown[]) => storage(...args),
}));
import { fetchMentoFpmmPrice, mentoFpmmProvider } from "../authoritative-price-sources/mento-fpmm";
import { applyProtocolPriceOverrides, createValidationContextResolver } from "../../cron/sync-stablecoins/pricing";
const CHFM = "0xb55a79f398e759e43c95b979163f30ec87ee131d";
const USDM = "0x765de816845861e75a25fca122bb6898b8b1282a";
const UNIT = 10n ** 18n;
const encode = (types: string, values: readonly unknown[]) => encodeAbiParameters(parseAbiParameters(types), values);
const uint = (value: bigint) => encode("uint256", [value]);
const limits = (limit = 100_000n * 10n ** 15n, flow = 0n) =>
  encode("int120,int120,uint8,uint32,uint32,int96,int96", [limit, limit * 5n, 18, 0, 0, flow, flow]);
function context(overrides: Partial<PeggedAsset> = {}) {
  return { assetsById: new Map([["cusd-celo", {
    id: "cusd-celo", name: "USDm", symbol: "USDm", price: 1.01,
    priceSource: "coingecko", priceConfidence: "single-source",
    priceObservedAt: Math.floor(Date.now() / 1000) - 30, priceObservedAtMode: "upstream",
    ...overrides,
  } as PeggedAsset]]) };
}
function pool(overrides: Record<string, `0x${string}`> = {}) {
  const values = {
    token0: encode("address", [USDM]), token1: encode("address", [CHFM]),
    inputDecimals: uint(18n), outputDecimals: uint(18n),
    inputImplementation: encode("address", ["0x815795c30d0758a297b08cd4e0643620c974c318"]),
    outputImplementation: encode("address", ["0x815795c30d0758a297b08cd4e0643620c974c318"]),
    reserves: encode("uint256,uint256,uint256", [30_000n * UNIT, 25_000n * UNIT, 1n]),
    inputBalance: uint(25_000n * UNIT), outputBalance: uint(30_000n * UNIT),
    lpFee: uint(20n), protocolFee: uint(10n), feeRecipient: encode("address", [USDM]),
    inputLimits: limits(), outputLimits: limits(),
    smallQuote: uint(UNIT * 6n * 9970n / 50_000n), impactQuote: uint(100n * UNIT * 6n * 9970n / 50_000n),
    rate: encode("uint256,uint256,uint256,uint256,bool,uint16,uint256", [5n, 6n, 1n, 1n, false, 100, 1n]),
    ...overrides,
  };
  multicall.mockImplementation(async (_chain, calls) => calls.map(({ label }: { label: string }) => ({ label, returnData: values[label as keyof typeof values], success: true })));
}
describe("CHFm guarded FPMM price", () => {
  afterEach(() => vi.restoreAllMocks());
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(Date, "now").mockReturnValue(1_800_000_000_000);
    blockNumber.mockResolvedValue(77580896);
    storage.mockResolvedValue("0x0000000000000000000000008cb0518a0510ab62450f79f3cd9ee0cbddb77f30");
    blockHeader.mockReset().mockResolvedValue({ number: 77580896, timestamp: Math.floor(Date.now() / 1000) - 3, hash: `0x${"ab".repeat(32)}` });
    pool();
  });
  it("prices a bounded executable quote using the actual fresh USDm mark and oldest dependency time", async () => {
    const ctx = context();
    const result = await fetchMentoFpmmPrice(ctx);
    expect(result).toMatchObject({ price: 1.208364, source: "mento-fpmm", confidence: "fallback",
      observedAt: ctx.assetsById.get("cusd-celo")!.priceObservedAt, observedAtMode: "upstream" });
    expect(multicall).toHaveBeenCalledTimes(1);
    expect(multicall.mock.calls[0][2]).toBe(77580896);
    expect(multicall.mock.calls[0][1]).toHaveLength(17);
  });
  it("survives shared publication validation near the CHF reference, while severe downside remains guarded", async () => {
    const override = await fetchMentoFpmmPrice(context());
    expect(override).not.toBeNull();
    for (const severe of [false, true]) {
      const asset = { id: "chfm-mento", name: "CHFm", symbol: "CHFm", pegType: "peggedCHF", price: null } as PeggedAsset;
      const applied = applyProtocolPriceOverrides({
        assets: [asset], overrides: new Map([[asset.id, { ...override!, ...(severe ? { price: 0.2 } : {}) }]]),
        validationContexts: createValidationContextResolver(),
        validationReferences: { rates: { peggedCHF: 1.21 }, type: "fresh", updatedAt: Math.floor(Date.now() / 1000) },
        syncStartSec: Math.floor(Date.now() / 1000),
      });
      expect(applied).toBe(severe ? 0 : 1);
      expect(asset.price).toBe(severe ? null : override!.price);
    }
  });
  it.each([
    ["wrong pair", { token0: encode("address", [CHFM]) }],
    ["wrong decimals", { inputDecimals: uint(6n) }],
    ["unreviewed token upgrade", { inputImplementation: encode("address", [CHFM]) }],
    ["unsynchronized inventory", { outputBalance: uint(29_999n * UNIT) }],
    ["empty inventory", { reserves: encode("uint256,uint256,uint256", [0n, 25_000n * UNIT, 1n]), outputBalance: uint(0n) }],
    ["excess fee", { lpFee: uint(201n) }],
    ["missing fee recipient", { feeRecipient: encode("address", ["0x0000000000000000000000000000000000000000"]) }],
    ["zero quote", { smallQuote: uint(0n) }],
    ["quote disagrees with guarded rate", { impactQuote: uint(121n * UNIT) }],
    ["exhausted input limit", { inputLimits: limits(100n * 10n ** 15n, 1n) }],
    ["exhausted output limit", { outputLimits: limits(100n * 10n ** 15n) }],
    ["negative limit", { inputLimits: limits(-1n) }],
    ["malformed limits", { outputLimits: "0x" }],
  ] as Array<[string, Record<string, `0x${string}`>]>) ("fails closed on %s", async (_name, overrides) => {
    pool(overrides);
    expect(await fetchMentoFpmmPrice(context())).toBeNull();
  });
  it("records a null RPC result with the pinned block", async () => {
    multicall.mockResolvedValue(null);
    const ctx = { ...context(), lastRejectionReason: null as string | null };
    expect(await fetchMentoFpmmPrice(ctx)).toBeNull();
    expect(ctx.lastRejectionReason).toBe("mento-fpmm:state-rpc-null:block-77580896");
  });
  it.each(["short", "wrong-label", "failed-call"])("records bounded %s diagnostics without RPC data", async (kind) => {
    multicall.mockImplementation(async (_chain, calls) => {
      const rows = calls.map(({ label }: { label: string }) => ({ label, success: true, returnData: uint(1n) }));
      if (kind === "short") rows.pop();
      else if (kind === "wrong-label") rows[0].label = "https://rpc.invalid/secret";
      else rows[14] = { ...rows[14], success: false, returnData: "secret-upstream-payload" };
      return rows;
    });
    const ctx = { ...context(), lastRejectionReason: null as string | null };
    expect(await fetchMentoFpmmPrice(ctx)).toBeNull();
    expect(ctx.lastRejectionReason).toBe(kind === "failed-call"
      ? "mento-fpmm:state-subcall-smallQuote:block-77580896"
      : "mento-fpmm:state-batch-shape:block-77580896");
    expect(ctx.lastRejectionReason).not.toContain("secret");
  });
  it("rejects a reorg between the pinned read and closing header", async () => {
    blockHeader.mockResolvedValueOnce({ number: 77580896, timestamp: Math.floor(Date.now() / 1000), hash: `0x${"cd".repeat(32)}` });
    expect(await fetchMentoFpmmPrice(context())).toBeNull();
  });
  it("rejects an unreviewed pool implementation before any quote", async () => {
    storage.mockResolvedValue(uint(1n));
    expect(await fetchMentoFpmmPrice(context())).toBeNull();
    expect(multicall).not.toHaveBeenCalled();
  });
  it("rejects duplicate/missing multicall labels and propagates cancellation", async () => {
    multicall.mockResolvedValue(Array.from({ length: 17 }, () => ({ label: "token0", success: true, returnData: uint(1n) })));
    expect(await fetchMentoFpmmPrice(context())).toBeNull();
    const controller = new AbortController();
    multicall.mockImplementation(async () => { controller.abort(); return null; });
    await expect(fetchMentoFpmmPrice(context(), controller.signal)).rejects.toMatchObject({ name: "AbortError" });
  });
  it("rejects a trusted parent already too old for the five-minute derived source", async () => {
    expect(await fetchMentoFpmmPrice(context({ priceObservedAt: Math.floor(Date.now() / 1000) - 300 }))).toBeNull();
    expect(blockNumber).not.toHaveBeenCalled();
  });
  it("rejects int96 flow overflow even under a larger configured limit", async () => {
    pool({ inputLimits: limits(1n << 100n, (1n << 95n) - 1n) });
    expect(await fetchMentoFpmmPrice(context())).toBeNull();
  });
  it.each(["stale", "future"])("rejects a %s block before reading pool state", async (kind) => {
    blockHeader.mockResolvedValue({ number: 77580896, timestamp: Math.floor(Date.now() / 1000) + (kind === "stale" ? -301 : 1), hash: `0x${"ab".repeat(32)}` });
    expect(await fetchMentoFpmmPrice(context())).toBeNull();
    expect(multicall).not.toHaveBeenCalled();
  });
  it.each([{ priceSource: "cached" }, { priceObservedAt: 1 }, { price: null }])("requires a fresh trusted USDm parent: %j", async (overrides) => {
    expect(await fetchMentoFpmmPrice(context(overrides))).toBeNull();
    expect(blockNumber).not.toHaveBeenCalled();
  });
  it("only targets missing CHFm and preserves a published market price", async () => {
    expect(mentoFpmmProvider.matches("copm-mento")).toBe(false);
    expect(mentoFpmmProvider.matches("chfm-mento")).toBe(true);
    const priced = context().assetsById.get("cusd-celo")!;
    expect(await mentoFpmmProvider.fetchLivePrice!(priced, context())).toBeNull();
    expect(blockNumber).not.toHaveBeenCalled();
  });
});
