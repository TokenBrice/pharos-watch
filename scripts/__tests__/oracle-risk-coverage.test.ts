
import { describe, expect, it } from "vitest";
import type { StablecoinMeta } from "@shared/types";
import { analyzeOracleRiskCoverage } from "../lib/oracle-risk-coverage";
import { runOracleRiskCoverageCheck } from "../ci/check-oracle-risk-coverage";

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

type OracleRisk = NonNullable<StablecoinMeta["oracleRisk"]>;
type OracleBranch = NonNullable<OracleRisk["branches"]>[number];

function completeBranch(overrides: Partial<OracleBranch> = {}): OracleBranch {
  return {
    id: "eth", label: "ETH", tier: "standard-external", summary: "ETH branch feed path.",
    feeds: [{ provider: "Chainlink", path: "ETH / USD", chain: "ethereum" }],
    fallbackBehavior: "The branch shuts down and preserves its last good price.",
    observedAt: "2026-07-13",
    collateralParameters: [{ asset: "ETH", minimumCollateralRatioPct: 110 }],
    liquidationMechanism: "Immediate permissionless liquidation against a Stability Pool.",
    liquidationDelaySec: 0,
    backstop: "The Stability Pool offsets debt before same-branch redistribution.",
    shutdownOrBadDebtBehavior: "Branch shutdown prevents new debt while residual bad debt remains with holders.",
    sources: [{ label: "Docs", url: "https://example.com/docs" }],
    ...overrides,
  };
}

function reviewedMultiBranch(overrides: Partial<OracleRisk> = {}): OracleRisk {
  return {
    tier: "standard-external",
    summary: "Multiple collateral markets are reviewed separately.",
    branchApplicability: {
      disposition: "branches-required", reviewedAt: "2026-07-13", reviewer: "test",
      rationale: "Each collateral market has independent oracle and liquidation behavior.",
      sources: [{ label: "Docs", url: "https://example.com/docs" }],
    },
    branchModel: "multi-branch", reviewedAt: "2026-07-13", reviewer: "test", confidence: "verified",
    branches: [completeBranch()],
    ...overrides,
  };
}

function runCoverageCli(coins: readonly StablecoinMeta[], argv: readonly string[] = []) {
  let stdout = "";
  let stderr = "";
  const status = runOracleRiskCoverageCheck(coins, argv, {
    stdout: { write: (value) => (stdout += value) },
    stderr: { write: (value) => (stderr += value) },
  });
  return { status, stdout, stderr };
}

it("enforces missing profiles without an advisory exit-success mode", () => {
  const enforced = runCoverageCli([makeCoin()]);
  expect(enforced.status).toBe(1);
  expect(enforced.stderr).toBe("");
  expect(enforced.stdout).toContain("oracleRisk coverage:");
  expect(enforced.stdout).toContain("test-cdp (TCDP): missing-profile");
});

it.each(["--advisory", "--advisory=true", "--advisory=false"])(
  "rejects retired option %s independently of the coverage census",
  (option) => {
    for (const coins of [[], [makeCoin()], [makeCoin({ oracleRisk: reviewedMultiBranch() })]]) {
      const rejected = runCoverageCli(coins, [option]);
      expect(rejected.status).toBe(1);
      expect(rejected.stderr).toBe(`Unknown argument: ${option}\n`);
      expect(rejected.stdout).toBe("");
    }
  },
);

it.each([
  { tier: "standard-external", summary: "Missing review provenance." },
  reviewedMultiBranch({ branches: undefined }),
  reviewedMultiBranch({ branches: [completeBranch({ liquidationDelaySec: undefined })] }),
] satisfies OracleRisk[])("blocks structurally incomplete profiles %j", (oracleRisk) => {
  const result = runCoverageCli([makeCoin({ oracleRisk })]);
  expect(result.status).toBe(1);
  expect(result.stderr).toBe("");
});

describe("analyzeOracleRiskCoverage", () => {
  it("does not demand borrower branches from a reviewed allocation-only explicit inventory", () => {
    const profile = reviewedMultiBranch({
      branchModel: "single-path",
      branches: undefined,
      branchApplicability: { ...reviewedMultiBranch().branchApplicability!, disposition: "top-level-only" },
      paths: [{
        id: "allocation", chain: "ethereum", address: "0x1111111111111111111111111111111111111111",
        pricingAuthority: "none",
        applicability: {
          disposition: "not-applicable", reviewedAt: "2026-07-13", reviewer: "test", confidence: "verified",
          rationale: "The exact direct-allocation contract has no price-sensitive authority.",
          sources: [{ label: "Deployed source", url: "https://example.com/allocation" }],
        },
      }],
    });
    const result = analyzeOracleRiskCoverage([makeCoin({ oracleRisk: profile })], { asOf: new Date("2026-08-01T00:00:00Z") });
    expect(result.findings).toEqual([]);
    expect(result.branchNotApplicable).toBe(1);
    expect(result.branchesRequired).toBe(0);
  });

  it("does not inherit an allocation exception for an unreviewed new facilitator", () => {
    const profile = reviewedMultiBranch({
      paths: [{
        id: "market", chain: "ethereum", address: "0x1111111111111111111111111111111111111111",
        pricingAuthority: "external-price", branchId: "eth",
        applicability: {
          disposition: "branches-required", reviewedAt: "2026-07-13", reviewer: "test", confidence: "verified",
          rationale: "The exact lending market consumes collateral prices.",
          sources: [{ label: "Market source", url: "https://example.com/market" }],
        },
      }, {
        id: "new-facilitator", chain: "ethereum", address: "0x2222222222222222222222222222222222222222",
        pricingAuthority: "unknown",
      }],
    });
    const result = analyzeOracleRiskCoverage([makeCoin({ oracleRisk: profile })], { asOf: new Date("2026-08-01T00:00:00Z") });
    expect(result.branchApplicabilityUnresolved).toBe(1);
    expect(result.reviewedBranchApplicability).toBe(0);
    expect(result.findings).toEqual([expect.objectContaining({ kind: "branch-applicability-unresolved" })]);
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

  it("blocks missing branches and incomplete branch evidence for declared multi-branch systems", () => {
    const missingBranches = analyzeOracleRiskCoverage([
      makeCoin({ oracleRisk: reviewedMultiBranch({ branches: undefined }) }),
    ]);
    expect(missingBranches.findings).toEqual([expect.objectContaining({ kind: "missing-branches" })]);

    const incomplete = analyzeOracleRiskCoverage([
      makeCoin({
        oracleRisk: reviewedMultiBranch({
          branches: [{ id: "eth", label: "ETH", tier: "standard-external", summary: "ETH branch feed path." }],
        }),
      }),
    ]);
    expect(incomplete.completeBranches).toBe(0);
    expect(incomplete.findings).toEqual([
      expect.objectContaining({ kind: "missing-branch-evidence", detail: expect.stringContaining("eth branch") }),
    ]);
  });

  it("blocks a missing liquidation delay without schema-backed uncallability", () => {
    const coin = makeCoin({
      oracleRisk: reviewedMultiBranch({ branches: [completeBranch({ liquidationDelaySec: undefined })] }),
    });
    const result = analyzeOracleRiskCoverage([coin], { asOf: new Date("2026-08-01T00:00:00Z") });

    expect(result.completeProfiles).toBe(0);
    expect(result.completeBranches).toBe(0);
    expect(result.findings).toEqual([
      expect.objectContaining({
        kind: "missing-branch-evidence",
        detail: "eth branch missing liquidationDelaySec",
      }),
    ]);
    expect(runCoverageCli([coin]).status).toBe(1);
  });

  it("counts schema-backed uncallable branches as complete without inventing a liquidation delay", () => {
    const coin = makeCoin({
      oracleRisk: reviewedMultiBranch({
        branches: [completeBranch({ liquidationState: "uncallable", liquidationDelaySec: undefined })],
      }),
    });
    const result = analyzeOracleRiskCoverage([coin], { asOf: new Date("2026-08-01T00:00:00Z") });

    expect(result.completeProfiles).toBe(1);
    expect(result.completeBranches).toBe(1);
    expect(result.findings).toEqual([]);
    const cli = runCoverageCli([coin]);
    expect(cli.status).toBe(0);
    expect(cli.stdout).toContain("1/1 branches complete");
  });
});

