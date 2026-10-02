import type { V9DeploymentControlFactV2 } from "../../types/safety-score-v9-facts";
import type { V9Severity } from "../../types/safety-score-v9";
import { resolveChainId } from "../chains";
import { isV9UncanonicalizedChainPoolRoute, V9_AMBIGUOUS_CHAIN_ROUTE_PREFIX } from "./facts";
import { uniqueSorted } from "./primitives";
import {
  controlCanRepresent,
  isKnownRequired,
  type V9BridgeRouteControlReview,
  type V9BridgeTier,
  type V9EconomicControlAssetFacts,
} from "./control-primitives";

// The complete measured split of supply across deployment routes: aggregate
// shares are produced and the rows sum back to each aggregate and to the
// whole. Only such a partition can bound the share of a deployment the
// producer did not join to its control; a partial or absent partition proves
// nothing about any deployment.
function reconciledSupplyPartition(
  facts: V9EconomicControlAssetFacts,
): V9EconomicControlAssetFacts["supply"]["selectedBridgeRoutes"] | null {
  if (!isKnownRequired(facts.supply.status)) return null;
  const { selectedRouteSupplyShare, unreviewedRouteSupplyShare, unknownRouteSupplyShare } = facts.supply;
  if (selectedRouteSupplyShare === null || unreviewedRouteSupplyShare === null || unknownRouteSupplyShare === null) {
    return null;
  }
  const rows = facts.supply.selectedBridgeRoutes;
  const reviewedShare = rows.reduce(
    (sum, route) => sum + (route.reviewState === "selected-reviewed" ? route.supplyShare : 0),
    0,
  );
  const unresolvedShare = rows.reduce(
    (sum, route) => sum + (route.reviewState === "selected-unresolved" ? route.supplyShare : 0),
    0,
  );
  const unmatchedShare = rows.reduce(
    (sum, route) => sum + (route.reviewState === "unmatched" ? route.supplyShare : 0),
    0,
  );
  if (
    !bridgeSharesReconcile(reviewedShare, selectedRouteSupplyShare) ||
    !bridgeSharesReconcile(unresolvedShare, unreviewedRouteSupplyShare) ||
    !bridgeSharesReconcile(unmatchedShare, unknownRouteSupplyShare) ||
    !bridgeSharesReconcile(reviewedShare + unresolvedShare + unmatchedShare, 1)
  ) {
    return null;
  }
  return rows;
}

// Upper bound for a null-share deployment control's supply share, proven by a
// reconciled partition: the sum of that deployment's measured rows plus its
// chain's unsplit ambiguous row (which bounds every candidate deployment on
// that chain), or zero when a complete partition holds no such row.
export function provenNullShareDeploymentBound(
  facts: V9EconomicControlAssetFacts,
  control: V9DeploymentControlFactV2,
): number | null {
  if (control.economicLossScope !== "deployment" || control.materialSupplyShare !== null) return null;
  const rows = reconciledSupplyPartition(facts);
  if (rows === null) return null;
  const separator = control.deploymentKey.indexOf(":");
  const chain = separator > 0 ? resolveChainId(control.deploymentKey.slice(0, separator)) : null;
  const ambiguousChainKey = chain === null ? null : `${V9_AMBIGUOUS_CHAIN_ROUTE_PREFIX}${facts.assetId}:${chain}`;
  return rows.reduce(
    (sum, route) =>
      sum +
      (route.deploymentRouteKey === control.deploymentKey || route.deploymentRouteKey === ambiguousChainKey
        ? route.supplyShare
        : 0),
    0,
  );
}

function bridgeSharesReconcile(left: number, right: number): boolean {
  return Math.abs(left - right) <= 0.000001;
}

// External-lock-mint bridge routes are share-banded to match the common-mode
// critical-dependency twin (proportionalCommonModeSeverity in evaluate-set.ts),
// which already grades an asset's *shared* bridge exposure by supply share. A
// route that mints against an external lock and holds a just-material fraction
// (deployment-material floor up to this threshold) of supply risks only that
// recoverable fraction if compromised, so it takes the moderate rung; a dominant
// (>= threshold) or unattributed (null) share stays high. Opaque topology stays
// critical. This threshold is above the deployment-material binding floor so a
// binding material-bridge lands in the moderate band until exposure is dominant.
export function materialBridgeSeverity(
  tier: V9BridgeTier,
  materialSupplyShare: number | null,
  highShareThreshold: number,
): V9Severity {
  if (tier === "opaque-or-unknown") return "critical";
  if (materialSupplyShare === null) return "high";
  return materialSupplyShare >= highShareThreshold ? "high" : "moderate";
}

/** Unresolved deployment exposure, including unattributed route residue. Bounds are join-only, never exact pricing. */
export function unresolvedDeploymentCohort(
  facts: V9EconomicControlAssetFacts,
  controls: readonly V9DeploymentControlFactV2[],
  allowProvenBounds = false,
): { share: number | null; controlKeys: ReadonlySet<string> } {
  const controlKeys = new Set<string>();
  const rows = reconciledSupplyPartition(facts);
  if (rows === null) return { share: null, controlKeys };
  const sharesByDeployment = new Map<string, number>();
  const exclusions = new Map((facts.supply.providerRowExclusions ?? []).filter(exclusion =>
    exclusion.review.assetId === facts.assetId && rows.some(row =>
      row.deploymentRouteKey === exclusion.deploymentRouteKey && row.reviewState === "unmatched" &&
      bridgeSharesReconcile(row.supplyShare, exclusion.supplyShare)))
    .map(exclusion => [exclusion.deploymentRouteKey, exclusion.supplyShare]));
  let joinedUnreviewedShare = 0;
  for (const control of controls) {
    if (
      control.scope !== "deployment" ||
      control.economicLossScope !== "deployment" ||
      control.status.applicability.state === "not-applicable" ||
      isKnownRequired(control.status)
    ) continue;
    const row = rows.find((candidate) => candidate.deploymentRouteKey === control.deploymentKey);
    const share = control.materialSupplyShare ??
      (allowProvenBounds ? provenNullShareDeploymentBound(facts, control) : null);
    if (
      control.status.applicability.state !== "required" ||
      control.status.observationState !== "bounded-unknown" ||
      share === null ||
      (row === undefined && (!allowProvenBounds || share !== 0)) ||
      (row !== undefined && !bridgeSharesReconcile(row.supplyShare, share))
    ) return { share: null, controlKeys: new Set<string>() };
    controlKeys.add(control.controlKey);
    // Unmatched rows already belong to unknownRouteSupplyShare. Admitting
    // their controls must neither invalidate the cohort nor count them twice.
    if (row === undefined || row.reviewState === "unmatched") continue;
    if (!sharesByDeployment.has(control.deploymentKey) && row.reviewState === "selected-unresolved") {
      joinedUnreviewedShare += row.supplyShare;
    }
    sharesByDeployment.set(control.deploymentKey, row.supplyShare);
  }
  return {
    share: Math.min(1, [...sharesByDeployment.values()].reduce((sum, share) => sum + share, 0) +
      Math.max(0, facts.supply.unknownRouteSupplyShare! - [...exclusions.values()].reduce((sum, share) => sum + share, 0)) +
      Math.max(0, facts.supply.unreviewedRouteSupplyShare! - joinedUnreviewedShare)),
    controlKeys,
  };
}

/**
 * Why the sub-threshold unresolved bridge-join completeness proof failed.
 *
 * ODR-D5a: the proof used to return a bare boolean, so a residue carrier
 * publishing `nonmaterial-bridge-supply-unmatched` said nothing about *which*
 * supply row could not be joined to a proven bridge control. Diagnosing the
 * residue then meant re-deriving the whole join by hand. The typed cause names
 * the failing `deploymentRouteKey` (or the offending control key, for the two
 * inventory-level failures that precede any row) so downstream diagnostics can
 * carry it. It is diagnostic only: no branch here changes the verdict.
 */
export type V9BridgeJoinFailureCode =
  /** The reviewed supply partition does not reconcile, so no row can be proven. */
  | "supply-partition-unreconciled"
  /** One reviewed bridge route row is claimed by more than one control review. */
  | "duplicate-bridge-route-control"
  /** A reviewed native row carries a bridge control it should not. */
  | "reviewed-native-row-carries-control"
  /** A reviewed row's route kind is absent (retained V2) or unrecognized. */
  | "reviewed-row-kind-unresolved"
  /** A reviewed controlled row joins zero or several bridge controls. */
  | "reviewed-row-control-join-not-unique"
  /** A reviewed controlled row's single control cannot carry the join. */
  | "reviewed-row-control-unproven"
  /** An unresolved or material unmatched row joins zero or several controls. */
  | "unresolved-row-control-join-not-unique"
  /** An unresolved or material unmatched row's control cannot bound it. */
  | "unresolved-row-control-unproven";

export interface V9BridgeJoinFailureCause {
  readonly code: V9BridgeJoinFailureCode;
  readonly deploymentRouteKey: string | null;
  readonly reviewState: V9EconomicControlAssetFacts["supply"]["selectedBridgeRoutes"][number]["reviewState"] | null;
  readonly reviewedRouteKind: "native" | "controlled" | null;
  readonly supplyShare: number | null;
  readonly controlKeys: readonly string[];
}

export type V9SubthresholdUnresolvedBridgeJoinResult =
  | { readonly complete: true; readonly cause: null }
  | { readonly complete: false; readonly cause: V9BridgeJoinFailureCause };

const COMPLETE_SUBTHRESHOLD_UNRESOLVED_BRIDGE_JOINS: V9SubthresholdUnresolvedBridgeJoinResult = {
  complete: true,
  cause: null,
};

export function evaluateV9SubthresholdUnresolvedBridgeJoins(
  facts: V9EconomicControlAssetFacts,
  controls: readonly V9DeploymentControlFactV2[],
  bridgeRoutes: readonly V9BridgeRouteControlReview[],
  materialShareThreshold: number,
  commonModeShareThreshold: number,
  unresolvedFullCeilingShareThreshold: number,
): V9SubthresholdUnresolvedBridgeJoinResult {
  const incomplete = (
    code: V9BridgeJoinFailureCode,
    detail: Partial<Omit<V9BridgeJoinFailureCause, "code">> = {},
  ): V9SubthresholdUnresolvedBridgeJoinResult => ({
    complete: false,
    cause: {
      code,
      deploymentRouteKey: detail.deploymentRouteKey ?? null,
      reviewState: detail.reviewState ?? null,
      reviewedRouteKind: detail.reviewedRouteKind ?? null,
      supplyShare: detail.supplyShare ?? null,
      controlKeys: detail.controlKeys ?? [],
    },
  });

  const rows = reconciledSupplyPartition(facts);
  if (rows === null) return incomplete("supply-partition-unreconciled");
  const cohortShare = unresolvedDeploymentCohort(facts, controls, true).share;
  const canRelaxUnresolvedRows = cohortShare !== null && cohortShare < unresolvedFullCeilingShareThreshold;

  // Native issuance rows are not bridge exposure. A profile may still carry
  // canonical-side adapter controls for one, but those controls belong to the
  // umbrella control inventory rather than this bridge-join proof.
  const reviewedNativeDeploymentKeys = new Set(
    rows
      .filter((route) => route.reviewState === "selected-reviewed" && route.reviewedRouteKind === "native")
      .map((route) => route.deploymentRouteKey),
  );
  const bridgeControlsByDeployment = new Map<string, V9DeploymentControlFactV2[]>();
  for (const control of controls) {
    if (control.controlKind !== "bridge" || reviewedNativeDeploymentKeys.has(control.deploymentKey)) continue;
    bridgeControlsByDeployment.set(control.deploymentKey, [
      ...(bridgeControlsByDeployment.get(control.deploymentKey) ?? []),
      control,
    ]);
  }
  const bridgeRouteCounts = new Map<string, number>();
  for (const route of bridgeRoutes) {
    bridgeRouteCounts.set(route.controlKey, (bridgeRouteCounts.get(route.controlKey) ?? 0) + 1);
  }
  const duplicateControlKeys = uniqueSorted(
    [...bridgeRouteCounts.entries()].filter(([, count]) => count !== 1).map(([controlKey]) => controlKey),
  );
  if (duplicateControlKeys.length > 0) {
    return incomplete("duplicate-bridge-route-control", { controlKeys: duplicateControlKeys });
  }
  for (const route of rows) {
    const rowDetail = {
      deploymentRouteKey: route.deploymentRouteKey,
      reviewState: route.reviewState,
      reviewedRouteKind: route.reviewedRouteKind ?? null,
      supplyShare: route.supplyShare,
    };
    // RULED D-J (2026-07-19): an unrecognized-chain-label pool below the
    // common-mode materiality floor is an accepted bounded row, not a proof
    // failure. At or above the floor the pool keeps the ordinary fail-closed
    // per-row checks below (the material unrecognized-chain latency case).
    if (canRelaxUnresolvedRows && isV9UncanonicalizedChainPoolRoute(route.deploymentRouteKey) && route.supplyShare < commonModeShareThreshold) {
      continue;
    }
    if (
      canRelaxUnresolvedRows &&
      route.reviewState === "unmatched" &&
      !isV9UncanonicalizedChainPoolRoute(route.deploymentRouteKey) &&
      route.supplyShare < materialShareThreshold
    ) {
      continue;
    }
    const joined = bridgeControlsByDeployment.get(route.deploymentRouteKey) ?? [];
    const joinedControlKeys = uniqueSorted(joined.map((control) => control.controlKey));
    if (route.reviewState === "selected-reviewed") {
      if (route.reviewedRouteKind === "native") {
        if (joined.length === 0) continue;
        return incomplete("reviewed-native-row-carries-control", {
          ...rowDetail,
          controlKeys: joinedControlKeys,
        });
      }
      if (route.reviewedRouteKind !== "controlled") {
        return incomplete("reviewed-row-kind-unresolved", { ...rowDetail, controlKeys: joinedControlKeys });
      }
      if (joined.length !== 1) {
        return incomplete("reviewed-row-control-join-not-unique", { ...rowDetail, controlKeys: joinedControlKeys });
      }
      const control = joined[0]!;
      const share = control.materialSupplyShare ?? provenNullShareDeploymentBound(facts, control);
      if (
        controlCanRepresent(control, "bridge") &&
        (isKnownRequired(control.status) ||
          (canRelaxUnresolvedRows &&
            control.status.applicability.state === "required" &&
            control.status.observationState === "bounded-unknown" &&
            control.scope === "deployment" &&
            control.economicLossScope === "deployment" &&
            share !== null &&
            share < (control.materialSupplyShare === null ? materialShareThreshold : unresolvedFullCeilingShareThreshold))) &&
        share !== null &&
        bridgeSharesReconcile(share, route.supplyShare) &&
        bridgeRouteCounts.get(control.controlKey) === 1
      ) {
        continue;
      }
      return incomplete("reviewed-row-control-unproven", { ...rowDetail, controlKeys: joinedControlKeys });
    }
    if (joined.length !== 1) {
      return incomplete("unresolved-row-control-join-not-unique", { ...rowDetail, controlKeys: joinedControlKeys });
    }
    const control = joined[0]!;
    const share = control.materialSupplyShare ?? provenNullShareDeploymentBound(facts, control);
    if (
      canRelaxUnresolvedRows &&
      control.scope === "deployment" &&
      control.economicLossScope === "deployment" &&
      share !== null &&
      bridgeSharesReconcile(share, route.supplyShare) &&
      share < (route.reviewState === "unmatched" || control.materialSupplyShare === null
        ? materialShareThreshold
        : unresolvedFullCeilingShareThreshold)
    ) {
      continue;
    }
    return incomplete("unresolved-row-control-unproven", { ...rowDetail, controlKeys: joinedControlKeys });
  }
  return COMPLETE_SUBTHRESHOLD_UNRESOLVED_BRIDGE_JOINS;
}

export function controlFallbackKind(control: V9DeploymentControlFactV2): "mint" | "oracle" | "bridge" | null {
  if (controlCanRepresent(control, "bridge")) return "bridge";
  if (controlCanRepresent(control, "oracle")) return "oracle";
  if (controlCanRepresent(control, "mint") || controlCanRepresent(control, "upgrade")) return "mint";
  return null;
}
