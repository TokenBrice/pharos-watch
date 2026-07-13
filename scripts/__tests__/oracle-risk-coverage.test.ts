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
    expect(result.findings).toContainEqual(expect.objectContaining({
      kind: "missing-review-metadata",
      detail: "oracleRisk missing reviewedAt, reviewer, confidence",
    }));
  });

  it("accepts complete fresh profiles and ignores non-CDP assets and variants", () => {
    const result = analyzeOracleRiskCoverage(
      [
        makeCoin({
          oracleRisk: {
            tier: "medianized-with-delay",
            summary: "Medianized feeds with delay are documented.",
            branchApplicability: {
              disposition: "not-applicable",
              reviewedAt: "2026-06-01",
              reviewer: "Codex data review",
              rationale: "The reviewed system has one shared collateral path rather than separately parameterized markets.",
              sources: [{ label: "Docs", url: "https://example.com/docs" }],
            },
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

  it("blocks missing branches and incomplete branch evidence for declared multi-branch systems", () => {
    const missingBranches = analyzeOracleRiskCoverage([
      makeCoin({
        oracleRisk: {
          tier: "standard-external",
          summary: "Multiple collateral markets are reviewed separately.",
          branchApplicability: {
            disposition: "branches-required",
            reviewedAt: "2026-07-13",
            reviewer: "test",
            rationale: "Each collateral market has independent oracle and liquidation behavior.",
            sources: [{ label: "Docs", url: "https://example.com/docs" }],
          },
          branchModel: "multi-branch",
          reviewedAt: "2026-07-13",
          reviewer: "test",
          confidence: "verified",
        },
      }),
    ]);
    expect(missingBranches.findings).toEqual([expect.objectContaining({ kind: "missing-branches" })]);

    const incomplete = analyzeOracleRiskCoverage([
      makeCoin({
        oracleRisk: {
          tier: "standard-external",
          summary: "Multiple collateral markets are reviewed separately.",
          branchApplicability: {
            disposition: "branches-required",
            reviewedAt: "2026-07-13",
            reviewer: "test",
            rationale: "Each collateral market has independent oracle and liquidation behavior.",
            sources: [{ label: "Docs", url: "https://example.com/docs" }],
          },
          branchModel: "multi-branch",
          reviewedAt: "2026-07-13",
          reviewer: "test",
          confidence: "verified",
          branches: [{ id: "eth", label: "ETH", tier: "standard-external", summary: "ETH branch feed path." }],
        },
      }),
    ]);
    expect(incomplete.completeBranches).toBe(0);
    expect(incomplete.findings).toEqual([
      expect.objectContaining({ kind: "missing-branch-evidence", detail: expect.stringContaining("eth branch") }),
    ]);
  });

  it("accepts complete branch evidence and treats stale observations as advisory", () => {
    const result = analyzeOracleRiskCoverage(
      [
        makeCoin({
          oracleRisk: {
            tier: "standard-external",
            summary: "Multiple collateral markets are reviewed separately.",
            branchApplicability: {
              disposition: "branches-required",
              reviewedAt: "2026-07-13",
              reviewer: "test",
              rationale: "Each collateral market has independent oracle and liquidation behavior.",
              sources: [{ label: "Docs", url: "https://example.com/docs" }],
            },
            branchModel: "multi-branch",
            reviewedAt: "2026-07-13",
            reviewer: "test",
            confidence: "verified",
            branches: [
              {
                id: "eth",
                label: "ETH",
                tier: "standard-external",
                summary: "ETH branch feed path.",
                feeds: [{ provider: "Chainlink", path: "ETH / USD", chain: "ethereum" }],
                fallbackBehavior: "The branch shuts down and preserves its last good price.",
                observedAt: "2026-01-01",
                collateralParameters: [{ asset: "ETH", minimumCollateralRatioPct: 110 }],
                liquidationMechanism: "Immediate permissionless liquidation against a Stability Pool.",
                liquidationDelaySec: 0,
                backstop: "The Stability Pool offsets debt before same-branch redistribution.",
                shutdownOrBadDebtBehavior:
                  "Branch shutdown prevents new debt while residual bad debt remains with holders.",
                sources: [{ label: "Docs", url: "https://example.com/docs" }],
              },
            ],
          },
        }),
      ],
      { asOf: new Date("2026-07-13T00:00:00Z"), staleDays: 180 },
    );

    expect(result.completeBranches).toBe(1);
    expect(result.completeProfiles).toBe(1);
    expect(result.findings).toEqual([expect.objectContaining({ kind: "stale-branch-observation" })]);
  });

  it("surfaces reviewed unresolved branch applicability without changing the v8 profile-completeness gate", () => {
    const result = analyzeOracleRiskCoverage([
      makeCoin({
        oracleRisk: {
          tier: "standard-external",
          summary: "The profile has source-backed system-wide evidence but no market inventory.",
          branchApplicability: {
            disposition: "unresolved",
            reviewedAt: "2026-07-13",
            reviewer: "test",
            rationale: "The system has multiple collateral markets, but reviewed sources lack complete per-market evidence.",
            sources: [{ label: "Docs", url: "https://example.com/docs" }],
          },
          reviewedAt: "2026-07-13",
          reviewer: "test",
          confidence: "verified",
        },
      }),
    ]);

    expect(result.completeProfiles).toBe(1);
    expect(result.branchApplicabilityUnresolved).toBe(1);
    expect(result.findings).toEqual([expect.objectContaining({ kind: "branch-applicability-unresolved" })]);
  });

  it("keeps unreviewed profile-only branch applicability visible as an advisory backlog", () => {
    const result = analyzeOracleRiskCoverage([
      makeCoin({
        oracleRisk: {
          tier: "standard-external",
          summary: "A complete profile that predates the branch-applicability review contract.",
          reviewedAt: "2026-07-13",
          reviewer: "test",
          confidence: "verified",
        },
      }),
    ]);

    expect(result.completeProfiles).toBe(1);
    expect(result.reviewedBranchApplicability).toBe(0);
    expect(result.findings).toEqual([expect.objectContaining({ kind: "missing-branch-applicability" })]);
  });
});
