import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { encodeAbiParameters, parseAbiParameters } from "viem/utils";
import { MENTO_POOL_EXCHANGE_ABI_PARAMETERS } from "@shared/lib/mento-contracts";
import type { PeggedAsset } from "../../cron/sync-stablecoins/enrich-prices-shared";
const blockNumber = vi.fn(), blockHeader = vi.fn(), multicall = vi.fn();
vi.mock("../evm-rpc", () => ({ fetchEvmBlockNumber: (...args: unknown[]) => blockNumber(...args),
  fetchEvmBlockHeader: (...args: unknown[]) => blockHeader(...args),
  fetchEvmMulticall3Aggregate3AtBlock: (...args: unknown[]) => multicall(...args) }));
import { fetchMentoBrokerPrice, mentoBrokerProvider } from "../authoritative-price-sources/mento-broker";
import { fetchAuthoritativeLivePriceOverrides } from "../authoritative-price-sources";
import { classifyPrimaryDepegTrust } from "../depeg-trust-policy";
import { evaluateStablecoinActivePriceCoverage } from "../stablecoin-publication-coverage";
import { applyProtocolPriceOverrides, createValidationContextResolver, settleNominalPriceReferences } from "../../cron/sync-stablecoins/pricing";
const UNIT = 10n ** 18n;
const BROKER = "0x777a8255ca72412f0d706dc03c9d1987306b4cad", USDM = "0x765de816845861e75a25fca122bb6898b8b1282a";
const routes: Record<string, [`0x${string}`, `0x${string}`, bigint, bigint]> = {
  "cadm-mento": ["0xff4ab19391af240c311c54200a492233052b6325", "0x20869cf54ead821c45dfb2ab0c23d2e10fbb65a4", 720_000n, 1_000n],
  "audm-mento": ["0x7175504c455076f15c04a2f90a8e352281f492f9", "0x646bd504c3864ea5b8a6b6d25743721f61864a07", 720_000n, 1_000n],
  "copm-mento": ["0x8a567e2ae79ca692bd748ab832081c45de4041ea", "0x0196d1f4fda21fa442e53eaf18bf31282f6139f1", 320n, 1_000_000n],
  "xofm-mento": ["0x73f93dcc49cb8a239e2032663e9475dd5ef29a08", "0x43620310c2feadbfecfd71b5a93e6e28946d64a5", 1_700n, 1_000_000n],
  "zarm-mento": ["0x4c35853a3b4e647fd266f4de678dcc8fec410bf6", "0x17ef04af0c52465694a841552fc2415169b1114c", 60_000n, 1_000n],
};
const encode = (types: string, values: readonly unknown[]) => encodeAbiParameters(parseAbiParameters(types), values);
const uint = (x: bigint) => encode("uint256", [x]);
const address = (x: string) => encode("address", [x]);
const config = (limit = 10_000, flags = 4) => encode("uint32,uint32,int48,int48,int48,uint8", [0, 0, 0, 0, limit, flags]);
function context() { return { assetsById: new Map([["cusd-celo", { id: "cusd-celo", price: 1.01, priceSource: "coingecko", priceConfidence: "single-source", priceObservedAt: Math.floor(Date.now() / 1000) - 20, priceObservedAtMode: "upstream" } as PeggedAsset]]) }; }
function fixture(overrides: Record<string, `0x${string}`> = {}, spread = 0n, id = "cadm-mento") {
  const [token, feed, rate, depth] = routes[id];
  const quote = rate * UNIT / 1_000_000n;
  const values: Record<string, `0x${string}`> = {
    reserve: address("0x9380fa34fd9e4fd14c06305fd7b6199089ed4eb9"), managerBroker: address(BROKER), inputBroker: address(BROKER),
    oracle: address("0xefb84935239dacdecf7c5ba76d8de40b077b7b33"), breaker: address("0x303ed1df62fa067659b586ebee8de0ece824ab39"),
    provider: encode("bool", [true]), outputMinter: encode("bool", [true]), inputStable: encode("bool", [true]), outputStable: encode("bool", [true]),
    inputDecimals: uint(18n), outputDecimals: uint(18n),
    inputImplementation: address("0x434563b0604be100f04b7ae485bcafe3c9d8850e"), outputImplementation: address("0x815795c30d0758a297b08cd4e0643620c974c318"),
    brokerImplementation: address("0x1b78f6acd05e7bcb00f74863bfd8a7c264143e37"), managerImplementation: address("0xc016174b60519bdc24433d4ed2cff6c1efac7881"),
    pool: encodeAbiParameters(MENTO_POOL_EXCHANGE_ABI_PARAMETERS, [{ asset0: USDM, asset1: token, pricingModule: USDM, bucket0: 100_000n * UNIT, bucket1: 100_000n * UNIT, lastBucketUpdate: 1n, config: { spread, referenceRateFeedID: feed, referenceRateResetFrequency: 360n, minimumReports: 1n, stablePoolResetSize: 100_000n * UNIT } }]),
    mode: uint(0n), oracleTime: uint(BigInt(Math.floor(Date.now() / 1000) - 60)), oracleCount: uint(1n), expired: encode("bool,address", [false, USDM]),
    small: uint(quote), depth: uint(quote * depth), inputLimits: config(depth > 10_000n ? 2_000_000 : 10_000), outputLimits: config(),
    inputState: encode("uint32,uint32,int48,int48,int48", [0, 0, 0, 0, 0]), outputState: encode("uint32,uint32,int48,int48,int48", [0, 0, 0, 0, 0]), ...overrides,
  };
  multicall.mockImplementation(async (_chain, calls) => calls.map(({ label }: { label: string }) => ({ label, success: true, returnData: values[label] })));
}
describe("Mento V2 Broker guarded prices", () => {
  afterEach(() => vi.restoreAllMocks());
  beforeEach(() => { vi.clearAllMocks(); vi.spyOn(Date, "now").mockReturnValue(1_789_480_000_000); blockNumber.mockResolvedValue(100); blockHeader.mockReset().mockResolvedValue({ number: 100, timestamp: Math.floor(Date.now() / 1000) - 2, hash: `0x${"ab".repeat(32)}` }); fixture(); });
  it.each<Record<string, `0x${string}`>>([
    { mode: uint(1n) }, { brokerImplementation: address(USDM) }, { oracleTime: uint(1n) }, { inputLimits: config(999) },
  ])("validates each route even when sharing a head: %j", async (bad) => {
    for (const success of [false, true]) {
      const shared = context(); blockNumber.mockClear();
      fixture(success ? {} : bad);
      expect(await fetchMentoBrokerPrice("cadm-mento", shared) !== null).toBe(success);
      fixture(success ? bad : {}, 0n, "audm-mento");
      expect(await fetchMentoBrokerPrice("audm-mento", shared) !== null).toBe(!success);
      expect(blockNumber).toHaveBeenCalledTimes(success ? 1 : 2);
      expect(multicall.mock.calls.slice(-2).map((c) => [c[2], c[1].length])).toEqual([[100, 26], [100, 26]]);
    }
  });
  it("rejects a second-route reorg and discards the shared head", async () => {
    const shared = context();
    expect(await fetchMentoBrokerPrice("cadm-mento", shared)).not.toBeNull();
    fixture({}, 0n, "audm-mento");
    blockHeader.mockResolvedValueOnce({ number: 100, timestamp: Math.floor(Date.now() / 1000) - 2, hash: "0xbb" });
    expect(await fetchMentoBrokerPrice("audm-mento", shared)).toBeNull();
    expect(await fetchMentoBrokerPrice("audm-mento", shared)).not.toBeNull();
    expect(blockNumber).toHaveBeenCalledTimes(2);
  });
  it("refreshes heads at five minutes", async () => {
    const shared = context();
    expect(await fetchMentoBrokerPrice("cadm-mento", shared)).not.toBeNull();
    const later = Date.now() + 298_000;
    vi.spyOn(Date, "now").mockReturnValue(later);
    shared.assetsById.get("cusd-celo")!.priceObservedAt = Math.floor(later / 1000) - 20;
    blockHeader.mockResolvedValue({ number: 100, timestamp: Math.floor(later / 1000) - 2, hash: `0x${"ab".repeat(32)}` });
    fixture({}, 0n, "audm-mento");
    expect(await fetchMentoBrokerPrice("audm-mento", shared)).not.toBeNull();
    expect(blockNumber).toHaveBeenCalledTimes(2);
    expect(blockHeader).toHaveBeenCalledTimes(4);
  });
  it("rechecks parent and cancellation", async () => {
    const shared = context();
    expect(await fetchMentoBrokerPrice("cadm-mento", shared)).not.toBeNull();
    shared.assetsById.get("cusd-celo")!.priceObservedAt = Math.floor(Date.now() / 1000) - 300;
    expect(await fetchMentoBrokerPrice("audm-mento", shared)).toBeNull();
    shared.assetsById.get("cusd-celo")!.priceObservedAt = Math.floor(Date.now() / 1000);
    await expect(fetchMentoBrokerPrice("audm-mento", shared, AbortSignal.abort())).rejects.toThrow();
    expect(multicall).toHaveBeenCalledTimes(1);
  });
  it.each([
    ["cadm-mento", "peggedCAD", 0.73],
    ["audm-mento", "peggedAUD", 0.73],
    ["copm-mento", "peggedCOP", 0.00032],
  ])("guards %s publication", async (id, pegType, reference) => {
    fixture({}, 0n, id);
    expect(mentoBrokerProvider.matches(id)).toBe(true);
    expect(await mentoBrokerProvider.fetchLivePrice!({ ...context().assetsById.get("cusd-celo")!, id }, context())).toBeNull();
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
  const int48Limit = (1n << 47n) - 1n;
  const overflowingOutput = (int48Limit + 2n) * UNIT;
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
    ["int48 delta overflow", {
      small: uint(overflowingOutput / 1_000n), depth: uint(overflowingOutput), outputLimits: config(Number(int48Limit)),
      outputState: encode("uint32,uint32,int48,int48,int48", [0, 0, 0, 0, Number(int48Limit)]),
    }],
    ["fractional output rounds away from zero", {
      outputLimits: config(1), outputState: encode("uint32,uint32,int48,int48,int48", [0, 0, 0, 0, -1]),
    }],
  ])("withholds %s", async (_name, overrides) => { fixture(overrides); expect(await fetchMentoBrokerPrice("cadm-mento", context())).toBeNull(); });
  it.each([["xofm-mento", "peggedXOF", 0.0017], ["zarm-mento", "peggedZAR", 0.06]] as const)("%s prefers verified Broker, failing closed", async (id, pegType, par) => {
    const now = Math.floor(Date.now() / 1000);
    const refs = { rates: { [pegType]: par }, type: "fresh" as const, updatedAt: now - 60,
      sourceModeByPeg: { [pegType]: "live" as const }, typeByPeg: { [pegType]: "fresh" as const }, updatedAtByPeg: { [pegType]: now - 60 } };
    const asset = { id, name: id, symbol: id, pegType, circulating: { [pegType]: 1e6 }, price: par,
      priceSource: "protocol-par", priceObservedAtMode: "nominal_reference", priceSyncedAt: now } as PeggedAsset;
    fixture({}, 0n, id);
    const overrides = await fetchAuthoritativeLivePriceOverrides([asset, ...context().assetsById.values()], undefined, refs);
    expect(overrides.get(id)?.source).toBe("mento-broker");
    const apply = (quotes = overrides) => applyProtocolPriceOverrides({ assets: [asset], overrides: quotes,
      validationContexts: createValidationContextResolver(), validationReferences: refs, syncStartSec: now });
    apply();
    settleNominalPriceReferences([asset], now, refs);
    expect(asset.priceSource).toBe("mento-broker");
    expect(await mentoBrokerProvider.fetchLivePrice!({ ...asset, priceSource: "binance", priceConfidence: "single-source", agreeSources: ["binance"] }, context())).toBeNull();
    expect(classifyPrimaryDepegTrust(asset, now)).toBe("confirm_required");
    expect(evaluateStablecoinActivePriceCoverage([asset], [id]).nominalReferenceIds).toEqual([]);
    for (const state of [{ price: NaN }, { price: 0 }, { priceObservedAt: now - 300 }, { priceObservedAt: now + 1 }, { priceObservedAtMode: "local_fetch" as const }]) {
      apply(); Object.assign(asset, state); settleNominalPriceReferences([asset], now, refs);
      expect(asset.priceSource).toBe("protocol-par");
    }
    apply(new Map([[id, { ...overrides.get(id)!, price: par / 5 }]]));
    expect(asset.priceSource).toBe("protocol-par");
    apply(new Map());
    expect(asset.priceObservedAtMode).toBe("nominal_reference");
    expect(evaluateStablecoinActivePriceCoverage([asset], [id]).nominalReferenceIds).toEqual([id]);
    apply(); delete asset.nominalPriceReference;
    settleNominalPriceReferences([asset], now);
    expect(asset.price).toBeNull();
    fixture({ mode: uint(1n) }, 0n, id);
    expect(await fetchMentoBrokerPrice(id, { ...context(), validationReferences: refs })).toBeNull();
    fixture({}, 0n, id);
    for (const type of ["none", "static", "stale"] as const) {
      expect(await fetchMentoBrokerPrice(id, { ...context(), validationReferences: { ...refs, typeByPeg: { [pegType]: type } } })).toBeNull();
    }
  });
  it("rejects unknown IDs and spread", async () => {
    expect(mentoBrokerProvider.matches("toString")).toBe(false);
    expect(await fetchMentoBrokerPrice("toString", context())).toBeNull();
    fixture({}, 21n * 10n ** 21n);
    expect(await fetchMentoBrokerPrice("cadm-mento", context())).toBeNull();
  });

});
