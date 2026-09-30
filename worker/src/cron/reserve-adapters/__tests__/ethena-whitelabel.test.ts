import { describe, expect, it } from "vitest";

import {
  adaptEthenaWhitelabel,
  type EthenaWhitelabelPayload,
} from "../ethena-whitelabel";
import {
  expectValidAdapterOutput,
  expectWarnings,
  runAdapter,
} from "./reserve-adapter.test-support";

const ENDPOINT = "https://whitelabel.ethena.fi/api/transparency";
const NOW_SEC = 1_788_912_032;


/** Live suiUSDe entry: `rows` merges USDe+USDC for display and must never
 *  enter custody accounting. The six-decimal wire ratio is reconciled. */
const SUIUSDE_ENTRY = {
  stablecoin: "suiUSDe",
  partnerName: "suiUSDe",
  totalBacking: 13119708.420237,
  totalSupply: 13096209.619346,
  collateralizationRatio: 1.001794,
  lastUpdated: 1788912026758,
  custodians: [
    { custodian: "Anchorage 2", network: "sui", address: "0x1620", asset: "USDC", amount: 449 },
    { custodian: "Anchorage 3", network: "sui", address: "0x4c8f", asset: "USDC", amount: 18208.262082 },
    { custodian: "Coinbase 1", network: "coinbase_prime", address: "78b14526", asset: "USDC", amount: 2901.362187 },
    { custodian: "Coinbase 2", network: "ethereum", address: "0x79f876", asset: "USDe", amount: 11865522.860536 },
    { custodian: "Coinbase 2", network: "ethereum", address: "0x79f876", asset: "USDC", amount: 1005464.50009 },
    { custodian: "Mint/Redeem", network: "sui", address: "0xffcc05", asset: "USDC", amount: 227162.434342 },
  ],
  rows: [
    { custodian: "Coinbase 2", entries: [{ asset: "USDe/USDC", amount: 12870987.360625999 }] },
    { custodian: "Anchorage 2", entries: [{ asset: "USDC", amount: 449 }] },
  ],
};

const JUPUSD_ENTRY = {
  stablecoin: "jupUSD",
  partnerName: "Jupiter",
  totalBacking: 1,
  totalSupply: 1,
  lastUpdated: 1788912031824,
  custodians: [{ custodian: "Anchorage 1", network: "solana", asset: "USDC", amount: 1 }],
};

const SUIUSDE_PAYLOAD: EthenaWhitelabelPayload = {
  data: [SUIUSDE_ENTRY, JUPUSD_ENTRY],
};

const TOTAL_RESERVE_USD = 11865522.860536 + (449 + 18208.262082 + 1005464.50009 + 227162.434342) + 2901.362187;
const SUPPLY_USD = 13096209.619346;


describe("adaptEthenaWhitelabel", () => {
  it("maps USDe/USDC custodian rows, keeps Coinbase Prime off-chain custody as an unlinked slice, and computes the honest ratio", () => {
    const result = adaptEthenaWhitelabel(SUIUSDE_PAYLOAD, "suiUSDe");

    expect(result.slices).toEqual([
      { sourceKey: "ethena-whitelabel:usde", name: "USDe (Ethena synthetic dollar)", pct: 90.441, risk: "high", coinId: "usde-ethena", depType: "collateral" },
      { sourceKey: "ethena-whitelabel:usdc", name: "USDC cash-equivalent reserves", pct: 9.537, risk: "low", coinId: "usdc-circle", depType: "collateral" },
      { sourceKey: "ethena-whitelabel:off-chain", name: "Coinbase Prime custody (off-chain)", pct: 0.022, risk: "low" },
    ]);

    // The off-chain Coinbase Prime balance is never described as on-chain verified.
    expect(result.warnings).toEqual([
      expect.objectContaining({ code: "off-chain-custody", severity: "info", effect: "info" }),
    ]);
    expect(result.metadata).toMatchObject({
      sourceTimestamp: 1788912026,
      freshnessMode: "verified",
      supplyUsd: SUPPLY_USD,
      details: { lastUpdated: 1788912026758 },
    });
    expect(result.metadata?.totalReserveUsd).toBeCloseTo(TOTAL_RESERVE_USD, 3);
    expect(result.metadata?.collateralizationRatio).toBeCloseTo(TOTAL_RESERVE_USD / SUPPLY_USD, 9);
    expect(result.metadata?.unknownExposurePct).toBeUndefined();
  });

  it("is valid under validateAdapterOutput and the off-chain info warning does not degrade the snapshot", () => {
    const result = adaptEthenaWhitelabel(SUIUSDE_PAYLOAD, "suiUSDe");
    const report = expectValidAdapterOutput("ethena-whitelabel", result, { now: NOW_SEC });
    expect(report.warnings).toEqual([]);
  });

  it("sums `custodians`, never the duplicate `rows` projection, and aggregates repeated asset rows", () => {
    const extraRowsEntry = {
      ...SUIUSDE_ENTRY,
      rows: [
        { custodian: "Coinbase 2", entries: [{ asset: "USDe/USDC", amount: 99_000_000 }] },
        { custodian: "Fake", entries: [{ asset: "USDe", amount: 99_000_000 }] },
      ],
    };
    const withExtraRows: EthenaWhitelabelPayload = {
      data: [extraRowsEntry, JUPUSD_ENTRY],
    };

    const result = adaptEthenaWhitelabel(withExtraRows, "suiUSDe");

    // `rows` carries fabricated amounts that must not affect the composition.
    expect(result.metadata?.totalReserveUsd).toBeCloseTo(TOTAL_RESERVE_USD, 3);
    // Multiple custodians holding USDC collapse into one slice, and Coinbase 2's
    // two asset rows are each attributed to their own asset.
    expect(result.slices).toEqual([
      { sourceKey: "ethena-whitelabel:usde", name: "USDe (Ethena synthetic dollar)", pct: 90.441, risk: "high", coinId: "usde-ethena", depType: "collateral" },
      { sourceKey: "ethena-whitelabel:usdc", name: "USDC cash-equivalent reserves", pct: 9.537, risk: "low", coinId: "usdc-circle", depType: "collateral" },
      { sourceKey: "ethena-whitelabel:off-chain", name: "Coinbase Prime custody (off-chain)", pct: 0.022, risk: "low" },
    ]);
  });

  it("degrades-warns and buckets an unmapped custodian asset instead of failing closed", () => {
    const withUnknownAsset: EthenaWhitelabelPayload = {
      data: [
        {
          ...SUIUSDE_ENTRY,
          totalBacking: TOTAL_RESERVE_USD + 1_000_000,
          collateralizationRatio: (TOTAL_RESERVE_USD + 1_000_000) / SUPPLY_USD,
          custodians: [
            ...SUIUSDE_ENTRY.custodians,
            { custodian: "Test Custodian", network: "ethereum", address: "0xaaaa", asset: "DAI", amount: 1_000_000 },
          ],
        },
      ],
    };

    const result = adaptEthenaWhitelabel(withUnknownAsset, "suiUSDe");

    expect(result.warnings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "unknown-asset", severity: "warning", effect: "degraded" }),
      ]),
    );
    expect(result.slices).toContainEqual(
      expect.objectContaining({ name: "Unmapped suiUSDe backing assets", risk: "high" }),
    );
    expect(result.metadata?.unknownExposurePct).toBeCloseTo((1_000_000 / (TOTAL_RESERVE_USD + 1_000_000)) * 100, 3);
  });

  it("throws when the payload has no entry for the requested stablecoin slug", () => {
    expect(() => adaptEthenaWhitelabel(SUIUSDE_PAYLOAD, "nonexistent")).toThrow("no entry for stablecoin nonexistent");
  });

  it("throws when the payload has no data[] or an unreadable lastUpdated", () => {
    expect(() => adaptEthenaWhitelabel({}, "suiUSDe")).toThrow("missing data[]");
    expect(() =>
      adaptEthenaWhitelabel({ data: [{ ...SUIUSDE_ENTRY, lastUpdated: "" }] }, "suiUSDe"),
    ).toThrow("unreadable lastUpdated");
  });
});

describe("fetchEthenaWhitelabelReserves", () => {
  it("fetches the configured endpoint, parses the stablecoin param, and adapts the selected entry", async () => {
    const { result } = await runAdapter("ethena-whitelabel", "suiusde-sui", {
      network: { json: { [ENDPOINT]: SUIUSDE_PAYLOAD } },
      nowSec: NOW_SEC,
    });

    expect(result.slices[0]).toMatchObject({ name: "USDe (Ethena synthetic dollar)" });
    expectWarnings(result, ["off-chain-custody"]);
  });

  it.each([
    ["missing positive row", { custodians: SUIUSDE_ENTRY.custodians.slice(1) }],
    ["overstated rows", { totalBacking: TOTAL_RESERVE_USD - 100 }],
    ["understated rows", { totalBacking: TOTAL_RESERVE_USD + 100 }],
    ["null headline", { totalBacking: null }],
    ["missing headline", { totalBacking: undefined }],
    ["negative headline", { totalBacking: -1 }],
    ["malformed headline", { totalBacking: "bad" }],
    ["missing ratio", { collateralizationRatio: undefined }],
    ["null ratio", { collateralizationRatio: null }],
    ["negative ratio", { collateralizationRatio: -1 }],
    ["malformed ratio", { collateralizationRatio: "bad" }],
    ["contradictory ratio", { collateralizationRatio: 2 }],
    ["duplicate custody", {
      custodians: [...SUIUSDE_ENTRY.custodians, SUIUSDE_ENTRY.custodians[0]],
      totalBacking: TOTAL_RESERVE_USD + 449,
      collateralizationRatio: (TOTAL_RESERVE_USD + 449) / SUPPLY_USD,
    }],
    ...[null, undefined, "", "bad", -1].map((amount) => [
      `malformed custody amount ${String(amount)}`,
      { custodians: [{ ...SUIUSDE_ENTRY.custodians[0], amount }, ...SUIUSDE_ENTRY.custodians.slice(1)] },
    ] as const),
    ...["network", "address", "asset"].map((field) => [
      `missing custody ${field}`,
      { custodians: [{ ...SUIUSDE_ENTRY.custodians[0], [field]: "" }, ...SUIUSDE_ENTRY.custodians.slice(1)] },
    ] as const),
  ] as const)("rejects %s through the fetch boundary", async (_label, patch) => {
    await expect(runAdapter("ethena-whitelabel", "suiusde-sui", {
      network: { json: { [ENDPOINT]: { data: [{ ...SUIUSDE_ENTRY, ...patch }] } } },
      nowSec: NOW_SEC,
    })).rejects.toThrow();
  });

  it.each([0.00000049, -0.00000049, 0.00000051, -0.00000051])("enforces six-decimal wire ratio tolerance at %s", async (delta) => {
    const request = runAdapter("ethena-whitelabel", "suiusde-sui", {
      network: { json: { [ENDPOINT]: { data: [{
        ...SUIUSDE_ENTRY,
        collateralizationRatio: TOTAL_RESERVE_USD / SUPPLY_USD + delta,
      }] } } },
      nowSec: NOW_SEC,
    });
    if (Math.abs(delta) > 0.0000005) {
      await expect(request).rejects.toThrow();
    } else {
      const { result } = await request;
      expect(result.metadata?.collateralizationRatio).toBeCloseTo(TOTAL_RESERVE_USD / SUPPLY_USD, 12);
      expectValidAdapterOutput("ethena-whitelabel", result, { now: NOW_SEC });
    }
  });

  it.each([0.001, -0.001, 0.009, -0.009])("accepts rounding-only backing delta %s without changing custody values", async (delta) => {
    const totalBacking = TOTAL_RESERVE_USD + delta;
    const { result } = await runAdapter("ethena-whitelabel", "suiusde-sui", {
      network: { json: { [ENDPOINT]: { data: [{
        ...SUIUSDE_ENTRY,
        totalBacking,
        collateralizationRatio: Number((totalBacking / SUPPLY_USD).toFixed(6)),
      }] } } },
      nowSec: NOW_SEC,
    });
    expect(result.metadata?.totalReserveUsd).toBeCloseTo(TOTAL_RESERVE_USD, 6);
    expect(result.metadata?.details).toMatchObject({ sourceTotalBackingUsd: totalBacking });
    expectValidAdapterOutput("ethena-whitelabel", result, { now: NOW_SEC });
    expectWarnings(result, ["off-chain-custody"]);
  });

  it.each([0.011, -0.011])("rejects backing delta beyond rounding tolerance %s", async (delta) => {
    await expect(runAdapter("ethena-whitelabel", "suiusde-sui", {
      network: { json: { [ENDPOINT]: { data: [{ ...SUIUSDE_ENTRY, totalBacking: TOTAL_RESERVE_USD + delta }] } } },
      nowSec: NOW_SEC,
    })).rejects.toThrow();
  });

  it("retains a reconciled undercollateralized mix with a degrading warning and observed zero row", async () => {
    const { result } = await runAdapter("ethena-whitelabel", "suiusde-sui", {
      network: { json: { [ENDPOINT]: { data: [{
        ...SUIUSDE_ENTRY,
        totalSupply: TOTAL_RESERVE_USD * 2,
        collateralizationRatio: 0.5,
        custodians: [...SUIUSDE_ENTRY.custodians, {
          custodian: "Empty custody", network: "ethereum", address: "0xbbbb", asset: "USDC", amount: 0,
        }],
      }] } } },
      nowSec: NOW_SEC,
    });
    expect(result.metadata?.collateralizationRatio).toBe(0.5);
    expect(result.slices.find((slice) => slice.coinId === "usde-ethena")?.pct).toBe(90.441);
    expect(result.warnings).toContainEqual(expect.objectContaining({ code: "reserve-undercollateralized", effect: "degraded" }));
    expectValidAdapterOutput("ethena-whitelabel", result, { now: NOW_SEC });
  });

  it("propagates an error when the endpoint request fails", async () => {
    await expect(runAdapter("ethena-whitelabel", "suiusde-sui", {
      network: { json: { [ENDPOINT]: { status: 500, json: {} } } },
      nowSec: NOW_SEC,
    })).rejects.toThrow();
  });
});
