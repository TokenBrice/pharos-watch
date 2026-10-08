import { afterEach, describe, expect, it, vi } from "vitest";
import { TRACKED_SOURCE_COINS } from "@shared/lib/stablecoins/registry";
import { buildReviewedReserveClassifications } from "../../../lib/safety-score-v9/extension";
import { fetchSparkUsdcV1InventoryReserves } from "../spark-usdc-v1-inventory";
import { installAdapterNetwork, type AdapterRpcValue } from "./reserve-adapter.test-support";

const VAULT = "0xbc65ad17c5c0a2a4d159fa5a503f4992c7b545fe";
const SUSDS = "0xa3931d71877c0e7a3148cb7eb4463524fec27fbd";
const USDC = "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48";
const USDS = "0xdc035d45d973e3ec169d2276ddab16f1e407384f";
const DAI = "0x6b175474e89094c44da98b954eedeac495271d0f";
const PSM = "0xa188eec8f81263234da3622a406892f3d630f98c";
const DAI_PSM = "0xf6e72db5454dd049d0788e411b06cfaf16853042";
const SUPPLY = 160355449716788777022751169n;
const RECEIPT_VALUE = 178319360712216484513248851n;
const NAV = 178319360712216n;
const WAD = 10n ** 18n;
const FLOOR = 10n ** 12n;
const BALANCE = `0x70a08231${VAULT.slice(2).padStart(64, "0")}`;
const conversion = (value: bigint) => `0x07a2d13a${value.toString(16).padStart(64, "0")}`;
const coin = { id: "susdc-spark-v1", contracts: [{ chain: "ethereum", address: VAULT, decimals: 18 }] };
const config = { inputs: { primary: { kind: "onchain-evm", chain: "ethereum", rpcMode: "public-rpc" } } } as const;

// Raw eth_call results from spark-pinned-{identity,receipt,dust}.json, captured
// 2026-10-07T21:13:46Z..21:15:17Z via https://api-ethereum-mainnet-erigon.n.dwellir.com.
// All state reads: block 26143056, hash 0x89f40231094f9e32ac24584fe0e0410dadfa93508d21d99b3397a9fcfca72b39.
const RAW_PIN: Record<string, AdapterRpcValue> = {
  [`${VAULT}:0x38d52e0f`]: "0x000000000000000000000000a0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
  [`${VAULT}:0x01e1d114`]: "0x0000000000000000000000000000000000000000000000000000a22e3626de18",
  [`${VAULT}:0x18160ddd`]: "0x00000000000000000000000000000000000000000084a49658ff0a993fb181c1",
  [`${VAULT}:0x58b8f19c`]: "0x000000000000000000000000a3931d71877c0e7a3148cb7eb4463524fec27fbd",
  [`${VAULT}:0x04bda262`]: "0x000000000000000000000000a188eec8f81263234da3622a406892f3d630f98c",
  [`${VAULT}:0xaaf10f42`]: "0x000000000000000000000000f943cb8d5f06f2bbf352878ebef3ec5c537a20ba",
  [`${VAULT}:0x3e413bee`]: "0x000000000000000000000000a0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
  [`${SUSDS}:0x4cf282fb`]: "0x000000000000000000000000dc035d45d973e3ec169d2276ddab16f1e407384f",
  [`${PSM}:0xcccef9e2`]: "0x00000000000000000000000037305b1cd40574e4c5ce33f8e8306be057fd7341",
  [`${PSM}:0x04bda262`]: "0x000000000000000000000000f6e72db5454dd049d0788e411b06cfaf16853042",
  [`${SUSDS}:${BALANCE}`]: "0x00000000000000000000000000000000000000000084a49658ff0a993fb181c1",
  [`${SUSDS}:${conversion(SUPPLY)}`]: "0x000000000000000000000000000000000000000000938097e9fd408c4296f653",
  [`${VAULT}:${conversion(SUPPLY)}`]: "0x0000000000000000000000000000000000000000000000000000a22e3626de18",
  [`${USDC}:${BALANCE}`]: "0x00000000000000000000000000000000000000000000000000000000000f55a1",
  [`${USDS}:${BALANCE}`]: "0x00000000000000000000000000000000000000000000000000098fdde03c5548",
  [`${DAI_PSM}:0xf4b9fa75`]: "0x0000000000000000000000006b175474e89094c44da98b954eedeac495271d0f",
  [`${DAI}:${BALANCE}`]: "0x0000000000000000000000000000000000000000000000000000000000000000",
};

function read(overrides: Record<string, AdapterRpcValue> = {}) {
  const network = installAdapterNetwork({
    rpc: { ...RAW_PIN, ...overrides },
    block: {
      number: 26143056,
      timestamp: 1791406775,
      hash: "0x89f40231094f9e32ac24584fe0e0410dadfa93508d21d99b3397a9fcfca72b39",
    },
  });
  return {
    network,
    result: fetchSparkUsdcV1InventoryReserves(coin, config, new AbortController().signal, {
      chainRpcs: network.chainRpcs,
      nowSec: 1791407717,
    }),
  };
}

afterEach(() => vi.restoreAllMocks());

describe("Spark V1 local receipt inventory", () => {
  it("replays the exact raw pin, retains dust, and values the receipt once rather than as USDC custody", async () => {
    const { result: pending, network } = read();
    const result = await pending;
    expect(result.slices).toHaveLength(3);
    expect(result.slices.map(({ sourceKey, coinId, assetClass }) => ({ sourceKey, coinId, assetClass }))).toEqual([
      { sourceKey: "spark-usdc-v1:ethereum:susds", coinId: "susds-sky", assetClass: "protocol-position" },
      { sourceKey: "spark-usdc-v1:ethereum:usdc", coinId: "usdc-circle", assetClass: "stablecoin" },
      { sourceKey: "spark-usdc-v1:ethereum:usds", coinId: "usds-sky", assetClass: "stablecoin" },
    ]);
    const gross = 178319361.71986894;
    expect(result.slices[0].pct).toBeCloseTo(178319360.71221648 / gross * 100, 12);
    expect(result.slices[1].pct).toBeCloseTo(1.004961 / gross * 100, 15);
    expect(result.slices[2].pct).toBeCloseTo(0.002691457902990664 / gross * 100, 18);
    expect(result.slices.reduce((sum, row) => sum + row.pct, 0)).toBeCloseTo(100, 12);
    expect(result.metadata).toMatchObject({
      freshnessMode: "verified",
      sourceTimestamp: 1791406775,
      observedBlock: { chain: "ethereum", number: 26143056, timestamp: 1791406775 },
      navUsd: 178319360.712216,
      totalReserveUsd: gross,
      details: {
        receiptBalanceRaw: SUPPLY.toString(),
        receiptAssetsRaw: RECEIPT_VALUE.toString(),
        idleUsdcRaw: "1004961",
        idleUsdsRaw: "2691457902990664",
        idleDaiRaw: "0",
        grossLocalValueRaw: "178319361719868942416239515",
        localSurplusRaw: "1007652942416239515",
        receiptSurplusRaw: "0",
        navFloorRemainderRaw: "484513248851",
      },
    });
    expect(result.metadata?.redemption).toBeUndefined();
    expect(result.warnings ?? []).toEqual([]);
    expect(network.unmatched).toEqual([]);
    const reads = network.rpcCalls.filter((call) => call.method === "eth_call");
    expect(reads.length).toBeGreaterThan(0);
    expect(new Set(reads.map((call) => call.block))).toEqual(new Set(["0x18ee950"]));
    expect(reads.filter((call) => call.contract === USDC)).toHaveLength(1);
    expect(reads.some((call) => call.contract === "0x37305b1cd40574e4c5ce33f8e8306be057fd7341")).toBe(false);
  });

  it("keeps local accounting NAV distinct from an independently measured USD liability", async () => {
    const { result } = read();
    const observed = await result;
    expect(observed.metadata).toMatchObject({
      navUsd: 178319360.712216,
      totalAssetsUsd: 178319360.712216,
      details: { totalSupply: SUPPLY.toString(), obligationAssetsRaw: RECEIPT_VALUE.toString() },
    });
    expect(observed.metadata).not.toHaveProperty("supplyUsd");
    expect(observed.metadata).not.toHaveProperty("collateralizationRatio");
  });

  it("drops successfully measured zero idle rows, without dropping the receipt identity", async () => {
    const { result } = read({ [`${USDC}:${BALANCE}`]: 0n, [`${USDS}:${BALANCE}`]: 0n });
    expect((await result).slices).toMatchObject([{ coinId: "susds-sky", pct: 100 }]);
  });

  it("recognizes a positive DAI balance and normalizes USDC6 and all three 18-decimal tokens", async () => {
    const { result } = read({
      [`${USDC}:${BALANCE}`]: 3_000_000n,
      [`${USDS}:${BALANCE}`]: 2n * WAD,
      [`${DAI}:${BALANCE}`]: 4n * WAD,
    });
    const observed = await result;
    const denominator = Number(RECEIPT_VALUE) / 1e18 + 9;
    for (const [key, value, coinId] of [["usdc", 3, "usdc-circle"], ["usds", 2, "usds-sky"], ["dai", 4, "dai-makerdao"]] as const) {
      const row = observed.slices.find((slice) => slice.sourceKey === `spark-usdc-v1:ethereum:${key}`);
      expect(row?.coinId).toBe(coinId);
      expect(row?.pct).toBeCloseTo(value / denominator * 100, 14);
    }
    expect(observed.slices).toHaveLength(4);
  });

  it("joins positive measured DAI to the actual zero-weight reviewed category without borrowing its weight", async () => {
    const { result } = read({ [`${DAI}:${BALANCE}`]: 4n * WAD });
    const observed = await result;
    const liveDai = observed.slices.find((row) => row.coinId === "dai-makerdao");
    const meta = TRACKED_SOURCE_COINS.find((entry) => entry.id === coin.id);
    if (!meta || !liveDai) throw new Error("Missing Spark catalog metadata or measured DAI");
    const reviewedDai = meta.reserves?.find((row) => row.sourceKey === liveDai.sourceKey);
    expect(reviewedDai?.pct).toBe(0);
    expect(liveDai.pct).toBeGreaterThan(0);
    const measured = { ...liveDai, name: "Measured implementation-linked DAI" };
    const [classification] = buildReviewedReserveClassifications([measured], meta, 1791406775);
    expect(classification).toMatchObject({
      trackedAssetId: "dai-makerdao",
      assetClass: "stablecoin",
      liquidityHorizon: "unknown",
    });
    expect(classification.classificationKey).toMatch(/^registry-reviewed:/);
    expect(measured.pct).toBe(liveDai.pct);
    const [unmatched] = buildReviewedReserveClassifications(
      [{ ...measured, sourceKey: "spark-usdc-v1:ethereum:unreviewed-dai" }],
      meta,
      1791406775,
    );
    expect(unmatched.classificationKey).toMatch(/^source-native:/);
    expect(unmatched.liquidityHorizon).toBeNull();
  });

  it.each([USDC, USDS, DAI, SUSDS])("withholds the entire result when %s balance is unavailable", async (token) => {
    await expect(read({ [`${token}:${BALANCE}`]: null }).result).rejects.toThrow();
  });

  it.each([`0x${"0".repeat(65)}`, `0x${"0".repeat(128)}`, `0x${"z".repeat(64)}`])("rejects malformed balance payload %s instead of a measured zero", async (raw) => {
    await expect(read({ [`${DAI}:${BALANCE}`]: raw }).result).rejects.toThrow();
  });

  it.each([
    `${VAULT}:0xaaf10f42`,
    `${SUSDS}:0x4cf282fb`,
    `${DAI_PSM}:0xf4b9fa75`,
    `${VAULT}:0x18160ddd`,
    `${VAULT}:0x01e1d114`,
    `${VAULT}:${conversion(SUPPLY)}`,
    `${SUSDS}:${conversion(SUPPLY)}`,
  ])("withholds unavailable identity, obligation, and conversion read %s", async (key) => {
    await expect(read({ [key]: null }).result).rejects.toThrow();
  });

  it.each([
    [VAULT, "0xaaf10f42"], [VAULT, "0x38d52e0f"], [VAULT, "0x3e413bee"],
    [VAULT, "0x58b8f19c"], [VAULT, "0x04bda262"], [SUSDS, "0x4cf282fb"],
    [PSM, "0x04bda262"], [PSM, "0xcccef9e2"], [DAI_PSM, "0xf4b9fa75"],
  ])("withholds independent inventory when %s/%s identity drifts", async (contract, selector) => {
    await expect(read({ [`${contract}:${selector}`]: "0x1111111111111111111111111111111111111111" }).result).rejects.toThrow();
  });

  it("rejects even a one-share-unit receipt deficit despite abundant idle USDC", async () => {
    await expect(read({
      [`${SUSDS}:${BALANCE}`]: SUPPLY - 1n,
      [`${USDC}:${BALANCE}`]: 1_000_000_000_000_000n,
    }).result).rejects.toThrow();
  });

  it("values independently held excess receipts using their own conversion and preserves genuine surplus", async () => {
    const excess = SUPPLY + WAD;
    const extraValue = 1_112_025_000_000_000_000n;
    const { result: pending, network } = read({
      [`${SUSDS}:${BALANCE}`]: excess,
      [`${SUSDS}:${conversion(excess)}`]: RECEIPT_VALUE + extraValue,
    });
    const result = await pending;
    expect(result.metadata?.details).toMatchObject({
      receiptBalanceRaw: excess.toString(),
      receiptAssetsRaw: (RECEIPT_VALUE + extraValue).toString(),
      receiptSurplusRaw: WAD.toString(),
      localSurplusRaw: (1_007_652_942_416_239_515n + extraValue).toString(),
    });
    const navUsd = result.metadata?.navUsd;
    if (typeof navUsd !== "number") throw new Error("Missing numeric accounting NAV");
    expect(result.metadata?.totalReserveUsd).toBeGreaterThan(navUsd);
    expect(network.rpcCalls.some((call) => call.contract === SUSDS && call.data === conversion(excess))).toBe(true);
    expect(result.warnings ?? []).toEqual([]);
  });

  it("rejects a missing or regressive actual-receipt conversion", async () => {
    const excess = SUPPLY + WAD;
    await expect(read({
      [`${SUSDS}:${BALANCE}`]: excess,
      [`${SUSDS}:${conversion(excess)}`]: null,
    }).result).rejects.toThrow();
    await expect(read({
      [`${SUSDS}:${BALANCE}`]: excess,
      [`${SUSDS}:${conversion(excess)}`]: RECEIPT_VALUE - 1n,
    }).result).rejects.toThrow();
  });

  it.each([0n, FLOOR - 1n])("accepts exact NAV flooring with remainder %s", async (remainder) => {
    const { result } = read({ [`${SUSDS}:${conversion(SUPPLY)}`]: NAV * FLOOR + remainder });
    expect((await result).metadata?.details?.navFloorRemainderRaw).toBe(remainder.toString());
  });

  const inconsistentAccountingCases: Record<string, AdapterRpcValue>[] = [
    { [`${VAULT}:0x01e1d114`]: NAV + 1n },
    { [`${VAULT}:${conversion(SUPPLY)}`]: NAV + 1n },
    { [`${SUSDS}:${conversion(SUPPLY)}`]: (NAV + 1n) * FLOOR },
    { [`${SUSDS}:${conversion(SUPPLY)}`]: NAV * FLOOR - 1n },
    { [`${VAULT}:0x18160ddd`]: 0n },
  ];
  it.each(inconsistentAccountingCases)("withholds inconsistent supply/NAV accounting %#", async (overrides) => {
    await expect(read(overrides).result).rejects.toThrow();
  });

  it("rejects another vault, V2 instrument, chain, or mixed-chain observation anchor", async () => {
    const signal = new AbortController().signal;
    await expect(fetchSparkUsdcV1InventoryReserves({ ...coin, id: "susdc-spark" }, config, signal)).rejects.toThrow();
    await expect(fetchSparkUsdcV1InventoryReserves({ ...coin, contracts: [{ chain: "ethereum", address: USDC, decimals: 18 }] }, config, signal)).rejects.toThrow();
    await expect(fetchSparkUsdcV1InventoryReserves(coin, { inputs: { primary: { ...config.inputs.primary, chain: "base" } } }, signal)).rejects.toThrow();
    await expect(fetchSparkUsdcV1InventoryReserves(coin, config, signal, { observedBlock: { chain: "base", number: 26143056, timestamp: 1791406775 } })).rejects.toThrow();
  });

  it("rejects unsupported parameters instead of ignoring a proposed alternate identity", async () => {
    await expect(fetchSparkUsdcV1InventoryReserves(coin, { ...config, params: { vault: USDC } }, new AbortController().signal)).rejects.toThrow();
  });
});
