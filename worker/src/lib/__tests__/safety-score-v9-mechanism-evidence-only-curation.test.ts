import { describe, expect, it } from "vitest";
import mechanismReviewOverlaysAsset from "@shared/data/safety-score-v9/mechanism-review-overlays-v1.json";
import {
  expandOverlayReview,
  MechanismReviewOverlaySchema,
} from "../safety-score-v9-extension-mechanism";

const EVIDENCE_ONLY_TARGETS = {
  "usdgo-osl": ["custodyContinuity"],
  // Reclassified 2026-08-08 from the inherited fiat-cash archetype to
  // rwa-credit-fund; custody is the reviewed nondisclosure component.
  "syrupusdc-maple": ["custody"],
  "susdt-spark": ["assuranceAndReconciliation", "custodyContinuity"],
  "moveusd-cfx": ["assuranceAndReconciliation", "claimAndSegregation", "custodyContinuity"],
  "uusd-anything-labs": ["assuranceAndReconciliation", "claimAndSegregation", "custodyContinuity"],
  "usda-alpha-partner": ["assuranceAndReconciliation", "claimAndSegregation", "custodyContinuity"],
  "pgold-pleasing": ["assuranceAndReconciliation", "custodyContinuity"],
  "usdon-ondo": [],
  "xaum-matrixdock": [],
  "chfau-allunity": ["assuranceAndReconciliation", "custodyContinuity"],
  "jupusd-jupiter": ["claimAndSegregation"],
  "brz-transfero": ["assuranceAndReconciliation", "claimAndSegregation", "custodyContinuity"],
  "pathusd-bridge": ["assuranceAndReconciliation"],
  "eusd-electronic-usd": [],
  "aid-gaib": ["claimAndSegregation", "custodyContinuity"],
  "usdm-moneta": ["custodyContinuity"],
  "usdb-blast": ["assuranceAndReconciliation", "custodyContinuity"],
  "eusd-telcoin": ["assuranceAndReconciliation", "custodyContinuity"],
  "eurq-quantoz": ["assuranceAndReconciliation", "custodyContinuity"],
  "idrt-rupiah-token": ["custodyContinuity"],
  "sbc-brale": ["custodyContinuity"],
  "usdq-quantoz": ["assuranceAndReconciliation", "custodyContinuity"],
  "ctusd-citrea": ["assuranceAndReconciliation", "custodyContinuity"],
  "tryb-bilira": ["custodyContinuity"],
  "vnxau-vnx": ["custodyContinuity"],
  "axcnh-anchorx": ["custodyContinuity"],
  "kgst-kyrgyz-som": ["assuranceAndReconciliation", "custodyContinuity"],
  "jtrsy-anemoy": ["lossRecoveryDesign"],
  "gusd-gate": ["durationAndLiquidity", "fundClaimAndSeniority", "lossRecoveryDesign", "navValuation"],
  "frax-frax": ["durationAndLiquidity", "lossRecoveryDesign", "navValuation"],
  "thbill-theo": ["durationAndLiquidity", "lossRecoveryDesign", "navValuation"],
  "usdk-kast": ["durationAndLiquidity", "lossRecoveryDesign", "navValuation"],
  "usdm-mega": ["lossRecoveryDesign", "navValuation"],
  "cdxusd-cod3x": ["backstop", "shutdownAndBadDebt", "structuralRedemption"],
  "btcusd-btcfi": ["backstop", "shutdownAndBadDebt"],
  "fusd-freedom-dollar": ["emergencyRecovery", "lossRecovery"],
} as const;

// The v9.14 commodity-claim migration re-stamped these three overlays on
// 2026-08-09. Their reviewed nondisclosures are unchanged — `custodyContinuity`
// and `assuranceAndReconciliation` keep their keys across the archetype move —
// so only the review date differs.
const V9_14_MIGRATED = new Set(["pgold-pleasing", "vnxau-vnx", "xaum-matrixdock"]);

describe("Safety Score V9 evidence-only mechanism curation", () => {
  it("keeps every reviewed nondisclosure target bounded and non-scoring", () => {
    expect(Object.keys(EVIDENCE_ONLY_TARGETS)).toHaveLength(36);
    expect(Object.values(EVIDENCE_ONLY_TARGETS).flat()).toHaveLength(65);

    const overlayById = new Map(
      mechanismReviewOverlaysAsset.overlays.map((overlay) => [overlay.assetId, overlay]),
    );
    for (const [assetId, componentKeys] of Object.entries(EVIDENCE_ONLY_TARGETS)) {
      const overlay = MechanismReviewOverlaySchema.parse(overlayById.get(assetId));
      expect(overlay.reviewedAt, assetId).toBe(V9_14_MIGRATED.has(assetId) ? "2026-08-09" : "2026-08-08");
      const expanded = expandOverlayReview(overlay) as unknown as Record<
        string,
        { quality: string | null; status: { observationState: string; gapIds: string[] } }
      >;

      for (const componentKey of componentKeys) {
        expect(overlay.components[componentKey], `${assetId}:${componentKey}`).toMatchObject({
          applicability: "unavailable",
        });
        expect(expanded[componentKey], `${assetId}:${componentKey}`).toMatchObject({
          quality: null,
          status: {
            observationState: "bounded-unknown",
          },
        });
        expect(expanded[componentKey].status.gapIds, `${assetId}:${componentKey}`).not.toHaveLength(0);
      }
    }
  });
});
