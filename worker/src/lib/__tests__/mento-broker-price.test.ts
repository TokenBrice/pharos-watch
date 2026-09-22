import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { encodeAbiParameters, parseAbiParameters } from "viem/utils";
import { MENTO_POOL_EXCHANGE_ABI_PARAMETERS } from "@shared/lib/mento-contracts";
import type { PeggedAsset } from "../../cron/sync-stablecoins/enrich-prices-shared";
const blockNumber = vi.fn(), blockHeader = vi.fn(), multicall = vi.fn();
vi.mock("../evm-rpc", () => ({ fetchEvmBlockNumber: (...args: unknown[]) => blockNumber(...args),
  fetchEvmBlockHeader: (...args: unknown[]) => blockHeader(...args),
  fetchEvmMulticall3Aggregate3AtBlock: (...args: unknown[]) => multicall(...args) }));
import { fetchMentoBrokerPrice, mentoBrokerProvider } from "../authoritative-price-sources/mento-broker";
import { applyProtocolPriceOverrides, createValidationContextResolver } from "../../cron/sync-stablecoins/pricing";
const UNIT = 10n ** 18n;
const BROKER = "0x777a8255ca72412f0d706dc03c9d1987306b4cad", USDM = "0x765de816845861e75a25fca122bb6898b8b1282a";
const TOKEN = "0xff4ab19391af240c311c54200a492233052b6325";
const encode = (types: string, values: readonly unknown[]) => encodeAbiParameters(parseAbiParameters(types), values);
const uint = (x: bigint) => encode("uint256", [x]);
const address = (x: string) => encode("address", [x]);
const config = (limit = 10_000, flags = 4) => encode("uint32,uint32,int48,int48,int48,uint8", [0, 0, 0, 0, limit, flags]);
function context() { return { assetsById: new Map([["cusd-celo", { id: "cusd-celo", price: 1.01, priceSource: "coingecko", priceConfidence: "single-source", priceObservedAt: Math.floor(Date.now() / 1000) - 20, priceObservedAtMode: "upstream" } as PeggedAsset]]) }; }
function fixture(overrides: Record<string, `0x${string}`> = {}, spread = 0n, id = "cadm-mento") {
  const copm = id === "copm-mento";
  const token = id === "audm-mento" ? "0x7175504c455076f15c04a2f90a8e352281f492f9" : TOKEN;
  const feed = id === "audm-mento" ? "0x646bd504c3864ea5b8a6b6d25743721f61864a07" : "0x20869cf54ead821c45dfb2ab0c23d2e10fbb65a4";
  const values: Record<string, `0x${string}`> = {
    reserve: address("0x9380fa34fd9e4fd14c06305fd7b6199089ed4eb9"), managerBroker: address(BROKER), inputBroker: address(BROKER),
    oracle: address("0xefb84935239dacdecf7c5ba76d8de40b077b7b33"), breaker: address("0x303ed1df62fa067659b586ebee8de0ece824ab39"),
    provider: encode("bool", [true]), outputMinter: encode("bool", [true]), inputStable: encode("bool", [true]), outputStable: encode("bool", [true]),
    inputDecimals: uint(18n), outputDecimals: uint(18n),
    inputImplementation: address("0x434563b0604be100f04b7ae485bcafe3c9d8850e"), outputImplementation: address("0x815795c30d0758a297b08cd4e0643620c974c318"),
    brokerImplementation: address("0x1b78f6acd05e7bcb00f74863bfd8a7c264143e37"), managerImplementation: address("0xc016174b60519bdc24433d4ed2cff6c1efac7881"),
    pool: encodeAbiParameters(MENTO_POOL_EXCHANGE_ABI_PARAMETERS, [{ asset0: USDM, asset1: copm ? "0x8a567e2ae79ca692bd748ab832081c45de4041ea" : token, pricingModule: USDM, bucket0: 100_000n * UNIT, bucket1: 100_000n * UNIT, lastBucketUpdate: 1n, config: { spread, referenceRateFeedID: copm ? "0x0196d1f4fda21fa442e53eaf18bf31282f6139f1" : feed, referenceRateResetFrequency: 360n, minimumReports: 1n, stablePoolResetSize: 100_000n * UNIT } }]),
    mode: uint(0n), oracleTime: uint(BigInt(Math.floor(Date.now() / 1000) - 60)), oracleCount: uint(1n), expired: encode("bool,address", [false, USDM]),
    small: uint(copm ? UNIT * 32n / 100_000n : UNIT * 72n / 100n), depth: uint((copm ? 320n : 720n) * UNIT), inputLimits: config(copm ? 2_000_000 : 10_000), outputLimits: config(),
    inputState: encode("uint32,uint32,int48,int48,int48", [0, 0, 0, 0, 0]), outputState: encode("uint32,uint32,int48,int48,int48", [0, 0, 0, 0, 0]), ...overrides,
  };
  multicall.mockImplementation(async (_chain, calls) => calls.map(({ label }: { label: string }) => ({ label, success: true, returnData: values[label] })));
}
describe("Mento V2 Broker guarded prices", () => {
  afterEach(() => vi.restoreAllMocks());
  beforeEach(() => { vi.clearAllMocks(); vi.spyOn(Date, "now").mockReturnValue(1_789_480_000_000); blockNumber.mockResolvedValue(100); blockHeader.mockReset().mockResolvedValue({ number: 100, timestamp: Math.floor(Date.now() / 1000) - 2, hash: `0x${"ab".repeat(32)}` }); fixture(); });
  it("uses reviewed global-limit execution and oldest oracle dependency with fresh USDm price", async () => {
    expect(await fetchMentoBrokerPrice("cadm-mento", context())).toMatchObject({ price: 0.7272, source: "mento-broker", confidence: "fallback", observedAt: Math.floor(Date.now() / 1000) - 60 });
    expect(multicall).toHaveBeenCalledTimes(1);
    expect(multicall.mock.calls[0][2]).toBe(100);
  });
  it("prices COPm using its exact route and million-token depth", async () => {
    fixture({}, 0n, "copm-mento");
    const result = await fetchMentoBrokerPrice("copm-mento", context());
    expect(result).toMatchObject({ source: "mento-broker", confidence: "fallback" });
    expect(result!.price).toBeCloseTo(0.0003232, 12);
  });
  it.each([
    ["cadm-mento", "peggedCAD", 0.73],
    ["audm-mento", "peggedAUD", 0.73],
    ["copm-mento", "peggedCOP", 0.00032],
  ])("publishes %s near FX but keeps severe downside guarded", async (id, pegType, reference) => {
    fixture({}, 0n, id);
    expect(mentoBrokerProvider.matches(id)).toBe(true);
    const override = await fetchMentoBrokerPrice(id, context());
    expect(override).not.toBeNull();
    for (const severe of [false, true]) {
      const asset = { id, name: id, symbol: id, pegType, price: null } as PeggedAsset;
      const applied = applyProtocolPriceOverrides({
        assets: [asset], overrides: new Map([[id, { ...override!, ...(severe ? { price: reference / 5 } : {}) }]]),
        validationContexts: createValidationContextResolver(),
        validationReferences: { rates: { [pegType]: reference }, type: "fresh", updatedAt: Math.floor(Date.now() / 1000) },
        syncStartSec: Math.floor(Date.now() / 1000),
      });
      expect(applied).toBe(severe ? 0 : 1);
      expect(asset.price).toBe(severe ? null : override!.price);
    }
  });
  it.each([
    ["unknown limit mode", { inputLimits: config(10_000, 1) }],
    ["global input exhausted", { inputLimits: config(999) }],
    ["global output exhausted", { outputLimits: config(719) }],
    ["breaker open", { mode: uint(1n) }],
    ["stale oracle", { oracleTime: uint(1n) }],
    ["insufficient reports", { oracleCount: uint(0n) }],
    ["expired reports", { expired: encode("bool,address", [true, USDM]) }],
    ["mint permission removed", { outputMinter: encode("bool", [false]) }],
    ["unreviewed input implementation", { inputImplementation: address(USDM) }],
    ["unreviewed broker implementation", { brokerImplementation: address(USDM) }],
    ["wrong decimals", { outputDecimals: uint(6n) }],
    ["over five percent impact", { depth: uint(680n * UNIT) }],
    ["malformed", { small: "0x" as const }],
  ])("withholds %s", async (_name, overrides) => { fixture(overrides); expect(await fetchMentoBrokerPrice("cadm-mento", context())).toBeNull(); });
  it("rejects unsupported ids and excessive configured spread", async () => {
    expect(mentoBrokerProvider.matches("toString")).toBe(false);
    expect(await fetchMentoBrokerPrice("toString", context())).toBeNull();
    fixture({}, 21n * 10n ** 21n);
    expect(await fetchMentoBrokerPrice("cadm-mento", context())).toBeNull();
  });
  it("rejects an int48 delta even when opposite existing flow would hide overflow", async () => {
    const limit = (1n << 47n) - 1n;
    const output = (limit + 2n) * UNIT;
    fixture({ small: uint(output / 1_000n), depth: uint(output), outputLimits: config(Number(limit)),
      outputState: encode("uint32,uint32,int48,int48,int48", [0, 0, 0, 0, Number(limit)]) });
    expect(await fetchMentoBrokerPrice("cadm-mento", context())).toBeNull();
  });
  it("checks small fractional output as minus one unit even when the large quote passes", async () => {
    fixture({ outputLimits: config(1), outputState: encode("uint32,uint32,int48,int48,int48", [0, 0, 0, 0, -1]) });
    expect(await fetchMentoBrokerPrice("cadm-mento", context())).toBeNull();
  });
  it("withholds on canonical-block changes and preserves existing prices", async () => {
    blockHeader.mockResolvedValueOnce({ number: 100, timestamp: Math.floor(Date.now() / 1000) - 2, hash: "0xaa" }).mockResolvedValueOnce({ number: 100, timestamp: Math.floor(Date.now() / 1000) - 2, hash: "0xbb" });
    expect(await fetchMentoBrokerPrice("cadm-mento", context())).toBeNull();
    expect(await mentoBrokerProvider.fetchLivePrice!({ id: "cadm-mento", price: 0.73, priceSource: "coingecko", priceConfidence: "single-source", priceObservedAt: Math.floor(Date.now() / 1000), priceObservedAtMode: "upstream" } as PeggedAsset, context())).toBeNull();
  });
});
