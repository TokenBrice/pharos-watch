import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";
import {
  adaptTetherTransparency,
  type TetherTransparencyParams,
  type TetherTransparencyResponse,
} from "../tether-transparency";
import { expectValidAdapterOutput, runAdapter } from "./reserve-adapter.test-support";

const FIXTURES_DIR = join(dirname(fileURLToPath(import.meta.url)), "fixtures");
// Captured 2026-07-09 from GET https://app.tether.to/transparency.json
const TETHER_TRANSPARENCY_FIXTURE = JSON.parse(
  readFileSync(join(FIXTURES_DIR, "tether-transparency.json"), "utf8"),
) as TetherTransparencyResponse;
const TETHER_ENDPOINT = "https://app.tether.to/transparency.json";
// One hour after the fixture's own publication instant, so freshness policy is
// exercised against the capture rather than against wall-clock drift.
const FIXTURE_NOW_SEC = 1_783_555_140 + 3_600;

const USDT_PARAMS: TetherTransparencyParams = {
  currencyIso: "usdt",
  slices: [
    { name: "Direct & indirect U.S. Treasury Bills", pct: 73.5, risk: "very-low" },
    { name: "Physical gold bars", pct: 10.4, risk: "very-low" },
    { name: "Bitcoin", pct: 3.7, risk: "medium" },
    {
      name: "Other reserves (cash & equivalents, secured loans, corporate bonds, other investments)",
      pct: 12.4,
      risk: "medium",
    },
  ],
};

const XAUT_PARAMS: TetherTransparencyParams = {
  currencyIso: "xaut",
  slices: [{ name: "Physical gold bars (LBMA Good Delivery, Swiss vaults)", pct: 100, risk: "very-low" }],
};

describe("adaptTetherTransparency", () => {
  it("selects the usdt entry, computes the honest ratio, and persists USD-denominated totals", () => {
    const result = adaptTetherTransparency(TETHER_TRANSPARENCY_FIXTURE, USDT_PARAMS);

    expect(result.slices).toEqual([
      { name: "Direct & indirect U.S. Treasury Bills", pct: 73.5, risk: "very-low" },
      {
        name: "Other reserves (cash & equivalents, secured loans, corporate bonds, other investments)",
        pct: 12.4,
        risk: "medium",
      },
      { name: "Physical gold bars", pct: 10.4, risk: "very-low" },
      { name: "Bitcoin", pct: 3.7, risk: "medium" },
    ]);

    expect(result.metadata).toMatchObject({
      freshnessMode: "verified",
      sourceTimestamp: 1783555140,
      totalAssetsUsd: 189761994736.8062,
      totalLiabilitiesUsd: 184211219230.290086,
      shareholderEquityUsd: 5466941751.78272135,
    });
    expect(result.metadata?.collateralizationRatio).toBeCloseTo(1.030, 3);
  });

  it("emits an info warning for the nonzero quarantined balance on Solana", () => {
    const result = adaptTetherTransparency(TETHER_TRANSPARENCY_FIXTURE, USDT_PARAMS);

    expect(result.warnings).toEqual([
      expect.objectContaining({
        code: "quarantined-balance",
        severity: "info",
        effect: "info",
        message: expect.stringContaining("Solana"),
      }),
    ]);
    const details = result.metadata?.details as { chains: Array<{ name: string; quarantined: number }> };
    const solana = details.chains.find((chain) => chain.name === "Solana");
    expect(solana?.quarantined).toBeCloseTo(3698541.306464, 3);
  });

  it("selects the xaut entry, omits *Usd metadata fields, and still computes a dimensionless ratio", () => {
    const result = adaptTetherTransparency(TETHER_TRANSPARENCY_FIXTURE, XAUT_PARAMS);

    expect(result.slices).toEqual([
      { name: "Physical gold bars (LBMA Good Delivery, Swiss vaults)", pct: 100, risk: "very-low" },
    ]);
    expect(result.warnings).toBeUndefined();
    expect(result.metadata?.collateralizationRatio).toBeCloseTo(1, 6);
    expect(result.metadata).not.toHaveProperty("totalAssetsUsd");
    expect(result.metadata).not.toHaveProperty("totalLiabilitiesUsd");
    expect(result.metadata).not.toHaveProperty("shareholderEquityUsd");

    const details = result.metadata?.details as { chains: Array<{ name: string }> };
    expect(details.chains.map((chain) => chain.name).sort()).toEqual(["BNB Smart Chain", "Ethereum"]);
  });

  it("throws when the requested currencyIso has no matching data_formatted entry", () => {
    const usdtOnly: TetherTransparencyResponse = {
      data_formatted: TETHER_TRANSPARENCY_FIXTURE.data_formatted!.filter((entry) => entry.iso === "usdt"),
    };

    expect(() => adaptTetherTransparency(usdtOnly, XAUT_PARAMS)).toThrow(
      /no data_formatted entry for currencyIso "xaut"/,
    );
  });

  it("throws when data_formatted is missing", () => {
    expect(() => adaptTetherTransparency({}, USDT_PARAMS)).toThrow("missing data_formatted entries");
  });

  it("throws when total_assets/total_liabilities are malformed", () => {
    const malformed: TetherTransparencyResponse = {
      data_formatted: TETHER_TRANSPARENCY_FIXTURE.data_formatted!.map((entry) =>
        entry.iso === "usdt" ? { ...entry, total_assets: "not-a-number" } : entry,
      ),
    };

    expect(() => adaptTetherTransparency(malformed, USDT_PARAMS)).toThrow(
      /invalid total_assets\/total_liabilities/,
    );
  });

  it("throws when the id timestamp is unreadable", () => {
    const noId: TetherTransparencyResponse = {
      data_formatted: TETHER_TRANSPARENCY_FIXTURE.data_formatted!.map((entry) =>
        entry.iso === "usdt" ? { ...entry, id: undefined } : entry,
      ),
    };

    expect(() => adaptTetherTransparency(noId, USDT_PARAMS)).toThrow("unreadable id timestamp");
  });

  it("is degraded-but-valid under validateAdapterOutput when the id timestamp is stale", () => {
    const staleSeconds = Math.floor((Date.now() - 10 * 24 * 60 * 60 * 1000) / 1000);
    const stale: TetherTransparencyResponse = {
      data_formatted: TETHER_TRANSPARENCY_FIXTURE.data_formatted!.map((entry) =>
        entry.iso === "usdt" ? { ...entry, id: staleSeconds } : entry,
      ),
    };

    const result = adaptTetherTransparency(stale, USDT_PARAMS);
    const report = expectValidAdapterOutput("tether-transparency", result);
    expect(report.warnings).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: "stale-source-data", effect: "degraded" })]),
    );
  });
});

describe("fetchTetherTransparencyReserves", () => {
  it("fetches the coin's configured transparency endpoint and publishes its reserve totals", async () => {
    const { result, network } = await runAdapter("tether-transparency", "usdt-tether", {
      network: { json: { [TETHER_ENDPOINT]: TETHER_TRANSPARENCY_FIXTURE } },
      nowSec: FIXTURE_NOW_SEC,
    });

    expect(network.requests.map((request) => request.url)).toEqual([TETHER_ENDPOINT]);
    expect(result.metadata?.totalAssetsUsd).toBe(189761994736.8062);
    expect(result.metadata?.freshnessMode).toBe("verified");
  });

  it("selects the configured currency per coin on the shared endpoint", async () => {
    const { result } = await runAdapter("tether-transparency", "xaut-tether", {
      network: { json: { [TETHER_ENDPOINT]: TETHER_TRANSPARENCY_FIXTURE } },
      nowSec: FIXTURE_NOW_SEC,
    });

    expect(result.slices.every((slice) => /gold/i.test(slice.name))).toBe(true);
    expect(result.metadata).not.toHaveProperty("totalAssetsUsd");
  });

  it("fails the attempt when the endpoint errors instead of publishing a partial mix", async () => {
    await expect(
      runAdapter("tether-transparency", "usdt-tether", {
        network: { json: { [TETHER_ENDPOINT]: { status: 500, body: "upstream down" } } },
        nowSec: FIXTURE_NOW_SEC,
      }),
    ).rejects.toThrow(/500/);
  });
});
