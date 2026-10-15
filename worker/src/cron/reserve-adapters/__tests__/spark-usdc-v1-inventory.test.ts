import { afterEach, describe, expect, it, vi } from "vitest";
import { TRACKED_SOURCE_COINS } from "@shared/lib/stablecoins/registry";
import { computeLiveReserveConfigFingerprint, LiveReservesConfigSchema } from "@shared/lib/live-reserve-adapters";
import { buildReviewedReserveClassifications } from "../../../lib/safety-score-v9/extension";
import { fetchSparkUsdcV1InventoryReserves } from "../spark-usdc-v1-inventory";
import type { AdapterContext } from "../types";
import { installAdapterNetwork, type AdapterRpcValue } from "./reserve-adapter.test-support";
import { SPARK_INVENTORY_NETWORK, SPARK_L2_ZERO_RPC } from "./fixtures/identity-bound-reserve-readers";

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
const coin = { id: "susdc-spark-v1", contracts: [
  { chain: "ethereum", address: VAULT, decimals: 18 },
  { chain: "arbitrum", address: "0x940098b108fb7d0a7e374f6eded7760787464609", decimals: 18 },
  { chain: "base", address: "0x3128a0f7f0ea68e7b7c9b00afa7e41045828e858", decimals: 18 },
  { chain: "optimism", address: "0xcf9326e24ebffbef22ce1050007a43a3c0b6db55", decimals: 18 },
  { chain: "unichain", address: "0x14d9143becc348920b68d123687045db49a016c6", decimals: 18 },
] };
const config = { inputs: { primary: { kind: "onchain-evm", chain: "ethereum", rpcMode: "public-rpc" } } } as const;

// Embedded historical raw eth_call captures:
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

function read(
  overrides: Record<string, AdapterRpcValue> = {},
  observedBlock?: AdapterContext["observedBlock"],
) {
  const network = installAdapterNetwork({
    chains: SPARK_INVENTORY_NETWORK.chains,
    rpc: { ...RAW_PIN, ...SPARK_L2_ZERO_RPC, ...overrides },
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
      observedBlock,
    }),
  };
}

afterEach(() => vi.restoreAllMocks());

describe("Spark V1 local receipt inventory", () => {
  it("invalidates retained Ethereum-only snapshots with the version-two catalog binding", () => {
    const authored = TRACKED_SOURCE_COINS.find((entry) => entry.id === coin.id)?.liveReservesConfig;
    if (!authored) throw new Error("Missing Spark live reserve binding");
    expect(authored.version).toBe(2);
    expect(LiveReservesConfigSchema.safeParse(authored).success).toBe(true);
    const previous = { ...authored, version: 1 };
    expect(LiveReservesConfigSchema.safeParse(previous).success).toBe(false);
    expect(computeLiveReserveConfigFingerprint(authored)).not.toBe(computeLiveReserveConfigFingerprint(previous));
  });

  it("uses each chain's own numbered state and the oldest pin, even with a primary anchor", async () => {
    // Deliberately different synthetic headers expose accidental Ethereum-anchor reuse.
    const anchors = coin.contracts.map(({ chain }, index) => ({
      chain,
      number: 30_000_000 + index,
      timestamp: 1791406775 - index * 60,
    }));
    const overrides: Record<string, AdapterRpcValue> = {};
    for (const anchor of anchors.slice(1)) {
      overrides[`${anchor.chain}:eth_blockNumber`] = BigInt(anchor.number);
      overrides[`${anchor.chain}:eth_getBlockByNumber`] = anchor;
    }
    const { result, network } = read(overrides, anchors[0]);
    const observed = await result;
    expect(observed.metadata?.sourceTimestamp).toBe(anchors[4].timestamp);
    expect(observed.metadata?.details?.observedBlocks).toEqual(anchors);
    for (const anchor of anchors) {
      const calls = network.rpcCalls.filter((call) => call.method === "eth_call" && call.chain === anchor.chain);
      expect(new Set(calls.map((call) => call.block))).toEqual(new Set([`0x${anchor.number.toString(16)}`]));
    }
  });

  it.each(coin.contracts)("rejects a missing $chain deployment before reading any partial book", async ({ chain }) => {
    const network = installAdapterNetwork({});
    await expect(fetchSparkUsdcV1InventoryReserves({
      ...coin,
      contracts: coin.contracts.filter((entry) => entry.chain !== chain),
    }, config, new AbortController().signal, { chainRpcs: network.chainRpcs })).rejects.toThrow(/deployment roster/);
  });

  it.each(coin.contracts.slice(1))("withholds the entire book for missing $chain receipt custody", async ({ address }) => {
    const susds = SPARK_L2_ZERO_RPC[`${address}:0x58b8f19c`];
    if (typeof susds !== "string") throw new Error("Missing reviewed L2 receipt");
    const token = `0x${susds.slice(-40)}`;
    const balance = `0x70a08231${address.slice(2).padStart(64, "0")}`;
    await expect(read({ [`${token}:${balance}`]: null }).result).rejects.toThrow();
  });

  it.each(coin.contracts.slice(1))("withholds mismatched $chain implementation or NAV", async ({ address }) => {
    await expect(read({ [`${address}:0xaaf10f42`]: "0x1111111111111111111111111111111111111111" }).result).rejects.toThrow();
    await expect(read({ [`${address}:0x01e1d114`]: 1n }).result).rejects.toThrow();
    await expect(read({ [`${address}:0x18160ddd`]: null }).result).rejects.toThrow();
  });

  it("values a positive L2 position through local USDC conversion rather than Ethereum sUSDS arithmetic", async () => {
    const address = "0x3128a0f7f0ea68e7b7c9b00afa7e41045828e858";
    const receipt = "0x5875eee11cf8398102fdad704c9e96607675467a";
    const shares = 10n * WAD;
    const balance = `0x70a08231${address.slice(2).padStart(64, "0")}`;
    const { result } = read({
      [`${address}:0x18160ddd`]: shares,
      [`${address}:0x01e1d114`]: 11_128_860n,
      [`${address}:${conversion(shares)}`]: 11_128_860n,
      [`${receipt}:${balance}`]: shares,
    });
    const observed = await result;
    expect(observed.slices.find((row) => row.sourceKey === "spark-usdc-v1:base:susds")?.pct).toBeGreaterThan(0);
    expect(observed.metadata?.navUsd).toBeCloseTo(178319360.712216 + 11.12886, 6);
  });

  it.each(coin.contracts.slice(1))("retains $chain idle cash and independently converts surplus receipts", async ({ chain, address }) => {
    const receipt = SPARK_L2_ZERO_RPC[`${address}:0x58b8f19c`];
    const usdc = SPARK_L2_ZERO_RPC[`${address}:0x3e413bee`];
    if (typeof receipt !== "string" || typeof usdc !== "string") throw new Error("Missing L2 identities");
    const balance = `0x70a08231${address.slice(2).padStart(64, "0")}`;
    const shares = 10n * WAD;
    const held = shares + WAD;
    const { result } = read({
      [`${address}:0x18160ddd`]: shares,
      [`${address}:0x01e1d114`]: 11_000_000n,
      [`${address}:${conversion(shares)}`]: 11_000_000n,
      [`${address}:${conversion(held)}`]: 12_100_000n,
      [`${receipt}:${balance}`]: held,
      [`${usdc}:${balance}`]: 2_000_000n,
    });
    const observed = await result;
    expect(observed.metadata?.navUsd).toBeCloseTo(178319360.712216 + 11, 6);
    expect(observed.metadata?.totalReserveUsd).toBeCloseTo(178319361.71986894 + 14.1, 6);
    expect(observed.slices.find((row) => row.sourceKey === `spark-usdc-v1:${chain}:usdc`)?.pct).toBeGreaterThan(0);
  });

  it("withholds an L2 receipt deficit despite excess idle cash and rejects missing surplus conversion", async () => {
    const address = coin.contracts[2].address;
    const receipt = "0x5875eee11cf8398102fdad704c9e96607675467a";
    const usdc = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";
    const balance = `0x70a08231${address.slice(2).padStart(64, "0")}`;
    const shares = WAD;
    const base = {
      [`${address}:0x18160ddd`]: shares,
      [`${address}:0x01e1d114`]: 1_100_000n,
      [`${address}:${conversion(shares)}`]: 1_100_000n,
    };
    await expect(read({
      ...base,
      [`${receipt}:${balance}`]: shares - 1n,
      [`${usdc}:${balance}`]: 1_000_000_000_000n,
    }).result).rejects.toThrow(/receipt\/NAV mismatch/);
    await expect(read({
      ...base,
      [`${receipt}:${balance}`]: shares + 1n,
      [`${address}:${conversion(shares + 1n)}`]: null,
    }).result).rejects.toThrow();
  });

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
    if (!meta?.reserveReview || !liveDai) throw new Error("Missing Spark catalog review or measured DAI");
    const reviewedDai = meta.reserves?.find((row) => row.sourceKey === liveDai.sourceKey);
    expect(reviewedDai?.pct).toBe(0);
    expect(liveDai.pct).toBeGreaterThan(0);
    const measured = { ...liveDai, name: "Measured implementation-linked DAI" };
    // Historical RPC replay predates the current authored review: evaluate the
    // category join only after that review, without changing the measured weight.
    const reviewClock = Date.parse(`${meta.reserveReview.reviewedAt}T00:00:00Z`) / 1000 + 86400;
    const [classification] = buildReviewedReserveClassifications([measured], meta, reviewClock);
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
      reviewClock,
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
