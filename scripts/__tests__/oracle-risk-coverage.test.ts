import { describe, expect, it } from "vitest";
import type { StablecoinMeta } from "@shared/types";
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
            branchModel: "single-path",
            branchApplicability: {
              // Post-9.17 semantics: "no separately parameterized borrower
              // markets" is `top-level-only`, not `not-applicable`. Pairing that
              // rationale with `not-applicable` is the stale pre-9.17 pattern
              // this release migrated away from, so the fixture must not bless it.
              disposition: "top-level-only",
              reviewedAt: "2026-06-01",
              reviewer: "Codex data review",
              rationale: "The reviewed system prices one shared collateral path rather than separately parameterized markets, so its top-level authority is scoreable without borrower branches.",
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

  describe("reviewed inoperable branch dispositions", () => {
    const deadOracleBranch = {
      id: "dead",
      label: "Dead oracle market",
      tier: "standard-external" as const,
      summary: "The market's price feed reverts.",
      feeds: [{ provider: "Chainlink", path: "ETH / USD", chain: "ethereum" }],
      fallbackBehavior: "No fallback: the price read reverts.",
      observedAt: "2026-07-13",
      collateralParameters: [{ asset: "ETH", minimumCollateralRatioPct: 150 }],
      liquidationMechanism: "Permissionless liquidation that cannot execute while the oracle reverts.",
      backstop: "None.",
      shutdownOrBadDebtBehavior: "Debt is stranded with holders.",
      sources: [{ label: "Docs", url: "https://example.com/docs" }],
    };

    function coinWithDeadBranch(branchOverrides: Record<string, unknown> = {}) {
      return makeCoin({
        oracleRisk: {
          tier: "standard-external",
          summary: "One market's oracle is dead.",
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
          branches: [{ ...deadOracleBranch, ...branchOverrides }],
        },
      });
    }

    const disposition = {
      id: "test-cdp",
      branchId: "dead",
      field: "liquidationDelaySec" as const,
      disposition: "reviewed-inoperable" as const,
      reasonCode: "liquidation-uncallable-dead-oracle" as const,
      schemaLimitation: "The field cannot express an unbounded wait.",
      finding: "liquidateVault reverts empty on a live position at the pinned block.",
      observedBlocks: ["ethereum:1"],
      evidenceUrls: ["https://example.com/proof"],
      reviewer: "test",
      reviewedDate: "2026-08-09",
    };

    const asOf = { asOf: new Date("2026-07-13T00:00:00Z"), staleDays: 180 };

    it("reports an unreviewed dead-oracle gap as outstanding evidence work", () => {
      const result = analyzeOracleRiskCoverage([coinWithDeadBranch()], asOf);

      expect(result.completeBranches).toBe(0);
      expect(result.reviewedInoperableBranches).toBe(0);
      expect(result.findings).toEqual([
        expect.objectContaining({
          kind: "missing-branch-evidence",
          detail: "dead branch missing liquidationDelaySec",
        }),
      ]);
    });

    it("converts the gap into a reviewed-inoperable finding that carries its evidence", () => {
      const result = analyzeOracleRiskCoverage([coinWithDeadBranch()], {
        ...asOf,
        reviewedBranchDispositions: [disposition],
      });

      expect(result.reviewedInoperableBranches).toBe(1);
      // Reviewed is not complete: the audit knows why the field is blank, which
      // is a different claim from having the evidence the field asks for.
      expect(result.completeBranches).toBe(0);
      expect(result.findings).toEqual([
        expect.objectContaining({
          kind: "reviewed-inoperable-branch-evidence",
          detail: expect.stringContaining("https://example.com/proof"),
        }),
      ]);
      expect(result.findings[0]?.detail).toContain("liquidation-uncallable-dead-oracle");
      expect(result.findings[0]?.detail).toContain("ethereum:1");
    });

    it("blocks when a disposition outlives the gap it excused", () => {
      const populated = analyzeOracleRiskCoverage([coinWithDeadBranch({ liquidationDelaySec: 0 })], {
        ...asOf,
        reviewedBranchDispositions: [disposition],
      });
      expect(populated.reviewedInoperableBranches).toBe(0);
      expect(populated.completeBranches).toBe(1);
      expect(populated.findings).toEqual([
        expect.objectContaining({
          kind: "stale-branch-disposition",
          detail: "dead branch liquidationDelaySec disposition no longer applies: branch now records liquidationDelaySec",
        }),
      ]);

      const renamedBranch = analyzeOracleRiskCoverage([coinWithDeadBranch({ id: "renamed" })], {
        ...asOf,
        reviewedBranchDispositions: [disposition],
      });
      expect(renamedBranch.findings).toContainEqual(
        expect.objectContaining({
          kind: "stale-branch-disposition",
          detail: expect.stringContaining("profile has no branch with that id"),
        }),
      );

      const removedCoin = analyzeOracleRiskCoverage([], {
        ...asOf,
        reviewedBranchDispositions: [disposition],
      });
      expect(removedCoin.findings).toEqual([
        expect.objectContaining({
          kind: "stale-branch-disposition",
          detail: expect.stringContaining("no active crypto-backed CDP with that id"),
        }),
      ]);
    });
  });
});
