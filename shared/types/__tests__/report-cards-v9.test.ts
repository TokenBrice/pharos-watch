import { describe, expect, it } from "vitest";
import {
  HistoricalResolvedReportCardsV9ResponseSchema,
  REPORT_CARDS_V9_RESPONSE_SCHEMA_VERSION,
} from "../report-cards-v9";
import {
  ReportCardsV9CurrentResponseSchema,
  type ReportCardsV9Response,
} from "../report-cards-v9-current";
import { ReportCardsV9DetailResponseSchema } from "../report-cards-v9-projections";
import { projectV9Detail } from "../../lib/report-cards-v9-projections";
import type { V9OpenEvidence } from "../safety-score-v9-public";
import { makeReportCardsV9Card, makeReportCardsV9Response } from "@shared/test-utils/report-cards-v9";

const preset = {
  safetyScoreIdentity: {
    model: "v9",
    schemaVersion: 1,
    methodologyVersion: "10.36",
    policyId: "safety-score-v9",
    policyDigest: "a".repeat(64),
    evaluationBuildDigest: "b".repeat(64),
    baseInputGenerationId: `report-cards-input:v1:${"c".repeat(64)}`,
    publicationGenerationId: "report-cards:v9:fixture",
  },
  defaultUpdatedAt: 1_000,
  asOfSec: 1_000,
  source: {
    candidateId: "safety-score-v9:fixture",
    factSetDigest: "c".repeat(64),
    resultDigest: "d".repeat(64),
    sourceGenerations: { reportCards: "source-1" },
  },
} satisfies {
  safetyScoreIdentity: ReportCardsV9Response["safetyScoreIdentity"];
  defaultUpdatedAt: number;
  asOfSec: number;
  source: ReportCardsV9Response["source"];
};

const base = makeReportCardsV9Response(preset, makeReportCardsV9Card);

const openEvidence: V9OpenEvidence = {
  semantics: "open-question-v1",
  totals: { questions: 1, open: 1, issuer: 0, documentation: 0, obligations: 2 },
  owners: [{ responsibility: "unresearched", questions: 1, obligations: 2 }],
  reasons: [{ code: "unresolved-control-identity", bucket: "open", questions: 1, obligations: 2 }],
  documentation: { questions: 0, datums: 0, facts: 0, reasons: [] },
  issuer: { questions: 0, assets: 0, oldestReviewedAtSec: null, newestReviewedAtSec: null },
  byCard: [{
    id: "usdc-circle",
    openBucketQuestionsCarried: 1,
    inheritedOpenBucketQuestionsCarried: 0,
    openBucketObligationsCarried: 2,
    documentationObligationsCarried: 0,
  }],
};

describe("report-cards v9 open-evidence envelope", () => {
  it("reads schema 9 live and keeps archived schema-8 rows out of the live reader", () => {
    expect(REPORT_CARDS_V9_RESPONSE_SCHEMA_VERSION).toBe(9);
    const { openEvidence: _evidence, openEvidenceUnavailableReason: _reason, ...report8 } = base;
    const archived = { ...report8, schemaVersion: 8 };
    expect(HistoricalResolvedReportCardsV9ResponseSchema.safeParse(archived).success).toBe(true);
    expect(ReportCardsV9CurrentResponseSchema.safeParse(archived).success).toBe(false);
  });

  it("accepts a live payload without openEvidence so a retained pre-cutover cache renders unavailable", () => {
    expect(ReportCardsV9CurrentResponseSchema.safeParse(base).success).toBe(true);
  });

  it("validates the open-evidence block against the published cards", () => {
    const withEvidence = makeReportCardsV9Response(preset, makeReportCardsV9Card, { openEvidence });
    expect(ReportCardsV9CurrentResponseSchema.safeParse(withEvidence).success).toBe(true);

    const orphaned = structuredClone(openEvidence);
    orphaned.byCard[0]!.id = "usdt-tether";
    expect(ReportCardsV9CurrentResponseSchema.safeParse(
      makeReportCardsV9Response(preset, makeReportCardsV9Card, { openEvidence: orphaned }),
    ).success).toBe(false);

    const overCounted = structuredClone(openEvidence);
    overCounted.byCard[0]!.openBucketObligationsCarried = -1;
    expect(ReportCardsV9CurrentResponseSchema.safeParse(
      makeReportCardsV9Response(preset, makeReportCardsV9Card, { openEvidence: overCounted }),
    ).success).toBe(false);
  });

  it("mirrors the documentation-only pillar annotation into the detail projection", () => {
    const annotatedEvidence: V9OpenEvidence = {
      ...openEvidence,
      byCard: [{ ...openEvidence.byCard[0]!, documentationOnlyLimited: ["backing", "control", "exit"] }],
    };
    const annotated = projectV9Detail(
      makeReportCardsV9Response(preset, makeReportCardsV9Card, { openEvidence: annotatedEvidence }),
      "usdc-circle",
    );
    expect(annotated.documentationOnlyLimited).toEqual(["backing", "control", "exit"]);
    expect(ReportCardsV9DetailResponseSchema.safeParse(annotated).success).toBe(true);

    const plain = projectV9Detail(base, "usdc-circle");
    expect("documentationOnlyLimited" in plain).toBe(false);

    expect(ReportCardsV9DetailResponseSchema.safeParse({ ...annotated, documentationOnlyLimited: [] }).success).toBe(false);
    expect(ReportCardsV9DetailResponseSchema.safeParse({ ...annotated, documentationOnlyLimited: ["peg"] }).success).toBe(false);
    expect(ReportCardsV9DetailResponseSchema.safeParse(
      { ...annotated, documentationOnlyLimited: ["exit", "backing"] },
    ).success).toBe(false);
  });
});
