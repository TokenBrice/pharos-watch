import { describe, expect, it, beforeEach, vi } from "vitest";
import type * as IndependentAssurance from "../independent-assurance";
import { getReserveAdapter } from "../index";
import { fetchIndependentAssuranceReserves } from "../independent-assurance";
import { runAdapter, type AdapterNetworkSpec } from "./reserve-adapter.test-support";

const REPORT_TIMESTAMP = 1_785_542_399;
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
          lastUpdated: "Aug 11, 2026",
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
      { name: "FDIC-insured bank cash", pct: 0.990893, risk: "very-low", assetClass: "bank-deposit" },
      { name: "BlackRock BUIDL", pct: 27.987907, risk: "low", coinId: "buidl-blackrock", assetClass: "fund-share" },
      { name: "Goldman Sachs STBXX (CUSIP 38151N205)", pct: 8.904468, risk: "low", assetClass: "money-market-fund" },
      { name: "JPMorgan JLTXX (CUSIP 46655R119)", pct: 62.116731, risk: "low", assetClass: "money-market-fund" },
    ],
    metadata: {
      sourceTimestamp: REPORT_TIMESTAMP,
      freshnessMode: "verified",
      collateralizationRatio: 1_116_301_304 / 1_112_640_495,
      details: { assurance: { reportUrl: "https://learn.anchorage.com/07.31.26_USDGO-Stablecoin-Attestation-Report-signed.pdf" } },
    },
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
      totalReserveUsd: 1_116_301_304,
      totalAssetsUsd: 1_116_301_304,
      totalLiabilitiesUsd: 1_112_640_495,
      supplyUsd: 1_112_640_495,
      shareholderEquityUsd: 3_660_809,
      unknownExposurePct: 0,
      details: {
        authoritativeBasis: "Deloitte examination report; issuer API is cross-check only",
        reportSurplusUsd: 3_660_809,
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
        lastUpdated: "Jul 31, 2026",
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
