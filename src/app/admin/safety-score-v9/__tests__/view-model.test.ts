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

  it("follows the latest run for the header identity and histogram while floors stay on the qualifying selection", () => {
    const response = makeSafetyScoreV9AdminAvailableResponse();
    response.latestEnvelope.candidate.candidateId = "v9-candidate-2";
    response.latestEnvelope.candidate.publicationGenerationId = "v9-generation-2";
    response.latestEnvelope.candidate.cards[0]!.grade = "A";

    const model = buildSafetyScoreV9WorkspaceModel(response);

    // The header follows the latest successful run (the live identity).
    expect(model.displayIsLatest).toBe(true);
    expect(model.displayCandidate.candidateId).toBe("v9-candidate-2");
    expect(model.displayCandidate.publicationGenerationId).toBe("v9-generation-2");
    expect(model.displayGradeCounts).toEqual([
      { grade: "A", count: 1 },
      { grade: "NR", count: 1 },
    ]);

    // The qualifying selection, current day, histogram source, and floors are
    // unchanged — they still describe the pinned earliest-in-window run.
    expect(model.candidate.publicationGenerationId).toBe("v9-generation-1");
    expect(model.currentDay?.selectedRun?.identity.publicationGenerationId).toBe("v9-generation-1");
    expect(model.gradeCounts).toEqual([
      { grade: "A+", count: 1 },
      { grade: "NR", count: 1 },
    ]);
    expect(model.failedCoverageFloors.map((floor) => floor.id)).toEqual(["rated-coverage"]);
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
        schemaVersion: 2,
        reviewKey: card.review.key!,
        reviewClassKey: card.review.classKey!,
        reviewedV8Score: card.v8?.score ?? null,
        reviewedV9Score: card.v9?.score ?? null,
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
