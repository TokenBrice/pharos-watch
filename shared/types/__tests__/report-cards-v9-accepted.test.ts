import { describe, expect, it } from "vitest";
import {
  makeReportCardsV9Card,
  makeReportCardsV9NextResponse,
  makeReportCardsV9Response,
  type ReportCardsV9ResponseFixturePreset,
} from "@shared/test-utils/report-cards-v9";
import {
  ReportCardsV9AcceptedResponseSchema,
  ReportCardsV9ReaderResponseSchema,
  projectReportCardsV9ReaderResponse,
} from "../report-cards-v9-accepted";

const PRESET = {
  safetyScoreIdentity: {
    model: "v9", schemaVersion: 1, methodologyVersion: "9.0", policyId: "safety-score-v9",
    policyDigest: "a".repeat(64), evaluationBuildDigest: "b".repeat(64),
    baseInputGenerationId: `report-cards-input:v1:${"c".repeat(64)}`,
    publicationGenerationId: "v9-publication-1",
  },
  defaultUpdatedAt: 1, asOfSec: 1,
  source: {
    candidateId: "safety-score-v9:v1:2026-07-15", factSetDigest: "c".repeat(64),
    resultDigest: "d".repeat(64), sourceGenerations: { reportCards: "source-1" },
  },
} satisfies ReportCardsV9ResponseFixturePreset;

const report8 = makeReportCardsV9Response(PRESET, makeReportCardsV9Card, { cards: [] });
const report9 = makeReportCardsV9NextResponse(PRESET, makeReportCardsV9Card, { cards: [] });

describe("accepted report-cards response contract", () => {
  it("admits the emitted report8 and the next report9 contract", () => {
    expect(ReportCardsV9AcceptedResponseSchema.parse(report8)).toEqual(report8);
    expect(ReportCardsV9AcceptedResponseSchema.parse(report9)).toEqual(report9);
  });

  it("keeps the wire version and the report9-only carriers on the accepted payload", () => {
    const parsed = ReportCardsV9AcceptedResponseSchema.parse(report9);
    expect(parsed.schemaVersion).toBe(9);
    if (parsed.schemaVersion !== 9) throw new Error("expected report9");
    expect(parsed.openEvidence).toBeNull();
    expect(parsed.openEvidenceUnavailableReason).toBe("publication-predates-open-evidence");
  });

  it("gives readers the report8 view without the report9-only carriers", () => {
    const parsed = ReportCardsV9ReaderResponseSchema.parse(report9);
    expect(parsed.schemaVersion).toBe(8);
    expect(parsed).not.toHaveProperty("openEvidence");
    expect(parsed).not.toHaveProperty("openEvidenceUnavailableReason");
    expect(parsed).not.toHaveProperty("documentationCauseGaps");
    expect(projectReportCardsV9ReaderResponse(report8)).toEqual(report8);
    expect(parsed.cards).toEqual(report8.cards);
  });

  it.each([6, 7, 10, 11])("fails closed for schemaVersion %s", (schemaVersion) => {
    expect(ReportCardsV9AcceptedResponseSchema.safeParse({ ...report8, schemaVersion }).success).toBe(false);
    expect(ReportCardsV9ReaderResponseSchema.safeParse({ ...report9, schemaVersion }).success).toBe(false);
  });
});
