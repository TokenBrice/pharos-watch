import { describe, expect, it } from "vitest";
import { installAdapterNetwork, runAdapter } from "./reserve-adapter.test-support";

const TGBP_URL = "https://api.tgbp.io/api/v1/public/data/tgbp";
const QCAD_URL = "https://api.sdc.stablecorp.ca/reports/balances?type=unformatted_json";
const NOW = Date.parse("2026-03-20T12:01:00Z") / 1000;

function runJson(
  coinId: "tgbp-tokenised" | "qcad-stablecorp",
  payload: unknown,
  params: Record<string, unknown> = {},
  nowSec = NOW,
) {
  const url = coinId === "tgbp-tokenised" ? TGBP_URL : QCAD_URL;
  return runAdapter("single-asset", coinId, {
    network: installAdapterNetwork({ json: { [url]: payload } }),
    params,
    nowSec,
  });
}

function runOnchain(network = installAdapterNetwork({
  chains: { ethereum: "https://rpc.example" },
  rpc: { "ethereum:0x18160ddd": 1_000_000n },
})) {
  return runAdapter("single-asset", "axcnh-anchorx", { network });
}

describe("fetchSingleAssetReserves", () => {
  it("returns 100% slice in http-json mode when probe returns non-zero", async () => {
    const { result } = await runJson("tgbp-tokenised", { total_supply: "1000000" }, {
      label: "ETH collateral",
      risk: "low",
      reserveProbe: { kind: "json-path", path: ["total_supply"] },
      supplyProbe: undefined,
      timestampProbe: undefined,
      reserveSourceLabel: "ETH collateral",
    });
    expect(result.slices).toEqual([
      { name: "ETH collateral", pct: 100, risk: "low" },
    ]);
    expect(result.metadata).toMatchObject({
      freshnessMode: "unverified",
      details: {
        proofKind: "single-asset-liveness-probe",
        reserveSourceLabel: "ETH collateral",
      },
    });
    expect(result.metadata?.redemption).toBeUndefined();
    expect(result.metadata?.totalReserveUsd).toBeUndefined();
    expect(result.metadata?.supplyUsd).toBeUndefined();
  });

  it("preserves optional coinId and depType in the slice", async () => {
    const { result } = await runJson("tgbp-tokenised", { value: "42" }, {
      label: "USDC backing",
      risk: "very-low",
      coinId: "usdc-circle",
      depType: "wrapper",
      reserveProbe: { kind: "json-path", path: ["value"] },
      supplyProbe: undefined,
      timestampProbe: undefined,
    });
    expect(result.slices).toEqual([
      { name: "USDC backing", pct: 100, risk: "very-low", coinId: "usdc-circle", depType: "wrapper" },
    ]);
  });

  it.each(["0", "0.0"])("throws on '%s' probe value in http-json mode", async (probeValue) => {
    await expect(runJson("tgbp-tokenised", { total_supply: probeValue }, {
      label: "ETH collateral",
      risk: "low",
      reserveProbe: { kind: "json-path", path: ["total_supply"] },
      supplyProbe: undefined,
      timestampProbe: undefined,
    })).rejects.toThrow("zero/empty");
  });

  it("throws when http-json mode has no probe configured", async () => {
    await expect(runJson("tgbp-tokenised", { value: "100" }, {
      reserveProbe: undefined,
      supplyProbe: undefined,
    })).rejects.toThrow("params.reserveProbe or params.supplyProbe");
  });

  it.each([
    { name: "invalid risk value", params: { risk: "invalid-risk" } },
    { name: "label is missing", params: { label: undefined } },
  ])("throws when $name", async ({ params }) => {
    await expect(runJson("tgbp-tokenised", {}, params)).rejects.toThrow("single-asset adapter params invalid");
  });

  it("returns 100% slice in onchain mode when probe succeeds", async () => {
    const { result } = await runOnchain();
    expect(result.slices).toEqual([
      { name: "CNH cash reserves", pct: 100, risk: "very-low" },
    ]);
    expect(result.metadata).toMatchObject({
      freshnessMode: "not-applicable",
      details: {
        proofKind: "erc20-total-supply-liveness",
      },
    });
    expect(result.metadata?.redemption).toBeUndefined();
    expect(result.metadata?.totalReserveUsd).toBeUndefined();
  });

  it("computes reserve and supply metadata when richer json probes are configured", async () => {
    const { result } = await runJson("qcad-stablecorp", {
      totalFiatReserves: "105000000",
      totalSupply: "100000000",
      chains: [{ lastSyncedAt: "2026-03-20T12:00:00Z" }],
    }, {
      label: "Treasury reserve",
      risk: "very-low",
      reserveSourceLabel: "Issuer reserve dashboard",
    });
    expect(result.metadata).toMatchObject({
      totalReserveQuantity: 105000000,
      supplyTokens: 100000000,
      nativeQuantityBasis: {
        reserveUnit: { kind: "currency", unit: "CAD" },
        supplyToken: "QCAD",
        nominalValuePerToken: 1,
      },
      collateralizationRatio: 1.05,
      freshnessMode: "unverified",
      details: {
        proofKind: "reserve-and-supply-probe",
        reserveSourceLabel: "Issuer reserve dashboard",
        chainSupplyObservedAt: Date.parse("2026-03-20T12:00:00Z") / 1000,
      },
    });
    expect(result.metadata?.sourceTimestamp).toBeUndefined();
    expect(result.metadata?.totalReserveUsd).toBeUndefined();
    expect(result.metadata?.supplyUsd).toBeUndefined();
    expect(result.metadata?.redemption).toBeUndefined();
  });

  it("emits a degraded warning when meaningful reserve/supply probes are undercollateralized", async () => {
    const { result } = await runJson("qcad-stablecorp", {
      totalFiatReserves: "99000000",
      totalSupply: "100000000",
      chains: [{ lastSyncedAt: "2026-03-20T12:00:00Z" }],
    });
    expect(result.metadata?.collateralizationRatio).toBe(0.99);
    expect(result.warnings).toEqual([
      expect.objectContaining({
        code: "reserve-undercollateralized",
        effect: "degraded",
      }),
    ]);
  });

  it("keeps a chain timestamp diagnostic instead of certifying whole-reserve freshness", async () => {
    const { result } = await runJson("tgbp-tokenised", {
      data: {
        price: "1.120735576038699094",
        timestamp: "1774874195",
      },
    }, {
      label: "Treasury reserve",
      risk: "very-low",
      reserveProbe: { kind: "json-path", path: ["data", "price"] },
      supplyProbe: undefined,
      timestampProbe: { kind: "json-path", path: ["data", "timestamp"] },
      reserveSourceLabel: "Treasury reserve",
    }, 1_774_874_255);
    expect(result.metadata).toMatchObject({
      freshnessMode: "unverified",
      details: {
        proofKind: "single-asset-liveness-probe",
        reserveSourceLabel: "Treasury reserve",
        chainSupplyObservedAt: 1_774_874_195,
      },
    });
  });

  it.each([undefined, {
    reserveUnit: { kind: "token", unit: "ETH" },
    supplyToken: "unrelated",
    nominalValuePerToken: 1,
    reviewedAt: "2026-03-19",
    evidenceRef: "https://example.com/units",
  }])("withholds a ratio without a supported matching native relation", async (nativeQuantityBasis) => {
    const { result } = await runJson("qcad-stablecorp", {
      totalFiatReserves: "105", totalSupply: "100",
      chains: [{ lastSyncedAt: "2026-03-20T12:00:00Z" }],
    }, { nativeQuantityBasis });
    expect(result.metadata?.totalReserveQuantity).toBe(105);
    expect(result.metadata?.supplyTokens).toBe(100);
    expect(result.metadata?.collateralizationRatio).toBeUndefined();
    expect(result.metadata?.redemption).toBeUndefined();
  });

  it("retains reviewed GBP-native quantities while the binding remains suspended", async () => {
    const { result } = await runJson("tgbp-tokenised", {
      result: { collateral: "101", total_supply: "100" },
    });
    expect(result.metadata).toMatchObject({
      totalReserveQuantity: 101,
      supplyTokens: 100,
      nativeQuantityBasis: { reserveUnit: { kind: "currency", unit: "GBP" } },
      collateralizationRatio: 1.01,
      freshnessMode: "unverified",
    });
    expect(result.metadata?.totalReserveUsd).toBeUndefined();
    expect(result.metadata?.redemption).toBeUndefined();
  });

  it.each([null, "unreadable", "0"])("rejects a malformed configured chain clock: %j", async (lastSyncedAt) => {
    await expect(runJson("qcad-stablecorp", {
      totalFiatReserves: "100", totalSupply: "100", chains: [{ lastSyncedAt }],
    })).rejects.toThrow("unreadable timestamp");
  });

  it("propagates a failed on-chain supply probe", async () => {
    const error = new Error("RPC unavailable");
    const network = installAdapterNetwork({
      chains: { ethereum: "https://rpc.example" },
      rpc: { "ethereum:0x18160ddd": () => { throw error; } },
    });
    await expect(runOnchain(network)).rejects.toThrow("single-asset totalSupply probe failed");
  });
});
