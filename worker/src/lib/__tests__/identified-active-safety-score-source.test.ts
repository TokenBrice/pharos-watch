import type { ReportCardsV9Response } from "@shared/types/report-cards-v9";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  loadActiveSafetyScoreSource: vi.fn(),
}));

vi.mock("../safety-score-active-source", () => ({
  loadActiveSafetyScoreSource: mocks.loadActiveSafetyScoreSource,
}));

const { loadIdentifiedActiveSafetyScoreSource } = await import(
  "../identified-active-safety-score-source"
);

const digest = (character: string) => character.repeat(64);
const db = {} as D1Database;
const v9Identity = {
  model: "v9" as const,
  schemaVersion: 1 as const,
  methodologyVersion: "9.0",
  policyId: "safety-score-v9",
  policyDigest: digest("c"),
  evaluationBuildDigest: digest("d"),
  baseInputGenerationId: `report-cards-input:v1:${digest("e")}`,
  publicationGenerationId: "report-cards:v9:100",
};
const v9Snapshot = {
  updatedAt: 200,
  cards: [],
  safetyScoreIdentity: v9Identity,
  publicationHealth: {
    schemaVersion: 1,
    status: "current",
    acceptedPublicationGenerationId:
      v9Identity.publicationGenerationId,
    acceptedAtSec: 200,
    attemptedAtSec: 200,
    heldSinceSec: null,
    reasons: [],
  },
} as unknown as ReportCardsV9Response;
const activeV9 = {
  kind: "v9" as const,
  expectedModel: "v9" as const,
  snapshot: v9Snapshot,
};
const activeError = {
  kind: "error" as const,
  expectedModel: "v9" as const,
  reason: "v9-identity-mismatch" as const,
  detail: "marker and snapshot disagree",
};

describe("identified active Safety Score source", () => {
  beforeEach(() => {
    mocks.loadActiveSafetyScoreSource.mockReset();
  });

  it("projects the canonical active V9 snapshot", async () => {
    mocks.loadActiveSafetyScoreSource.mockResolvedValue(activeV9);

    await expect(loadIdentifiedActiveSafetyScoreSource(db)).resolves.toEqual({
      kind: "v9",
      expectedModel: "v9",
      identity: v9Identity,
      publishedAtSec: 200,
      snapshot: v9Snapshot,
    });
  });

  it("treats held canonical V9 as unavailable", async () => {
    mocks.loadActiveSafetyScoreSource.mockResolvedValue({
      ...activeV9,
      snapshot: {
        ...v9Snapshot,
        publicationHealth: {
          ...v9Snapshot.publicationHealth,
          status: "held",
          attemptedAtSec: 300,
          heldSinceSec: 300,
          reasons: [{ code: "dex-stale" }],
        },
      },
    });

    await expect(loadIdentifiedActiveSafetyScoreSource(db)).resolves.toEqual({
      kind: "error",
      expectedModel: "v9",
      reason: "v9-publication-held",
      detail:
        "Canonical Safety Score V9 ratings are held at the last verified snapshot",
    });
  });

  it("preserves a fail-closed active-model error", async () => {
    mocks.loadActiveSafetyScoreSource.mockResolvedValue(activeError);

    await expect(loadIdentifiedActiveSafetyScoreSource(db)).resolves.toEqual({
      kind: "error",
      expectedModel: "v9",
      reason: "v9-identity-mismatch",
      detail: "marker and snapshot disagree",
    });
  });
});
