import { describe, expect, it } from "vitest";
import { buildSafetyScoreV9WorkspaceModel, filterSafetyScoreV9AssetRows } from "../view-model";
import { makeSafetyScoreV9AdminAvailableResponse } from "@/test-utils/safety-score-v9-admin-fixture";

describe("Safety Score V9 admin view model", () => {
  it("keeps activation at no-go and reconciles blockers, grades, reviews, and current generation", () => {
    const model = buildSafetyScoreV9WorkspaceModel(makeSafetyScoreV9AdminAvailableResponse());

    expect(model.isNoGo).toBe(true);
    expect(model.currentDay?.selectedRun?.identity.publicationGenerationId).toBe("v9-generation-1");
    expect(model.currentDay?.attemptCounts).toEqual({ successful: 1, failed: 0 });
    expect(model.gradeCounts).toEqual([
      { grade: "A+", count: 1 },
      { grade: "NR", count: 1 },
    ]);
    expect(model.reviewRows.map((row) => row.id)).toEqual(["coin-a"]);
    expect(model.blockers).toEqual(
      expect.arrayContaining([
        "Independent validation is not sealed",
        "rated-coverage: Only half rated",
        "1 material movement reviews remain pending",
      ]),
    );
  });

  it("filters asset rows by grade, review requirement, ID, and reason code", () => {
    const rows = buildSafetyScoreV9WorkspaceModel(makeSafetyScoreV9AdminAvailableResponse()).assetRows;

    expect(
      filterSafetyScoreV9AssetRows(rows, { query: "coin-b", grade: "all", reviewOnly: false }).map(
        ({ card }) => card.id,
      ),
    ).toEqual(["coin-b"]);
    expect(
      filterSafetyScoreV9AssetRows(rows, { query: "insufficient", grade: "NR", reviewOnly: false }).map(
        ({ card }) => card.id,
      ),
    ).toEqual(["coin-b"]);
    expect(
      filterSafetyScoreV9AssetRows(rows, { query: "", grade: "all", reviewOnly: true }).map(({ card }) => card.id),
    ).toEqual(["coin-a"]);
  });

  it("projects durable semantic reviews without rewriting the retained diff", () => {
    const response = makeSafetyScoreV9AdminAvailableResponse();
    const card = response.diff.cards[0]!;
    response.movementReviews = [
      {
        schemaVersion: 1,
        reviewKey: card.review.key!,
        assetId: card.id,
        sourceDiffReportDigest: response.diff.reportDigest,
        candidateId: response.diff.v9Identity.candidateId,
        sourcePublicationGenerationId: response.diff.v9Identity.publicationGenerationId,
        policyDigest: response.diff.v9Identity.policyDigest,
        evaluationBuildDigest: response.diff.v9Identity.evaluationBuildDigest,
        v8MethodologyVersion: response.diff.v8Identity.methodologyVersion,
        disposition: "intended-methodology-change",
        reviewerId: "reviewer@example.com",
        rationale: "The score movement is the intended result of the weakest-path methodology.",
        reviewedAtSec: response.diff.generatedAtSec + 1,
        reviewDigest: "b".repeat(64),
      },
    ];

    const model = buildSafetyScoreV9WorkspaceModel(response);
    expect(model.pendingReviewCount).toBe(0);
    expect(model.reviewRows[0]?.review).toMatchObject({
      status: "classified",
      disposition: "intended-methodology-change",
    });
    expect(model.blockers).not.toContain("1 material movement reviews remain pending");
    expect(response.diff.cards[0]?.review.status).toBe("pending");
  });
});
