import type {
  V9AssetFactsV2,
  V9DeploymentControlFactV2,
  V9FactStatusV2,
  V9FailureDomainRef,
} from "../../types/safety-score-v9-facts";
import type {
  V9ReasonCode,
  V9Severity,
  V9StructuralSignalKind,
  V9ValidatedPolicyEnvelope,
} from "../../types/safety-score-v9";
import {
  V9_CANDIDATE_POLICY_V1,
  assertV9ReasonCodesRegistered,
  assertV9ValidatedPolicyEnvelope,
  resolveV9ReasonPolicy,
} from "./policy";
import { isV9UncanonicalizedChainPoolRoute } from "./facts";
import { canonicalDomains, compareText, domainKey, uniqueSorted } from "./primitives";

export type V9MintReconciliation = "continuous" | "periodic" | "not-applicable" | "unknown";
export type V9MintSupervision = "prudential" | "attestation-only" | "none" | "unknown";
export type V9MintPosture =
  | "none-resolved"
  | "bounded-admin"
  | "partially-bounded-admin"
  | "concentrated-admin"
  | "unbounded-reconciled"
  | "unbounded-or-compromised"
  | "unknown";
export type V9OracleTier =
  | "oracleless-or-internal"
  | "redundant-with-failover"
  | "medianized-with-delay"
  | "standard-external"
  | "single-source-or-laggy"
  | "opaque-or-unknown";
export type V9BridgeTier =
  | "single-chain-or-native"
  | "issuer-native-burn-mint"
  | "canonical-rollup-bridge"
  | "issuer-native-lock-mint"
  | "external-validated-network"
  | "liquidity-or-intent-route"
  | "external-lock-mint"
  | "opaque-or-unknown";

export type V9OracleBranchKind = "feed" | "collateral-parameter" | "liquidation" | "backstop" | "shutdown-bad-debt";

export interface V9UpgradeControlReview {
  state: "immutable" | "not-applicable" | "reviewed" | "unknown";
  controlKey: string | null;
}

export interface V9MintMechanismReview {
  status: V9FactStatusV2;
  controlKey: string | null;
  reconciliation: V9MintReconciliation;
  supervision: V9MintSupervision;
  /**
   * Epoch second of the most recent resolved mint incident, or null when the
   * review records none. Absolute rather than an age so the fact is stable
   * between compilation cycles; the evaluator converts it against its own
   * clock (see {@link EvaluateV9EconomicControlArgs.resolvedIncidentAgeMonths}).
   */
  latestResolvedIncidentAtSec?: number | null;
  upgrade: V9UpgradeControlReview;
}

export interface V9MintControlPostureFacts {
  supervision: V9MintSupervision;
  reconciliation: V9MintReconciliation;
  attestationCadence: "independent-periodic" | "self-reported" | "unknown";
  custodyStructure: "segregated-diversified" | "concentrated-custodian" | "unknown";
  openLegalEvents: "none" | "open" | "unknown";
}

/**
 * Grade the full R4 control-posture tuple. The production review currently
 * carries only supervision and reconciliation, so its bounded proxy is
 * applied separately in evaluateV9EconomicControl; unknown richer facts keep
 * this full grader on the existing conservative posture value.
 */
export function gradeV9MintControlPosture(
  posture: V9MintPosture,
  facts: V9MintControlPostureFacts,
  envelope: V9ValidatedPolicyEnvelope = V9_CANDIDATE_POLICY_V1,
): number {
  assertV9ValidatedPolicyEnvelope(envelope);
  const policy = envelope.policy.semantic.control;
  const conservative = policy.mintPostureQuality[posture];
  if (posture !== "concentrated-admin" && posture !== "unbounded-reconciled") return conservative;

  const reconciled = facts.reconciliation === "continuous" || facts.reconciliation === "periodic";
  const favorableSupportingFacts =
    facts.attestationCadence === "independent-periodic" &&
    facts.custodyStructure === "segregated-diversified" &&
    facts.openLegalEvents === "none";
  if (!reconciled || !favorableSupportingFacts) return conservative;
  if (facts.supervision === "prudential") return policy.mintPostureGrading.prudentialReconciled;
  if (facts.supervision === "attestation-only") return policy.mintPostureGrading.attestationOnlyReconciled;
  return conservative;
}

export interface V9OracleBranchReview {
  branch: V9OracleBranchKind;
  status: V9FactStatusV2;
  controlKey: string | null;
  mechanismKey: string | null;
  inheritedFromAssetId: string | null;
}

export interface V9OracleControlReview {
  status: V9FactStatusV2;
  tier: V9OracleTier | null;
  branches: readonly V9OracleBranchReview[];
  /**
   * Worst severity band from weak market branches whose measured debt share is
   * below the deployment-materiality threshold. Such branches do not drive the
   * material-only top-level {@link tier}; this surfaces them as one non-binding
   * oracle diagnostic. Absent when the branch-materiality lever is inactive or
   * no sub-material weak branch exists. Derived in `adaptOracleReview`.
   */
  subMaterialWeakBand?: "moderate" | "low";
}

export interface V9BridgeRouteControlReview {
  controlKey: string;
  tier: V9BridgeTier;
}

export interface V9BridgeControlReview {
  status: V9FactStatusV2;
  routes: readonly V9BridgeRouteControlReview[];
}

export interface V9EconomicControlAssetFacts {
  assetId: V9AssetFactsV2["assetId"];
  archetype: V9AssetFactsV2["archetype"];
  controlStatus: V9AssetFactsV2["controlStatus"];
  controls: readonly V9DeploymentControlFactV2[];
  supply: Pick<
    V9AssetFactsV2["supply"],
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

/** Facts still awaiting a first-class home in V9AssetFactsV2. */
export interface V9EconomicControlReviewExtension {
  assetId: V9AssetFactsV2["assetId"];
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
  components: readonly V9ControlComponent[];
  reasons: readonly V9CompactControlReason[];
  structuralFailures: readonly V9ControlStructuralFailure[];
  failureDomains: readonly V9FailureDomainRef[];
}

const ORACLE_BRANCHES = [
  "feed",
  "collateral-parameter",
  "liquidation",
  "backstop",
  "shutdown-bad-debt",
] as const satisfies readonly V9OracleBranchKind[];

function isKnownRequired(status: V9FactStatusV2): boolean {
  return status.applicability.state === "required" && status.observationState === "known";
}

function isControlEconomicallyRelevant(control: V9DeploymentControlFactV2): boolean {
  if (control.claimImpairment === "none" && control.economicLossScope === "access-only") return false;
  if (control.controlKind !== "governance") return true;
  return control.capabilities.some((capability) =>
    ["mint", "upgrade", "oracle-update", "bridge-mint", "custody-transfer", "parameter-change"].includes(capability),
  );
}

function mappedControlStatusReason(control: V9DeploymentControlFactV2): V9ReasonCode {
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

function controlCanRepresent(control: V9DeploymentControlFactV2, kind: "mint" | "upgrade" | "oracle" | "bridge") {
  if (control.controlKind === kind) return true;
  const capability = {
    mint: "mint",
    upgrade: "upgrade",
    oracle: "oracle-update",
    bridge: "bridge-mint",
  } as const;
  return control.capabilities.includes(capability[kind]);
}

function bindingByMateriality(control: V9DeploymentControlFactV2, materialShareThreshold: number): boolean {
  if (control.economicLossScope === "global-claim" || control.economicLossScope === "reserve-claim") return true;
  if (control.economicLossScope === "access-only") return false;
  // A missing deployment share is not evidence of immateriality. Keep it
  // fail-closed until the producer supplies an exact below-threshold share.
  return control.materialSupplyShare === null || control.materialSupplyShare >= materialShareThreshold;
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
const MATERIAL_BRIDGE_HIGH_SHARE_THRESHOLD = 0.25;

function materialBridgeSeverity(tier: V9BridgeTier, materialSupplyShare: number | null): V9Severity {
  if (tier === "opaque-or-unknown") return "critical";
  if (materialSupplyShare === null) return "high";
  return materialSupplyShare >= MATERIAL_BRIDGE_HIGH_SHARE_THRESHOLD ? "high" : "moderate";
}

function hasCompleteSubthresholdUnresolvedBridgeJoins(
  facts: V9EconomicControlAssetFacts,
  controls: readonly V9DeploymentControlFactV2[],
  bridgeRoutes: readonly V9BridgeRouteControlReview[],
  materialShareThreshold: number,
  commonModeShareThreshold: number,
): boolean {
  if (!isKnownRequired(facts.supply.status)) return false;
  const { selectedRouteSupplyShare, unreviewedRouteSupplyShare, unknownRouteSupplyShare } = facts.supply;
  if (selectedRouteSupplyShare === null || unreviewedRouteSupplyShare === null || unknownRouteSupplyShare === null) {
    return false;
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
    return false;
  }

  const bridgeControlsByDeployment = new Map<string, V9DeploymentControlFactV2[]>();
  for (const control of controls) {
    if (control.controlKind !== "bridge") continue;
    bridgeControlsByDeployment.set(control.deploymentKey, [
      ...(bridgeControlsByDeployment.get(control.deploymentKey) ?? []),
      control,
    ]);
  }
  const bridgeRouteCounts = new Map<string, number>();
  for (const route of bridgeRoutes) {
    bridgeRouteCounts.set(route.controlKey, (bridgeRouteCounts.get(route.controlKey) ?? 0) + 1);
  }
  if ([...bridgeRouteCounts.values()].some((count) => count !== 1)) return false;
  return rows.every((route) => {
    // RULED D-J (2026-07-19): an unrecognized-chain-label pool below the
    // common-mode materiality floor is an accepted bounded row, not a proof
    // failure. At or above the floor the pool keeps the ordinary fail-closed
    // per-row checks below (the material unrecognized-chain latency case).
    if (isV9UncanonicalizedChainPoolRoute(route.deploymentRouteKey) && route.supplyShare < commonModeShareThreshold) {
      return true;
    }
    const joined = bridgeControlsByDeployment.get(route.deploymentRouteKey) ?? [];
    if (route.reviewState === "selected-reviewed") {
      if (route.reviewedRouteKind === "native") return joined.length === 0;
      if (route.reviewedRouteKind !== "controlled") return false;
      if (joined.length !== 1) return false;
      const control = joined[0]!;
      return (
        controlCanRepresent(control, "bridge") &&
        isKnownRequired(control.status) &&
        control.materialSupplyShare !== null &&
        bridgeSharesReconcile(control.materialSupplyShare, route.supplyShare) &&
        bridgeRouteCounts.get(control.controlKey) === 1
      );
    }
    if (joined.length !== 1) return false;
    const control = joined[0]!;
    return (
      control.scope === "deployment" &&
      control.economicLossScope === "deployment" &&
      control.materialSupplyShare !== null &&
      bridgeSharesReconcile(control.materialSupplyShare, route.supplyShare) &&
      control.materialSupplyShare < materialShareThreshold
    );
  });
}

function controlFallbackKind(control: V9DeploymentControlFactV2): "mint" | "oracle" | "bridge" | null {
  if (controlCanRepresent(control, "bridge")) return "bridge";
  if (controlCanRepresent(control, "oracle")) return "oracle";
  if (controlCanRepresent(control, "mint") || controlCanRepresent(control, "upgrade")) return "mint";
  return null;
}

type V9ControlPolicy = V9ValidatedPolicyEnvelope["policy"]["semantic"]["control"];

/**
 * A control row whose authority identity is fully reviewed: it is required-known,
 * its authority model is resolved, and its cap / claim / loss semantics are
 * enumerated. Such a row can carry a residual gap (unknown exposure share, an
 * unresolved mechanism-review) while its *authority* posture is verified.
 */
function isStaticallyVerifiedControl(control: V9DeploymentControlFactV2): boolean {
  return (
    isKnownRequired(control.status) &&
    control.authority !== null &&
    control.authority.model !== "unknown" &&
    control.capSemantics.kind !== "unknown" &&
    control.claimImpairment !== "unknown" &&
    control.economicLossScope !== "unknown"
  );
}

/**
 * Ascending, de-duplicated ladder of every mint-component quality value the
 * policy can produce. Bounded credits use it so a credit can lift a score
 * towards the next rung but never make a lower posture class read as the class
 * above it (the discipline the seasoned credit already follows).
 */
function mintQualityLadder(controlPolicy: V9ControlPolicy): readonly number[] {
  return [
    ...new Set([
      ...Object.values(controlPolicy.mintPostureQuality),
      controlPolicy.mintPostureGrading.prudentialReconciled,
      controlPolicy.mintPostureGrading.attestationOnlyReconciled,
      controlPolicy.boundedUnknownQuality,
      controlPolicy.mintMergedSignals.attestedKeyCustodyQuality,
    ]),
  ].sort((left, right) => left - right);
}

/**
 * Safety 9.1 — fine multisig quorum ladder. Replaces the binary
 * "threshold >= 2 and strictly more than half, plus a timelock" test with a
 * bounded adjustment over the reviewed threshold, signer set, delay and Safe
 * module surface. Derived strictly from the passed row; a control whose
 * topology was never reviewed takes the conservative unknown rung.
 */
function multisigQuorumRawAdjustment(control: V9DeploymentControlFactV2, controlPolicy: V9ControlPolicy): number {
  const knobs = controlPolicy.mintMergedSignals.multisigQuorumAdjustment;
  const quorum = control.authority?.threshold ?? null;
  if (quorum === null) return knobs.unknownTopology;
  let adjustment =
    quorum.required <= 1
      ? knobs.singleSigner
      : quorum.required === 2
        ? knobs.twoSigner
        : knobs.thresholdThreePlus;
  if (quorum.required >= 4) adjustment += knobs.thresholdFourPlusCredit;
  if (quorum.required * 2 > quorum.total) adjustment += knobs.majorityThresholdCredit;
  if (control.delaySec !== null && control.delaySec > 0) adjustment += knobs.timelockCredit;
  return Math.max(knobs.minAdjustment, adjustment);
}

/**
 * Safety 9.1 — reviewed Safe module/guard surface as a small quality modifier.
 * "none-detected" is positive evidence that no side-door module bypasses the
 * authority path; "present" is a reviewed extension surface. Unknown and
 * not-applicable are inert.
 */
function modulesOrGuardsAdjustment(control: V9DeploymentControlFactV2, controlPolicy: V9ControlPolicy): number {
  const knobs = controlPolicy.mintMergedSignals.modulesOrGuardsAdjustment;
  if (control.modulesOrGuards === "none-detected") return knobs.noneDetectedCredit;
  if (control.modulesOrGuards === "present") return -knobs.presentPenalty;
  return 0;
}

/**
 * Safety 9.1 — resolved-incident age decay. V9 previously penalized only
 * `incidentState: "active"`, so a resolved mint exploit cost nothing at all.
 * The retired Mint Authority engine carried the opposite bias (a permanent cap
 * by incident age). The merged rule keeps the age decay and re-expresses it on
 * V9's ladder: a resolved incident caps the mint component, and the cap relaxes
 * as the incident recedes without ever reaching the clean-record ladder. An
 * unmeasured age fails conservative onto the strictest rung.
 */
function resolvedIncidentQualityCap(
  resolvedIncidentAgeMonths: number | undefined,
  controlPolicy: V9ControlPolicy,
): number {
  const { resolvedIncidentQualityCaps: caps, resolvedIncidentDecayMinMonths: tiers } =
    controlPolicy.mintMergedSignals;
  if (resolvedIncidentAgeMonths === undefined) return caps.recent;
  if (resolvedIncidentAgeMonths >= tiers.dated) return caps.dated;
  if (resolvedIncidentAgeMonths >= tiers.aging) return caps.aging;
  return caps.recent;
}

/**
 * Safety 9.1 — apply the merged mint signals to an already-graded mint
 * component score. Credits are ceiling-bounded below the next ladder rung so a
 * quorum or module credit can never relabel a posture class; penalties floor at
 * the adverse rung so a granularity signal can never invent a worse-than-worst
 * posture. The resolved-incident cap is applied last: it is a ceiling on the
 * merged result, not another additive term.
 */
function applyMergedMintSignals(
  base: number,
  mintControl: V9DeploymentControlFactV2 | null,
  resolvedIncidentAgeMonths: number | undefined,
  controlPolicy: V9ControlPolicy,
): number {
  if (mintControl === null) return base;
  const signals = controlPolicy.mintMergedSignals;
  let adjustment = 0;
  if (mintControl.authority?.model === "multisig") {
    // `maxAdjustment` is the published component's credit ceiling: on a rated
    // card the quorum ladder's relief may cancel its own penalty but must not
    // manufacture a lift out of an unchanged posture.
    adjustment += Math.min(
      signals.multisigQuorumAdjustment.maxAdjustment,
      multisigQuorumRawAdjustment(mintControl, controlPolicy),
    );
  }
  // A bare externally-owned mint key is a single-point custody failure that the
  // cap/claim-derived posture cannot see. Reviewed MPC or HSM custody
  // reclassifies it as an issuer-operated backend and waives the penalty — the
  // treatment the retired Mint Authority engine applied to the same fact.
  if (
    mintControl.authority?.model === "eoa" &&
    mintControl.keyCustody !== "mpc" &&
    mintControl.keyCustody !== "hsm"
  ) {
    adjustment -= signals.unattestedEoaPenalty;
  }
  adjustment += modulesOrGuardsAdjustment(mintControl, controlPolicy);
  let score = base;
  if (adjustment > 0) {
    const nextRung = mintQualityLadder(controlPolicy).find((value) => value > base);
    const ceiling = nextRung === undefined ? base : nextRung - 1;
    score = Math.min(base + adjustment, Math.max(base, ceiling));
  } else if (adjustment < 0) {
    score = Math.max(base + adjustment, controlPolicy.mintPostureQuality["unbounded-or-compromised"]);
  }
  if (mintControl.incidentState === "resolved") {
    score = Math.min(score, resolvedIncidentQualityCap(resolvedIncidentAgeMonths, controlPolicy));
  }
  return score;
}

/**
 * LEVER 5 (2026-07-21): grade a verified control row on its own authority facts
 * instead of the bounded-unknown default. Derives strictly from the passed row
 * (wards / Safe threshold / timelock / authority.model), never from asset-generic
 * facts, and grades UP or DOWN relative to the 45 default: a live compromise or an
 * economically unbounded control grades below it, a hardened governed/multisig
 * path above it. issuer-backend and unknown authority stay at the neutral default.
 */
function gradeVerifiedControlAuthority(control: V9DeploymentControlFactV2, controlPolicy: V9ControlPolicy): number {
  const quality = controlPolicy.mintPostureQuality;
  const authority = control.authority;
  if (authority === null || authority.model === "unknown") return controlPolicy.boundedUnknownQuality;

  // A live compromise or an economically unbounded control is weak regardless of
  // who holds the key: grade it below the neutral default, never above.
  if (
    control.incidentState === "active" ||
    control.capSemantics.kind === "unbounded" ||
    control.claimImpairment === "unbounded"
  ) {
    return quality["unbounded-or-compromised"];
  }

  const timelocked = control.delaySec !== null && control.delaySec > 0;
  switch (authority.model) {
    case "none":
      // No live authority path (renounced / immutable) is the strongest posture.
      return quality["none-resolved"];
    case "contract":
      return quality["bounded-admin"];
    case "governance":
      return timelocked ? quality["bounded-admin"] : quality["partially-bounded-admin"];
    case "multisig": {
      // Safety 9.1: the fine quorum ladder replaces the binary strong-quorum
      // test. It grades from the concentrated rung and is bounded by the
      // partially-bounded rung above and the adverse rung below, so quorum
      // granularity refines this row's grade without relabelling its class.
      // This path starts from the concentrated rung by construction rather than
      // from the asset's own posture, so it grades on the raw ladder and takes
      // its ceiling from the partially-bounded rung below.
      const graded =
        quality["concentrated-admin"] +
        multisigQuorumRawAdjustment(control, controlPolicy) +
        modulesOrGuardsAdjustment(control, controlPolicy);
      return Math.max(
        quality["unbounded-or-compromised"],
        Math.min(graded, quality["partially-bounded-admin"]),
      );
    }
    case "issuer-backend":
      // A centralized backend key with a bounded claim is neither a lift nor a
      // clear danger on static facts alone: hold at the neutral default.
      return controlPolicy.boundedUnknownQuality;
    case "eoa":
      // Safety 9.1: an externally-owned key under reviewed MPC or HSM custody is
      // an issuer-operated backend, not a bare single key — the reclassification
      // the retired Mint Authority engine already made. Unattested single keys
      // keep the weak posture.
      if (control.keyCustody === "mpc" || control.keyCustody === "hsm") {
        return controlPolicy.mintMergedSignals.attestedKeyCustodyQuality;
      }
      // A single externally-owned key is a weak control posture: grade below 45.
      return quality["unbounded-or-compromised"];
    default:
      return controlPolicy.boundedUnknownQuality;
  }
}

/**
 * Canonically joins normalized asset facts to the explicit review extension.
 * The extension is mandatory: callers must not infer reconciliation or tiers.
 */
export function projectV9EconomicControlEvaluation(
  asset: V9EconomicControlAssetSource,
  review: V9EconomicControlReviewExtension,
  policy: V9ValidatedPolicyEnvelope,
): EvaluateV9EconomicControlArgs {
  assertV9ValidatedPolicyEnvelope(policy);
  if (review.assetId !== asset.assetId) {
    throw new Error(`Safety Score v9 control review ${review.assetId} does not match asset ${asset.assetId}`);
  }

  return {
    policy,
    facts: {
      assetId: asset.assetId,
      archetype: asset.archetype,
      controlStatus: asset.controlStatus,
      controls: [...asset.controls].sort((left, right) => compareText(left.controlKey, right.controlKey)),
      supply: {
        status: asset.supply.status,
        selectedBridgeRoutes: [...asset.supply.selectedBridgeRoutes].sort((left, right) =>
          compareText(left.deploymentRouteKey, right.deploymentRouteKey),
        ),
        selectedRouteSupplyShare: asset.supply.selectedRouteSupplyShare,
        unknownRouteSupplyShare: asset.supply.unknownRouteSupplyShare,
        unreviewedRouteSupplyShare: asset.supply.unreviewedRouteSupplyShare,
      },
    },
    mint: {
      ...review.mint,
      upgrade: { ...review.mint.upgrade },
    },
    ...(review.trackRecordMonths !== undefined ? { trackRecordMonths: review.trackRecordMonths } : {}),
    ...(review.resolvedIncidentAgeMonths !== undefined
      ? { resolvedIncidentAgeMonths: review.resolvedIncidentAgeMonths }
      : {}),
    oracle: {
      ...review.oracle,
      branches: [...review.oracle.branches].sort(
        (left, right) =>
          compareText(left.branch, right.branch) ||
          compareText(left.controlKey ?? "", right.controlKey ?? "") ||
          compareText(left.mechanismKey ?? "", right.mechanismKey ?? ""),
      ),
    },
    bridge: {
      ...review.bridge,
      routes: [...review.bridge.routes].sort((left, right) => compareText(left.controlKey, right.controlKey)),
    },
  };
}

export function evaluateV9EconomicControl(args: EvaluateV9EconomicControlArgs): V9EconomicControlResult {
  assertV9ValidatedPolicyEnvelope(args.policy);
  const policy = args.policy.policy.semantic;
  const materialShareThreshold = policy.materiality.deploymentMaterialSharePct / 100;
  const controls = [...args.facts.controls].sort((left, right) => compareText(left.controlKey, right.controlKey));
  const controlsByKey = new Map(controls.map((control) => [control.controlKey, control]));
  const components: V9ControlComponent[] = [];
  const reasons = new Map<string, V9CompactControlReason>();
  const structuralFailures = new Map<string, V9ControlStructuralFailure>();

  const addReason = (
    code: V9ReasonCode,
    pathKind: V9CompactControlReason["pathKind"],
    path: string,
    controlKey: string | null = null,
  ) => {
    const resolved = resolveV9ReasonPolicy(args.policy, code);
    if (!resolved.reason.pathKinds.includes(pathKind)) {
      throw new Error(`Safety Score v9 reason ${code} cannot describe ${pathKind}`);
    }
    const key = `${code}:${pathKind}:${path}:${controlKey ?? ""}`;
    reasons.set(key, {
      code,
      label: resolved.reason.publicLabel,
      critical: resolved.critical,
      pathKind,
      path,
      controlKey,
    });
  };

  const addStructuralFailure = (failure: V9ControlStructuralFailure) => {
    const domains = canonicalDomains(failure.failureDomains);
    const controlKeys = uniqueSorted(failure.controlKeys);
    const key = `${failure.kind}:${failure.binding}:${controlKeys.join("+")}:${domains
      .map(domainKey)
      .join("+")}`;
    structuralFailures.set(key, { ...failure, controlKeys, failureDomains: domains });
  };

  if (args.facts.controlStatus.applicability.state === "unresolved") {
    addReason("unresolved-control-identity", "local-component", "controls");
  } else if (
    args.facts.controlStatus.applicability.state === "required" &&
    args.facts.controlStatus.observationState !== "known"
  ) {
    addReason("unresolved-control-identity", "local-component", "controls");
  }

  for (const control of controls) {
    if (!isControlEconomicallyRelevant(control)) continue;
    if (control.status.applicability.state === "not-applicable") continue;
    const binding = bindingByMateriality(control, materialShareThreshold);
    const pathKind = control.controlKind === "bridge" ? "deployment-control" : "local-component";
    const path = `control:${control.controlKey}`;
    if (control.status.applicability.state === "unresolved" || control.status.observationState !== "known") {
      if (binding) addReason(mappedControlStatusReason(control), pathKind, path, control.controlKey);
      continue;
    }
    if (binding && (control.authority === null || control.authority.model === "unknown")) {
      addReason("unresolved-control-identity", "local-component", path, control.controlKey);
    }
    if (
      binding &&
      (control.capSemantics.kind === "unknown" ||
        control.claimImpairment === "unknown" ||
        control.economicLossScope === "unknown")
    ) {
      addReason("unresolved-control-identity", "local-component", `${path}:economic-semantics`, control.controlKey);
    }
    if (binding && control.incidentState === "unknown") {
      addReason("unresolved-control-identity", "local-component", `${path}:incident`, control.controlKey);
    } else if (control.incidentState === "active") {
      addStructuralFailure({
        kind: "active-control-incident",
        severity: "critical",
        binding,
        reason: "A reviewed economic control has an active compromise incident.",
        materialSharePct: control.materialSupplyShare === null ? null : control.materialSupplyShare * 100,
        controlKeys: [control.controlKey],
        failureDomains: control.failureDomains,
      });
    }
    if (
      control.economicLossScope === "deployment" &&
      control.materialSupplyShare === null &&
      control.scope !== "global"
    ) {
      addReason(
        control.controlKind === "bridge" ? "runtime-bridge-materiality-unavailable" : "unresolved-control-identity",
        pathKind,
        `${path}:materiality`,
        control.controlKey,
      );
    }
  }

  const mint = args.mint;
  if (mint.status.applicability.state === "not-applicable") {
    components.push({
      componentKey: "mint",
      kind: "mint",
      posture: "none-resolved",
      score: policy.control.mintPostureQuality["none-resolved"],
      binding: true,
      controlKeys: [],
      failureDomains: [],
    });
  } else if (mint.status.applicability.state === "unresolved") {
    addReason("mint-control-question", "local-component", "mint");
  } else if (mint.status.observationState !== "known") {
    addReason(
      mint.status.observationState === "missing" ? "missing-mint-authority" : "unresolved-mint-authority",
      "local-component",
      "mint",
      mint.controlKey,
    );
  } else {
    const mintControl = mint.controlKey === null ? null : (controlsByKey.get(mint.controlKey) ?? null);
    const immutableMechanism =
      mint.controlKey === null && mint.upgrade.state === "immutable" && mint.reconciliation === "not-applicable";
    if (mint.controlKey === null && !immutableMechanism) {
      addReason("missing-mint-authority", "local-component", "mint");
    } else if (mint.controlKey !== null && (!mintControl || !controlCanRepresent(mintControl, "mint"))) {
      addReason("unresolved-control-identity", "local-component", "mint", mint.controlKey);
    }
    if (mintControl?.capSemantics.kind === "unknown") {
      addReason("unknown-control-cap-authority", "local-component", "mint:cap", mint.controlKey);
    }
    if (mintControl?.claimImpairment === "unknown") {
      addReason("unknown-control-mint-ability", "local-component", "mint:claim-impairment", mint.controlKey);
    }
    if (
      mintControl &&
      mintControl.claimImpairment !== "none" &&
      mintControl.authority?.model === "issuer-backend" &&
      (mint.reconciliation === "not-applicable" || mint.reconciliation === "unknown")
    ) {
      addReason("mint-control-question", "local-component", "mint:reconciliation", mint.controlKey);
    }

    let upgradeControl: V9DeploymentControlFactV2 | null = null;
    let upgradeUnreviewed = false;
    if (mint.upgrade.state === "unknown") {
      upgradeUnreviewed = true;
      addReason("unknown-upgrade-authority", "local-component", "mint:upgrade", mint.upgrade.controlKey);
    } else if (mint.upgrade.state === "reviewed") {
      upgradeControl = mint.upgrade.controlKey === null ? null : (controlsByKey.get(mint.upgrade.controlKey) ?? null);
      if (!upgradeControl || !controlCanRepresent(upgradeControl, "upgrade")) {
        upgradeUnreviewed = true;
        addReason("missing-upgrade-control", "local-component", "mint:upgrade", mint.upgrade.controlKey);
      } else if (!isKnownRequired(upgradeControl.status)) {
        upgradeUnreviewed = true;
        addReason("missing-upgradeability-review", "local-component", "mint:upgrade", mint.upgrade.controlKey);
      }
    }

    const compromised = mintControl?.incidentState === "active";
    const posture: V9MintPosture = (() => {
      if (compromised) return "unbounded-or-compromised";
      if (!mintControl) return immutableMechanism ? "none-resolved" : "unknown";
      if (
        mintControl.capSemantics.kind === "unknown" ||
        mintControl.claimImpairment === "unknown" ||
        mintControl.economicLossScope === "unknown"
      ) {
        return "unknown";
      }
      if (mintControl.capSemantics.kind === "unbounded" || mintControl.claimImpairment === "unbounded") {
        // Economically unbounded minting that is reconciled against reserves is
        // a distinct, higher-quality posture than an unreconciled one; only the
        // latter (and any compromise, handled above) stays unbounded-or-compromised.
        // Prudential supervision by a named financial regulator is itself evidence
        // that issuance is constrained by the supervisory regime, so it qualifies
        // as reconciled even when reserve-reconciliation cadence is not-applicable.
        const reconciled =
          mint.reconciliation === "continuous" ||
          mint.reconciliation === "periodic" ||
          mint.supervision === "prudential";
        return reconciled ? "unbounded-reconciled" : "unbounded-or-compromised";
      }
      if (mintControl.claimImpairment === "none") return "none-resolved";
      if (mintControl.capSemantics.kind === "raiseable" || mint.reconciliation === "periodic") {
        return "partially-bounded-admin";
      }
      if (mintControl.capSemantics.kind === "bounded") return "bounded-admin";
      return "concentrated-admin";
    })();
    const componentControlKeys = uniqueSorted(
      [mintControl?.controlKey, upgradeControl?.controlKey].filter((value): value is string => value !== undefined),
    );
    const componentFailureDomains = canonicalDomains([
      ...(mintControl?.failureDomains ?? []),
      ...(upgradeControl?.failureDomains ?? []),
    ]);
    const mintControlKeys = mintControl === null ? [] : [mintControl.controlKey];
    const mintFailureDomains = canonicalDomains(mintControl?.failureDomains ?? []);
    const upgradeControlKeys = upgradeControl === null ? [] : [upgradeControl.controlKey];
    const upgradeFailureDomains = canonicalDomains(upgradeControl?.failureDomains ?? []);
    const mintBinding = mintControl === null ? true : bindingByMateriality(mintControl, materialShareThreshold);
    const mintReconciled = mint.reconciliation === "continuous" || mint.reconciliation === "periodic";
    const gradedPostureScore =
      (posture === "concentrated-admin" || posture === "unbounded-reconciled") && mintReconciled
        ? mint.supervision === "prudential"
          ? policy.control.mintPostureGrading.prudentialReconciled
          : mint.supervision === "attestation-only"
            ? policy.control.mintPostureGrading.attestationOnlyReconciled
            : policy.control.mintPostureQuality[posture]
        : policy.control.mintPostureQuality[posture];
    // T5 seasoned-issuer credit (owner ruling 2026-07-22, R2): a reconciled,
    // non-adverse measured posture with >= seasonedCreditMinMonths of track
    // record earns seasonedCreditPoints, capped at the next rung of the merged
    // posture/grading ladder — longevity can close the gap to the next rung
    // but never leapfrog it. Adverse/unknown postures (incl. every pin) are
    // structurally ineligible, and absent trackRecordMonths fails conservative.
    const mintPostureScore = (() => {
      const grading = policy.control.mintPostureGrading;
      if (
        grading.seasonedCreditPoints <= 0 ||
        args.trackRecordMonths === undefined ||
        args.trackRecordMonths < grading.seasonedCreditMinMonths ||
        !mintReconciled ||
        posture === "unknown" ||
        posture === "unbounded-or-compromised"
      ) {
        return gradedPostureScore;
      }
      const ladder = [
        ...Object.values(policy.control.mintPostureQuality),
        grading.prudentialReconciled,
        grading.attestationOnlyReconciled,
      ].sort((left, right) => left - right);
      const nextRung = ladder.find((value) => value > gradedPostureScore);
      // Strictly below the next rung: a seasoned credit rewards longevity but can
      // never make a lower posture class read identical to the class above it
      // (adversarial-review finding on the credit widening to 10).
      const ceiling = nextRung === undefined ? gradedPostureScore : nextRung - 1;
      return Math.min(gradedPostureScore + grading.seasonedCreditPoints, ceiling);
    })();
    // Safety 9.1 merged mint grader: quorum granularity, Safe module evidence,
    // and resolved-incident age decay refine the posture-derived score. The
    // active-incident path above is untouched — a live compromise still pins the
    // posture at unbounded-or-compromised and raises the critical signal.
    const mergedMintScore = applyMergedMintSignals(
      mintPostureScore,
      mintControl,
      args.resolvedIncidentAgeMonths,
      policy.control,
    );
    components.push({
      componentKey: "mint",
      kind: "mint",
      posture,
      score: mergedMintScore,
      binding: mintBinding,
      controlKeys: componentControlKeys,
      failureDomains: componentFailureDomains,
    });
    if (posture === "unbounded-reconciled" || posture === "unbounded-or-compromised") {
      // R3 keeps reconciled mint risk inside the control pillar for prudential
      // issuers, emits a diagnostic low signal for attestation-only issuers,
      // and fails closed for absent/unknown supervision. Only an active mint
      // compromise stays critical; an unbounded/unreconciled mint with no active
      // incident is a heavy control-pillar penalty (posture already scores 25)
      // but takes the high rung so its composite reflects its pillar blend rather
      // than being hard-capped at the critical floor.
      const prudentiallySupervised = posture === "unbounded-reconciled" && mint.supervision === "prudential";
      const severity: V9Severity | null =
        posture === "unbounded-or-compromised"
          ? compromised
            ? "critical"
            : "high"
          : prudentiallySupervised
            ? null
            : mint.supervision === "attestation-only"
              ? "low"
              : "high";
      if (severity !== null) {
        addStructuralFailure({
          kind: "centralized-mint",
          severity,
          binding: mintBinding,
          reason:
            posture === "unbounded-or-compromised"
              ? "Economically effective minting is unbounded or compromised."
              : "Minting is economically unbounded but supply is reconciled against reserves.",
          materialSharePct:
            mintControl?.materialSupplyShare == null ? null : mintControl.materialSupplyShare * 100,
          controlKeys: mintControlKeys,
          failureDomains: mintFailureDomains,
        });
      }
    } else if (posture === "concentrated-admin") {
      addStructuralFailure({
        kind: "centralized-mint",
        severity: "moderate",
        binding: mintBinding,
        reason: "Minting depends on one concentrated administrator path.",
        materialSharePct:
          mintControl?.materialSupplyShare == null ? null : mintControl.materialSupplyShare * 100,
        controlKeys: mintControlKeys,
        failureDomains: mintFailureDomains,
      });
    }
    if (upgradeUnreviewed) {
      const upgradeBinding =
        upgradeControl === null ? mintBinding : bindingByMateriality(upgradeControl, materialShareThreshold);
      addStructuralFailure({
        kind: "unreviewed-upgrade",
        severity: "high",
        binding: upgradeBinding,
        reason: "Mint-critical upgrade authority is not fully reviewed.",
        materialSharePct:
          upgradeControl?.materialSupplyShare == null ? null : upgradeControl.materialSupplyShare * 100,
        controlKeys: upgradeControlKeys,
        failureDomains: upgradeFailureDomains,
      });
    }
  }

  const oracle = args.oracle;
  if (oracle.status.applicability.state === "not-applicable") {
    components.push({
      componentKey: "oracle",
      kind: "oracle",
      posture: "oracleless-or-internal",
      score: policy.control.oracleTierQuality["oracleless-or-internal"],
      binding: true,
      controlKeys: [],
      failureDomains: [],
    });
  } else if (oracle.status.applicability.state === "unresolved") {
    addReason("unresolved-oracle-branch-applicability", "local-component", "oracle");
  } else if (oracle.status.observationState !== "known") {
    const code =
      oracle.status.observationState === "missing"
        ? "missing-oracle-profile"
        : oracle.status.observationState === "stale"
          ? "unreviewed-oracle-profile"
          : "incomplete-oracle-liquidation-branch";
    addReason(code, "local-component", "oracle");
  } else {
    const branchesByKind = new Map<V9OracleBranchKind, V9OracleBranchReview>();
    for (const branch of oracle.branches) {
      if (branchesByKind.has(branch.branch)) throw new Error(`Duplicate v9 oracle branch ${branch.branch}`);
      branchesByKind.set(branch.branch, branch);
    }
    const oracleControls = new Map<string, V9DeploymentControlFactV2>();
    const missingBranches = ORACLE_BRANCHES.filter((branch) => !branchesByKind.has(branch));
    if (missingBranches.length > 0) {
      addReason("missing-required-oracle-branches", "local-component", "oracle:branches");
    }
    for (const branchKind of ORACLE_BRANCHES) {
      const branch = branchesByKind.get(branchKind);
      if (!branch || branch.status.applicability.state === "not-applicable") continue;
      if (branch.status.applicability.state === "unresolved") {
        addReason("unresolved-oracle-branch-applicability", "local-component", `oracle:${branchKind}`);
        continue;
      }
      if (branch.status.observationState !== "known") {
        addReason("incomplete-oracle-liquidation-branch", "local-component", `oracle:${branchKind}`);
        continue;
      }
      if (branch.inheritedFromAssetId !== null && branch.mechanismKey === null) {
        addReason("incomplete-oracle-liquidation-branch", "local-component", `oracle:${branchKind}:inheritance`);
      }
      if (branch.controlKey === null && branch.mechanismKey === null) {
        addReason("incomplete-oracle-liquidation-branch", "local-component", `oracle:${branchKind}`);
        continue;
      }
      if (branch.controlKey !== null) {
        const control = controlsByKey.get(branch.controlKey);
        if (!control || !controlCanRepresent(control, "oracle")) {
          addReason(
            "incomplete-oracle-liquidation-branch",
            "local-component",
            `oracle:${branchKind}`,
            branch.controlKey,
          );
        } else if (!isKnownRequired(control.status)) {
          addReason("unreviewed-oracle-profile", "local-component", `oracle:${branchKind}`, branch.controlKey);
        } else {
          oracleControls.set(control.controlKey, control);
        }
      }
    }
    if (oracle.tier === null) {
      addReason("missing-oracle-profile", "local-component", "oracle:tier");
    } else {
      const linkedControls = [...oracleControls.values()];
      const failureDomains = canonicalDomains(linkedControls.flatMap((control) => control.failureDomains));
      components.push({
        componentKey: "oracle",
        kind: "oracle",
        posture: oracle.tier,
        score: policy.control.oracleTierQuality[oracle.tier],
        binding: true,
        controlKeys: linkedControls.map((control) => control.controlKey).sort(compareText),
        failureDomains,
      });
      if (oracle.tier === "single-source-or-laggy" || oracle.tier === "opaque-or-unknown") {
        addStructuralFailure({
          kind: "weak-oracle-branch",
          severity: oracle.tier === "opaque-or-unknown" ? "critical" : "high",
          binding: true,
          reason: `Oracle control topology is ${oracle.tier}.`,
          materialSharePct: null,
          controlKeys: linkedControls.map((control) => control.controlKey),
          failureDomains,
        });
      }
      // Weak market branches below the deployment-materiality threshold do not
      // drive the material-only tier above, but stay visible as one non-binding
      // diagnostic (5-10% -> moderate@74 ceiling, <5% -> low). It carries a
      // single synthetic failure domain so it never trips the common-mode
      // multi-branch oracle cap, and its ceiling sits above a healthy composite.
      if (oracle.subMaterialWeakBand !== undefined) {
        addStructuralFailure({
          kind: "weak-oracle-branch",
          severity: oracle.subMaterialWeakBand,
          binding: true,
          reason: `Weak oracle branches below the materiality threshold contribute a ${oracle.subMaterialWeakBand} diagnostic.`,
          materialSharePct: null,
          controlKeys: [],
          failureDomains: [{ kind: "oracle-feed", key: `oracle:${args.facts.assetId}:sub-material-weak` }],
        });
      }
    }
  }

  const bridge = args.bridge;
  if (bridge.status.applicability.state === "not-applicable") {
    components.push({
      componentKey: "bridge:native",
      kind: "bridge",
      posture: "single-chain-or-native",
      score: policy.control.bridgeTierQuality["single-chain-or-native"],
      binding: true,
      controlKeys: [],
      failureDomains: [],
    });
  } else if (bridge.status.applicability.state === "unresolved") {
    addReason("runtime-bridge-materiality-unavailable", "deployment-control", "bridge");
  } else if (bridge.status.observationState !== "known") {
    addReason(
      bridge.status.observationState === "missing" ? "missing-bridge-routes" : "runtime-bridge-materiality-unavailable",
      "deployment-control",
      "bridge",
    );
  } else {
    const completeSubthresholdUnresolvedJoins = hasCompleteSubthresholdUnresolvedBridgeJoins(
      args.facts,
      controls,
      bridge.routes,
      materialShareThreshold,
      policy.materiality.commonModeShareThreshold,
    );
    const unresolvedBridgeShare =
      args.facts.supply.unknownRouteSupplyShare === null || args.facts.supply.unreviewedRouteSupplyShare === null
        ? null
        : Math.min(1, args.facts.supply.unknownRouteSupplyShare + args.facts.supply.unreviewedRouteSupplyShare);
    const unresolvedBridgeResidueBinds =
      unresolvedBridgeShare === null || (unresolvedBridgeShare > 0 && !completeSubthresholdUnresolvedJoins);
    const hasUnresolvedSupplyRows = args.facts.supply.selectedBridgeRoutes.some(
      (route) => route.reviewState !== "selected-reviewed",
    );
    if (bridge.routes.length === 0 && (unresolvedBridgeResidueBinds || !hasUnresolvedSupplyRows)) {
      addReason("missing-bridge-route-rows", "deployment-control", "bridge:routes");
    }
    const seenBridgeControls = new Set<string>();
    for (const route of [...bridge.routes].sort((left, right) => compareText(left.controlKey, right.controlKey))) {
      if (seenBridgeControls.has(route.controlKey)) throw new Error(`Duplicate v9 bridge control ${route.controlKey}`);
      seenBridgeControls.add(route.controlKey);
      const control = controlsByKey.get(route.controlKey);
      if (!control || !controlCanRepresent(control, "bridge")) {
        addReason("selected-bridge-route-missing", "deployment-control", "bridge:route", route.controlKey);
        continue;
      }
      if (!isControlEconomicallyRelevant(control)) continue;
      const binding = bindingByMateriality(control, materialShareThreshold);
      if (!isKnownRequired(control.status)) {
        if (binding) {
          addReason("selected-bridge-route-unresolved", "deployment-control", "bridge:route", route.controlKey);
        }
        continue;
      }
      if (control.economicLossScope === "deployment" && control.materialSupplyShare === null) {
        addReason(
          "runtime-bridge-materiality-unavailable",
          "deployment-control",
          "bridge:route:materiality",
          route.controlKey,
        );
      }
      const selectedSupplyRoute = args.facts.supply.selectedBridgeRoutes.find(
        (supplyRoute) => supplyRoute.deploymentRouteKey === control.deploymentKey,
      );
      if (args.facts.supply.selectedBridgeRoutes.length > 0 && !selectedSupplyRoute && binding) {
        addReason("selected-bridge-route-missing", "deployment-control", "bridge:route:supply", route.controlKey);
      }
      if (selectedSupplyRoute?.reviewState === "selected-unresolved" && binding) {
        addReason("selected-bridge-route-unresolved", "deployment-control", "bridge:route:supply", route.controlKey);
      }
      if (
        selectedSupplyRoute?.reviewState === "unmatched" &&
        selectedSupplyRoute.supplyShare >= materialShareThreshold
      ) {
        addReason("material-bridge-supply-unmatched", "deployment-control", "bridge:supply", route.controlKey);
      }
      components.push({
        componentKey: `bridge:${control.deploymentKey}:${control.controlKey}`,
        kind: "bridge",
        posture: route.tier,
        score: policy.control.bridgeTierQuality[route.tier],
        binding,
        controlKeys: [control.controlKey],
        failureDomains: canonicalDomains(control.failureDomains),
      });
      if (route.tier === "external-lock-mint" || route.tier === "opaque-or-unknown") {
        addStructuralFailure({
          kind: binding ? "material-bridge" : "peripheral-bridge",
          severity: materialBridgeSeverity(route.tier, control.materialSupplyShare),
          binding,
          reason: `Bridge control topology is ${route.tier}.`,
          materialSharePct: control.materialSupplyShare === null ? null : control.materialSupplyShare * 100,
          controlKeys: [control.controlKey],
          failureDomains: control.failureDomains,
        });
      }
    }
    const unknownBridgeShare = Math.min(
      1,
      (args.facts.supply.unknownRouteSupplyShare ?? 0) + (args.facts.supply.unreviewedRouteSupplyShare ?? 0),
    );
    if (unknownBridgeShare > 0 && !completeSubthresholdUnresolvedJoins) {
      addReason("material-bridge-supply-unmatched", "deployment-control", "bridge:supply");
    }
  }

  // An unverified review leaves its section with reasons but no component.
  // When the policy treats those reasons as bounded (non-critical), the
  // section scores at the bounded-unknown control quality instead of nulling
  // the pillar; the reason-coded ceiling still bounds the final score. Under
  // critical reasons the pillar stays null regardless of these components.
  const boundedFallbacks = [
    { kind: "mint", componentKey: "mint", posture: "unknown" },
    { kind: "oracle", componentKey: "oracle", posture: "opaque-or-unknown" },
    { kind: "bridge", componentKey: "bridge:unverified", posture: "opaque-or-unknown" },
  ] as const;
  for (const fallback of boundedFallbacks) {
    if (components.some((component) => component.kind === fallback.kind)) continue;
    // Aggregate inventory reasons are section-neutral. A control-specific
    // reason may authorize only the section that control can represent.
    const verifiedGapControlKeys = new Set<string>();
    let hasBindingGap = false;
    let hasUnverifiedGap = false;
    for (const reason of reasons.values()) {
      const sectionMatch = reason.path === fallback.kind || reason.path.startsWith(`${fallback.kind}:`);
      const reasonControl = reason.controlKey === null ? undefined : controlsByKey.get(reason.controlKey);
      const controlMatch = reasonControl !== undefined && controlFallbackKind(reasonControl) === fallback.kind;
      if (!sectionMatch && !controlMatch) continue;
      hasBindingGap = true;
      // LEVER 5 (2026-07-21): a gap raised by a statically-verified control row
      // (its authority is reviewed; only an adjacent fact such as exposure share
      // or the mechanism review is missing) can be graded on that same row. A
      // section-level gap, or one behind an unverified row, is a genuine unknown
      // and holds the neutral default — this keeps assets whose control facts are
      // NOT verified pinned at the bounded-unknown quality.
      if (reasonControl !== undefined && isStaticallyVerifiedControl(reasonControl)) {
        verifiedGapControlKeys.add(reasonControl.controlKey);
      } else {
        hasUnverifiedGap = true;
      }
    }
    if (!hasBindingGap) continue;
    // Grade on the verified rows' own authority only when every authorizing gap
    // was raised by such a row (condition i: same-row, not asset-generic). The
    // grade may land above OR below the 45 default (condition ii).
    const gradeable = !hasUnverifiedGap && verifiedGapControlKeys.size > 0;
    const gradedControlKeys = uniqueSorted([...verifiedGapControlKeys]);
    const score = gradeable
      ? Math.min(
          ...gradedControlKeys.map((controlKey) =>
            gradeVerifiedControlAuthority(controlsByKey.get(controlKey)!, policy.control),
          ),
        )
      : policy.control.boundedUnknownQuality;
    components.push({
      componentKey: fallback.componentKey,
      kind: fallback.kind,
      posture: fallback.posture,
      score,
      binding: true,
      controlKeys: gradeable ? gradedControlKeys : [],
      failureDomains: [],
    });
  }

  const normalizedReasons = [...reasons.values()].sort(
    (left, right) =>
      compareText(left.code, right.code) ||
      compareText(left.path, right.path) ||
      compareText(left.controlKey ?? "", right.controlKey ?? ""),
  );
  assertV9ReasonCodesRegistered(
    args.policy,
    normalizedReasons.map((reason) => reason.code),
  );
  const normalizedStructuralFailures = [...structuralFailures.values()].sort(
    (left, right) =>
      compareText(left.kind, right.kind) || compareText(left.controlKeys.join("+"), right.controlKeys.join("+")),
  );
  const scopedDeploymentControlKeys = new Set(
    normalizedStructuralFailures
      .filter((failure) => failure.binding && failure.materialSharePct !== null)
      .flatMap((failure) =>
        failure.controlKeys.filter((controlKey) => {
          const control = controlsByKey.get(controlKey);
          return control?.economicLossScope === "deployment" && control.materialSupplyShare !== null;
        }),
      ),
  );
  const normalizedComponents = components
    .map((component) =>
      component.binding &&
      component.controlKeys.length > 0 &&
      component.controlKeys.every((controlKey) => scopedDeploymentControlKeys.has(controlKey))
        ? { ...component, binding: false }
        : component,
    )
    .sort((left, right) => compareText(left.componentKey, right.componentKey));
  const bindingControlFailureDomains = controls
    .filter(isControlEconomicallyRelevant)
    .filter((control) => isKnownRequired(control.status))
    .filter((control) => bindingByMateriality(control, materialShareThreshold))
    .flatMap((control) => control.failureDomains);
  const failureDomains = canonicalDomains([
    ...bindingControlFailureDomains,
    ...normalizedComponents.filter((component) => component.binding).flatMap((component) => component.failureDomains),
    ...normalizedStructuralFailures.filter((failure) => failure.binding).flatMap((failure) => failure.failureDomains),
  ]);
  const critical = normalizedReasons.some((reason) => reason.critical);
  const bindingScores = normalizedComponents
    .filter((component) => component.binding)
    .map((component) => component.score);
  const score = critical || bindingScores.length === 0 ? null : Math.min(...bindingScores);

  return {
    score,
    state: score === null ? "not-rated" : "rated",
    components: normalizedComponents,
    reasons: normalizedReasons,
    structuralFailures: normalizedStructuralFailures,
    failureDomains,
  };
}

export function evaluateV9EconomicControlAssetFacts(
  asset: V9EconomicControlAssetSource,
  review: V9EconomicControlReviewExtension,
  policy: V9ValidatedPolicyEnvelope,
): V9EconomicControlResult {
  return evaluateV9EconomicControl(projectV9EconomicControlEvaluation(asset, review, policy));
}
