import { beforeEach, describe, expect, it, vi } from "vitest";
import { makeReportCardsV9Response, makeWorkerSafetyScoreV9Publication, makeWorkerV9Card } from "../../test-helpers/report-cards-v9";
import { mockD1 } from "@shared/test-utils/mock-d1";
import { ReportCardsV9DependencyGraphSchema, buildReportCardsV9DependencyGraph } from "@shared/types/report-cards-v9";

const mockLoadPublication = vi.fn();
const mockLoadPublicationHealth = vi.fn();

vi.mock("../safety-score-v9/publication-store", () => ({
  loadSafetyScoreV9Publication: mockLoadPublication,
  loadSafetyScoreV9PublicationHealth: mockLoadPublicationHealth,
}));

const {
  loadPublishedReportCardsV9Snapshot,
  projectSafetyScoreV9PublicationToPublicSnapshot,
  ReportCardsV9SnapshotUnavailableError,
} = await import("../report-cards-v9-cache");

describe("canonical V9 report-card cache", () => {
  beforeEach(() => {
    mockLoadPublication.mockReset();
    mockLoadPublicationHealth.mockReset();
  });

  it("projects the evaluator publication into the active report-v7 contract", () => {
    const publication = makeWorkerSafetyScoreV9Publication();
    const health = makeReportCardsV9Response().publicationHealth;

    expect(
      projectSafetyScoreV9PublicationToPublicSnapshot(publication, health),
    ).toMatchObject({
      model: "v9",
      schemaVersion: 7,
      lifecycle: "active",
      safetyScoreIdentity: {
        publicationGenerationId: publication.publicationGenerationId,
      },
    });
  });


  it("rejects duplicated or unsorted graph edges", () => {
    const edge = { from: "alpha", to: "beta", kind: "basket" as const, materiality: "basket-weighted" as const, weight: 0.4, upstreamScore: 80 };
    expect(ReportCardsV9DependencyGraphSchema.safeParse({ edges: [edge, edge] }).success).toBe(false);
    expect(ReportCardsV9DependencyGraphSchema.safeParse({ edges: [{ ...edge, from: "zeta" }, edge] }).success).toBe(false);
    expect(ReportCardsV9DependencyGraphSchema.safeParse({ edges: [edge, { ...edge, from: "zeta" }] }).success).toBe(true);
  });

  it("projects dependency provenance exactly and excludes coverage from graph edges", () => {
    const provenance = { source: "live-reserve" as const, evidenceAsOf: "2026-09-29", intermediary: { kind: "bridge" as const, label: "Issuer bridge", verified: false } };
    const card = makeWorkerV9Card({
      id: "dependent",
      dependencies: { serial: [{ upstreamAssetId: "parent", score: 80, ratingStatus: "rated", partialEvidence: null, causeGapRefs: [], limitedEvidenceCauses: [], blocked: false, dependencyType: "wrapper", wrapperForm: "strategy-vault", provenance }], basket: [], roles: [], cycleBlocked: false, reasonCodes: [] },
      dependencyCoverage: [{ upstreamLabel: "Withheld coin", upstreamAssetId: null, share: 0.2, reason: "no-match", sourceAsOf: null, identityVerified: false }],
    });
    expect(buildReportCardsV9DependencyGraph([card]).edges).toEqual([{
      from: "parent", to: "dependent", kind: "serial", materiality: "serial", weight: null,
      upstreamScore: 80, dependencyType: "wrapper", wrapperForm: "strategy-vault", provenance,
    }]);
  });

  it("holds the stored publication when health points at another generation", () => {
    const publication = makeWorkerSafetyScoreV9Publication();
    const health = {
      ...makeReportCardsV9Response().publicationHealth,
      acceptedPublicationGenerationId: "report-cards:v9:other",
      acceptedAtSec: publication.publishedAtSec + 1,
    };

    expect(projectSafetyScoreV9PublicationToPublicSnapshot(publication, health).publicationHealth).toMatchObject({
      status: "held",
      acceptedPublicationGenerationId: publication.publicationGenerationId,
      acceptedAtSec: publication.publishedAtSec,
    });
  });

  it("holds a newer stored publication when health is older", () => {
    const publication = makeWorkerSafetyScoreV9Publication();
    const health = {
      ...makeReportCardsV9Response().publicationHealth,
      acceptedPublicationGenerationId: "report-cards:v9:older",
      acceptedAtSec: publication.publishedAtSec - 20,
      attemptedAtSec: publication.publishedAtSec - 10,
    };

    expect(projectSafetyScoreV9PublicationToPublicSnapshot(publication, health).publicationHealth).toMatchObject({
      status: "held",
      acceptedPublicationGenerationId: publication.publicationGenerationId,
      acceptedAtSec: publication.publishedAtSec,
      attemptedAtSec: publication.publishedAtSec,
      heldSinceSec: publication.publishedAtSec,
    });
  });

  it("requires a publication and health row", async () => {
    mockLoadPublication.mockResolvedValue(makeWorkerSafetyScoreV9Publication());
    mockLoadPublicationHealth.mockResolvedValue(null);

    await expect(
      loadPublishedReportCardsV9Snapshot(mockD1()),
    ).rejects.toBeInstanceOf(ReportCardsV9SnapshotUnavailableError);
  });
});
