import { beforeEach, describe, expect, it, vi } from "vitest";
import { makeReportCardsV9Response } from "../../test-helpers/report-cards-v9";
import { mockD1 } from "../../test-helpers/__shared/mock-d1";

const mockLoadPublication = vi.fn();
const mockLoadPublicationHealth = vi.fn();

vi.mock("../safety-score-v9-publication-store", () => ({
  loadSafetyScoreV9Publication: mockLoadPublication,
  loadSafetyScoreV9PublicationHealth: mockLoadPublicationHealth,
}));

const {
  loadPublishedReportCardsV9Snapshot,
  projectSafetyScoreV9PublicationToPublicSnapshot,
  ReportCardsV9SnapshotUnavailableError,
} = await import("../report-cards-v9-cache");

function evaluatorPublication() {
  const response = makeReportCardsV9Response();
  return {
    model: "v9-critical-path" as const,
    lifecycle: "active" as const,
    schemaVersion: 5 as const,
    candidateId: response.source.candidateId,
    policyVersion: response.methodology.version,
    policy: response.methodology.policy,
    evaluationBuildDigest:
      response.safetyScoreIdentity.evaluationBuildDigest,
    baseInputGenerationId:
      response.safetyScoreIdentity.baseInputGenerationId,
    publicationGenerationId:
      response.safetyScoreIdentity.publicationGenerationId,
    factSetDigest: response.source.factSetDigest,
    resultDigest: response.source.resultDigest,
    sourceGenerations: response.source.sourceGenerations,
    asOfSec: response.asOfSec,
    publishedAtSec: response.updatedAt,
    completeness: response.completeness,
    cards: response.cards,
  };
}

describe("canonical V9 report-card cache", () => {
  beforeEach(() => {
    mockLoadPublication.mockReset();
    mockLoadPublicationHealth.mockReset();
  });

  it("projects the evaluator publication into the active report-v4 contract", () => {
    const publication = evaluatorPublication();
    const health = makeReportCardsV9Response().publicationHealth;

    expect(
      projectSafetyScoreV9PublicationToPublicSnapshot(publication, health),
    ).toMatchObject({
      model: "v9",
      schemaVersion: 4,
      lifecycle: "active",
      safetyScoreIdentity: {
        publicationGenerationId: publication.publicationGenerationId,
      },
    });
  });

  it("requires matching publication and health rows", async () => {
    mockLoadPublication.mockResolvedValue(evaluatorPublication());
    mockLoadPublicationHealth.mockResolvedValue(null);

    await expect(
      loadPublishedReportCardsV9Snapshot(mockD1()),
    ).rejects.toBeInstanceOf(ReportCardsV9SnapshotUnavailableError);
  });
});
