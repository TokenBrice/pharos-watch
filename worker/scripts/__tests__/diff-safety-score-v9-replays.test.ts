import { describe, expect, it } from "vitest";
import {
  diffReplayArtifacts,
  extractCardGrades,
  VOLATILE_KEYS,
} from "../diff-safety-score-v9-replays";

// Minimal artifact shape. The card array lives at `pipeline.candidate.cards`
// (`SafetyScoreV9CandidatePipelineResult.candidate` is the
// `SafetyScoreV9CurrentResponse` built by `buildSafetyScoreV9Response`).
function artifact(cards: unknown[], volatile: Record<string, unknown> = {}) {
  return {
    schemaVersion: 1,
    kind: "safety-score-v9-candidate-replay",
    pipeline: { candidate: { cards, ...volatile } },
  };
}

describe("diffReplayArtifacts", () => {
  it("self-diff is empty even when volatile identity fields differ", () => {
    const a = artifact([{ id: "usdt-tether", grade: "B+", score: 72 }], {
      publishedAt: 1,
      safetyScoreIdentity: { x: 1 },
    });
    const b = artifact([{ id: "usdt-tether", grade: "B+", score: 72 }], {
      publishedAt: 2,
      safetyScoreIdentity: { x: 2 },
    });
    const diff = diffReplayArtifacts(a, b);
    expect(diff.equal).toBe(true);
    expect(diff.entries).toEqual([]);
  });

  it("reports a changed score with its asset id and path", () => {
    const a = artifact([{ id: "usdt-tether", grade: "B+", score: 72 }]);
    const b = artifact([{ id: "usdt-tether", grade: "B+", score: 71 }]);
    const diff = diffReplayArtifacts(a, b);
    expect(diff.equal).toBe(false);
    expect(diff.entries[0]).toMatchObject({
      assetId: "usdt-tether",
      path: "cards[usdt-tether].score",
      baseline: 72,
      candidate: 71,
    });
  });

  it("reports added and removed cards against their asset id", () => {
    const a = artifact([{ id: "usdt-tether", grade: "B+", score: 72 }]);
    const b = artifact([{ id: "frax", grade: "C", score: 55 }]);
    const diff = diffReplayArtifacts(a, b);
    const byAsset = new Map(diff.entries.map((entry) => [entry.assetId, entry]));
    expect(byAsset.get("usdt-tether")).toMatchObject({ candidate: undefined });
    expect(byAsset.get("frax")).toMatchObject({ baseline: undefined });
  });

  it("reports drift outside the card array with a null asset id", () => {
    const a = artifact([], { completeness: { expectedCount: 0 } });
    const b = artifact([], { completeness: { expectedCount: 1 } });
    const diff = diffReplayArtifacts(a, b);
    expect(diff.equal).toBe(false);
    expect(diff.entries).toEqual([
      {
        assetId: null,
        path: "$.pipeline.candidate.completeness.expectedCount",
        baseline: 0,
        candidate: 1,
      },
    ]);
  });

  it("extractCardGrades keys every card by id", () => {
    const grades = extractCardGrades(artifact([{ id: "frax", grade: "C", score: 55 }]));
    expect(grades.get("frax")).toEqual({ grade: "C", score: 55 });
  });

  it("extractCardGrades keeps a not-rated card with a null score", () => {
    const grades = extractCardGrades(artifact([{ id: "frax", grade: "NR", score: null }]));
    expect(grades.get("frax")).toEqual({ grade: "NR", score: null });
  });

  it("VOLATILE_KEYS covers the identity/timestamp family", () => {
    for (const key of [
      "publishedAt",
      "safetyScoreIdentity",
      "baseInputGenerationId",
      "publicationGenerationId",
      "evaluationBuildDigest",
      "capturedAt",
      "updatedAt",
      "payloadSha256",
      "contentSha256",
      "generationId",
      "releaseCandidateId",
    ]) {
      expect(VOLATILE_KEYS.has(key)).toBe(true);
    }
  });
});
