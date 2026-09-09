import { describe, expect, it, vi, beforeEach } from "vitest";
import type { StablecoinMeta } from "@shared/types/core";
import type { LiveReservesConfig } from "@shared/types/live-reserves";

vi.mock("../helpers", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../helpers")>();
  return {
    ...actual,
    fetchJsonAdapterInput: vi.fn(),
  };
});

import {
  adaptEthenaWhitelabel,
  fetchEthenaWhitelabelReserves,
  type EthenaWhitelabelPayload,
} from "../ethena-whitelabel";
import { fetchJsonAdapterInput } from "../helpers";
import {
  expectValidAdapterOutput,
  mockedReserveHelper,
} from "./reserve-adapter.test-support";

let signal: AbortSignal;

function makeCoin(): StablecoinMeta {
  return { id: "suiusde-sui", name: "eSui Dollar", ticker: "suiUSDe" } as unknown as StablecoinMeta;
}

function makeConfig(): LiveReservesConfig {
  return {
    adapter: "ethena-whitelabel",
    version: 1,
    semantics: "collateral-mix",
    inputs: {
      primary: { kind: "http-json", url: "https://whitelabel.ethena.fi/api/transparency" },
    },
    params: { stablecoin: "suiUSDe" },
  } as unknown as LiveReservesConfig;
}

/** Verbatim mirror of the live suiUSDe entry, including the wire-only
 *  `partnerName` / `collateralizationRatio` fields and the `rows` display
 *  projection that merges USDe+USDC under Coinbase 2 into a single
 *  "USDe/USDC" row. The adapter type deliberately omits those fields (it must
 *  never sum `rows`), so the raw entries keep their inferred shape and only
 *  the assembled payload asserts `EthenaWhitelabelPayload`. */
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

beforeEach(() => {
  vi.clearAllMocks();
  signal = new AbortController().signal;
});

describe("adaptEthenaWhitelabel", () => {
  it("maps USDe/USDC custodian rows, keeps Coinbase Prime off-chain custody as an unlinked slice, and computes the honest ratio", () => {
    const result = adaptEthenaWhitelabel(SUIUSDE_PAYLOAD, "suiUSDe");

    expect(result.slices).toEqual([
      { name: "USDe (Ethena synthetic dollar)", pct: 90.441, risk: "medium", coinId: "usde-ethena" },
      { name: "USDC cash-equivalent reserves", pct: 9.537, risk: "low", coinId: "usdc-circle" },
      { name: "Coinbase Prime custody (off-chain)", pct: 0.022, risk: "low" },
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
    const report = expectValidAdapterOutput("ethena-whitelabel", result);
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
      { name: "USDe (Ethena synthetic dollar)", pct: 90.441, risk: "medium", coinId: "usde-ethena" },
      { name: "USDC cash-equivalent reserves", pct: 9.537, risk: "low", coinId: "usdc-circle" },
      { name: "Coinbase Prime custody (off-chain)", pct: 0.022, risk: "low" },
    ]);
  });

  it("degrades-warns and buckets an unmapped custodian asset instead of failing closed", () => {
    const withUnknownAsset: EthenaWhitelabelPayload = {
      data: [
        {
          ...SUIUSDE_ENTRY,
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
    mockedReserveHelper(fetchJsonAdapterInput).mockResolvedValue(SUIUSDE_PAYLOAD);
    const config = makeConfig();

    const result = await fetchEthenaWhitelabelReserves(makeCoin(), config, signal);

    expect(fetchJsonAdapterInput).toHaveBeenCalledWith(
      config,
      "ethena-whitelabel",
      signal,
      12_000,
      undefined,
    );
    expect(result.slices[0]).toMatchObject({ name: "USDe (Ethena synthetic dollar)" });
  });

  it("propagates an error when the endpoint request fails", async () => {
    mockedReserveHelper(fetchJsonAdapterInput).mockRejectedValue(
      new Error("HTTP 500 for https://whitelabel.ethena.fi/api/transparency"),
    );

    await expect(fetchEthenaWhitelabelReserves(makeCoin(), makeConfig(), signal)).rejects.toThrow("HTTP 500");
  });
});
