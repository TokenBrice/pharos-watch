import { describe, expect, it } from "vitest";
import {
  makeReportCardsV9ArchivedResponse,
  makeReportCardsV9Card,
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

const report9 = makeReportCardsV9Response(PRESET, makeReportCardsV9Card, { cards: [] });
const report8 = makeReportCardsV9ArchivedResponse(PRESET, makeReportCardsV9Card, { cards: [] });

describe("accepted report-cards response contract", () => {
  it("admits the emitted report9 and the archive-only report8 rollback payload", () => {
    expect(ReportCardsV9AcceptedResponseSchema.parse(report9)).toEqual(report9);
    expect(ReportCardsV9AcceptedResponseSchema.parse(report8)).toEqual(report8);
  });

  it("keeps the wire version and the open-evidence pair on the report9 payload", () => {
    const parsed = ReportCardsV9AcceptedResponseSchema.parse(report9);
    expect(parsed.schemaVersion).toBe(9);
    if (parsed.schemaVersion !== 9) throw new Error("expected report9");
    expect(parsed.openEvidence).toBeNull();
    expect(parsed.openEvidenceUnavailableReason).toBe("publication-predates-open-evidence");
  });

  it("reads report8 as report9 with unavailable open evidence, never zero", () => {
    const parsed = ReportCardsV9ReaderResponseSchema.parse(report8);
    expect(parsed.schemaVersion).toBe(9);
    expect(parsed.openEvidence).toBeNull();
    expect(parsed.openEvidenceUnavailableReason).toBe("publication-predates-open-evidence");
    expect(parsed.cards).toEqual(report9.cards);
    expect(projectReportCardsV9ReaderResponse(report9)).toEqual(report9);
  });

  it.each([6, 7, 10, 11])("fails closed for schemaVersion %s", (schemaVersion) => {
    expect(ReportCardsV9AcceptedResponseSchema.safeParse({ ...report9, schemaVersion }).success).toBe(false);
    expect(ReportCardsV9ReaderResponseSchema.safeParse({ ...report8, schemaVersion }).success).toBe(false);
  });
});
