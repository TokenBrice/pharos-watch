import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect, vi, beforeEach } from "vitest";
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
  adaptTetherTransparency,
  fetchTetherTransparencyReserves,
  type TetherTransparencyParams,
  type TetherTransparencyResponse,
} from "../tether-transparency";
import { fetchJsonAdapterInput } from "../helpers";
import { expectValidAdapterOutput, TEST_SIGNAL as signal } from "./reserve-adapter.test-support";

const FIXTURES_DIR = join(dirname(fileURLToPath(import.meta.url)), "fixtures");
// Captured 2026-07-09 from GET https://tether.to/transparency.json
const TETHER_TRANSPARENCY_FIXTURE = JSON.parse(
  readFileSync(join(FIXTURES_DIR, "tether-transparency.json"), "utf8"),
) as TetherTransparencyResponse;

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

function makeCoin(id: string): StablecoinMeta {
  return { id, name: id, ticker: id.toUpperCase() } as unknown as StablecoinMeta;
}

function makeConfig(params: TetherTransparencyParams): LiveReservesConfig {
  return {
    adapter: "tether-transparency",
    version: 1,
    semantics: "attestation-mix",
    inputs: {
      primary: { kind: "http-json", url: "https://tether.to/transparency.json" },
    },
    params,
  } as unknown as LiveReservesConfig;
}

beforeEach(() => {
  vi.clearAllMocks();
});

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
  it("fetches the shared transparency.json endpoint and adapts the usdt entry", async () => {
    vi.mocked(fetchJsonAdapterInput).mockResolvedValue(TETHER_TRANSPARENCY_FIXTURE);
    const config = makeConfig(USDT_PARAMS);

    const result = await fetchTetherTransparencyReserves(makeCoin("usdt-tether"), config, signal);

    expect(fetchJsonAdapterInput).toHaveBeenCalledWith(
      config,
      "tether-transparency",
      signal,
      12_000,
      undefined,
    );
    expect(result.metadata?.totalAssetsUsd).toBe(189761994736.8062);
  });

  it("fetches the same endpoint and adapts the xaut entry when configured", async () => {
    vi.mocked(fetchJsonAdapterInput).mockResolvedValue(TETHER_TRANSPARENCY_FIXTURE);
    const config = makeConfig(XAUT_PARAMS);

    const result = await fetchTetherTransparencyReserves(makeCoin("xaut-tether"), config, signal);

    expect(result.slices).toEqual([
      { name: "Physical gold bars (LBMA Good Delivery, Swiss vaults)", pct: 100, risk: "very-low" },
    ]);
  });

  it("propagates an error when the endpoint request fails", async () => {
    vi.mocked(fetchJsonAdapterInput).mockRejectedValue(new Error("HTTP 500 for https://tether.to/transparency.json"));
    const config = makeConfig(USDT_PARAMS);

    await expect(fetchTetherTransparencyReserves(makeCoin("usdt-tether"), config, signal)).rejects.toThrow(
      "HTTP 500",
    );
  });
});
