import { describe, expect, it } from "vitest";
import mechanismOverlays from "@shared/data/safety-score-v9/mechanism-review-overlays-v1.json";
import operationalResilienceOverlays from "@shared/data/safety-score-v9/operational-resilience-overlays-v1.json";
import transferOverlays from "@shared/data/safety-score-v9/transfer-review-overlays-v1.json";
import stablecoinsGenerated from "@shared/data/stablecoins/coins.generated.json";
import { SafetyScoreV9MechanismReviewOverlayFileSchema } from "../safety-score-v9-mechanism-overlays";
import { SafetyScoreV9OperationalResilienceOverlayFileSchema } from "../safety-score-v9-operational-resilience-overlays";
import { SafetyScoreV9ReviewedTransferFileSchema } from "../safety-score-v9-transfer-overlays";

// The one compiler fallback able to grade a fiat-cash/commodity-claim
// assuranceAndReconciliation or tbill lossRecoveryDesign component `known`
// rather than bounded-unknown is `assuranceFact()`
// (worker/src/lib/safety-score-v9/extension-mechanism.ts), driven solely by
// `proofOfReserves.latestReport`. `expandOverlayReview` gives any curated
// component entry priority over that fallback, so a curated `unavailable`
// row on that exact field silently demotes a known fact to bounded-unknown
// (ODR-C2). This mirrors the guard documented in
// docs/process/mechanism-overlay-evidence-standard.md.
const ASSURANCE_COMPONENT_BY_ARCHETYPE: Readonly<Record<string, string>> = {
  "fiat-cash": "assuranceAndReconciliation",
  "commodity-claim": "assuranceAndReconciliation",
  tbill: "lossRecoveryDesign",
};

const mechanismFixture = { schemaVersion: 1, note: "Fixture", overlays: [mechanismOverlays.overlays[0]] };
const transferFixture = { schemaVersion: 1, note: "Fixture", reviews: [transferOverlays.reviews[0]] };
const operationalFixture = { schemaVersion: 1, note: "Fixture", overlays: [operationalResilienceOverlays.overlays[0]] };

describe("shared Safety Score V9 overlay boundaries", () => {
  it("validates every checked-in overlay asset through the shared schemas", () => {
    expect(() => SafetyScoreV9MechanismReviewOverlayFileSchema.parse(mechanismOverlays)).not.toThrow();
    expect(() => SafetyScoreV9ReviewedTransferFileSchema.parse(transferOverlays)).not.toThrow();
    expect(() =>
      SafetyScoreV9OperationalResilienceOverlayFileSchema.parse(operationalResilienceOverlays),
    ).not.toThrow();
  });

  it("rejects a malformed mechanism row instead of allowing a frontend cast", () => {
    expect(SafetyScoreV9MechanismReviewOverlayFileSchema.safeParse(mechanismFixture).success).toBe(true);
    const malformed = { ...mechanismFixture, overlays: [{ ...mechanismFixture.overlays[0], unexpectedPublishedField: true }] };
    expect(SafetyScoreV9MechanismReviewOverlayFileSchema.safeParse(malformed).success).toBe(false);
    expect(SafetyScoreV9MechanismReviewOverlayFileSchema.safeParse({ ...malformed, overlays: [{ ...mechanismOverlays.overlays[0], reviewedAt: "2026-02-31" }] }).success).toBe(false);
  });

  it("rejects transfer rows without a canonical deployment", () => {
    expect(SafetyScoreV9ReviewedTransferFileSchema.safeParse(transferFixture).success).toBe(true);
    const malformed = structuredClone(transferFixture) as Record<string, unknown> & {
      reviews: Array<{ deployments: Array<{ scope: string }> }>;
    };
    malformed.reviews[0]!.deployments.forEach((deployment) => {
      deployment.scope = "additional";
    });
    expect(SafetyScoreV9ReviewedTransferFileSchema.safeParse(malformed).success).toBe(false);
  });

  it("rejects operational-resilience evidence references absent from sources", () => {
    expect(SafetyScoreV9OperationalResilienceOverlayFileSchema.safeParse(operationalFixture).success).toBe(true);
    const malformed = structuredClone(operationalFixture) as Record<string, unknown> & {
      overlays: Array<{ eligibility: { liveHistory: { sourceIds: string[] } } }>;
    };
    malformed.overlays[0]!.eligibility.liveHistory.sourceIds = ["missing-source"];
    expect(SafetyScoreV9OperationalResilienceOverlayFileSchema.safeParse(malformed).success).toBe(false);
  });

  it.each([
    [SafetyScoreV9MechanismReviewOverlayFileSchema, { ...mechanismFixture, overlays: [mechanismFixture.overlays[0], mechanismFixture.overlays[0]] }, "overlays"],
    [SafetyScoreV9OperationalResilienceOverlayFileSchema, { ...operationalFixture, overlays: [operationalFixture.overlays[0], operationalFixture.overlays[0]] }, "overlays"],
    [SafetyScoreV9ReviewedTransferFileSchema, { ...transferFixture, reviews: [transferFixture.reviews[0], transferFixture.reviews[0]] }, "reviews"],
  ])("rejects duplicate asset identities at the collection path", (schema, input, path) => {
    const result = schema.safeParse(input);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues).toContainEqual(expect.objectContaining({ code: "custom", path: [path] }));
    }
  });

  it("never curates an unavailable assurance component the compiler already grades known from proofOfReserves.latestReport", () => {
    const assetIdsWithLatestReport = new Set(
      (stablecoinsGenerated as Array<{ id: string; proofOfReserves?: { latestReport?: unknown } }>)
        .filter((coin) => coin.proofOfReserves?.latestReport !== undefined)
        .map((coin) => coin.id),
    );

    const overlays = (mechanismOverlays as { overlays: Array<Record<string, unknown>> }).overlays;
    const violations = overlays.flatMap((overlay) => {
      const archetype = overlay.archetype as string;
      const assuranceField = ASSURANCE_COMPONENT_BY_ARCHETYPE[archetype];
      if (!assuranceField) return [];
      const components = overlay.components as Record<string, { applicability?: string }> | undefined;
      const component = components?.[assuranceField];
      if (component?.applicability !== "unavailable") return [];
      if (!assetIdsWithLatestReport.has(overlay.assetId as string)) return [];
      return [`${overlay.assetId}.${assuranceField}`];
    });

    expect(violations).toEqual([]);
  });
});
