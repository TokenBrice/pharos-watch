import { afterEach, describe, expect, it, vi } from "vitest";
import { encodeAbiParameters } from "viem/utils";
import { installAdapterNetwork, runAdapter, expectWarningEffect, type AdapterNetworkSpec } from "./reserve-adapter.test-support";

const DEBT = "0x94dc79ce9c515ba4ae4d195da8e6ab86c69bfc38";
const USDC = "0xabbb91c0617090f0028bdc27597cd0d038f3a833";
const ETH = "0x4effb5813271699683c25c734f4dabc45b363709";
const A_USDC = "0x0000000000000000000000000000000000000011";
const A_ETH = "0x0000000000000000000000000000000000000012";
const A_DEBT = "0x0000000000000000000000000000000000000013";
const ORACLE = "0x0000000000000000000000000000000000000021";
const SOURCE = "0x0000000000000000000000000000000000000022";
const VARIABLE = "0x0000000000000000000000000000000000000023";
const ALICE = "0x0000000000000000000000000000000000000031";
const BOB = "0x0000000000000000000000000000000000000032";
const CLOSED = "0x0000000000000000000000000000000000000033";
const NOW = 1_788_981_386;
const WAD = 10n ** 18n;
const URL = `https://api.sodax.com/v1/be/moneymarket/asset/${DEBT}/borrowers?offset=0&limit=128`;
function reserveData(aToken: string, decimals: number): string {
  const words = Array<bigint>(15).fill(0n);
  words[0] = BigInt(decimals) << 48n;
  words[8] = BigInt(aToken);
  words[10] = BigInt(VARIABLE);
  return `0x${words.map((w) => w.toString(16).padStart(64, "0")).join("")}`;
}
function network(overrides: { borrowers?: string[]; scaledTotal?: bigint; ethPrice?: bigint; timestamp?: number; extraReserve?: string } = {}): AdapterNetworkSpec {
  const reserves = [DEBT, USDC, ETH, ...(overrides.extraReserve ? [overrides.extraReserve] : [])];
  return {
    block: { number: 78_947_506, timestamp: NOW },
    json: { [URL]: { borrowers: overrides.borrowers ?? [ALICE, BOB, CLOSED], total: (overrides.borrowers ?? [ALICE, BOB, CLOSED]).length } },
    rpc: {
      "getReservesList()": encodeAbiParameters([{ type: "address[]" }], [reserves as `0x${string}`[]]),
      "getPriceOracle()": ORACLE,
      "getReserveData(address)": ({ data }) => {
        const reserve = `0x${data.slice(-40)}`;
        return reserveData(reserve === USDC ? A_USDC : reserve === DEBT ? A_DEBT : A_ETH, reserve === USDC ? 6 : 18);
      },
      "scaledTotalSupply()": overrides.scaledTotal ?? 3n * WAD,
      "scaledBalanceOf(address)": ({ data }) => data.endsWith(ALICE.slice(2)) ? WAD : data.endsWith(BOB.slice(2)) ? 2n * WAD : 0n,
      "BASE_CURRENCY_UNIT()": 100_000_000n,
      "getAssetPrice(address)": ({ data }) => data.endsWith(ETH.slice(2)) ? overrides.ethPrice ?? 2000n * 100_000_000n : 100_000_000n,
      "getSourceOfAsset(address)": SOURCE,
      "latestTimestamp()": overrides.timestamp ?? NOW,
      [`${A_USDC}:balanceOf(address)`]: ({ data }) => data.endsWith(ALICE.slice(2)) ? 100_000_000n : 300_000_000n,
      [`${A_ETH}:balanceOf(address)`]: WAD / 10n,
      [`${A_DEBT}:balanceOf(address)`]: 0n,
      "totalSupply()": 10n * WAD,
    },
  };
}
const run = (spec = network()) => runAdapter("sodax-sonic", "bnusd-balanced", { network: installAdapterNetwork(spec), nowSec: NOW });
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
const FIXED_SOURCE = "0x79fa150c700adeaf618475e8cb17933e7a9c3214";
const FIXED_CODE = "0x6080604052348015600e575f5ffd5b50600436106044575f3560e01c8063313ce56714604857806350d25bcd14605c578063b15b37a514606c578063fcab1819146073575b5f5ffd5b604051600881526020015b60405180910390f35b5f545b6040519081526020016053565b605f5f5481565b6001605f56fea2646970667358221220f08e076d17e100786032c4baefdd8213b917a901e65779644f832b8f795cb2cb64736f6c634300081c0033";

describe("sodax-sonic", () => {
  it("aggregates active borrowers, preserves tracked identities and withholds an unproven global ratio", async () => {
    const { result, network: observed } = await run();
    expect(result.slices).toEqual(expect.arrayContaining([
      expect.objectContaining({ sourceKey: `sodax-sonic:${USDC}`, coinId: "usdc-circle", pct: 50 }),
      expect.objectContaining({ sourceKey: `sodax-sonic:${ETH}`, pct: 50 }),
    ]));
    expect(result.metadata).toMatchObject({ totalReserveUsd: 800, unknownExposurePct: 0, supplyCoverageComplete: false, observedBlock: { number: 78_947_506 }, details: { activeBorrowerCount: 2, borrowerCensusComplete: true } });
    expect(result.metadata?.collateralizationRatio).toBeUndefined();
    expectWarningEffect(result, "supply-inventory-unverified", "info");
    expect(observed.rpcCalls.filter((c) => c.selector === "0x70a08231").every((c) => !c.data.endsWith(CLOSED.slice(2)) && c.block === `0x${(78_947_506).toString(16)}`)).toBe(true);
  });

  it("rejects a missing positive borrower even when the indexer calls its page complete", async () => {
    await expect(run(network({ borrowers: [ALICE, CLOSED] }))).rejects.toThrow("scaled debt does not reconcile");
  });

  it("rejects duplicate candidates instead of letting duplicated debt mask a missing borrower", async () => {
    await expect(run(network({ borrowers: [ALICE, ALICE, ALICE] }))).rejects.toThrow("duplicate borrower");
  });

  it("fails closed on an unpriced positive reserve rather than normalize away missing value", async () => {
    await expect(run(network({ ethPrice: 0n }))).rejects.toThrow("unpriced positive reserve");
  });

  it("retains the measured composition but degrades stale nonzero oracle observations", async () => {
    const { result } = await run(network({ timestamp: NOW - 3601 }));
    expect(result.metadata?.totalReserveUsd).toBe(800);
    expectWarningEffect(result, "sodax-oracle-stale", "degraded");
  });

  it("quantifies a newly discovered unreviewed reserve rather than omit it", async () => {
    const extra = "0x0000000000000000000000000000000000000041";
    const { result } = await run(network({ extraReserve: extra }));
    expect(result.slices.find((s) => s.sourceKey === `sodax-sonic:${extra}`)?.coinId).toBeUndefined();
    expect(result.metadata?.unknownExposurePct).toBeCloseTo(0.2 / 800.2 * 100);
    expect(result.metadata?.totalReserveUsd).toBeCloseTo(800.2);
  });

  it("accepts the reviewed immutable oracle without inventing an update timestamp", async () => {
    const spec = network();
    spec.rpc!["getSourceOfAsset(address)"] = FIXED_SOURCE;
    spec.code = { [FIXED_SOURCE]: FIXED_CODE };
    spec.json!["https://coins.llama.fi/prices/current/coingecko:usd-coin"] = {
      coins: { "coingecko:usd-coin": { price: 1, timestamp: NOW, confidence: 0.99 } },
    };
    const { result } = await run(spec);
    expect(result.metadata?.totalReserveUsd).toBe(800);
    expect(result.warnings?.some((w) => w.code === "sodax-oracle-stale")).toBe(false);
  });

  it("rejects code drift instead of extending the immutable-oracle exception to another implementation", async () => {
    const spec = network();
    spec.rpc!["getSourceOfAsset(address)"] = FIXED_SOURCE;
    spec.code = { [FIXED_SOURCE]: "0x6000" };
    await expect(run(spec)).rejects.toThrow("reviewed oracle code drift");
  });

  it("prices the fixed-constant USDT oracle leg with the live DefiLlama quote", async () => {
    const spec = network();
    spec.rpc!["getSourceOfAsset(address)"] = ({ data }) => data.endsWith(USDC.slice(2)) ? FIXED_SOURCE : SOURCE;
    spec.code = { [FIXED_SOURCE]: FIXED_CODE };
    spec.json!["https://coins.llama.fi/prices/current/coingecko:usd-coin"] = {
      coins: { "coingecko:usd-coin": { price: 1.05, timestamp: NOW, confidence: 0.99 } },
    };
    const { result } = await run(spec);

    // USDC valued at the DefiLlama 1.05 quote (420) instead of the immutable $1
    // constant (400); ETH keeps its normal oracle price (400).
    expect(result.metadata?.totalReserveUsd).toBeCloseTo(820);
    expect(result.metadata?.details).toMatchObject({
      priceSources: expect.arrayContaining([
        expect.objectContaining({ reserve: USDC, kind: "defillama", priceInsensitive: false }),
      ]),
    });
  });

  it("keeps the reviewed constant as a flagged price-insensitive fallback when no DefiLlama quote is available", async () => {
    const spec = network();
    spec.rpc!["getSourceOfAsset(address)"] = ({ data }) => data.endsWith(USDC.slice(2)) ? FIXED_SOURCE : SOURCE;
    spec.code = { [FIXED_SOURCE]: FIXED_CODE };
    spec.json!["https://coins.llama.fi/prices/current/coingecko:usd-coin"] = { coins: {} };
    const { result } = await run(spec);

    expect(result.metadata?.totalReserveUsd).toBe(800);
    expect(result.metadata?.details).toMatchObject({
      priceSources: expect.arrayContaining([
        expect.objectContaining({ reserve: USDC, kind: "oracle", priceInsensitive: true }),
      ]),
    });
  });
});
