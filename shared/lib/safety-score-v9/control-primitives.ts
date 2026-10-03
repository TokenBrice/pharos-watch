import type {
  V9AssetFactsBase,
  V9DeploymentControlFactV2,
  V9EconomicControlReviewV2,
  V9FactStatusV2,
  V9FailureDomainRef,
} from "../../types/safety-score-v9-facts";
import type { V9FactGapV3 } from "../../types/safety-score-v9-facts";
import type { V9EvidenceCause, V9ScoringDisposition } from "../../types/safety-score-v9-causes";
import type { BridgeRouteRiskTier, OracleRiskTier } from "../../types/core";
import type {
  V9ReasonCode,
  V9Severity,
  V9StructuralSignalKind,
  V9ValidatedPolicyEnvelope,
} from "../../types/safety-score-v9";
import { V9_EMPTY_ARRAY } from "./primitives";

export type V9MintReconciliation = V9EconomicControlReviewV2["mint"]["reconciliation"];
export type V9MintSupervision = V9EconomicControlReviewV2["mint"]["supervision"];
export type V9MintPosture =
  | "none-resolved"
  | "bounded-admin"
  | "partially-bounded-admin"
  | "concentrated-admin"
  | "collateral-gated"
  | "unbounded-reconciled"
  | "unbounded-governed"
  | "unbounded-reconciliation-unknown"
  | "unbounded-unreconciled"
  | "compromised"
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
  gaps?: readonly V9FactGapV3[];
  supply: Pick<
    V9AssetFactsBase["supply"],
    | "status"
    | "selectedBridgeRoutes"
    | "selectedRouteSupplyShare"
    | "unknownRouteSupplyShare"
    | "unreviewedRouteSupplyShare"
    | "providerRowExclusions"
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
  kind: "mint" | "oracle" | "bridge" | "inventory";
  posture: V9MintPosture | V9OracleTier | V9BridgeTier;
  score: number | null;
  cause: V9EvidenceCause | null;
  causeGapIds: readonly string[];
  scoringDisposition: V9ScoringDisposition;
  effectiveScoringWeight: number;
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

interface V9ControlStructuralFailureDetails {
  binding: boolean;
  reason: string;
  materialSharePct: number | null;
  controlKeys: readonly string[];
  failureDomains: readonly V9FailureDomainRef[];
}

export type V9ControlStructuralFailure = V9ControlStructuralFailureDetails & ({
  kind: "weak-oracle-branch";
  severity: Exclude<V9Severity, "critical">;
} | {
  kind: Extract<
    V9StructuralSignalKind,
    | "centralized-mint"
    | "unreviewed-upgrade"
    | "material-bridge"
    | "peripheral-bridge"
    | "active-control-incident"
  >;
  severity: V9Severity;
});

export interface V9EconomicControlResult {
  score: number | null;
  aggregationDisposition: "included" | "excluded-a-b";
  causeGapIds: readonly string[];
  limitedEvidenceCauses: readonly ("C" | "U" | "D")[];
  supportedComponentKeys: readonly string[];
  /** Proportional unresolved-deployment pricing, before resilience and dependency adjustments. */
  unresolvedDeploymentAdjustment?: { scoreBefore: number; scoreAfter: number };
  /** Admitted full unresolved cohort share used by the composite ceiling band. */
  unresolvedDeploymentShare?: number;
  state: "rated" | "not-rated";
  oracleApplicability: V9FactStatusV2["applicability"]["state"];
  components: readonly V9ControlComponent[];
  /** Compiler facts used only for truthful public authority diagnostics. */
  controlFacts?: readonly V9DeploymentControlFactV2[];
  reasons: readonly V9CompactControlReason[];
  structuralFailures: readonly V9ControlStructuralFailure[];
  failureDomains: readonly V9FailureDomainRef[];
}
/** Admit only complete, delayed, flash-resistant and enumerable governance issuance. */
export function isV9GovernedIssuanceQualified(
  control: V9DeploymentControlFactV2,
  policy: V9GovernedIssuancePolicy,
): boolean {
  const governance = control.issuanceGovernance;
  const admissibleVotingPower: readonly string[] = policy.admissibleVotingPower;
  return governance !== undefined &&
    governance.coverage === "complete" &&
    governance.incompleteReasons.length === 0 &&
    governance.nonGovernorUnboundedPathKeys.length === 0 &&
    governance.minUnavoidableDelaySec !== null &&
    governance.minUnavoidableDelaySec >= policy.minUnavoidableDelaySec &&
    admissibleVotingPower.includes(governance.votingPower) &&
    governance.enumerable;
}

/** Derive posture from recorded semantics; aggregate review confidence cannot clear an adverse fact. */
export function deriveV9MintPosture(
  control: V9DeploymentControlFactV2 | null,
  mint: V9MintMechanismReview,
  immutableMechanism: boolean,
  governedPolicy: V9GovernedIssuancePolicy,
): V9MintPosture {
  if (control?.incidentState === "active") return "compromised";
  if (!control) return immutableMechanism ? "none-resolved" : "unknown";
  if (control.economicLossScope === "unknown") return "unknown";
  if (control.capSemantics.kind === "unbounded" || control.claimImpairment === "unbounded") {
    const reconciled = mint.reconciliation === "continuous" || mint.reconciliation === "periodic";
    if (reconciled && (mint.supervision === "prudential" || mint.supervision === "attestation-only")) {
      return "unbounded-reconciled";
    }
    // D29: after independently graded reconciliation, only complete governor-only
    // issuance with unavoidable delay, flash-resistant voting and enumerability
    // outranks base reconciliation or an unreconciled / unverified mint process.
    if (isV9GovernedIssuanceQualified(control, governedPolicy)) return "unbounded-governed";
    if (reconciled || mint.supervision === "prudential") return "unbounded-reconciled";
    // An internal ledger process resolves the mint-process question, not
    // reserve reconciliation: retain the unverified rung without supervision.
    if (mint.reconciliation === "unknown" || mint.reconciliation === "internal-ledger") {
      return "unbounded-reconciliation-unknown";
    }
    return "unbounded-unreconciled";
  }
  if (control.capSemantics.kind === "unknown" || control.claimImpairment === "unknown") return "unknown";
  if (control.claimImpairment === "none") return "none-resolved";
  if (control.capSemantics.kind === "collateral-gated") return "collateral-gated";
  if (control.capSemantics.kind === "raiseable" || mint.reconciliation === "periodic") {
    return "partially-bounded-admin";
  }
  if (control.capSemantics.kind === "bounded") return "bounded-admin";
  return "concentrated-admin";
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
export type V9GovernedIssuancePolicy = V9ControlPolicy["governedIssuance"];

/** Resolve only admitted gap proofs; legacy owner labels never authorize exclusion. */
export function resolveV9StatusCauses(
  statuses: readonly (V9FactStatusV2 | undefined)[],
  gaps: readonly V9FactGapV3[] = [],
): { cause: V9EvidenceCause | null; causeGapIds: string[]; causes: V9EvidenceCause[]; excluded: boolean } {
  const missing = statuses.filter((status): status is V9FactStatusV2 =>
    status !== undefined && status.applicability.state !== "not-applicable" &&
    (status.observationState !== "known" || status.applicability.state === "unresolved"));
  const firstGapIds = missing[0]?.gapIds ?? V9_EMPTY_ARRAY;
  const canShareGapIds = firstGapIds.every((id, index) => index === 0 || id > firstGapIds[index - 1]!) &&
    missing.every((status) => status.gapIds === firstGapIds &&
      (!status.applicability.gapId || firstGapIds.includes(status.applicability.gapId)));
  const causeGapIds = canShareGapIds ? firstGapIds : [...new Set(missing.flatMap((status) => [
    ...status.gapIds, ...(status.applicability.gapId ? [status.applicability.gapId] : []),
  ]))].sort();
  const causes: V9EvidenceCause[] = causeGapIds.length === 0 ? [] :
    [...new Set(causeGapIds.map((id) => gaps.find((gap) => gap.gapId === id)?.causeProof.cause ?? "U"))];
  if (missing.length > 0 && causes.length === 0) causes.push("U");
  const cause = (["D", "C", "U", "A", "B"] as const).find((value) => causes.includes(value)) ?? null;
  return { cause, causeGapIds, causes, excluded: causes.length > 0 && causes.every((value) => value === "A" || value === "B") };
}

export function v9ScoringDisposition(cause: V9EvidenceCause | null): V9ScoringDisposition {
  return cause === "A" ? "excluded-pipeline" : cause === "B" ? "excluded-uncurated"
    : cause === "C" || cause === "U" ? "bounded-uncertainty"
      : cause === "D" ? "measured-adverse" : "included";
}
