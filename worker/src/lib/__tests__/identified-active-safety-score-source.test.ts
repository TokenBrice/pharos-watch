import type { ReportCardsResponse } from "@shared/types/report-cards";
import type { ReportCardsV9Response } from "@shared/types/report-cards-v9";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  loadActiveSafetyScoreSource: vi.fn(),
  loadActiveV8SafetyScoreHistorySource: vi.fn(),
}));

vi.mock("../safety-score-active-source", () => ({
  loadActiveSafetyScoreSource: mocks.loadActiveSafetyScoreSource,
}));

vi.mock("../safety-score-history-v2", () => ({
  loadActiveV8SafetyScoreHistorySource: mocks.loadActiveV8SafetyScoreHistorySource,
}));

const { loadIdentifiedActiveSafetyScoreSource } = await import(
  "../identified-active-safety-score-source"
);

const digest = (character: string) => character.repeat(64);
const db = {} as D1Database;
const v8Identity = {
  model: "v8" as const,
  schemaVersion: 1 as const,
  methodologyVersion: "8.17",
  evaluationBuildDigest: digest("a"),
  baseInputGenerationId: `report-cards-input:v1:${digest("b")}`,
  publicationGenerationId: "report-cards:8.17:100",
};
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
const v8Snapshot = {
  updatedAt: 100,
  cards: [],
  safetyScoreIdentity: v8Identity,
} as unknown as ReportCardsResponse;
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
const activeV8 = {
  kind: "v8" as const,
  expectedModel: "v8" as const,
  reason: "activation-marker-missing" as const,
  activationUpdatedAt: null,
};
const activeV9 = {
  kind: "v9" as const,
  expectedModel: "v9" as const,
  marker: {
    policyId: v9Identity.policyId,
    policyDigest: v9Identity.policyDigest,
    evaluationBuildDigest: v9Identity.evaluationBuildDigest,
    methodologyVersion: v9Identity.methodologyVersion,
  },
  activationUpdatedAt: 190,
  snapshot: v9Snapshot,
};
const activeError = {
  kind: "error" as const,
  expectedModel: "v9" as const,
  reason: "v9-identity-mismatch" as const,
  detail: "marker and snapshot disagree",
  activationUpdatedAt: 190,
  marker: activeV9.marker,
  snapshot: v9Snapshot,
};

describe("identified active Safety Score source", () => {
  beforeEach(() => {
    mocks.loadActiveSafetyScoreSource.mockReset();
    mocks.loadActiveV8SafetyScoreHistorySource.mockReset();
  });

  it("projects an active V9 snapshot without consulting V8", async () => {
    mocks.loadActiveSafetyScoreSource.mockResolvedValue(activeV9);

    await expect(loadIdentifiedActiveSafetyScoreSource(db)).resolves.toEqual({
      kind: "v9",
      expectedModel: "v9",
      identity: v9Identity,
      publishedAtSec: 200,
      activationUpdatedAt: 190,
      snapshot: v9Snapshot,
    });
    expect(mocks.loadActiveV8SafetyScoreHistorySource).not.toHaveBeenCalled();
  });

  it("treats held active V9 as unavailable without consulting V8", async () => {
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
      activationUpdatedAt: 190,
    });
    expect(mocks.loadActiveV8SafetyScoreHistorySource).not.toHaveBeenCalled();
  });

  it("preserves a fail-closed active-model error", async () => {
    mocks.loadActiveSafetyScoreSource.mockResolvedValue(activeError);

    await expect(loadIdentifiedActiveSafetyScoreSource(db)).resolves.toEqual({
      kind: "error",
      expectedModel: "v9",
      reason: "v9-identity-mismatch",
      detail: "marker and snapshot disagree",
      activationUpdatedAt: 190,
    });
    expect(mocks.loadActiveV8SafetyScoreHistorySource).not.toHaveBeenCalled();
  });

  it("loads the complete identified V8 source while no activation exists", async () => {
    mocks.loadActiveSafetyScoreSource.mockResolvedValue(activeV8);
    mocks.loadActiveV8SafetyScoreHistorySource.mockResolvedValue({
      snapshot: v8Snapshot,
      identity: v8Identity,
      publishedAtSec: 100,
    });

    await expect(loadIdentifiedActiveSafetyScoreSource(db)).resolves.toEqual({
      kind: "v8",
      expectedModel: "v8",
      identity: v8Identity,
      publishedAtSec: 100,
      activationUpdatedAt: null,
      snapshot: v8Snapshot,
    });
  });

  it("rechecks activation after a racing V8 read failure", async () => {
    mocks.loadActiveSafetyScoreSource
      .mockResolvedValueOnce(activeV8)
      .mockResolvedValueOnce(activeV9);
    mocks.loadActiveV8SafetyScoreHistorySource.mockRejectedValue(new Error("V8 cache changed"));

    await expect(loadIdentifiedActiveSafetyScoreSource(db)).resolves.toMatchObject({
      kind: "v9",
      identity: v9Identity,
      activationUpdatedAt: 190,
    });
    expect(mocks.loadActiveSafetyScoreSource).toHaveBeenCalledTimes(2);
  });

  it("preserves a V9 activation error found by the race recheck", async () => {
    mocks.loadActiveSafetyScoreSource
      .mockResolvedValueOnce(activeV8)
      .mockResolvedValueOnce(activeError);
    mocks.loadActiveV8SafetyScoreHistorySource.mockRejectedValue(new Error("V8 cache changed"));

    await expect(loadIdentifiedActiveSafetyScoreSource(db)).resolves.toMatchObject({
      kind: "error",
      expectedModel: "v9",
      reason: "v9-identity-mismatch",
      activationUpdatedAt: 190,
    });
  });

  it("reports an unavailable V8 snapshot only after V8 remains active", async () => {
    mocks.loadActiveSafetyScoreSource.mockResolvedValue(activeV8);
    mocks.loadActiveV8SafetyScoreHistorySource.mockRejectedValue(new Error("V8 cache missing"));

    await expect(loadIdentifiedActiveSafetyScoreSource(db)).resolves.toEqual({
      kind: "error",
      expectedModel: "v8",
      reason: "v8-snapshot-unavailable",
      detail: "V8 cache missing",
      activationUpdatedAt: null,
    });
    expect(mocks.loadActiveSafetyScoreSource).toHaveBeenCalledTimes(2);
  });
});
