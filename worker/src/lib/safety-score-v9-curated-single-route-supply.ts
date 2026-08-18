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
 * `buildSafetyScoreV9SupplyReview` (worker/src/lib/safety-score-v9-extension-supply.ts):
 *   1. a reviewer-signed, dated entry exists in this table for the asset;
 *   2. the asset's curated `bridgeRouteRisk.routes` has EXACTLY one route, its
 *      id equals the entry's `routeId`, and it is `reviewDisposition: "reviewed"`;
 *   3. the asset resolves no per-chain supply rows — a real upstream partition
 *      always wins over this curated attribution;
 *   4. the published aggregate supply is a finite positive USD number.
 * When any gate fails, behavior is exactly the pre-existing null-share posture.
 */
export interface CuratedNativeSingleRouteSupplyAttribution {
  readonly assetId: string;
  readonly routeId: string;
  readonly reviewer: string;
  readonly reviewedAt: string;
  readonly rationale: string;
}

export const CURATED_NATIVE_SINGLE_ROUTE_SUPPLY_ATTRIBUTION: Readonly<
  Record<string, CuratedNativeSingleRouteSupplyAttribution>
> = Object.freeze({
  "xdai-gnosis": Object.freeze({
    assetId: "xdai-gnosis",
    routeId: "gnosis:0xe91d153e0b41518a2ce8dd3d7944fa863463a97d",
    reviewer: "TokenBrice",
    reviewedAt: "2026-08-18",
    rationale:
      "xDAI is Gnosis Chain's native gas token: 100% of the published aggregate supply is native xDAI on Gnosis, minted and burned solely through the canonical xDAI bridge that the single reviewed route represents. The route's WXDAI deployment row (gnosis:0xe91d153e0b41518a2ce8dd3d7944fa863463a97d) is a same-chain wrapper and strict subset of the native supply, so no per-chain contract observation can equal the aggregate upstream. Attributing the published aggregate to this one reviewed route restates the reviewed bridge profile without asserting any new supply number.",
  }),
});
