import { describe, expect, it } from "vitest";
import { adaptAccountableTypeBreakdown } from "../accountable";

describe("adaptAccountableTypeBreakdown", () => {
  it("maps the type breakdown into reserve slices", () => {
    const slices = adaptAccountableTypeBreakdown(
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

    expect(slices).toEqual([
      { name: "Liquid Bonds", pct: 67.1, risk: "high" },
      { name: "Short Term Cash", pct: 32.9, risk: "very-low" },
    ]);
  });

  it("maps the reserves_split breakdown into reserve slices", () => {
    const slices = adaptAccountableTypeBreakdown(
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

    expect(slices).toEqual([
      { name: "Copper", pct: 72.5, risk: "medium" },
      { name: "Fireblocks", pct: 25.7, risk: "medium" },
      { name: "Insurance Fund", pct: 1.7, risk: "low" },
      { name: "Insurance Fund Usage", pct: 0.1, risk: "very-high" },
    ]);
  });

  it("maps deployment object buckets into reserve slices", () => {
    const slices = adaptAccountableTypeBreakdown(
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

    expect(slices).toEqual([
      { name: "Private Credit (Fasanara FTAC)", pct: 60, risk: "high" },
      { name: "DeFi Lending", pct: 20, risk: "medium" },
      { name: "CLOs (JAAA)", pct: 15, risk: "high" },
      { name: "Funding Rate (BTC)", pct: 5, risk: "high" },
    ]);
  });

  it("maps type_split buckets and applies renameMap", () => {
    const slices = adaptAccountableTypeBreakdown(
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
          ETH: "medium",
          "OTC Aggregate": "high",
          Other: "high",
        },
        renameMap: {
          Stablecoin: "Stablecoin reserves",
        },
      },
    );

    expect(slices).toEqual([
      { name: "Stablecoin reserves", pct: 88, risk: "low" },
      { name: "ETH", pct: 4, risk: "medium" },
      { name: "OTC Aggregate", pct: 6, risk: "high" },
      { name: "Other", pct: 2, risk: "high" },
    ]);
  });

  it("maps nested exposure_split values into reserve slices", () => {
    const slices = adaptAccountableTypeBreakdown(
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

    expect(slices).toEqual([
      { name: "[Ethena]_sUSDe_Loop", pct: 50, risk: "high" },
      { name: "[Maple]_syrupUSDT_Loop", pct: 30, risk: "high" },
      { name: "Fluid fUSDT0", pct: 20, risk: "low" },
    ]);
  });
});
