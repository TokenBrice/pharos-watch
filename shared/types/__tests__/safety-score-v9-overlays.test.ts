import { describe, expect, it } from "vitest";
import mechanismOverlays from "@shared/data/safety-score-v9/mechanism-review-overlays-v1.json";
import operationalResilienceOverlays from "@shared/data/safety-score-v9/operational-resilience-overlays-v1.json";
import transferOverlays from "@shared/data/safety-score-v9/transfer-review-overlays-v1.json";
import { SafetyScoreV9MechanismReviewOverlayFileSchema } from "../safety-score-v9-mechanism-overlays";
import { SafetyScoreV9OperationalResilienceOverlayFileSchema } from "../safety-score-v9-operational-resilience-overlays";
import { SafetyScoreV9ReviewedTransferFileSchema } from "../safety-score-v9-transfer-overlays";

describe("shared Safety Score V9 overlay boundaries", () => {
  it("validates every checked-in overlay asset through the shared schemas", () => {
    expect(() => SafetyScoreV9MechanismReviewOverlayFileSchema.parse(mechanismOverlays)).not.toThrow();
    expect(() => SafetyScoreV9ReviewedTransferFileSchema.parse(transferOverlays)).not.toThrow();
    expect(() =>
      SafetyScoreV9OperationalResilienceOverlayFileSchema.parse(operationalResilienceOverlays),
    ).not.toThrow();
  });

  it("rejects a malformed mechanism row instead of allowing a frontend cast", () => {
    const malformed = structuredClone(mechanismOverlays) as Record<string, unknown> & {
      overlays: Array<Record<string, unknown>>;
    };
    malformed.overlays[0] = { ...malformed.overlays[0], unexpectedPublishedField: true };
    expect(SafetyScoreV9MechanismReviewOverlayFileSchema.safeParse(malformed).success).toBe(false);
  });

  it("rejects transfer rows without a canonical deployment", () => {
    const malformed = structuredClone(transferOverlays) as Record<string, unknown> & {
      reviews: Array<{ deployments: Array<{ scope: string }> }>;
    };
    malformed.reviews[0]!.deployments.forEach((deployment) => {
      deployment.scope = "additional";
    });
    expect(SafetyScoreV9ReviewedTransferFileSchema.safeParse(malformed).success).toBe(false);
  });

  it("rejects operational-resilience evidence references absent from sources", () => {
    const malformed = structuredClone(operationalResilienceOverlays) as Record<string, unknown> & {
      overlays: Array<{ eligibility: { liveHistory: { sourceIds: string[] } } }>;
    };
    malformed.overlays[0]!.eligibility.liveHistory.sourceIds = ["missing-source"];
    expect(SafetyScoreV9OperationalResilienceOverlayFileSchema.safeParse(malformed).success).toBe(false);
  });
});
