import { describe, expect, it, beforeEach, vi } from "vitest";
import type * as IndependentAssurance from "../independent-assurance";
import { getReserveAdapter } from "../index";
import { fetchIndependentAssuranceReserves } from "../independent-assurance";
import { USDGO_INDEPENDENT_ASSURANCE_PROFILE } from "../usdgo-transparency";
import { runAdapter, type AdapterNetworkSpec } from "./reserve-adapter.test-support";

const REPORT_TIMESTAMP = 1_790_812_799;
const ISSUER_URL = "https://www.usdgo.com/api/lark-bitable";

vi.mock("../independent-assurance", async () => {
  const actual = await vi.importActual<typeof IndependentAssurance>("../independent-assurance");
  return { ...actual, fetchIndependentAssuranceReserves: vi.fn() };
});

function issuerNetwork(overrides: Record<string, unknown> = {}): AdapterNetworkSpec {
  return {
    json: {
      [ISSUER_URL]: {
        ok: true,
        data: {
          buidlUsdM: "359.37",
          gsUsdM: "99.50",
          jltxxUsdM: "689.14",
          usdUsdM: "11.82",
          backingAssetsM: "1159.83",
          circulationSupplyMFormatted: "1157.62",
          collateralizationRatio: 100.192,
          lastUpdated: "Oct 11, 2026",
          ...overrides,
        },
      },
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(fetchIndependentAssuranceReserves).mockResolvedValue({
    slices: [
      { name: "FDIC-insured bank cash", pct: 4.279431, risk: "very-low", assetClass: "bank-deposit" },
      { name: "BlackRock BUIDL", pct: 43.260761, risk: "low", coinId: "buidl-blackrock", depType: "collateral", assetClass: "fund-share" },
      { name: "Goldman Sachs STBXX (CUSIP 38151N205)", pct: 8.390349, risk: "low", assetClass: "money-market-fund" },
      { name: "JPMorgan JLTXX (CUSIP 46655R119)", pct: 44.069459, risk: "low", assetClass: "money-market-fund" },
    ],
    metadata: {
      sourceTimestamp: REPORT_TIMESTAMP,
      freshnessMode: "verified",
      collateralizationRatio: 1_191_693_796 / 1_186_633_562,
      details: { assurance: { reportUrl: "https://learn.anchorage.com/09.30.26_USDGO-Stablecoin-Attestation-Report-signed.pdf" } },
    },
  });
});

describe("usdgo-transparency profile classification", () => {
  it("names the STBXX fund that the CUSIP identifies, not the Financial Square series", () => {
    expect(USDGO_INDEPENDENT_ASSURANCE_PROFILE.classifications.stbxx).toMatchObject({
      name: "Goldman Sachs STBXX (CUSIP 38151N205)",
      issuerOrObligor: "Goldman Sachs Stablecoin Reserves Fund",
    });
  });
});

describe("usdgo-transparency independent promotion", () => {
  it("uses the Deloitte report for composition and liabilities, with later issuer data only as a cross-check", async () => {
    const { result } = await runAdapter("usdgo-transparency", "usdgo-osl", {
      network: issuerNetwork(),
      nowSec: REPORT_TIMESTAMP + 3_600,
    });

    expect(result.slices).toHaveLength(4);
    expect(result.metadata).not.toHaveProperty("buidlOnchain");
    expect(result.metadata).toMatchObject({
      sourceTimestamp: REPORT_TIMESTAMP,
      freshnessMode: "verified",
      totalReserveUsd: 1_191_693_796,
      totalAssetsUsd: 1_191_693_796,
      totalLiabilitiesUsd: 1_186_633_562,
      supplyUsd: 1_186_633_562,
      shareholderEquityUsd: 5_060_234,
      unknownExposurePct: 0,
      details: {
        authoritativeBasis: "Deloitte examination report; issuer API is cross-check only",
        reportSurplusUsd: 5_060_234,
      },
    });
    expect(result.metadata?.issuerCrossCheck).toMatchObject({ sourceTimestamp: expect.any(Number) });
    expect(result.warnings).toEqual([
      expect.objectContaining({ code: "usdgo-issuer-cross-check-newer-period", severity: "info" }),
    ]);
  });

  it("fails closed when the current independent report cannot be verified", async () => {
    vi.mocked(fetchIndependentAssuranceReserves).mockRejectedValue(new Error("report hash drift"));
    await expect(runAdapter("usdgo-transparency", "usdgo-osl", {
      network: issuerNetwork(),
      nowSec: REPORT_TIMESTAMP + 3_600,
      validate: false,
    })).rejects.toThrow("report hash drift");
  });

  it("treats a same-period issuer disagreement as fatal", async () => {
    await expect(runAdapter("usdgo-transparency", "usdgo-osl", {
      network: issuerNetwork({
        buidlUsdM: "150",
        backingAssetsM: "950.46",
        circulationSupplyMFormatted: "859.224943",
        lastUpdated: "Sep 30, 2026",
      }),
      nowSec: REPORT_TIMESTAMP + 3_600,
      validate: false,
    })).rejects.toThrow("issuer cross-check disagrees");
  });

  it("validates the promoted adapter output and registry declaration", async () => {
    const { result, report } = await runAdapter("usdgo-transparency", "usdgo-osl", {
      network: issuerNetwork(),
      nowSec: REPORT_TIMESTAMP + 3_600,
    });
    const adapter = getReserveAdapter("usdgo-transparency");
    expect(report.valid).toBe(true);
    expect(adapter).toMatchObject({ evidenceClass: "independent", sourceModel: "dynamic-mix" });
    expect(result.metadata?.freshnessMode).toBe("verified");
  });
});
