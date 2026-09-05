import { describe, expect, it, beforeEach, vi } from "vitest";
import type { StablecoinMeta } from "@shared/types/core";
import type { LiveReservesConfig } from "@shared/types/live-reserves";
import { fetchUsdgoTransparencyReserves } from "../usdgo-transparency";
import { validateAdapterOutput } from "../validate";
import { getReserveAdapter } from "../index";
import { fetchJsonWithRetry } from "../helpers";
import { fetchIndependentAssuranceReserves } from "../independent-assurance";

const REPORT_TIMESTAMP = 1_785_542_399;

vi.mock("../helpers", async () => {
  const actual = await vi.importActual<typeof import("../helpers")>("../helpers");
  return { ...actual, fetchJsonWithRetry: vi.fn() };
});

vi.mock("../independent-assurance", async () => {
  const actual = await vi.importActual<typeof import("../independent-assurance")>("../independent-assurance");
  return { ...actual, fetchIndependentAssuranceReserves: vi.fn() };
});

const coin = { id: "usdgo-osl", symbol: "USDGO" } as StablecoinMeta;
const config = {
  adapter: "usdgo-transparency",
  version: 3,
  semantics: "attestation-mix",
  inputs: {
    primary: {
      kind: "http-html",
      url: "https://www.anchorage.com/platform/usdgo-reserve-attestations",
    },
  },
  params: {
    product: "USDGO",
    profile: "usdgo-v1",
    indexHost: "www.anchorage.com",
    reportHosts: ["learn.anchorage.com"],
    issuerCrossCheckUrl: "https://www.usdgo.com/api/lark-bitable",
  },
} as LiveReservesConfig;

function mockIssuer(lastUpdated = "Aug 11, 2026", overrides: Record<string, unknown> = {}): void {
  vi.mocked(fetchJsonWithRetry).mockResolvedValue({
    ok: true,
    data: {
      buidlUsdM: "359.37",
      gsUsdM: "99.50",
      jltxxUsdM: "689.14",
      usdUsdM: "11.82",
      backingAssetsM: "1159.83",
      circulationSupplyMFormatted: "1157.62",
      collateralizationRatio: 100.192,
      lastUpdated,
      ...overrides,
    },
  });
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
  mockIssuer();
});

describe("usdgo-transparency independent promotion", () => {
  it("uses the Deloitte report for composition and liabilities, with later issuer data only as a cross-check", async () => {
    const result = await fetchUsdgoTransparencyReserves(coin, config, new AbortController().signal);

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
    await expect(fetchUsdgoTransparencyReserves(coin, config, new AbortController().signal)).rejects.toThrow(
      "report hash drift",
    );
  });

  it("treats a same-period issuer disagreement as fatal", async () => {
    mockIssuer("Jul 31, 2026", { buidlUsdM: "150", backingAssetsM: "950.46", circulationSupplyMFormatted: "859.224943" });
    await expect(fetchUsdgoTransparencyReserves(coin, config, new AbortController().signal)).rejects.toThrow(
      "issuer cross-check disagrees",
    );
  });

  it("validates the promoted adapter output and registry declaration", async () => {
    const result = await fetchUsdgoTransparencyReserves(coin, config, new AbortController().signal);
    const adapter = getReserveAdapter("usdgo-transparency");
    expect(validateAdapterOutput(result, { adapter: adapter ?? undefined }).valid).toBe(true);
    expect(adapter).toMatchObject({ evidenceClass: "independent", sourceModel: "dynamic-mix" });
  });
});
