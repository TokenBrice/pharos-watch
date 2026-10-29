import { describe, expect, it } from "vitest";
import type { SafetyScoreV9CurrentCard, V9OpenEvidence } from "@shared/types/safety-score-v9-public";
import type { V9EvidenceResponsibility } from "@shared/types/safety-score-v9-facts";
import { makeReportCardsV9Response, makeV9Card } from "@/test/fixtures/safety-score-v9";
import {
  buildDataCoverageModel,
  describeDataCoverageHoldCauses,
  describeIssuerReview,
} from "@/lib/safety-score-data-coverage";

const REVIEWED_AT_SEC = Date.parse("2026-10-03T00:00:00Z") / 1000;
const EARLIER_REVIEWED_AT_SEC = Date.parse("2026-09-28T00:00:00Z") / 1000;

function makeOpenEvidence(overrides: Partial<V9OpenEvidence> = {}): V9OpenEvidence {
  return {
    semantics: "open-question-v1",
    totals: { questions: 5, open: 3, issuer: 2, documentation: 0, obligations: 9 },
    owners: [{ responsibility: "unresearched", questions: 3, obligations: 6 }],
    reasons: [
      { code: "missing-reserve-composition", bucket: "issuer", questions: 2, obligations: 3 },
      { code: "unresolved-control-identity", bucket: "open", questions: 3, obligations: 6 },
    ],
    documentation: { questions: 0, datums: 0, facts: 0, reasons: [] },
    issuer: {
      questions: 2,
      assets: 1,
      oldestReviewedAtSec: REVIEWED_AT_SEC,
      newestReviewedAtSec: REVIEWED_AT_SEC,
    },
    byCard: [],
    ...overrides,
  };
}

function withGaps(
  card: SafetyScoreV9CurrentCard,
  summaries: Array<{
    responsibility: V9EvidenceResponsibility;
    factCount: number;
    criticalFactCount: number;
    reasonCodes: string[];
  }>,
): SafetyScoreV9CurrentCard {
  const currentSummaries = card.scoreTrace.evidenceResponsibility.summaries.some(
    (summary) => summary.responsibility === "published-evidence-expired",
  )
    ? card.scoreTrace.evidenceResponsibility.summaries
    : [
        ...card.scoreTrace.evidenceResponsibility.summaries,
        {
          responsibility: "published-evidence-expired" as const,
          factCount: 0,
          criticalFactCount: 0,
          reasonCodes: [],
        },
      ];
  const base = currentSummaries.map((summary) => {
    const override = summaries.find((entry) => entry.responsibility === summary.responsibility);
    return override ? { ...summary, ...override } : summary;
  }) as SafetyScoreV9CurrentCard["scoreTrace"]["evidenceResponsibility"]["summaries"];
  return {
    ...card,
    scoreTrace: {
      ...card.scoreTrace,
      evidenceResponsibility: {
        ...card.scoreTrace.evidenceResponsibility,
        totalFactCount: base.reduce((sum, summary) => sum + (summary.factCount ?? 0), 0),
        summaries: base,
      },
    },
  };
}

describe("buildDataCoverageModel", () => {
  it("returns null without a response", () => {
    expect(buildDataCoverageModel(null)).toBeNull();
    expect(buildDataCoverageModel(undefined)).toBeNull();
  });

  it("copies the three server-computed buckets instead of re-deriving them", () => {
    const response = makeReportCardsV9Response({
      cards: [makeV9Card({ id: "aaa-one" })],
      openEvidence: makeOpenEvidence(),
    });

    const model = buildDataCoverageModel(response)!;

    expect(model.openEvidence).toEqual({
      semantics: "open-question-v1",
      questions: 5,
      open: 3,
      issuer: 2,
      documentation: 0,
      obligations: 9,
      documentationDatums: 0,
      documentationFacts: 0,
      issuerReview: {
        oldestReviewedAtSec: REVIEWED_AT_SEC,
        newestReviewedAtSec: REVIEWED_AT_SEC,
      },
    });
    expect(model.gapOwners).toEqual([
      expect.objectContaining({
        responsibility: "unresearched",
        questions: 3,
        obligations: 6,
        share: 1,
      }),
    ]);
    expect(model.reasons.map((reason) => [reason.bucket, reason.code, reason.count])).toEqual([
      ["open", "unresolved-control-identity", 3],
      ["issuer", "missing-reserve-composition", 2],
    ]);
  });

  it("renders unavailable, never zero, when the payload predates open evidence", () => {
    const response = makeReportCardsV9Response({
      cards: [makeV9Card({ id: "aaa-one" })],
    });
    expect(response.openEvidence).toBeNull();
    expect(response.openEvidenceUnavailableReason).toBe("publication-predates-open-evidence");

    const model = buildDataCoverageModel(response)!;

    expect(model.openEvidence).toBeNull();
    expect(model.gapOwners).toEqual([]);
    expect(model.reasons).toEqual([]);
    // Card-level assessments stay readable; only the question counts are unavailable.
    expect(model.assetCount).toBe(1);
    expect(model.inputsEvaluated).toBe(8);
  });

  it("labels unresearched responsibility Unresolved and explains inconclusive research", () => {
    const response = makeReportCardsV9Response({
      cards: [makeV9Card({ id: "aaa-one" })],
      openEvidence: makeOpenEvidence({
        totals: { questions: 1, open: 1, issuer: 0, documentation: 0, obligations: 1 },
        owners: [{ responsibility: "unresearched", questions: 1, obligations: 1 }],
        reasons: [{ code: "unresolved-control-identity", bucket: "open", questions: 1, obligations: 1 }],
        issuer: { questions: 0, assets: 0, oldestReviewedAtSec: null, newestReviewedAtSec: null },
      }),
    });

    expect(buildDataCoverageModel(response)!.gapOwners).toContainEqual(expect.objectContaining({
      responsibility: "unresearched",
      label: "Unresolved",
      detail: "No admissible evidence settles this input yet: it is unresearched or was researched without a conclusive source. This is not a claim of issuer silence.",
      questions: 1,
    }));
  });

  it("partitions the headline open bucket by owner and names the mixed remainder", () => {
    const response = makeReportCardsV9Response({
      cards: [makeV9Card({ id: "aaa-one" })],
      openEvidence: makeOpenEvidence({
        totals: { questions: 6, open: 6, issuer: 0, documentation: 0, obligations: 12 },
        owners: [
          { responsibility: "mixed", questions: 2, obligations: 4 },
          { responsibility: "producer-failed", questions: 4, obligations: 8 },
        ],
        reasons: [{ code: "missing-runtime-route-evidence", bucket: "open", questions: 6, obligations: 12 }],
        issuer: { questions: 0, assets: 0, oldestReviewedAtSec: null, newestReviewedAtSec: null },
      }),
    });

    const model = buildDataCoverageModel(response)!;

    expect(model.gapOwners.map((owner) => [owner.responsibility, owner.questions])).toEqual([
      ["producer-failed", 4],
      ["mixed", 2],
    ]);
    expect(model.gapOwners.find((owner) => owner.responsibility === "mixed")).toMatchObject({
      label: "Several owners",
    });
    expect(model.gapOwners.reduce((sum, owner) => sum + owner.share, 0)).toBe(1);
  });

  it("maps the Pharos-owned classes to their existing reader labels", () => {
    const response = makeReportCardsV9Response({
      cards: [makeV9Card({ id: "aaa-one" })],
      openEvidence: makeOpenEvidence({
        totals: { questions: 5, open: 5, issuer: 0, documentation: 0, obligations: 9 },
        owners: [
          { responsibility: "published-evidence-expired", questions: 2, obligations: 4 },
          { responsibility: "public-data-uncurated", questions: 1, obligations: 2 },
          { responsibility: "integration-missing", questions: 2, obligations: 3 },
        ],
        reasons: [],
        issuer: { questions: 0, assets: 0, oldestReviewedAtSec: null, newestReviewedAtSec: null },
      }),
    });

    const labels = Object.fromEntries(
      buildDataCoverageModel(response)!.gapOwners.map((owner) => [owner.responsibility, owner.label]),
    );

    expect(labels).toEqual({
      "integration-missing": "Pharos has not integrated it yet",
      "published-evidence-expired": "Published evidence is out of date",
      "public-data-uncurated": "Awaiting curation",
    });
  });

  it("labels reasons in plain English and groups them by server bucket", () => {
    const response = makeReportCardsV9Response({
      cards: [makeV9Card({ id: "aaa-one" })],
      openEvidence: makeOpenEvidence(),
    });

    const reasons = buildDataCoverageModel(response)!.reasons;

    expect(reasons.map((reason) => reason.label)).toEqual([
      "Controlling entity not identified",
      "Reserve composition not published",
    ]);
    expect(reasons.every((reason) => reason.countUnit === "questions")).toBe(true);
    expect(reasons.every((reason) => !reason.label.includes("-"))).toBe(true);
  });

  it("inventories documentation reasons in datums, after the question buckets", () => {
    const response = makeReportCardsV9Response({
      cards: [makeV9Card({ id: "aaa-one" })],
      openEvidence: makeOpenEvidence({
        totals: { questions: 4, open: 3, issuer: 0, documentation: 1, obligations: 265 },
        documentation: {
          questions: 1,
          datums: 256,
          facts: 250,
          reasons: [{ reason: "no-scoring-path", datums: 256 }],
        },
        reasons: [{ code: "unresolved-control-identity", bucket: "open", questions: 3, obligations: 6 }],
        issuer: { questions: 0, assets: 0, oldestReviewedAtSec: null, newestReviewedAtSec: null },
      }),
    });

    const model = buildDataCoverageModel(response)!;

    expect(model.reasons.at(-1)).toEqual({
      code: "no-scoring-path",
      bucket: "documentation",
      // T1 has no documentation policy block yet; the label degrades visibly.
      label: "No scoring path",
      questions: null,
      count: 256,
      countUnit: "datums",
    });
    expect(model.openEvidence).toMatchObject({ documentation: 1, documentationDatums: 256 });
  });

  it("keeps a critical obligation count separate from the reason inventory", () => {
    const response = makeReportCardsV9Response({
      cards: [
        withGaps(makeV9Card({ id: "aaa-one" }), [
          {
            responsibility: "unresearched",
            factCount: 2,
            criticalFactCount: 1,
            reasonCodes: ["missing-reserve-composition"],
          },
        ]),
      ],
      openEvidence: makeOpenEvidence({
        reasons: [{ code: "unresolved-control-identity", bucket: "open", questions: 3, obligations: 6 }],
      }),
    });

    const model = buildDataCoverageModel(response)!;

    expect(model.criticalGapCount).toBe(1);
    expect(model.reasons.map((reason) => reason.code)).toEqual(["unresolved-control-identity"]);
  });

  it("reconciles completeness and evaluated inputs across cards", () => {
    const response = makeReportCardsV9Response({
      cards: [makeV9Card({ id: "aaa-one" }), makeV9Card({ id: "bbb-two" })],
      openEvidence: makeOpenEvidence(),
    });

    const model = buildDataCoverageModel(response)!;

    expect(model.assetCount).toBe(2);
    expect(model.ratedCount).toBe(2);
    expect(model.notRatedCount).toBe(0);
    // Each fixture card contributes 1 backing + 6 exit route + 1 control component.
    expect(model.inputsByPillar).toEqual([
      { key: "backing", label: "Backing", count: 2 },
      { key: "exit", label: "Exit", count: 12 },
      { key: "control", label: "Econ. control", count: 2 },
    ]);
    expect(model.inputsEvaluated).toBe(16);
    expect(model.backingObservedCount).toBe(2);
    expect(model.backingKnownCount).toBe(2);
  });

  it("counts critical gaps carried by not-rated cards without evaluating inputs", () => {
    const notRated = withGaps(
      makeV9Card({
        id: "ccc-three",
        score: null,
        grade: "NR",
        qualityScore: null,
        pegMultiplier: null,
        pegAdjustedScore: null,
        nrReasons: [
          {
            code: "insufficient-evidence",
            message: "Not enough evidence",
            field: null,
            origin: "asset",
          },
        ],
      }),
      [
        {
          responsibility: "integration-missing",
          factCount: 7,
          criticalFactCount: 2,
          reasonCodes: ["insufficient-evidence"],
        },
      ],
    );
    const model = buildDataCoverageModel(
      makeReportCardsV9Response({
        cards: [notRated],
        openEvidence: makeOpenEvidence({
          totals: { questions: 0, open: 0, issuer: 0, documentation: 0, obligations: 7 },
          owners: [],
          reasons: [],
          issuer: { questions: 0, assets: 0, oldestReviewedAtSec: null, newestReviewedAtSec: null },
        }),
      }),
    )!;

    expect(model.notRatedCount).toBe(1);
    expect(model.criticalGapCount).toBe(2);
    expect(model.openEvidence?.obligations).toBe(7);
    // NR cards publish no component breakdowns.
    expect(model.inputsEvaluated).toBe(0);
  });

  it("reports no hold when the publication is current", () => {
    expect(buildDataCoverageModel(makeReportCardsV9Response())!.hold).toBeNull();
  });
});

describe("describeIssuerReview", () => {
  it("dates a single review and a review window without re-dating it", () => {
    expect(describeIssuerReview({
      oldestReviewedAtSec: REVIEWED_AT_SEC,
      newestReviewedAtSec: REVIEWED_AT_SEC,
    })).toBe("Reviewed Oct 3, 2026; the issuer does not publish this datum.");
    expect(describeIssuerReview({
      oldestReviewedAtSec: EARLIER_REVIEWED_AT_SEC,
      newestReviewedAtSec: REVIEWED_AT_SEC,
    })).toBe("Reviewed Sep 28, 2026 – Oct 3, 2026; the issuer does not publish this datum.");
  });
});

describe("describeDataCoverageHoldCauses", () => {
  it("describes input-health and coverage-floor holds without raw identifiers", () => {
    const causes = describeDataCoverageHoldCauses([
      { code: "dex-stale" },
      { code: "live-reserves-unavailable" },
      { code: "live-reserves-coverage-below-floor" },
      { code: "coverage-floor-failed", floorIds: ["floor-a", "floor-b"] },
    ]);

    expect(causes).toEqual([
      "DEX liquidity data is behind schedule.",
      "Live reserve data is unavailable.",
      "Live reserve coverage is below the publication floor.",
      "Coverage fell below the required floor for 2 checks.",
    ]);
    expect(causes.join(" ")).not.toContain("floor-a");
  });

});
