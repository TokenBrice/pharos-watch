import { describe, expect, it } from "vitest";
import { adaptAccountableDashboard } from "../accountable";
import type { LiveReservesConfig } from "@shared/types/live-reserves";
import { fetchAccountableReserves } from "../accountable";
import { getReserveAdapter } from "../index";
import { validateAdapterOutput } from "../validate";
import apxusd from "@shared/data/stablecoins/coins/apxusd-apyx.json";
import usdu from "@shared/data/stablecoins/coins/usdu-unitas.json";
import yusd from "@shared/data/stablecoins/coins/yusd-aegis.json";
import yzusd from "@shared/data/stablecoins/coins/yzusd-yuzu.json";
import nusd from "@shared/data/stablecoins/coins/nusd-neutrl.json";
import utyxsy from "@shared/data/stablecoins/coins/uty-xsy.json";
import usn from "@shared/data/stablecoins/coins/usn-noon.json";

const signal = AbortSignal.timeout(5_000);

describe("adaptAccountableDashboard", () => {
  it("maps the type breakdown into reserve slices", () => {
    const slices = adaptAccountableDashboard(
      {
        res: "ok",
        data: {
          collateralization: 1.0595,
          ts: "1773304804848",
          reserves: {
            type: {
              "Liquid Bonds": 8_971_650.68,
              "Short Term Cash": 4_398_374.55,
            },
          },
        },
      },
      {
        bucket: "type",
        riskMap: {
          "Liquid Bonds": "high",
          "Short Term Cash": "very-low",
        },
      },
    );

    expect(slices.slices).toEqual([
      { name: "Liquid Bonds", pct: 67.1, risk: "high" },
      { name: "Short Term Cash", pct: 32.9, risk: "very-low" },
    ]);
  });

  it("maps the reserves_split breakdown into reserve slices", () => {
    const slices = adaptAccountableDashboard(
      {
        res: "ok",
        data: {
          collateralization: 1.00007,
          ts: "1773337492853",
          reserves: {
            reserves_split: [
              { name: "Copper", value: 28_058_537.09 },
              { name: "Fireblocks", value: 9_964_626 },
              { name: "Insurance Fund", value: 656_796.7 },
              { name: "Insurance Fund Usage", value: 20_000 },
              { name: "Binance", value: 1_181.38 },
              { name: "Ethereum Chain", value: 7.96 },
            ],
          },
        },
      },
      {
        bucket: "reserves_split",
        riskMap: {
          Copper: "medium",
          Fireblocks: "medium",
          "Insurance Fund": "low",
          "Insurance Fund Usage": "very-high",
          Binance: "high",
        },
      },
    );

    expect(slices.slices).toEqual([
      { name: "Copper", pct: 72.5, risk: "medium" },
      { name: "Fireblocks", pct: 25.7, risk: "medium" },
      { name: "Insurance Fund", pct: 1.7, risk: "low" },
      { name: "Insurance Fund Usage", pct: 0.1, risk: "very-high" },
    ]);
  });

  it("reconciles reviewed signed reserves_split buckets without emitting negative reserve slices", () => {
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
        allowNegativeBuckets: ["Ethereum"],
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

  it("maps deployment object buckets into reserve slices", () => {
    const slices = adaptAccountableDashboard(
      {
        res: "ok",
        data: {
          collateralization: 1.013,
          ts: "1773337732067",
          reserves: {
            deployment: {
              "Private Credit (Fasanara FTAC)": 60,
              "DeFi Lending": 20,
              "CLOs (JAAA)": 15,
              "Funding Rate (BTC)": 5,
            },
          },
        },
      },
      {
        bucket: "deployment",
        riskMap: {
          "Private Credit (Fasanara FTAC)": "high",
          "DeFi Lending": "medium",
          "CLOs (JAAA)": "high",
          "Funding Rate (BTC)": "high",
        },
      },
    );

    expect(slices.slices).toEqual([
      { name: "Private Credit (Fasanara FTAC)", pct: 60, risk: "high" },
      { name: "DeFi Lending", pct: 20, risk: "medium" },
      { name: "CLOs (JAAA)", pct: 15, risk: "high" },
      { name: "Funding Rate (BTC)", pct: 5, risk: "high" },
    ]);
  });

  it("retains every USN deployment bucket and the signed same-snapshot residual without changing classifications", async () => {
    const config = usn.liveReservesConfig as LiveReservesConfig;
    const primary = config.inputs.primary;
    if (primary.kind !== "http-json") {
      throw new Error("expected Noon Accountable primary input to be http-json");
    }

    const dashboardTimestamp = "1785194915915";
    const totalReserves = 34_400_188.21;
    const deployment = {
      "Private Credit (Fasanara FTAC)": 24_486_151.98,
      "DeFi Lending": 3_521_782.048151,
      "US Treasury Bills": 2_748_703.094363,
      Other: 1_844_795.0026801375,
      "CLOs (JAAA)": 1_798_755.11936221,
      "Funding Rate (BTC)": 0.9612150669,
    };

    const result = await fetchAccountableReserves(
      {} as never,
      config,
      signal,
      {
        requestCache: new Map([
          [`json-get:${primary.url}:12000:null`, Promise.resolve({
            res: "ok",
            data: {
              collateralization: 1.013786,
              ts: dashboardTimestamp,
              reserves: {
                interval: "live",
                verifiability: "100",
                total_reserves: totalReserves,
                deployment,
              },
            },
          })],
        ]),
      },
    );

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
      risk: "high",
    }));
    expect(result.slices).not.toContainEqual(expect.objectContaining({
      name: "Funding Rate (BTC)",
    }));
  });

  it("maps type_split buckets and applies renameMap", () => {
    const slices = adaptAccountableDashboard(
      {
        res: "ok",
        data: {
          collateralization: 1.01,
          ts: "1773337561984",
          reserves: {
            type_split: {
              Stablecoin: 220,
              ETH: 10,
              "OTC Aggregate": 15,
              Other: 5,
            },
          },
        },
      },
      {
        bucket: "type_split",
        riskMap: {
          Stablecoin: "low",
          ETH: "very-low",
          "OTC Aggregate": "high",
          Other: "high",
        },
        renameMap: {
          Stablecoin: "Stablecoin reserves",
        },
      },
    );

    expect(slices.slices).toEqual([
      { name: "Stablecoin reserves", pct: 88, risk: "low" },
      { name: "OTC Aggregate", pct: 6, risk: "high" },
      { name: "ETH", pct: 4, risk: "very-low" },
      { name: "Other", pct: 2, risk: "high" },
    ]);
  });

  it("applies renameMap exactly once even when a renamed value is itself a rename key", () => {
    // "A" renames to "B", and "B" is also a renameMap key ("B" -> "C").
    // The rename must resolve "A" -> "B" once; it must NOT cascade to "C".
    const slices = adaptAccountableDashboard(
      {
        res: "ok",
        data: {
          collateralization: 1.0,
          ts: "1773304804848",
          reserves: {
            type: {
              A: 60,
              B: 40,
            },
          },
        },
      },
      {
        bucket: "type",
        riskMap: {
          A: "low",
          B: "high",
        },
        renameMap: {
          A: "B",
          B: "C",
        },
      },
    );

    expect(slices.slices).toEqual([
      { name: "B", pct: 60, risk: "low" },
      { name: "C", pct: 40, risk: "high" },
    ]);
  });

  it("maps nested exposure_split values into reserve slices", () => {
    const slices = adaptAccountableDashboard(
      {
        res: "ok",
        data: {
          collateralization: 1.06,
          ts: "1773336724281",
          reserves: {
            exposure_split: {
              "[Ethena]_sUSDe_Loop": { "": 50 },
              "[Maple]_syrupUSDT_Loop": { "": 30 },
              "[Fluid]_fUSDT0": { "": 20 },
            },
          },
        },
      },
      {
        bucket: "exposure_split",
        riskMap: {
          "[Ethena]_sUSDe_Loop": "high",
          "[Maple]_syrupUSDT_Loop": "high",
          "[Fluid]_fUSDT0": "low",
        },
        renameMap: {
          "[Fluid]_fUSDT0": "Fluid fUSDT0",
        },
      },
    );

    expect(slices.slices).toEqual([
      { name: "[Ethena]_sUSDe_Loop", pct: 50, risk: "high" },
      { name: "[Maple]_syrupUSDT_Loop", pct: 30, risk: "high" },
      { name: "Fluid fUSDT0", pct: 20, risk: "low" },
    ]);
  });

  it("maps product-scoped protocol_split values into reserve slices", () => {
    const slices = adaptAccountableDashboard(
      {
        res: "ok",
        data: {
          collateralization: 1.002,
          ts: "1778509189684",
          reserves: {
            protocol_split: {
              hoUSDT: { hoUSDT: 3_676_711.58 },
              USDT0: { USDT0: 25_184.45 },
              USDC: { Morpho: 586_637.21 },
              masterUSD: { masterUSD: 2_001_257.2 },
            },
          },
        },
      },
      {
        bucket: "protocol_split",
        riskMap: {
          hoUSDT: "high",
          USDT0: "low",
          USDC: "medium",
          masterUSD: "high",
        },
        coinIdMap: {
          hoUSDT: "usdt-tether",
          USDT0: "usdt-tether",
          USDC: "usdc-circle",
        },
        depTypeMap: {
          hoUSDT: "wrapper",
          USDT0: "wrapper",
          USDC: "collateral",
        },
        renameMap: {
          hoUSDT: "hoUSDT strategy exposure",
          USDT0: "USDT0 reserves",
          USDC: "Morpho USDC lending exposure",
          masterUSD: "masterUSD strategy exposure",
        },
      },
    );

    expect(slices.slices).toEqual([
      { name: "hoUSDT strategy exposure", pct: 58.5, risk: "high", coinId: "usdt-tether", depType: "wrapper" },
      { name: "masterUSD strategy exposure", pct: 31.8, risk: "high" },
      { name: "Morpho USDC lending exposure", pct: 9.3, risk: "medium", coinId: "usdc-circle", depType: "collateral" },
      { name: "USDT0 reserves", pct: 0.4, risk: "low", coinId: "usdt-tether", depType: "wrapper" },
    ]);
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

    const result = await fetchAccountableReserves(
      {} as never,
      config,
      signal,
      {
        requestCache: new Map([
          ["json-get:https://example.com:12000:null", Promise.resolve({
            res: "ok",
            data: {
              collateralization: 1.01,
              ts: "2026-03-20T00:00:00Z",
              reserves: {
                type: {
                  Stablecoin: 70,
                  "New Bucket": 30,
                },
              },
            },
          })],
        ]),
      },
    );

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

  it("maps the reviewed Apyx Accountable reserves_split into STRC-heavy apxUSD slices", async () => {
    const config = apxusd.liveReservesConfig as LiveReservesConfig;
    const primary = config.inputs.primary;
    if (primary.kind !== "http-json") {
      throw new Error("expected Apyx Accountable primary input to be http-json");
    }
    const url = primary.url;

    const result = await fetchAccountableReserves(
      {} as never,
      config,
      signal,
      {
        requestCache: new Map([
          [`json-get:${url}:12000:null`, Promise.resolve({
            res: "ok",
            data: {
              collateralization: 0.881615,
              ts: "1784376607058",
              reserves: {
                interval: "live",
                verifiability: "100",
                total_reserves: { value: 1_000, name: "Total Reserves" },
                reserves_split: [
                  { value: 612, name: "STRC" },
                  { value: 158, name: "Protocol Owned Liquidity" },
                  { value: 100, name: "Cash & Equivalents" },
                  { value: 130, name: "Inventory" },
                ],
              },
            },
          })],
        ]),
      },
    );

    expect(result.warnings).toEqual([{
      code: "reserve-undercollateralized",
      message: "Accountable dashboard reports 88.16% collateralization",
      severity: "warning",
      effect: "degraded",
    }]);
    expect(result.metadata).toMatchObject({
      bucket: "reserves_split",
      breakdownCount: 4,
      mappedBucketCount: 4,
      totalReserves: 1_000,
      collateralization: 0.881615,
      collateralizationRatio: 0.881615,
    });
    expect(result.slices).toEqual([
      { name: "STRC (Strategy preferred equity, BTC-linked)", pct: 61.2, risk: "high" },
      { name: "Protocol Owned Liquidity", pct: 15.8, risk: "high" },
      { name: "Inventory", pct: 13, risk: "high" },
      { name: "Cash & Equivalents (USDC, U.S. Treasury Bills)", pct: 10, risk: "very-low" },
    ]);
    expect(apxusd.reserves.map(({ name, pct, risk }) => ({ name, pct, risk }))).toEqual(result.slices);
    expect(validateAdapterOutput(result, {
      adapter: getReserveAdapter("accountable") ?? undefined,
      now: Date.UTC(2026, 6, 18, 14) / 1000,
    }).valid).toBe(true);
  });

  it("treats Unitas deployment buckets as the same high-risk strategy basket", async () => {
    const config = usdu.liveReservesConfig as LiveReservesConfig;
    const primary = config.inputs.primary;
    if (primary.kind !== "http-json") {
      throw new Error("expected Unitas Accountable primary input to be http-json");
    }

    const result = await fetchAccountableReserves(
      {} as never,
      config,
      signal,
      {
        requestCache: new Map([
          [`json-get:${primary.url}:12000:null`, Promise.resolve({
            res: "ok",
            data: {
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
            },
          })],
        ]),
      },
    );

    expect(result.slices).toEqual([
      { name: "Binance", pct: 50.6, risk: "high" },
      { name: "Solana", pct: 48.3, risk: "high" },
      { name: "Bnb_smartchain", pct: 1.1, risk: "high" },
    ]);
  });

  it("rejects poisoned Apyx Accountable mapped buckets before reserve slice normalization", async () => {
    const config = apxusd.liveReservesConfig as LiveReservesConfig;
    const primary = config.inputs.primary;
    if (primary.kind !== "http-json") {
      throw new Error("expected Apyx Accountable primary input to be http-json");
    }
    const url = primary.url;

    await expect(fetchAccountableReserves(
      {} as never,
      config,
      signal,
      {
        requestCache: new Map([
          [`json-get:${url}:12000:null`, Promise.resolve({
            res: "ok",
            data: {
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
            },
          })],
        ]),
      },
    )).rejects.toThrow(/Accountable reserves_split bucket "STRC" has invalid value/);
  });

  it("rejects Apyx Accountable mapped buckets that would be silently dropped as zero", async () => {
    const config = apxusd.liveReservesConfig as LiveReservesConfig;
    const primary = config.inputs.primary;
    if (primary.kind !== "http-json") {
      throw new Error("expected Apyx Accountable primary input to be http-json");
    }
    const url = primary.url;

    await expect(fetchAccountableReserves(
      {} as never,
      config,
      signal,
      {
        requestCache: new Map([
          [`json-get:${url}:12000:null`, Promise.resolve({
            res: "ok",
            data: {
              collateralization: 1.001022,
              ts: "1780583904415",
              reserves: {
                total_reserves: { value: 180_040_870.38, name: "Total Reserves" },
                reserves_split: [
                  { value: 0, name: "STRC" },
                  { value: 180_040_870.38, name: "Cash & Equivalents" },
                  { value: 0, name: "SATA" },
                  { value: 0, name: "Other" },
                ],
              },
            },
          })],
        ]),
      },
    )).rejects.toThrow(/non-positive value: Other, SATA, STRC/);
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
    const primary = config.inputs.primary;
    if (primary.kind !== "http-json") {
      throw new Error("expected Aegis Accountable primary input to be http-json");
    }
    const url = primary.url;

    const result = await fetchAccountableReserves(
      {} as never,
      config,
      signal,
      {
        requestCache: new Map([
          [`json-get:${url}:12000:null`, Promise.resolve({
            res: "ok",
            data: {
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
            },
          })],
        ]),
      },
    );

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
    const primary = config.inputs.primary;
    if (primary.kind !== "http-json") {
      throw new Error("expected Yuzu Accountable primary input to be http-json");
    }
    const url = primary.url;

    const result = await fetchAccountableReserves(
      {} as never,
      config,
      signal,
      {
        requestCache: new Map([
          [`json-get:${url}:12000:null`, Promise.resolve({
            res: "ok",
            data: {
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
                  "[Sky]_SUSDS_Loop": { value: 10 },
                  "Rest_of_Assets": { value: 10 },
                  "[Aave]_Gho_Savings": { value: 10 },
                  "[Paxos]_USDG": { value: 10 },
                },
              },
            },
          })],
        ]),
      },
    );

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
    expect(result.slices).toContainEqual(expect.objectContaining({ name: "Sky sUSDS loop", pct: 5.9, risk: "high", coinId: "susds-sky", depType: "collateral" }));
    expect(result.slices).toContainEqual(expect.objectContaining({ name: "Paxos USDG", pct: 5.9, risk: "low", coinId: "usdg-paxos", depType: "collateral" }));
    expect(validateAdapterOutput(result, {
      adapter: getReserveAdapter("accountable") ?? undefined,
      now: Date.UTC(2026, 4, 12) / 1000,
    }).valid).toBe(true);
  });

  it("records signed Yuzu Accountable exposure buckets as degraded warnings instead of failing the adapter", async () => {
    const config = yzusd.liveReservesConfig as LiveReservesConfig;
    const primary = config.inputs.primary;
    if (primary.kind !== "http-json") {
      throw new Error("expected Yuzu Accountable primary input to be http-json");
    }
    const url = primary.url;

    const result = await fetchAccountableReserves(
      {} as never,
      config,
      signal,
      {
        requestCache: new Map([
          [`json-get:${url}:12000:null`, Promise.resolve({
            res: "ok",
            data: {
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
            },
          })],
        ]),
      },
    );

    expect(result.warnings?.map((warning) => warning.code).sort()).toEqual([
      "signed-negative-bucket",
      "total-reserves-unreconciled",
    ]);
    expect(result.metadata).toMatchObject({
      bucket: "exposure_split",
      breakdownCount: 14,
      mappedBucketCount: 13,
      signedBucketNames: ["[Strata]_srUSDe_Pendle_PT_Loop"],
      totalReservesValidationSkipped: true,
    });
    expect(result.metadata?.unknownBucketCount).toBeUndefined();
    expect(result.metadata?.unknownExposurePct).toBeUndefined();
    expect(result.slices).not.toContainEqual(expect.objectContaining({
      name: "Strata srUSDe Pendle PT loop",
    }));
    expect(result.slices).toContainEqual(expect.objectContaining({
      name: "PayPal PYUSD loop",
      risk: "high",
      coinId: "pyusd-paypal",
      depType: "collateral",
    }));
    expect(validateAdapterOutput(result, {
      adapter: getReserveAdapter("accountable") ?? undefined,
      now: Date.UTC(2026, 5, 20, 10) / 1000,
    }).valid).toBe(true);
  });

  it("maps the current Neutrl Accountable type_split buckets including JLP and Protocol Owned Liquidity without unknown exposure warnings", async () => {
    const config = nusd.liveReservesConfig as LiveReservesConfig;
    const primary = config.inputs.primary;
    if (primary.kind !== "http-json") {
      throw new Error("expected Neutrl Accountable primary input to be http-json");
    }
    const url = primary.url;

    const result = await fetchAccountableReserves(
      {} as never,
      config,
      signal,
      {
        requestCache: new Map([
          [`json-get:${url}:12000:null`, Promise.resolve({
            res: "ok",
            data: {
              collateralization: 1.02,
              ts: "1781945117382",
              reserves: {
                type_split: {
                  Stablecoin: 800,
                  ETH: 50,
                  "OTC Aggregate": 34,
                  Other: 31,
                  JLP: 60,
                  "Protocol Owned Liquidity": 25,
                },
              },
            },
          })],
        ]),
      },
    );

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
      now: Date.UTC(2026, 5, 20, 10) / 1000,
    }).valid).toBe(true);
  });

  it("maps the new Yuzu Accountable [Agora]_PT_AUSD Pendle PT bucket into a mapped reserve slice", async () => {
    const config = yzusd.liveReservesConfig as LiveReservesConfig;
    const primary = config.inputs.primary;
    if (primary.kind !== "http-json") {
      throw new Error("expected Yuzu Accountable primary input to be http-json");
    }
    const url = primary.url;

    const result = await fetchAccountableReserves(
      {} as never,
      config,
      signal,
      {
        requestCache: new Map([
          [`json-get:${url}:12000:null`, Promise.resolve({
            res: "ok",
            data: {
              collateralization: 1.101272,
              ts: "1781945117382",
              reserves: {
                exposure_split: {
                  "[Ethena]_USDe_Loop": { value: 80 },
                  "[Agora]_PT_AUSD": { value: 20 },
                },
              },
            },
          })],
        ]),
      },
    );

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

  it("maps XSY Accountable chain-name buckets including the new Bnb_smartchain/Hyperevm/Hyperliquid/Megaeth deployments without unknown exposure warnings", async () => {
    const config = utyxsy.liveReservesConfig as LiveReservesConfig;
    const primary = config.inputs.primary;
    if (primary.kind !== "http-json") {
      throw new Error("expected XSY Accountable primary input to be http-json");
    }
    const url = primary.url;

    const result = await fetchAccountableReserves(
      {} as never,
      config,
      signal,
      {
        requestCache: new Map([
          [`json-get:${url}:12000:null`, Promise.resolve({
            res: "ok",
            data: {
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
                ],
              },
            },
          })],
        ]),
      },
    );

    expect(result.warnings).toBeUndefined();
    expect(result.metadata).toMatchObject({
      bucket: "reserves_split",
      breakdownCount: 13,
      mappedBucketCount: 13,
    });
    expect(result.metadata?.unknownBucketCount).toBeUndefined();
    expect(result.metadata?.unknownExposurePct).toBeUndefined();
    expect(validateAdapterOutput(result, {
      adapter: getReserveAdapter("accountable") ?? undefined,
      now: Date.UTC(2026, 5, 20, 10) / 1000,
    }).valid).toBe(true);
  });
});
