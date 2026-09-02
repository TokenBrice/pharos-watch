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
// (worker/src/lib/safety-score-v9-extension-mechanism.ts), driven solely by
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

// Pre-existing violations found when this guard was authored (ODR-C2-guard,
// 2026-09-01), grandfathered so the guard can ship without a forbidden edit
// to mechanism-review-overlays-v1.json rows. `brz-transfero`'s overlay
// (reviewedAt 2026-08-08) marked assuranceAndReconciliation unavailable
// before a proofOfReserves.latestReport (self-verification, reviewed
// 2026-08-29) was later added to its coin record; assuranceFact() now grades
// that report known(weak), so the curated row silently overrides a known
// fact. Fixing the row is mechanism-overlay curation work, not this guard's
// job — do not widen this list without the same scrutiny; shrink it only
// when the referenced row is actually re-curated.
const KNOWN_PRE_EXISTING_OVERRIDE_VIOLATIONS: readonly string[] = [];

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

  it.each([
    [SafetyScoreV9MechanismReviewOverlayFileSchema, { ...mechanismOverlays, overlays: [...mechanismOverlays.overlays, mechanismOverlays.overlays[0]!] }, "overlays", "Duplicate overlay assetId"],
    [SafetyScoreV9OperationalResilienceOverlayFileSchema, { ...operationalResilienceOverlays, overlays: [...operationalResilienceOverlays.overlays, operationalResilienceOverlays.overlays[0]!] }, "overlays", "Duplicate operational-resilience overlay assetId"],
    [SafetyScoreV9ReviewedTransferFileSchema, { ...transferOverlays, reviews: [...transferOverlays.reviews, transferOverlays.reviews[0]!] }, "reviews", "Duplicate reviewed transfer assetId"],
  ])("keeps duplicate asset issue paths and messages stable", (schema, input, path, message) => {
    const result = schema.safeParse(input);
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.issues).toEqual([{ code: "custom", path: [path], message }]);
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

    const knownBaseline = new Set(KNOWN_PRE_EXISTING_OVERRIDE_VIOLATIONS);
    const newViolations = violations.filter((violation) => !knownBaseline.has(violation));
    const fixedBaselineEntries = KNOWN_PRE_EXISTING_OVERRIDE_VIOLATIONS.filter(
      (entry) => !violations.includes(entry),
    );
    // Fails on any violation not already grandfathered above (blocks a new
    // curated `unavailable` row from overriding a compiler-known fact).
    expect(newViolations).toEqual([]);
    // Fails once a grandfathered row is re-curated, so the baseline entry
    // above must be deleted rather than left stale.
    expect(fixedBaselineEntries).toEqual([]);
  });
});
