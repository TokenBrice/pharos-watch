import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { StablecoinMeta } from "@shared/types";
import type { RedemptionBackstopConfig } from "@shared/lib/redemption-backstop-configs/shared";
import {
  generateRedemptionCoverageAudit,
  runCli,
  validateReviewedRedemptionDispositions,
  validateReviewedRedemptionDispositionRows,
} from "../maintenance/generate-redemption-coverage-audit";
import type { ReviewedRedemptionCoverageDisposition } from "@shared/data/coverage-dispositions/redemption-coverage-dispositions";
import { makeCoverageCoin } from "./helpers/coverage-coin";
import { createTempRepoTracker } from "./helpers/test-state";

const roots = createTempRepoTracker("redemption-coverage-audit");
afterEach(() => roots.cleanup());

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
  it("keeps the published coverage register valid after reviewed holder-route admission", () => {
    const result = validateReviewedRedemptionDispositionRows();
    expect(result.rowErrors).toEqual([]);
    expect(result.missingIds).toEqual([]);
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

  it("does not present unavailable report-card diagnostics as zero gaps", () => {
    const input = { trackedCoins: [], activeCoins: [], configs: {}, reviewedDispositions: [] };
    expect(generateRedemptionCoverageAudit(input).reportCardDiagnostics).toBeNull();
    expect(generateRedemptionCoverageAudit({
      ...input, reportCards: { asOfSec: 1_791_402_404, cards: [] },
    }).reportCardDiagnostics).toMatchObject({
      evaluatedCards: 0, costGapInstances: 0, settlementGapInstances: 0, portfolioCoverageAffectedCards: 0,
    });
  });

  it.each(["reviewed", "missing", "invalid", "stale"] as const)(
    "keeps default/check exit parity for %s dispositions",
    (kind) => {
      const cwd = roots.makeRoot();
      const build = () => generateRedemptionCoverageAudit({
        trackedCoins: [coin({ id: "reviewed-gap" })],
        activeCoins: [coin({ id: "reviewed-gap" })],
        configs: kind === "stale" ? { "reviewed-gap": configuredRoute } : {},
        generatedAt: "2026-10-08T00:00:00.000Z",
        reviewedDispositions: kind === "missing" ? [] : [
          review("reviewed-gap", kind === "invalid" ? { reviewer: "" } : {}),
        ],
      });
      const expected = kind === "reviewed" ? 0 : 1;
      expect(runCli(["--json", "--report", "default.json"], cwd, build)).toBe(expected);
      expect(runCli(["--json", "--check", "--report", "check.json"], cwd, build)).toBe(expected);
      expect(JSON.parse(readFileSync(join(cwd, "check.json"), "utf8"))).toEqual(
        JSON.parse(readFileSync(join(cwd, "default.json"), "utf8")),
      );
      if (kind === "reviewed") expect(build().activeUnconfigured).toHaveLength(1);
    },
  );

  it("keeps strict active-gap escalation independent of check presentation", () => {
    const cwd = roots.makeRoot();
    const build = () => {
      const audit = generateRedemptionCoverageAudit({
        trackedCoins: [coin({ id: "reviewed-gap" })],
        activeCoins: [coin({ id: "reviewed-gap" })],
        configs: {}, reviewedDispositions: [review("reviewed-gap")],
      });
      audit.summary.activeDefaultClassified = 1;
      return audit;
    };
    for (const presentation of [[], ["--check"]]) {
      expect(runCli(["--json", "--report", "plain.json", ...presentation], cwd, build)).toBe(0);
      expect(runCli(["--json", "--report", "strict.json", "--strict-active-gaps", ...presentation], cwd, build)).toBe(1);
    }
  });

});
