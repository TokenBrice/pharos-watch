import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { StablecoinMeta } from "../../shared/types";
import type { RedemptionBackstopConfig } from "../../shared/lib/redemption-backstop-configs/shared";
import {
  evaluateRedemptionCoverageAudit,
  generateRedemptionCoverageAudit,
  parseArgs,
  renderRedemptionCoverageAuditMarkdown,
  runCli,
  validateReviewedRedemptionDispositions,
} from "../maintenance/generate-redemption-coverage-audit";
import type { ReviewedRedemptionCoverageDisposition } from "@shared/data/coverage-dispositions/redemption-coverage-dispositions";
import { makeCoverageCoin } from "./helpers/coverage-coin";

const coin = (input: Partial<StablecoinMeta> & Pick<StablecoinMeta, "id">) =>
  makeCoverageCoin(input, { defaultLinks: true });

const configuredRoute: RedemptionBackstopConfig = {
  routeFamily: "offchain-issuer",
  accessModel: "issuer-api",
  settlementModel: "same-day",
  executionModel: "rules-based-nav",
  outputAssetType: "stable-single",
  capacityModel: { kind: "supply-full", confidence: "documented-bound" },
  costModel: { kind: "dynamic-or-unclear", confidence: "undisclosed-reviewed" },
  reviewedAt: "2026-05-12",
};

const heuristicRoute: RedemptionBackstopConfig = {
  ...configuredRoute,
  routeFamily: "queue-redeem",
  capacityModel: { kind: "supply-ratio", ratio: 0.1, confidence: "heuristic" },
};

function review(
  id: string,
  overrides: Partial<ReviewedRedemptionCoverageDisposition> = {},
): ReviewedRedemptionCoverageDisposition {
  return {
    id,
    disposition: "needs-research",
    reasonCode: "documentation-insufficient",
    blocker: "Fixture blocker.",
    rationale: "Fixture source-reviewed rationale.",
    evidenceNeeded: "Fixture evidence requirement.",
    evidenceUrls: [`https://example.com/evidence/${id}`],
    reviewer: "Fixture reviewer",
    reviewedDate: "2026-07-13",
    allowedRouteFamilyIfProven: null,
    ...overrides,
  };
}

describe("generate-redemption-coverage-audit", () => {
  it("uses reviewed registry rows and preserves canonical market-cap order", () => {
    const activeCoins = [
      coin({ id: "usdc-circle" }),
      coin({ id: "mmxn-moneta-digital", symbol: "MMXN" }),
      coin({ id: "iusd-initia" }),
      coin({ id: "random-crypto" }),
    ];

    const audit = generateRedemptionCoverageAudit({
      trackedCoins: activeCoins,
      activeCoins,
      configs: { "usdc-circle": configuredRoute },
      reviewedDispositions: [
        review("mmxn-moneta-digital", {
          reasonCode: "issuer-terms-missing",
          allowedRouteFamilyIfProven: "offchain-issuer",
        }),
        review("iusd-initia", {
          disposition: "defer",
          reasonCode: "capacity-unpublished",
          allowedRouteFamilyIfProven: "queue-redeem",
        }),
        review("random-crypto"),
      ],
      generatedAt: "2026-05-12T00:00:00.000Z",
    });

    expect(audit.summary.activeUnconfigured).toBe(3);
    expect(audit.summary.activeUnclassified).toBe(0);
    expect(audit.summary.activeDefaultClassified).toBe(0);
    expect(audit.dispositionCounts).toEqual({
      add: 0,
      defer: 1,
      "hard-reject": 0,
      "needs-research": 2,
    });
    expect(audit.activeUnconfigured).toEqual([
      expect.objectContaining({
        id: "mmxn-moneta-digital",
        marketCapRank: 2,
        disposition: "needs-research",
        reasonCode: "issuer-terms-missing",
        classificationSource: "reviewed-registry",
        allowedRouteFamilyIfProven: "offchain-issuer",
      }),
      expect.objectContaining({
        id: "iusd-initia",
        marketCapRank: 3,
        disposition: "defer",
        classificationSource: "reviewed-registry",
      }),
      expect.objectContaining({
        id: "random-crypto",
        marketCapRank: 4,
        disposition: "needs-research",
        reasonCode: "documentation-insufficient",
        classificationSource: "reviewed-registry",
      }),
    ]);
  });

  it("rejects missing, duplicate, unknown, configured, and inactive registry rows", () => {
    const alpha = coin({ id: "alpha" });
    const beta = coin({ id: "beta" });
    const frozen = coin({ id: "frozen", status: "frozen" });
    const validationInput = {
      trackedCoins: [alpha, beta, frozen],
      activeCoins: [alpha, beta],
      configuredIds: new Set(["beta"]),
    };

    expect(() => validateReviewedRedemptionDispositions({ ...validationInput, reviewedDispositions: [] })).toThrow(
      "Missing reviewed redemption dispositions",
    );
    expect(() =>
      validateReviewedRedemptionDispositions({
        ...validationInput,
        reviewedDispositions: [review("alpha"), review("alpha")],
      }),
    ).toThrow("Duplicate reviewed redemption disposition");
    expect(() =>
      validateReviewedRedemptionDispositions({ ...validationInput, reviewedDispositions: [review("unknown")] }),
    ).toThrow("unknown stablecoin");
    expect(() =>
      validateReviewedRedemptionDispositions({ ...validationInput, reviewedDispositions: [review("beta")] }),
    ).toThrow("route is now configured");
    expect(() =>
      validateReviewedRedemptionDispositions({ ...validationInput, reviewedDispositions: [review("frozen")] }),
    ).toThrow("stablecoin is not active");
  });

  it("separates non-active unconfigured coins from active gaps", () => {
    const activeCoins = [coin({ id: "usdc-circle" })];
    const preLaunchCoins = [coin({ id: "krw1-bdacs", status: "pre-launch" }), coin({ id: "brd-volpon" })];
    const frozenCoins = [coin({ id: "buck-buck-assets", status: "frozen" }), coin({ id: "statusless-frozen" })];

    const audit = generateRedemptionCoverageAudit({
      trackedCoins: [...activeCoins, ...preLaunchCoins, ...frozenCoins],
      activeCoins,
      preLaunchCoins,
      frozenCoins,
      configs: { "usdc-circle": configuredRoute },
      reviewedDispositions: [],
    });

    expect(audit.summary.activeUnconfigured).toBe(0);
    expect(audit.summary.preLaunchUnconfigured).toBe(2);
    expect(audit.summary.frozenUnconfigured).toBe(2);
    expect(audit.lifecycleExcludedUnconfigured).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "brd-volpon",
          lifecycle: "pre-launch",
          disposition: "defer",
          reasonCode: "pre-launch",
        }),
        expect.objectContaining({
          id: "statusless-frozen",
          lifecycle: "frozen",
          disposition: "hard-reject",
          reasonCode: "frozen",
        }),
      ]),
    );
    expect(audit.lifecycleExcludedUnconfigured).toHaveLength(4);
    expect(audit.lifecycleExcludedUnconfigured).toEqual([
      expect.objectContaining({
        id: "brd-volpon",
      }),
      expect.objectContaining({
        id: "buck-buck-assets",
        lifecycle: "frozen",
        disposition: "hard-reject",
        reasonCode: "frozen",
      }),
      expect.objectContaining({
        id: "krw1-bdacs",
        lifecycle: "pre-launch",
        disposition: "defer",
        reasonCode: "pre-launch",
      }),
      expect.objectContaining({
        id: "statusless-frozen",
      }),
    ]);
  });

  it("adds configured heuristic routes to the V4-43 review queue", () => {
    const audit = generateRedemptionCoverageAudit({
      trackedCoins: [coin({ id: "usdc-circle" }), coin({ id: "pmusd-precious-metals" })],
      activeCoins: [coin({ id: "usdc-circle" }), coin({ id: "pmusd-precious-metals" })],
      configs: {
        "usdc-circle": configuredRoute,
        "pmusd-precious-metals": heuristicRoute,
      },
      reviewedDispositions: [],
    });

    expect(audit.summary.heuristicConfiguredRoutes).toBe(1);
    expect(audit.heuristicConfiguredRoutes).toEqual([
      expect.objectContaining({
        id: "pmusd-precious-metals",
        routeFamily: "queue-redeem",
        capacityModel: "supply-ratio",
      }),
    ]);
  });

  it("renders the expected reviewer tables", () => {
    const rationaleWithTableSyntax = "First line|with-pipe\nsecond line";
    const audit = generateRedemptionCoverageAudit({
      trackedCoins: [coin({ id: "mmxn-moneta-digital" })],
      activeCoins: [coin({ id: "mmxn-moneta-digital" })],
      configs: {},
      reviewedDispositions: [
        review("mmxn-moneta-digital", {
          reasonCode: "issuer-terms-missing",
          rationale: rationaleWithTableSyntax,
          allowedRouteFamilyIfProven: "offchain-issuer",
        }),
      ],
      generatedAt: "2026-05-12T00:00:00.000Z",
    });

    const markdown = renderRedemptionCoverageAuditMarkdown(audit);

    expect(markdown).toContain("## Active Unconfigured Gaps");
    expect(markdown).toContain(
      "market-cap rank | id | lifecycle | current disposition | classification source | blocker | rationale",
    );
    expect(markdown).toContain(
      "1 | mmxn-moneta-digital | active | needs-research (issuer-terms-missing) | reviewed-registry",
    );
    expect(markdown).toContain("First line\\|with-pipe second line");
    expect(markdown).not.toContain("with-pipe\nsecond line");
  });

  it("parses CLI format and report options", () => {
    expect(parseArgs(["--json", "--strict-active-gaps", "--check", "--report", "agents/audit.json"])).toEqual({
      format: "json",
      reportPath: "agents/audit.json",
      strictActiveGaps: true,
      check: true,
    });
    expect(() => parseArgs(["--report"])).toThrow("--report requires a path");
    expect(() => parseArgs(["--unknown"])).toThrow("Unknown argument: --unknown");
  });

  it("strict CLI mode accepts durably reviewed active gaps", () => {
    const cwd = mkdtempSync(join(tmpdir(), "redemption-coverage-audit-"));
    const reviewedGapAudit = () =>
      generateRedemptionCoverageAudit({
        trackedCoins: [coin({ id: "reviewed-coin" })],
        activeCoins: [coin({ id: "reviewed-coin" })],
        configs: {},
        reviewedDispositions: [review("reviewed-coin")],
      });

    expect(runCli(["--json", "--strict-active-gaps", "--report", "reviewed.json"], cwd, reviewedGapAudit)).toBe(0);
    const report = JSON.parse(readFileSync(join(cwd, "reviewed.json"), "utf8")) as {
      summary: { activeDefaultClassified: number };
    };
    expect(report.summary.activeDefaultClassified).toBe(0);
  });

  it("keeps the default-classified count at strict zero", () => {
    const audit = generateRedemptionCoverageAudit({
      trackedCoins: [coin({ id: "random-crypto" })],
      activeCoins: [coin({ id: "random-crypto" })],
      configs: {},
      reviewedDispositions: [review("random-crypto")],
    });

    expect(evaluateRedemptionCoverageAudit(audit)).toEqual([]);
    expect(evaluateRedemptionCoverageAudit(audit, { strictActiveGaps: true })).toEqual([]);
  });

  it("writes nested CLI reports with the selected output format", () => {
    const cwd = mkdtempSync(join(tmpdir(), "redemption-coverage-audit-report-"));
    const status = runCli(["--json", "--report", "nested/reports/audit.json"], cwd, () =>
      generateRedemptionCoverageAudit({
        trackedCoins: [coin({ id: "usdc-circle" })],
        activeCoins: [coin({ id: "usdc-circle" })],
        configs: { "usdc-circle": configuredRoute },
        reviewedDispositions: [],
        generatedAt: "2026-05-12T00:00:00.000Z",
      }),
    );

    expect(status).toBe(0);
    const report = JSON.parse(readFileSync(join(cwd, "nested/reports/audit.json"), "utf8")) as {
      generatedAt: string;
      summary: { activeConfigured: number; activeUnconfigured: number };
    };
    expect(report.generatedAt).toBe("2026-05-12T00:00:00.000Z");
    expect(report.summary.activeConfigured).toBe(1);
    expect(report.summary.activeUnconfigured).toBe(0);
  });
});
