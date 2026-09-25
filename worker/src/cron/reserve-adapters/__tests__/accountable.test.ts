import { afterEach, describe, expect, it, vi } from "vitest";
import type { StablecoinMeta } from "@shared/types/core";
import { adaptAccountableDashboard } from "../accountable";
import type { LiveReservesConfig } from "@shared/types/live-reserves";
import { getReserveAdapter } from "../index";
import { validateAdapterOutput } from "../validate";
import apxusd from "@shared/data/stablecoins/coins/apxusd-apyx.json";
import apxusdReserves from "@shared/data/stablecoins/domains/reserves/apxusd-apyx.json";
import usdu from "@shared/data/stablecoins/coins/usdu-unitas.json";
import yusd from "@shared/data/stablecoins/coins/yusd-aegis.json";
import yzusd from "@shared/data/stablecoins/coins/yzusd-yuzu.json";
import utyxsy from "@shared/data/stablecoins/coins/uty-xsy.json";
import usn from "@shared/data/stablecoins/coins/usn-noon.json";
import {
  ACCOUNTABLE_MAPPING_CASES,
  makeTimestampedYuzuPayload,
  NEUTRL_TYPE_SPLIT_CAPTURE,
  TORI_ASSET_BREAKDOWN_CAPTURE,
  USN_DEPLOYMENT_CAPTURE,
  YUZU_SIGNED_EXPOSURE_CAPTURE,
} from "./accountable.test-support";
import { installAdapterNetwork, runAdapter } from "./reserve-adapter.test-support";

// Production removed NUSD's live config after its endpoint stopped resolving.
// Keep this inline mapping fixture to exercise the reviewed historical
// Accountable shape without re-enabling that production feed.
const NEUTRL_ACCOUNTABLE_TEST_CONFIG: LiveReservesConfig = {
  adapter: "accountable",
  version: 1,
  semantics: "protocol-reserve",
  breakerScope: "nusd-neutrl",
  display: {
    url: "https://accountable.neutrl.finance/",
    label: "Accountable Dashboard",
  },
  inputs: {
    primary: {
      kind: "http-json",
      url: "https://cache.accountable.capital/dashboard/neutrl",
    },
  },
  params: {
    bucket: "type_split",
    riskMap: {
      Stablecoin: "low",
      ETH: "very-low",
      "OTC Aggregate": "high",
      Other: "high",
      JLP: "high",
      "Protocol Owned Liquidity": "high",
    },
    renameMap: {
      Stablecoin: "Stablecoin reserves",
      ETH: "ETH collateral",
      "OTC Aggregate": "OTC aggregate positions",
      Other: "Other reserve assets",
      JLP: "JLP (Jupiter Perps LP token)",
    },
  },
};

async function runAccountablePayload(config: LiveReservesConfig, data: Record<string, unknown>) {
  const primary = config.inputs.primary;
  if (primary.kind !== "http-json") {
    throw new Error("expected Accountable primary input to be http-json");
  }

  const coin = {
    id: config.breakerScope ?? "accountable-test",
    symbol: "TEST",
    liveReservesConfig: config,
  } as StablecoinMeta;
  const { result } = await runAdapter("accountable", coin, {
    network: {
      json: {
        [primary.url]: { res: "ok", data },
      },
    },
  });
  return result;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("adaptAccountableDashboard", () => {
  it.each(ACCOUNTABLE_MAPPING_CASES)("maps $name into reserve slices", (testCase) => {
    const result = adaptAccountableDashboard(
      { res: "ok", data: {
        collateralization: testCase.collateralization,
        ts: testCase.ts,
        reserves: { [testCase.bucket]: testCase.buckets },
      } },
      testCase.params,
    );
    expect(result.slices).toEqual(testCase.expected);
  });

  it("reconciles signed reserves_split buckets without emitting negative reserve slices", () => {
    const result = adaptAccountableDashboard(
      {
        res: "ok",
        data: {
          collateralization: 1,
          ts: "1785150653410",
          reserves: {
            total_reserves: 900,
            reserves_split: [
              { name: "Base", value: 600 },
              { name: "Avalanche", value: 400 },
              { name: "Ethereum", value: -100 },
            ],
          },
        },
      },
      {
        bucket: "reserves_split",
        riskMap: {
          Base: "medium",
          Avalanche: "high",
          Ethereum: "medium",
        },
      },
    );

    expect(result.slices).toEqual([
      { name: "Base", pct: 60, risk: "medium" },
      { name: "Avalanche", pct: 40, risk: "high" },
    ]);
    expect(result.warnings?.map((warning) => warning.code)).toEqual([
      "signed-negative-bucket",
    ]);
    expect(result.metadata).toMatchObject({
      breakdownCount: 3,
      mappedBucketCount: 2,
      signedBucketNames: ["Ethereum"],
      signedBucketValue: -100,
      totalReserves: 900,
    });
  });


  it("retains every USN deployment bucket and the signed same-snapshot residual without changing classifications", async () => {
    const config = usn.liveReservesConfig as LiveReservesConfig;

    const { dashboardTimestamp, totalReserves, deployment } = USN_DEPLOYMENT_CAPTURE;

    const result = await runAccountablePayload(config, {
      collateralization: 1.013786,
      ts: dashboardTimestamp,
      reserves: {
        interval: "live",
        verifiability: "100",
        total_reserves: totalReserves,
        deployment,
      },
    });

    const bucketTotal = Object.values(deployment).reduce((sum, value) => sum + value, 0);
    expect(result.metadata?.deploymentSnapshot).toEqual({
      buckets: Object.entries(deployment).map(([name, value]) => ({ name, value })),
      bucketTotal,
      totalReserves,
      reconciliationResidual: totalReserves - bucketTotal,
      dashboardTimestamp,
    });
    expect(result.metadata).toMatchObject({
      dashboardTimestamp,
      sourceTimestamp: 1_785_194_915,
      freshnessMode: "verified",
    });
    expect(result.slices.filter((slice) => slice.coinId != null)).toEqual([
      expect.objectContaining({
        name: "CLOs (JAAA)",
        coinId: "jaaa-janus-henderson-anemoy",
        depType: "collateral",
        risk: "high",
      }),
    ]);
    expect(result.slices).toContainEqual(expect.objectContaining({
      name: "Other / unmapped Accountable buckets",
      sourceKey: "accountable:noon:deployment:other",
      risk: "high",
    }));
    expect(result.slices).toContainEqual(expect.objectContaining({
      name: "US Treasury Bills",
      sourceKey: "accountable:noon:deployment:us-treasury-bills",
    }));
    expect(result.slices).not.toContainEqual(expect.objectContaining({
      name: "Funding Rate (BTC)",
    }));
  });





  it("preserves unmapped buckets as explicit unknown exposure instead of defaulting them to medium risk", async () => {
    const config: LiveReservesConfig = {
      adapter: "accountable",
      version: 1,
      semantics: "protocol-reserve",
      inputs: { primary: { kind: "http-json", url: "https://example.com" } },
      params: {
        bucket: "type",
        riskMap: { Stablecoin: "low" },
      },
    };

    const result = await runAccountablePayload(config, {
      collateralization: 1.01,
      ts: "2026-03-20T00:00:00Z",
      reserves: {
        type: {
          Stablecoin: 70,
          "New Bucket": 30,
        },
      },
    });

    expect(result.slices).toEqual([
      { name: "Stablecoin", pct: 70, risk: "low" },
      { name: "Unknown / unmapped Accountable buckets", pct: 30, risk: "high" },
    ]);
    expect(result.metadata).toMatchObject({
      unknownBucketCount: 1,
      unknownBucketNames: ["New Bucket"],
      unknownExposurePct: 30,
    });
    expect(result.metadata?.redemption).toBeUndefined();
    expect(validateAdapterOutput(result, { adapter: getReserveAdapter("accountable") ?? undefined }).valid).toBe(true);
    expect(result.warnings?.[0]).toMatchObject({
      code: "unmapped-bucket",
      effect: "degraded",
    });
  });

  it("maps reviewed Apyx own claims out of both sides of the reserve accounting", async () => {
    const result = await runAccountablePayload(apxusd.liveReservesConfig as LiveReservesConfig, {
      collateralization: 1.000102, ts: "1789502434250",
      reserves: {
        total_reserves: 307593129.35, total_supply: 307573514.82,
        inventory: 61062157.37285687, pol: 53894639.55179605,
        reserves_split: [
          { name: "STRC", value: 167094567.4 }, { name: "Inventory", value: 61062157.37 },
          { name: "Protocol Owned Liquidity", value: 53894639.55 },
          { name: "Cash & Equivalents", value: 25534632.39 }, { name: "Other", value: 7132.64 },
        ],
      },
    });
    expect(result.warnings ?? []).toEqual([]);
    expect(result.slices).toEqual(apxusdReserves.reserves.map(({ sourceKey, name, pct, risk }) => ({ sourceKey, name, pct, risk })));
    expect(result.metadata?.collateralizationBasis).toBe("net-of-protocol-owned");
    expect(result.metadata?.collateralizationReconciliation).toMatchObject({ basis: "net-of-protocol-owned", grossRatio: expect.any(Number), netRatio: expect.any(Number) });
    expect(result.metadata?.selfIssuedAccounting).toMatchObject({
      grossReservesUsd: 307593129.35, grossSupplyUsd: 307573514.82,
      netExternalReservesUsd: expect.closeTo(192636332.42534712, 5), netRedeemableClaimsUsd: expect.closeTo(192616717.8953471, 5),
      excludedSelfClaims: [{ name: "Inventory", valueUsd: 61062157.37285687 }, { name: "Protocol Owned Liquidity", valueUsd: 53894639.55179605 }],
    });
  });

  it("fetches the Apyx dashboard through its catalog endpoint", async () => {
    const config = apxusd.liveReservesConfig as LiveReservesConfig;
    const primary = config.inputs.primary;
    if (primary.kind !== "http-json") throw new Error("expected Apyx Accountable input to be http-json");

    const network = installAdapterNetwork({
      json: {
        [primary.url]: {
          res: "ok",
          data: {
            collateralization: 1,
            ts: "1784376607058",
            reserves: {
              total_reserves: 100, total_supply: 100, inventory: 0, pol: 0,
              reserves_split: [{ value: 100, name: "Cash & Equivalents" }, { value: 0, name: "Inventory" }, { value: 0, name: "Protocol Owned Liquidity" }],
            },
          },
        },
      },
    });
    const { result } = await runAdapter("accountable", "apxusd-apyx", {
      network,
      nowSec: 1_784_376_608,
    });

    expect(network.requests.map((request) => request.url)).toEqual([primary.url]);
    expect(result.slices).toEqual([{
      sourceKey: "accountable:apyx:deployment:cash-equivalents",
      name: "Cash & Equivalents (cash, stablecoins, bills and DeFi positions)",
      pct: 100,
      risk: "medium",
    }]);
  });

  it("fails closed when the configured reserve bucket is dropped upstream", async () => {
    const config = apxusd.liveReservesConfig as LiveReservesConfig;

    await expect(runAccountablePayload(config, {
      collateralization: 1,
      ts: "1784376607058",
      reserves: {
        total_reserves: { value: 100, name: "Total Reserves" },
      },
    })).rejects.toThrow(/Unsupported Accountable bucket/);
  });
  it("treats Unitas deployment buckets as the same high-risk strategy basket", async () => {
    const config = usdu.liveReservesConfig as LiveReservesConfig;

    const result = await runAccountablePayload(config, {
      collateralization: 1.059395,
      ts: "1784376513803",
      reserves: {
        interval: "live",
        verifiability: "100",
        total_reserves: { value: 100, name: "Total Reserves" },
        reserves_split: [
          { value: 50.6, name: "Binance" },
          { value: 48.3, name: "Solana" },
          { value: 1.1, name: "Bnb_smartchain" },
        ],
      },
    });

    expect(result.slices).toEqual([
      { sourceKey: "accountable:unitas:deployment:binance", name: "Binance", pct: 50.6, risk: "high" },
      { sourceKey: "accountable:unitas:deployment:solana", name: "Solana", pct: 48.3, risk: "high" },
      { sourceKey: "accountable:unitas:deployment:bnb-smartchain", name: "Bnb_smartchain", pct: 1.1, risk: "high" },
    ]);
  });

  it("fails closed on an unparseable Apyx Accountable reserves_split value", async () => {
    const config = apxusd.liveReservesConfig as LiveReservesConfig;

    await expect(runAccountablePayload(config, {
      collateralization: 1.001022,
      ts: "1780583904415",
      reserves: {
        total_reserves: { value: 476_302_149.26, name: "Total Reserves" },
        reserves_split: [
          { value: -296_181_048.36, name: "STRC" },
          { value: 180_040_870.38, name: "Cash & Equivalents" },
          { value: 0, name: "SATA" },
          { value: "not-a-number", name: "Other" },
        ],
      },
    })).rejects.toThrow(/Accountable reserves_split bucket "Other" has invalid value/);
  });

  it("rejects Apyx Accountable mapped buckets that would be silently dropped as zero", async () => {
    const config = apxusd.liveReservesConfig as LiveReservesConfig;

    await expect(runAccountablePayload(config, {
      collateralization: 1.001022,
      ts: "1780583904415",
      reserves: {
        total_reserves: { value: 180_040_870.38, name: "Total Reserves" },
        total_supply: 180_040_870.38 / 1.001022, inventory: 0, pol: 0,
        reserves_split: [
          { value: 0, name: "STRC" },
          { value: 180_040_870.38, name: "Cash & Equivalents" },
          { value: 0, name: "SATA" },
          { value: 0, name: "Other" },
          { value: 0, name: "Inventory" }, { value: 0, name: "Protocol Owned Liquidity" },
        ],
      },
    })).rejects.toThrow(/zero value: Other, SATA, STRC/);
  });

  it("rejects Accountable bucket totals that materially diverge from total_reserves", () => {
    expect(() => adaptAccountableDashboard(
      {
        res: "ok",
        data: {
          collateralization: 1.01,
          ts: "1773337492853",
          reserves: {
            total_reserves: { value: 1_000, name: "Total Reserves" },
            reserves_split: [
              { name: "Cash & Equivalents", value: 100 },
            ],
          },
        },
      },
      {
        bucket: "reserves_split",
        riskMap: { "Cash & Equivalents": "very-low" },
      },
    )).toThrow(/bucket total 100 does not match total_reserves 1000/);
  });

  it("omits configured Accountable buckets from total_reserves reconciliation and reserve slices", async () => {
    const config = yusd.liveReservesConfig as LiveReservesConfig;

    const result = await runAccountablePayload(config, {
      collateralization: 1.002841,
      ts: "1781948757311",
      reserves: {
        interval: "live",
        verifiability: "100",
        total_reserves: { value: 36_193_106.94, name: "Total Reserves" },
        reserves_split: [
          { value: 26_197_666.041081343, name: "Copper" },
          { value: 9_990_180.9994548, name: "Fireblocks" },
          { value: 591_806.76, name: "Insurance Fund" },
          { value: 5_130.378053203912, name: "Binance" },
          { value: 122.0547387685523, name: "Ethereum Chain" },
          { value: 7.46933060805061, name: "BNB Smart Chain" },
        ],
      },
    });

    expect(result.warnings).toBeUndefined();
    expect(result.metadata).toMatchObject({
      totalReserves: 36_193_106.94,
      totalReservesExcludedBuckets: ["Insurance Fund"],
    });
    expect(result.slices).not.toContainEqual(expect.objectContaining({
      name: "Insurance Fund",
    }));
    const totalPct = result.slices.reduce((sum, slice) => sum + slice.pct, 0);
    expect(totalPct).toBeCloseTo(100, 1);
    expect(validateAdapterOutput(result, {
      adapter: getReserveAdapter("accountable") ?? undefined,
      now: Date.UTC(2026, 5, 20, 10) / 1000,
    }).valid).toBe(true);
  });

  it("maps the current Yuzu Accountable exposure buckets without unknown exposure warnings", async () => {
    const config = yzusd.liveReservesConfig as LiveReservesConfig;

    const result = await runAccountablePayload(config, {
      collateralization: 1.101272,
      ts: "2026-05-11T23:13:49.469Z",
      reserves: {
        exposure_split: {
          "[Securitize]_VBILL_Loop": { value: 10 },
          "[Superstate]_USTB_Loop": { value: 10 },
          "[Ethena]_USDe_Loop": { value: 10 },
          "[Ethena]_USDe": { value: 10 },
          "[Maple]_syrupUSDT_Loop": { value: 10 },
          "Liquidity_Buffer": { value: 10 },
          "[Paypal]_PYUSD_Loop": { value: 10 },
          "[Ethena]_sUSDe_Loop": { value: 10 },
          "[Aave]_USDT": { value: 10 },
          "[Aave]_Gho": { value: 10 },
          "[MegaEth]_USDm": { value: 10 },
          "[Maple]_syrupUSDC_Loop": { value: 10 },
          "[Maple]_syrupUSDT": { value: 10 },
          "[Sky]_PT_sUSDS_Loop": { value: 10 },
          "Rest_of_Assets": { value: 10 },
          "[Aave]_Gho_Savings": { value: 10 },
          "[Paxos]_USDG": { value: 10 },
        },
      },
    });

    expect(result.warnings).toBeUndefined();
    expect(result.metadata).toMatchObject({
      bucket: "exposure_split",
      breakdownCount: 17,
      mappedBucketCount: 17,
    });
    expect(result.metadata?.unknownBucketCount).toBeUndefined();
    expect(result.metadata?.unknownExposurePct).toBeUndefined();
    expect(result.slices).toContainEqual(expect.objectContaining({ name: "Ethena USDe loop", pct: 5.9, risk: "high", coinId: "usde-ethena", depType: "collateral" }));
    expect(result.slices).toContainEqual(expect.objectContaining({ name: "Ethena USDe", pct: 5.9, risk: "high", coinId: "usde-ethena", depType: "collateral" }));
    expect(result.slices).toContainEqual(expect.objectContaining({ name: "Aave GHO", pct: 5.9, risk: "medium", coinId: "gho-aave", depType: "collateral" }));
    expect(result.slices).toContainEqual(expect.objectContaining({ name: "MegaETH USDm", pct: 5.9, risk: "low", coinId: "usdm-mega", depType: "collateral" }));
    expect(result.slices).toContainEqual(expect.objectContaining({ name: "Maple syrupUSDT", pct: 5.9, risk: "medium", coinId: "syrupusdt-maple", depType: "collateral" }));
    expect(result.slices).toContainEqual(expect.objectContaining({ name: "Sky PT sUSDS loop", pct: 5.9, risk: "high", coinId: "susds-sky", depType: "collateral" }));
    expect(result.slices).toContainEqual(expect.objectContaining({ name: "Paxos USDG", pct: 5.9, risk: "low", coinId: "usdg-paxos", depType: "collateral" }));
    expect(validateAdapterOutput(result, {
      adapter: getReserveAdapter("accountable") ?? undefined,
      now: Date.UTC(2026, 4, 12) / 1000,
    }).valid).toBe(true);
  });

  it("maps new Yuzu USDG positions without inventing token links and keeps the dust signed bucket informational", async () => {
    const config = yzusd.liveReservesConfig as LiveReservesConfig;
    const result = await runAccountablePayload(config, makeTimestampedYuzuPayload({
      exposure_split_ts: "2026.09.11 15:47:21 UTC",
      exposure_split: {
        "[Aave]_USDG": { "": 401060.966095 },
        "[Global_Dollar]_PT_USDG_Loop": { "": 1095824.4201706 },
        "[Sky]_sUSDS_Loop": { "": -0.106673148760028 },
        Liquidity_Buffer: { "": 57317555.79365808 },
      },
      timeline: [{ ts: String(Date.parse("2026-09-11T15:47:21Z")), reserves: 59000823.4 }],
    }));
    const aave = result.slices.find((slice) => slice.sourceKey === "accountable:yuzu:deployment:aave-usdg");
    const loop = result.slices.find((slice) => slice.sourceKey === "accountable:yuzu:deployment:global-dollar-pt-usdg-loop");
    expect(aave).toMatchObject({ name: "Aave USDG", risk: "medium" });
    expect(loop).toMatchObject({ name: "Global Dollar USDG Pendle PT loop", risk: "high" });
    for (const slice of [aave, loop]) {
      expect(slice?.coinId).toBeUndefined();
      expect(slice?.depType).toBeUndefined();
    }
    expect(result.warnings?.map((warning) => warning.code)).toEqual(["signed-negative-bucket"]);
    expect(result.warnings?.[0]).toMatchObject({ severity: "info", effect: "info" });
    expect(result.warnings?.[0]?.message).toContain("[Sky]_sUSDS_Loop (0.00% of positive reserve buckets)");
    expect(result.metadata?.sourceTimestamp).toBe(Date.parse("2026-09-11T15:47:21Z") / 1000);
    expect(result.metadata?.unknownBucketCount).toBeUndefined();
  });

  it("keeps sub-material signed exposure informational while material signed exposure still degrades", async () => {
    const config = yzusd.liveReservesConfig as LiveReservesConfig;

    const subMaterial = await runAccountablePayload(config, {
      collateralization: 1,
      ts: "1787848065315",
      reserves: {
        exposure_split: {
          Liquidity_Buffer: { "": 100 },
          "[Sky]_sUSDS_Loop": { "": -4 },
        },
      },
    });
    expect(subMaterial.warnings).toEqual([
      expect.objectContaining({ code: "signed-negative-bucket", severity: "info", effect: "info" }),
    ]);
    expect(subMaterial.slices.map((slice) => slice.name)).toEqual(["Liquidity buffer"]);
    expect(subMaterial.metadata).toMatchObject({ signedBucketNames: ["[Sky]_sUSDS_Loop"], signedBucketValue: -4 });

    const material = await runAccountablePayload(config, {
      collateralization: 1,
      ts: "1787848065315",
      reserves: {
        exposure_split: {
          Liquidity_Buffer: { "": 100 },
          "[Sky]_sUSDS_Loop": { "": -6 },
        },
      },
    });
    expect(material.warnings).toEqual([
      expect.objectContaining({ code: "signed-negative-bucket", severity: "warning", effect: "degraded" }),
    ]);
    expect(material.slices.map((slice) => slice.name)).toEqual(["Liquidity buffer"]);
  });

  it("maps the new Yuzu [Re]_reUSD_LP and [Morpho]_USDC buckets with reviewed classifications", async () => {
    const config = yzusd.liveReservesConfig as LiveReservesConfig;

    const result = await runAccountablePayload(config, {
      collateralization: 1.101272,
      ts: "1781945117382",
      reserves: {
        exposure_split: {
          "[Re]_reUSD_LP": { value: 30 },
          "[Morpho]_USDC": { value: 70 },
        },
      },
    });

    expect(result.warnings).toBeUndefined();
    expect(result.metadata).toMatchObject({
      bucket: "exposure_split",
      breakdownCount: 2,
      mappedBucketCount: 2,
    });
    expect(result.metadata?.unknownBucketCount).toBeUndefined();
    expect(result.slices).toContainEqual(expect.objectContaining({
      sourceKey: "accountable:yuzu:deployment:re-reusd-lp",
      name: "Re reUSD LP",
      pct: 30,
      risk: "high",
      coinId: "reusd-re-protocol",
      depType: "collateral",
    }));
    expect(result.slices).toContainEqual(expect.objectContaining({
      sourceKey: "accountable:yuzu:deployment:morpho-usdc",
      name: "Morpho USDC",
      pct: 70,
      risk: "medium",
      coinId: "usdc-circle",
      depType: "collateral",
    }));
    expect(validateAdapterOutput(result, {
      adapter: getReserveAdapter("accountable") ?? undefined,
      now: Date.UTC(2026, 5, 20, 10) / 1000,
    }).valid).toBe(true);
  });

  it("omits the current signed Yuzu USDG loop bucket without inflating reserve composition", async () => {
    const config = yzusd.liveReservesConfig as LiveReservesConfig;

    const result = await runAccountablePayload(config, {
      collateralization: 1.083117,
      ts: "2026-08-27T00:00:00.000Z",
      reserves: {
        exposure_split: {
          "[Global_Dollar]_USDG_Loop": { "": -15725261.164036 },
          Liquidity_Buffer: { "": 100_000_000 },
        },
      },
    });

    expect(result.slices).toEqual([
      { sourceKey: "accountable:yuzu:deployment:liquidity-buffer", name: "Liquidity buffer", pct: 100, risk: "low", coinId: "usdt-tether", depType: "collateral" },
    ]);
    expect(result.slices).not.toContainEqual(expect.objectContaining({
      name: "Global Dollar USDG loop",
    }));
    expect(result.warnings?.map((warning) => warning.code)).toEqual([
      "signed-negative-bucket",
    ]);
    expect(result.metadata).toMatchObject({
      bucket: "exposure_split",
      breakdownCount: 2,
      mappedBucketCount: 1,
      collateralization: 1.083117,
      reportedCollateralizationRatio: 1.083117,
      signedBucketCount: 1,
      signedBucketNames: ["[Global_Dollar]_USDG_Loop"],
      signedBucketValue: -15725261.164036,
    });
    expect(result.metadata).not.toHaveProperty("collateralizationRatio");
  });

  it("reconciles a timestamped Yuzu exposure split against the nearest contemporaneous timeline total", async () => {
    const config = yzusd.liveReservesConfig as LiveReservesConfig;

    const result = await runAccountablePayload(config, {
      collateralization: 1.088759,
      ts: "1787848065315",
      reserves: {
        total_reserves: { value: 65_497_754.94, name: "Total Backing Assets" },
        total_supply: { value: 60_158_172.36, name: "Total TVL" },
        exposure_split_ts: "2026.08.24 07:31:16 UTC",
        exposure_split: {
          "[Global_Dollar]_USDG_Loop": { "": -15_725_261.164036 },
          Liquidity_Buffer: { "": 79_252_583.394036 },
        },
        timeline: [
          { ts: "not-a-timestamp", reserves: 1 },
          { ts: "1787503607271", reserves: 65_611_285.55 },
          { ts: "1787600794262", reserves: 63_527_322.23 },
          { ts: "1787633192787", reserves: 63_507_487.14 },
        ],
      },
    });

    expect(result.metadata).toMatchObject({
      sourceTimestamp: 1_787_556_676,
      dashboardTimestamp: "1787848065315",
      totalReserves: 65_497_754.94,
      supplyUsd: 60_158_172.36,
      collateralizationBasis: "gross",
      exposureSplitTimestamp: "2026.08.24 07:31:16 UTC",
      exposureSplitTimelineTimestamp: 1_787_600_794,
      exposureSplitTimelineTotalReserves: 63_527_322.23,
    });
    expect(result.slices).toEqual([
      { sourceKey: "accountable:yuzu:deployment:liquidity-buffer", name: "Liquidity buffer", pct: 100, risk: "low", coinId: "usdt-tether", depType: "collateral" },
    ]);
    expect(result.warnings?.map((warning) => warning.code)).toEqual(["signed-negative-bucket"]);
  });

  it("degrades the current signed Yuzu exposure split whose net exceeds the reserve total instead of failing the snapshot", async () => {
    const config = yzusd.liveReservesConfig as LiveReservesConfig;

    // Captured 2026-09-11 from https://cache.accountable.capital/dashboard/yuzu: every
    // exposure_split bucket now wraps its value in an empty-key object, and the Pendle PT loop
    // buckets are signed.
    const result = await runAccountablePayload(config, YUZU_SIGNED_EXPOSURE_CAPTURE);

    expect(result.warnings?.map((warning) => warning.code)).toEqual(["signed-negative-bucket"]);
    expect(result.warnings?.[0]?.message).toContain(
      "signed total is 3449533.41 USD above the reconciled reserve total",
    );
    expect(result.warnings?.[0]?.effect).toBe("degraded");
    expect(result.metadata).toMatchObject({
      bucket: "exposure_split",
      breakdownCount: 23,
      mappedBucketCount: 20,
      signedBucketCount: 3,
      signedBucketNames: [
        "[Ethena]_sUSDe_Pendle_PT_Loop",
        "[Sky]_sUSDS_Loop",
        "[Strata]_srUSDe_Pendle_PT_Loop",
      ],
    });
    expect(result.metadata?.signedBucketTotalResidual).toBeCloseTo(3_449_533.411, 2);
    expect(result.slices.map((slice) => slice.name)).not.toContain("Strata srUSDe Pendle PT loop");
    expect(result.slices.every((slice) => slice.pct > 0)).toBe(true);
    expect(result.slices.reduce((sum, slice) => sum + slice.pct, 0)).toBeCloseTo(100, 1);
  });

  it("uses exposure_split_ts, not the newer dashboard envelope timestamp, for Yuzu freshness", async () => {
    const config = yzusd.liveReservesConfig as LiveReservesConfig;
    const result = await runAccountablePayload(config, makeTimestampedYuzuPayload());

    expect(result.metadata).toMatchObject({
      sourceTimestamp: 1_787_556_676,
      freshnessMode: "verified",
      dashboardTimestamp: "1787848065315",
    });
  });

  it("keeps an approximately 81-hour-old truthful Yuzu exposure timestamp stale under the 3-day policy", async () => {
    const config = yzusd.liveReservesConfig as LiveReservesConfig;
    const result = await runAccountablePayload(config, makeTimestampedYuzuPayload());

    const validation = validateAdapterOutput(result, {
      adapter: getReserveAdapter("accountable") ?? undefined,
      now: Date.UTC(2026, 7, 27, 16, 31, 16) / 1000,
    });
    expect(validation.warnings).toContainEqual(expect.objectContaining({
      code: "stale-source-data",
      effect: "degraded",
    }));
  });

  it("rejects a timestamped Yuzu exposure split that misses the nearest timeline reserve total by more than 1%", async () => {
    const config = yzusd.liveReservesConfig as LiveReservesConfig;

    await expect(runAccountablePayload(config, makeTimestampedYuzuPayload({
      total_reserves: 63_527_322.23,
      total_supply: 63_527_322.23,
      exposure_split: {
        "[Global_Dollar]_USDG_Loop": { "": -15_725_261.164036 },
        Liquidity_Buffer: { "": 79_252_583.394036 },
      },
      timeline: [{ ts: "1787600794262", reserves: 65_000_000 }],
    }))).rejects.toThrow(
      /Accountable exposure_split bucket total 63527322\.23 does not match total_reserves 65000000/,
    );
  });

  it("fails closed when a timestamped Yuzu exposure split has no valid timeline reserve total", async () => {
    const config = yzusd.liveReservesConfig as LiveReservesConfig;

    await expect(runAccountablePayload(config, makeTimestampedYuzuPayload({
      timeline: [
        { ts: "not-a-timestamp", reserves: 1_000 },
        { ts: "1787600794262", reserves: 0 },
      ],
    }))).rejects.toThrow(/no valid timeline reserve total/);
  });

  it("fails closed when the nearest Yuzu timeline reserve total is more than 24 hours away", async () => {
    const config = yzusd.liveReservesConfig as LiveReservesConfig;

    await expect(runAccountablePayload(config, makeTimestampedYuzuPayload({
      timeline: [{ ts: "1787466675000", reserves: 1_000 }],
    }))).rejects.toThrow(/no contemporaneous timeline reserve total/);
  });

  it("keeps current-shaped Yuzu mGLO exposure unlinked while preserving the reviewed risk label", async () => {
    const config = yzusd.liveReservesConfig as LiveReservesConfig;

    const result = await runAccountablePayload(config, {
      collateralization: 1,
      ts: "2026-08-07T05:13:55.000Z",
      reserves: {
        exposure_split: {
          "[Fasanara]_mGLOBAL_Loop": { "": 60 },
          "[Fasanara]_mGLO_Loop": { "": 40 },
        },
      },
    });

    expect(result.slices).toContainEqual(expect.objectContaining({
      name: "Fasanara mGLOBAL loop",
      pct: 60,
      risk: "high",
      coinId: "mglobal-midas-fasanara",
      depType: "collateral",
    }));
    expect(result.slices).toContainEqual({
      sourceKey: "accountable:yuzu:deployment:fasanara-mglo-loop",
      name: "Fasanara mGLO loop",
      pct: 40,
      risk: "high",
    });
    expect(validateAdapterOutput(result, {
      adapter: getReserveAdapter("accountable") ?? undefined,
      now: Date.UTC(2026, 7, 7, 6) / 1000,
    }).valid).toBe(true);
  });

  it("rejects the partial signed Yuzu exposure split when it does not reconcile to total reserves", async () => {
    const config = yzusd.liveReservesConfig as LiveReservesConfig;
    expect(config.params).not.toHaveProperty("skipTotalReservesValidation");

    await expect(runAccountablePayload(config, {
      collateralization: 1.06701,
      ts: "1781945117382",
      reserves: {
        interval: "live",
        verifiability: "100",
        total_reserves: {
          value_rwa: 5_753_096.84,
          name: "Total Backing Assets",
          value: 44_273_802.48,
        },
        exposure_split: {
          "[Securitize]_VBILL_Loop": { "": 123_923.977512 },
          "[Superstate]_USTB_Loop": { "": 4_458_036.0056144 },
          "[Ethena]_USDe_Loop": { "": 4_801_152.47906593 },
          "[Ethena]_USDe": { "": 0.0000000952939047370631 },
          "[Strata]_srUSDe_Pendle_PT_Loop": { "": -1_500_946.168294 },
          "[Maple]_syrupUSDT_Loop": { "": 6_580_976.92964618 },
          "Liquidity_Buffer": { "": 1_050_466.213873575 },
          "[Paypal]_PYUSD_Loop": { "": 8_563_449.832375925 },
          "[Ethena]_sUSDe_Loop": { "": 11_062_254.975953272 },
          "[Aave]_USDT": { "": 491_369.244057127 },
          "[Maple]_syrupUSDC_Loop": { "": 1_378_418.93199401 },
          "[Aave]_RLUSD": { "": 62.3113133180608 },
          "Rest_of_Assets": { "": 870_168.7445106531 },
          "[Yuzu]_yzPRIME": { "": 3_016_917.24160501 },
        },
      },
    })).rejects.toThrow(
      /Accountable exposure_split bucket total .* does not match total_reserves 44273802\.48/,
    );
  });

  it("maps the current Neutrl Accountable type_split buckets including JLP and Protocol Owned Liquidity without unknown exposure warnings", async () => {
    const config = NEUTRL_ACCOUNTABLE_TEST_CONFIG;

    // Latest verifiable Neutrl type_split snapshot: 2026-08-13T11:02:37.520Z.
    const result = await runAccountablePayload(config, NEUTRL_TYPE_SPLIT_CAPTURE);

    expect(result.warnings).toBeUndefined();
    expect(result.metadata).toMatchObject({
      bucket: "type_split",
      breakdownCount: 6,
      mappedBucketCount: 6,
    });
    expect(result.metadata?.unknownBucketCount).toBeUndefined();
    expect(result.metadata?.unknownExposurePct).toBeUndefined();
    expect(result.slices).toContainEqual(expect.objectContaining({
      name: "JLP (Jupiter Perps LP token)",
      risk: "high",
    }));
    expect(result.slices).toContainEqual(expect.objectContaining({
      name: "Protocol Owned Liquidity",
      risk: "high",
    }));
    expect(validateAdapterOutput(result, {
      adapter: getReserveAdapter("accountable") ?? undefined,
      now: Date.UTC(2026, 7, 13, 12) / 1000,
    }).valid).toBe(true);
  });

  it("maps the new Yuzu Accountable [Agora]_PT_AUSD Pendle PT bucket into a mapped reserve slice", async () => {
    const config = yzusd.liveReservesConfig as LiveReservesConfig;

    const result = await runAccountablePayload(config, {
      collateralization: 1.101272,
      ts: "1781945117382",
      reserves: {
        exposure_split: {
          "[Ethena]_USDe_Loop": { value: 80 },
          "[Agora]_PT_AUSD": { value: 20 },
        },
      },
    });

    expect(result.warnings).toBeUndefined();
    expect(result.metadata).toMatchObject({
      bucket: "exposure_split",
      breakdownCount: 2,
      mappedBucketCount: 2,
    });
    expect(result.metadata?.unknownBucketCount).toBeUndefined();
    expect(result.slices).toContainEqual(expect.objectContaining({
      name: "Agora AUSD Pendle PT",
      pct: 20,
      risk: "high",
      coinId: "ausd-agora",
      depType: "collateral",
    }));
    expect(validateAdapterOutput(result, {
      adapter: getReserveAdapter("accountable") ?? undefined,
      now: Date.UTC(2026, 5, 20, 10) / 1000,
    }).valid).toBe(true);
  });

  it("keeps XSY location-only buckets conservative and fully mapped", async () => {
    const config = utyxsy.liveReservesConfig as LiveReservesConfig;

    const result = await runAccountablePayload(config, {
      collateralization: 1.03,
      ts: "1781945117382",
      reserves: {
        reserves_split: [
          { name: "Avalanche", value: 35_000_000 },
          { name: "Copper", value: 5_000_000 },
          { name: "Katana", value: 3_000_000 },
          { name: "Ethereum", value: 2_000_000 },
          { name: "Base", value: 1_500_000 },
          { name: "Plasma", value: 900_000 },
          { name: "Arbitrum", value: 800_000 },
          { name: "Monad", value: 700_000 },
          { name: "Bybit", value: 600_000 },
          { name: "Bnb_smartchain", value: 12.5 },
          { name: "Hyperevm", value: 8.2 },
          { name: "Hyperliquid", value: 4.1 },
          { name: "Megaeth", value: 1.9 },
          { name: "Sei", value: 0.1 },
        ],
      },
    });

    expect(result.warnings).toBeUndefined();
    expect(result.metadata).toMatchObject({
      bucket: "reserves_split",
      breakdownCount: 14,
      mappedBucketCount: 14,
    });
    expect(result.metadata?.unknownBucketCount).toBeUndefined();
    expect(result.metadata?.unknownExposurePct).toBeUndefined();
    expect(result.slices.every((slice) => slice.risk === "high")).toBe(true);
    expect(validateAdapterOutput(result, {
      adapter: getReserveAdapter("accountable") ?? undefined,
      now: Date.UTC(2026, 5, 20, 10) / 1000,
    }).valid).toBe(true);
  });

  it("maps the root-level assetBreakdown layout into reserve slices", () => {
    // Verbatim Tori Accountable dashboard capture: the four strategy categories
    // live at data.assetBreakdown (not data.reserves.type*), and their nested
    // entries sum to the published total_reserves value.
    const result = adaptAccountableDashboard(
      TORI_ASSET_BREAKDOWN_CAPTURE,
      {
        layout: "asset-breakdown",
        riskMap: {
          "Money Markets": "medium",
          "Cash & Equivalents": "medium",
          "Delta-Neutral Futures Arbitrage": "high",
          "On-chain Buffer": "low",
        },
        renameMap: {
          "Money Markets": "Hedged money-market positions at undisclosed custodians (asset-manager mandate)",
          "Delta-Neutral Futures Arbitrage": "Delta-neutral futures arbitrage and calendar-spread positions",
          "Cash & Equivalents": "Cash and equivalents held as FX collateral at investment banks and exchange venues",
          "On-chain Buffer": "On-chain stablecoin buffer in the minting custodian wallet",
        },
      },
    );

    expect(result.slices).toEqual([
      { name: "Hedged money-market positions at undisclosed custodians (asset-manager mandate)", pct: 61.7, risk: "medium" },
      { name: "Delta-neutral futures arbitrage and calendar-spread positions", pct: 26.7, risk: "high" },
      { name: "Cash and equivalents held as FX collateral at investment banks and exchange venues", pct: 10.1, risk: "medium" },
      { name: "On-chain stablecoin buffer in the minting custodian wallet", pct: 1.5, risk: "low" },
    ]);
    expect(result.metadata).toMatchObject({
      bucket: "asset-breakdown",
      layout: "asset-breakdown",
      breakdownCount: 4,
      mappedBucketCount: 4,
      totalReserves: 67_390_916.86,
      sourceTimestamp: 1_788_968_760,
      freshnessMode: "verified",
    });
    expect(result.metadata?.unknownExposurePct).toBeUndefined();
    expect(result.warnings).toBeUndefined();
  });

  it("records unknownExposurePct for unmapped asset-breakdown categories", () => {
    const result = adaptAccountableDashboard(
      {
        res: "ok",
        data: {
          collateralization: 1.01,
          ts: "1788968760934",
          reserves: {
            total_reserves: { value: 100 },
            total_supply: { value: 99 },
          },
          assetBreakdown: {
            "Money Markets": { "Money Market Instruments": { value: 70 } },
            "Undisclosed Custodian Strategy": { "Custodian Positions": { value: 30 } },
          },
        },
      },
      {
        layout: "asset-breakdown",
        riskMap: { "Money Markets": "medium" },
      },
    );

    expect(result.slices).toEqual([
      { name: "Money Markets", pct: 70, risk: "medium" },
      { name: "Unknown / unmapped Accountable buckets", pct: 30, risk: "high" },
    ]);
    expect(result.metadata).toMatchObject({
      bucket: "asset-breakdown",
      layout: "asset-breakdown",
      unknownBucketCount: 1,
      unknownExposurePct: 30,
    });
    expect(result.warnings?.[0]).toMatchObject({
      code: "unmapped-bucket",
      effect: "degraded",
    });
  });
});

