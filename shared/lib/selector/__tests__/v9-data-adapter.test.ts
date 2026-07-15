import { describe, expect, it } from "vitest";
import { buildReportCardsV9DependencyGraph, type ReportCardsV9Response } from "../../../types/report-cards-v9";
import type { SafetyScoreV9Card } from "../../../types/safety-score-v9-public";
import { buildV9SelectorSnapshot, V9SelectorSnapshotUnavailableError } from "../v9-data-adapter";

const digest = (value: string) => value.repeat(64);

function card(): SafetyScoreV9Card {
  const pillar = {
    score: 80,
    evidenceLevel: "adequate" as const,
    freshness: "current" as const,
    components: ["reviewed"],
    reasons: [],
  };
  return {
    id: "asset-a",
    score: 80,
    grade: "B",
    qualityScore: 82,
    pegMultiplier: 0.98,
    pegAdjustedScore: 80,
    pillars: { backing: pillar, exit: pillar, control: pillar },
    weakestPillar: { pillar: "backing", score: 80 },
    caps: [],
    bindingCap: null,
    nrReasons: [],
    reasonCodes: [],
    evidence: { level: "adequate", freshness: "current", reasons: [] },
    accessPosture: {
      transfer: "restrictable",
      freezeExposure: "direct",
      primaryExit: "eligibility-gated",
      governance: "single-entity",
      unknownFields: [],
      signals: [],
      reasons: [],
    },
    dependencies: {
      serial: [{ upstreamAssetId: "asset-upstream", score: 70, blocked: false }],
      basket: [],
      cycleBlocked: false,
      reasonCodes: [],
    },
    stressStateDigest: null,
  };
}

function response(overrides: Partial<ReportCardsV9Response> = {}): ReportCardsV9Response {
  const cards = overrides.cards ?? [card()];
  const identity = overrides.safetyScoreIdentity ?? {
    model: "v9" as const,
    schemaVersion: 1 as const,
    methodologyVersion: "candidate-v9.0",
    policyId: "policy-v9",
    policyDigest: digest("a"),
    evaluationBuildDigest: digest("b"),
    baseInputGenerationId: `report-cards-input:v1:${digest("c")}`,
    publicationGenerationId: "publication-v9-1",
  };
  return {
    model: "v9",
    schemaVersion: 1,
    lifecycle: "shadow",
    safetyScoreIdentity: identity,
    methodology: {
      version: identity.methodologyVersion,
      policy: { id: identity.policyId, semanticDigest: identity.policyDigest },
    },
    asOfSec: 100,
    updatedAt: 110,
    completeness: { expectedCount: 1, ratedCount: 1, notRatedCount: 0, notRatedIds: [] },
    source: {
      candidateId: "candidate-v9.0",
      factSetDigest: digest("d"),
      resultDigest: digest("e"),
      sourceGenerations: { registry: "registry-1" },
    },
    cards,
    dependencyGraph: buildReportCardsV9DependencyGraph(cards),
    ...overrides,
  };
}

describe("V9 selector data adapter", () => {
  it("omits V8 dimensions and defers every recommendation threshold", () => {
    const source = response();
    const snapshot = buildV9SelectorSnapshot(source, source.safetyScoreIdentity, 120);
    expect(snapshot).toMatchObject({
      model: "v9",
      safetyScoreIdentity: source.safetyScoreIdentity,
      recommendation: { status: "deferred", reason: "v9-selector-thresholds-unreviewed" },
      rows: [{
        id: "asset-a",
        safetyScore: 80,
        safetyGrade: "B",
        pillars: expect.any(Object),
        accessPosture: expect.any(Object),
        dependencies: expect.any(Object),
      }],
    });
    expect(snapshot.rows[0]).not.toHaveProperty("dimensions");
    expect(snapshot.rows[0]).not.toHaveProperty("safetyResilienceScore");
    expect(snapshot).not.toHaveProperty("recommended");
  });

  it("binds every identity field into a replay-stable dataset hash", () => {
    const source = response();
    const baseline = buildV9SelectorSnapshot(source, source.safetyScoreIdentity, 120);
    const nextIdentity = {
      ...source.safetyScoreIdentity,
      publicationGenerationId: "publication-v9-2",
    };
    const changed = response({ safetyScoreIdentity: nextIdentity });
    const changedSnapshot = buildV9SelectorSnapshot(changed, changed.safetyScoreIdentity, 121);
    const replay = buildV9SelectorSnapshot(source, source.safetyScoreIdentity, 999);

    expect(changedSnapshot.datasetHash).not.toBe(baseline.datasetHash);
    expect(replay.datasetHash).toBe(baseline.datasetHash);
    expect(replay.createdAt).toBe(999);
    expect(replay.safetyScoreIdentity).toEqual(source.safetyScoreIdentity);
  });

  it("rejects identity mismatch and malformed source data", () => {
    const source = response();
    expect(() => buildV9SelectorSnapshot(
      source,
      { ...source.safetyScoreIdentity, policyDigest: digest("f") },
      120,
    )).toThrow(V9SelectorSnapshotUnavailableError);
    expect(() => buildV9SelectorSnapshot({ ...source, cards: [] }, source.safetyScoreIdentity, 120)).toThrow(
      V9SelectorSnapshotUnavailableError,
    );
  });
});
