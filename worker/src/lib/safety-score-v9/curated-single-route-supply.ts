/**
 * Curated native single-route supply attribution table.
 *
 * Some assets are native gas tokens whose entire liability lives on exactly
 * one chain behind exactly one reviewed bridge route, while no probeable
 * contract equals the native supply (a wrapper such as WXDAI is a strict
 * subset of it). Upstream ingestion therefore publishes only an aggregate and
 * leaves the per-chain partition empty, which nulls the V9 supply review and
 * caps the asset on runtime-bridge-materiality-unavailable even though the
 * curated bridge review already asserts the single-route reality.
 *
 * An entry here asserts no new supply number. At V9 supply-review build time
 * the already-admitted published aggregate is distributed onto the asset's ONE
 * reviewed route (share 1). Because the attribution only consumes the existing
 * aggregate, and only while no per-chain observation exists, it cannot restate
 * supply or double count. All gates are enforced fail-closed in
 * `buildSafetyScoreV9SupplyReview` (worker/src/lib/safety-score-v9/extension-supply.ts):
 *   1. a reviewer-signed, dated entry exists in this table for the asset;
 *   2. the asset's curated `bridgeRouteRisk.routes` has EXACTLY one route, its
 *      id equals the entry's `routeId`, and it is `reviewDisposition: "reviewed"`;
 *   3. the asset resolves no per-chain supply rows — a real upstream partition
 *      always wins over this curated attribution;
 *   4. the published aggregate supply is a finite positive USD number.
 * When any gate fails, behavior is exactly the pre-existing null-share posture.
 */
import supplyAttributionReviews from "@shared/data/safety-score-v9/supply-attribution-reviews-v1.json";
import { ReviewedEconomicSupplyPlanFileSchema, type CuratedNativeSingleRouteSupplyAttribution } from "@shared/types/safety-score-v9-supply-attribution";

export const CURATED_NATIVE_SINGLE_ROUTE_SUPPLY_ATTRIBUTION: Readonly<Record<string, CuratedNativeSingleRouteSupplyAttribution>> = Object.freeze(
  Object.fromEntries(ReviewedEconomicSupplyPlanFileSchema.parse(supplyAttributionReviews).nativeSingleRouteReviews.map(review => [
    review.assetId, Object.freeze(review),
  ])),
);
