import { beforeEach, describe, expect, it, vi } from "vitest";
import { makeReportCardsV9Response } from "../../test-helpers/report-cards-v9";
import { mockD1 } from "@shared/test-utils/mock-d1";

const mockLoadPublication = vi.fn();
const mockLoadPublicationHealth = vi.fn();

vi.mock("../safety-score-v9-publication-store", () => ({
  loadSafetyScoreV9Publication: mockLoadPublication,
  loadSafetyScoreV9PublicationHealth: mockLoadPublicationHealth,
}));

const { loadActiveSafetyScoreIdentity } = await import(
  "../safety-score-active-source"
);

function evaluatorPublication() {
  const response = makeReportCardsV9Response();
  return {
    model: "v9-critical-path" as const,
    lifecycle: "active" as const,
    schemaVersion: 5 as const,
    candidateId: response.source.candidateId,
    policyVersion: response.methodology.version,
    policy: response.methodology.policy,
    evaluationBuildDigest: response.safetyScoreIdentity.evaluationBuildDigest,
    baseInputGenerationId: response.safetyScoreIdentity.baseInputGenerationId,
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

function matchingHealth(publication: ReturnType<typeof evaluatorPublication>) {
  return {
    ...makeReportCardsV9Response().publicationHealth,
    acceptedPublicationGenerationId: publication.publicationGenerationId,
    acceptedAtSec: publication.publishedAtSec,
  };
}

/**
 * The identity-only loader is what the yield publish-time guard reads, so its
 * three states have to match `loadActiveSafetyScoreSource` exactly: only `v9`
 * lets the guard compare identities, and every unavailable or incompatible
 * publication has to fail closed to `error` instead of throwing.
 */
describe("active Safety Score identity", () => {
  beforeEach(() => {
    mockLoadPublication.mockReset();
    mockLoadPublicationHealth.mockReset();
  });

  it("resolves the canonical publication identity without the cards", async () => {
    const publication = evaluatorPublication();
    mockLoadPublication.mockResolvedValue(publication);
    mockLoadPublicationHealth.mockResolvedValue(matchingHealth(publication));

    await expect(loadActiveSafetyScoreIdentity(mockD1())).resolves.toEqual({
      kind: "v9",
      safetyScoreIdentity: {
        model: "v9",
        schemaVersion: 1,
        methodologyVersion: publication.policyVersion,
        policyId: publication.policy.id,
        policyDigest: publication.policy.semanticDigest,
        evaluationBuildDigest: publication.evaluationBuildDigest,
        baseInputGenerationId: publication.baseInputGenerationId,
        publicationGenerationId: publication.publicationGenerationId,
      },
    });
  });

  it("reports a held publication as held and still carries its identity", async () => {
    const publication = evaluatorPublication();
    mockLoadPublication.mockResolvedValue(publication);
    mockLoadPublicationHealth.mockResolvedValue({
      ...matchingHealth(publication),
      status: "held",
      heldSinceSec: publication.publishedAtSec + 1_800,
      reasons: [{ code: "dex-stale" }],
    });

    await expect(loadActiveSafetyScoreIdentity(mockD1())).resolves.toMatchObject({
      kind: "held",
      safetyScoreIdentity: {
        publicationGenerationId: publication.publicationGenerationId,
      },
    });
  });

  it("holds when health points at another generation", async () => {
    const publication = evaluatorPublication();
    mockLoadPublication.mockResolvedValue(publication);
    mockLoadPublicationHealth.mockResolvedValue({
      ...makeReportCardsV9Response().publicationHealth,
      acceptedPublicationGenerationId: "report-cards:v9:other",
      acceptedAtSec: publication.publishedAtSec + 1,
    });

    await expect(loadActiveSafetyScoreIdentity(mockD1())).resolves.toMatchObject({
      kind: "held",
    });
  });

  it("fails closed to error when the publication row is missing", async () => {
    mockLoadPublication.mockResolvedValue(null);
    mockLoadPublicationHealth.mockResolvedValue(
      makeReportCardsV9Response().publicationHealth,
    );

    await expect(loadActiveSafetyScoreIdentity(mockD1())).resolves.toEqual({
      kind: "error",
      safetyScoreIdentity: null,
    });
  });

  it("fails closed to error when the health row is missing", async () => {
    const publication = evaluatorPublication();
    mockLoadPublication.mockResolvedValue(publication);
    mockLoadPublicationHealth.mockResolvedValue(null);

    await expect(loadActiveSafetyScoreIdentity(mockD1())).resolves.toEqual({
      kind: "error",
      safetyScoreIdentity: null,
    });
  });

  it("fails closed to error when a load rejects instead of propagating", async () => {
    mockLoadPublication.mockRejectedValue(new Error("D1 unavailable"));
    mockLoadPublicationHealth.mockResolvedValue(
      makeReportCardsV9Response().publicationHealth,
    );

    await expect(loadActiveSafetyScoreIdentity(mockD1())).resolves.toEqual({
      kind: "error",
      safetyScoreIdentity: null,
    });
  });

  it("fails closed to error when the stored publication is incompatible", async () => {
    mockLoadPublication.mockResolvedValue({ publicationGenerationId: "only-a-fragment" });
    mockLoadPublicationHealth.mockResolvedValue(
      makeReportCardsV9Response().publicationHealth,
    );

    await expect(loadActiveSafetyScoreIdentity(mockD1())).resolves.toEqual({
      kind: "error",
      safetyScoreIdentity: null,
    });
  });
});
