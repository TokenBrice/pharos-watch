import type {
  V9AssetFactsBase,
  V9DeploymentControlFactV2,
  V9EconomicControlReviewV2,
  V9FactStatusV2,
  V9FailureDomainRef,
} from "../../types/safety-score-v9-facts";
import type { BridgeRouteRiskTier, OracleRiskTier } from "../../types/core";
import type {
  V9ReasonCode,
  V9Severity,
  V9StructuralSignalKind,
  V9ValidatedPolicyEnvelope,
} from "../../types/safety-score-v9";

export type V9MintReconciliation = V9EconomicControlReviewV2["mint"]["reconciliation"];
export type V9MintSupervision = V9EconomicControlReviewV2["mint"]["supervision"];
export type V9MintPosture =
  | "none-resolved"
  | "bounded-admin"
  | "partially-bounded-admin"
  | "concentrated-admin"
  | "collateral-gated"
  | "unbounded-reconciled"
  | "unbounded-reconciliation-unknown"
  | "unbounded-or-compromised"
  | "unknown";
export type V9OracleTier = OracleRiskTier;
export type V9BridgeTier = BridgeRouteRiskTier;

export type V9OracleBranchKind = V9EconomicControlReviewV2["oracle"]["branches"][number]["branch"];


export type V9MintMechanismReview = Omit<
  V9EconomicControlReviewV2["mint"],
  "latestResolvedIncidentAtSec"
> & {
  /**
   * Epoch second of the most recent resolved mint incident, or null when the
   * review records none. Absolute rather than an age so the fact is stable
   * between compilation cycles; the evaluator converts it against its own
   * clock (see {@link EvaluateV9EconomicControlArgs.resolvedIncidentAgeMonths}).
   */
  latestResolvedIncidentAtSec?: number | null;
};

export type V9OracleBranchReview = V9EconomicControlReviewV2["oracle"]["branches"][number];

export type V9OracleControlReview = Omit<V9EconomicControlReviewV2["oracle"], "branches"> & {
  branches: readonly V9OracleBranchReview[];
};

export type V9BridgeRouteControlReview = V9EconomicControlReviewV2["bridge"]["routes"][number];

export type V9BridgeControlReview = Omit<V9EconomicControlReviewV2["bridge"], "routes"> & {
  routes: readonly V9BridgeRouteControlReview[];
};

export interface V9EconomicControlAssetFacts {
  assetId: V9AssetFactsBase["assetId"];
  archetype: V9AssetFactsBase["archetype"];
  controlStatus: V9AssetFactsBase["controlStatus"];
  controls: readonly V9DeploymentControlFactV2[];
  supply: Pick<
    V9AssetFactsBase["supply"],
    | "status"
    | "selectedBridgeRoutes"
    | "selectedRouteSupplyShare"
    | "unknownRouteSupplyShare"
    | "unreviewedRouteSupplyShare"
  >;
}

export interface EvaluateV9EconomicControlArgs {
  policy: V9ValidatedPolicyEnvelope;
  facts: V9EconomicControlAssetFacts;
  mint: V9MintMechanismReview;
  oracle: V9OracleControlReview;
  bridge: V9BridgeControlReview;
  /** See {@link V9EconomicControlReviewExtension.trackRecordMonths}. */
  trackRecordMonths?: number;
  /** See {@link V9EconomicControlReviewExtension.resolvedIncidentAgeMonths}. */
  resolvedIncidentAgeMonths?: number;
}

export type V9EconomicControlAssetSource = V9EconomicControlAssetFacts;

/** Facts still awaiting a first-class home in the shared asset-fact base. */
export interface V9EconomicControlReviewExtension {
  assetId: V9AssetFactsBase["assetId"];
  mint: V9MintMechanismReview;
  oracle: V9OracleControlReview;
  bridge: V9BridgeControlReview;
  /**
   * Conservative measured track record (months since launch, floor). Absent →
   * no seasoning credit (unit callers, unknown launch dates fail conservative).
   */
  trackRecordMonths?: number;
  /**
   * Conservative measured age (months, floor) of the mint review's most recent
   * resolved incident. Absent → the decay ladder holds its strictest rung when
   * a resolved incident is nonetheless recorded on the control row.
   */
  resolvedIncidentAgeMonths?: number;
}

export interface V9ControlComponent {
  componentKey: string;
  kind: "mint" | "oracle" | "bridge";
  posture: V9MintPosture | V9OracleTier | V9BridgeTier;
  score: number;
  binding: boolean;
  controlKeys: readonly string[];
  failureDomains: readonly V9FailureDomainRef[];
}

export interface V9CompactControlReason {
  code: V9ReasonCode;
  label: string;
  critical: boolean;
  pathKind: "local-component" | "deployment-control";
  path: string;
  controlKey: string | null;
}

export interface V9ControlStructuralFailure {
  kind: Extract<
    V9StructuralSignalKind,
    | "centralized-mint"
    | "unreviewed-upgrade"
    | "material-bridge"
    | "peripheral-bridge"
    | "weak-oracle-branch"
    | "active-control-incident"
  >;
  severity: V9Severity;
  binding: boolean;
  reason: string;
  materialSharePct: number | null;
  controlKeys: readonly string[];
  failureDomains: readonly V9FailureDomainRef[];
}

export interface V9EconomicControlResult {
  score: number | null;
  state: "rated" | "not-rated";
  oracleApplicability: V9FactStatusV2["applicability"]["state"];
  components: readonly V9ControlComponent[];
  reasons: readonly V9CompactControlReason[];
  structuralFailures: readonly V9ControlStructuralFailure[];
  failureDomains: readonly V9FailureDomainRef[];
}
export function isKnownRequired(status: V9FactStatusV2): boolean {
  return status.applicability.state === "required" && status.observationState === "known";
}

export function isControlEconomicallyRelevant(control: V9DeploymentControlFactV2): boolean {
  if (control.claimImpairment === "none" && control.economicLossScope === "access-only") return false;
  if (control.controlKind !== "governance") return true;
  return control.capabilities.some((capability) =>
    ["mint", "upgrade", "oracle-update", "bridge-mint", "custody-transfer", "parameter-change"].includes(capability),
  );
}

export function hasFreshScopedQuestion(control: V9DeploymentControlFactV2): boolean {
  return control.scopedQuestionFresh === true && control.status.observationState !== "missing";
}

export function mappedControlStatusReason(control: V9DeploymentControlFactV2): V9ReasonCode {
  if (hasFreshScopedQuestion(control)) return "scoped-control-question";
  if (control.controlKind === "mint") {
    return control.status.observationState === "missing" ? "missing-mint-authority" : "unresolved-mint-authority";
  }
  if (control.controlKind === "upgrade") {
    return control.status.observationState === "missing"
      ? "missing-upgradeability-review"
      : "unknown-upgrade-authority";
  }
  if (control.controlKind === "oracle") {
    if (control.status.observationState === "missing") return "missing-oracle-profile";
    if (control.status.observationState === "stale") return "unreviewed-oracle-profile";
    return "incomplete-oracle-liquidation-branch";
  }
  if (control.controlKind === "bridge") {
    return control.status.observationState === "missing" ? "missing-bridge-routes" : "selected-bridge-route-unresolved";
  }
  return "unresolved-control-identity";
}

export function controlCanRepresent(control: V9DeploymentControlFactV2, kind: "mint" | "upgrade" | "oracle" | "bridge") {
  if (control.controlKind === kind) return true;
  const capability = {
    mint: "mint",
    upgrade: "upgrade",
    oracle: "oracle-update",
    bridge: "bridge-mint",
  } as const;
  return control.capabilities.includes(capability[kind]);
}

export function bindingByMateriality(
  control: V9DeploymentControlFactV2,
  materialShareThreshold: number,
  provenNullShareBound: number | null = null,
): boolean {
  if (control.economicLossScope === "global-claim" || control.economicLossScope === "reserve-claim") return true;
  if (control.economicLossScope === "access-only") return false;
  // A missing deployment share is not evidence of immateriality. Keep it
  // fail-closed unless the producer supplied an exact share or a reconciled
  // supply partition proves an upper bound for the control's deployment.
  const share = control.materialSupplyShare ?? provenNullShareBound;
  return share === null || share >= materialShareThreshold;
}
export type V9ControlPolicy = V9ValidatedPolicyEnvelope["policy"]["semantic"]["control"];
