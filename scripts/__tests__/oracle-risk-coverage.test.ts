import { describe, expect, it } from "vitest";
import type { StablecoinMeta } from "../../shared/types";
import { analyzeOracleRiskCoverage } from "../lib/oracle-risk-coverage";

function makeCoin(overrides: Partial<StablecoinMeta> = {}): StablecoinMeta {
  return {
    id: "test-cdp",
    name: "Test CDP",
    symbol: "TCDP",
    flags: {
      backing: "crypto-backed",
      pegCurrency: "USD",
      governance: "decentralized",
      yieldBearing: false,
      rwa: false,
      navToken: false,
    },
    collateral: "ETH",
    pegMechanism: "CDP",
    mechanismArchetype: "cdp",
    detailProvider: "defillama",
    ...overrides,
  } as StablecoinMeta;
}

describe("analyzeOracleRiskCoverage", () => {
  it("warns on active crypto-backed CDPs missing oracleRisk", () => {
    const result = analyzeOracleRiskCoverage([makeCoin()], { asOf: new Date("2026-06-12T00:00:00Z") });

    expect(result.totalCryptoCdp).toBe(1);
    expect(result.missingOracleRisk).toBe(1);
    expect(result.findings).toEqual([
      expect.objectContaining({
        id: "test-cdp",
        kind: "missing-profile",
      }),
    ]);
  });

  it("requires review provenance for complete profiles", () => {
    const result = analyzeOracleRiskCoverage([
      makeCoin({
        oracleRisk: {
          tier: "standard-external",
          summary: "Standard external feeds are documented.",
        },
      }),
    ]);

    expect(result.withOracleRisk).toBe(1);
    expect(result.completeProfiles).toBe(0);
    expect(result.findings[0]).toMatchObject({
      kind: "missing-review-metadata",
      detail: "oracleRisk missing reviewedAt, reviewer, confidence",
    });
  });

  it("accepts complete fresh profiles and ignores non-CDP assets and variants", () => {
    const result = analyzeOracleRiskCoverage(
      [
        makeCoin({
          oracleRisk: {
            tier: "medianized-with-delay",
            summary: "Medianized feeds with delay are documented.",
            reviewedAt: "2026-06-01",
            reviewer: "Codex data review",
            confidence: "verified",
          },
        }),
        makeCoin({
          id: "fiat",
          flags: {
            backing: "rwa-backed",
            pegCurrency: "USD",
            governance: "centralized",
            yieldBearing: false,
            rwa: true,
            navToken: false,
          },
          mechanismArchetype: "fiat-cash",
        }),
        makeCoin({
          id: "variant-cdp",
          variantOf: "test-cdp",
          variantKind: "strategy-vault",
        }),
      ],
      { asOf: new Date("2026-06-12T00:00:00Z") },
    );

    expect(result.totalCryptoCdp).toBe(1);
    expect(result.completeProfiles).toBe(1);
    expect(result.findings).toEqual([]);
  });
});
