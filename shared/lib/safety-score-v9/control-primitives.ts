import type {
  V9AssetFactsBase,
  V9DeploymentControlFactV2,
  V9EconomicControlReviewV2,
  V9FactStatusV2,
  V9FailureDomainRef,
  V1005CompiledVotingControl,
  V1005ProcessDiagnostic,
  V1005AssetIssuanceFacts,
} from "../../types/safety-score-v9-facts";
import type { V9FactGapV3 } from "../../types/safety-score-v9-facts";
import type { V9EvidenceCause, V9ScoringDisposition } from "../../types/safety-score-v9-causes";
import type { BridgeRouteRiskTier, OracleRiskTier } from "../../types/core";
import type {
  V9ReasonCode,
  V9Severity,
  V9StructuralSignalKind,
  V9ValidatedPolicyEnvelope,
  V9MethodologySemantic,
} from "../../types/safety-score-v9";
import { normalizeDeploymentId } from "../../types/deployment-id";
import { V9_EMPTY_ARRAY } from "../../types/safety-score-v9-immutable";
import { sortV1005ProcessDiagnostics } from "./control-scope";

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
  | "unbounded-veto-guarded"
  | "unbounded-operationally-governed"
  | "unbounded-adverse"
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
  issuanceFacts?: V1005AssetIssuanceFacts;
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
  processDiagnostics?: readonly V1005ProcessDiagnostic[];
  issuanceFacts?: V1005AssetIssuanceFacts;
  reasons: readonly V9CompactControlReason[];
  structuralFailures: readonly V9ControlStructuralFailure[];
  failureDomains: readonly V9FailureDomainRef[];
}

/** D32 is shared by every favorable governance-process rung. */
function isV1005VotingControlQualified(
  voting: V1005CompiledVotingControl | undefined,
  policy: V9GovernedIssuancePolicy,
): boolean {
  if (!voting || voting.observationState !== "known" || !voting.qualified ||
      voting.affiliatedUnilateralRouteIds.length > policy.votingControl.maxAffiliatedUnilateralRouteCount ||
      voting.unknownAboveThresholdVoteOwnershipControllerIds.length > 0 ||
      voting.otherHolderVoteOperatorControllerIds.length > 0 ||
      !policy.votingControl.admissiblePrivilegedVoteCreation.includes(voting.privilegedVoteCreation as "none" | "governor-only") ||
      !policy.votingControl.admissibleForcedDelegation.includes(voting.forcedDelegation as "none" | "governor-only") ||
      voting.diagnostics.length > 0 || voting.censusReconciliations.length === 0) return false;
  return voting.censusReconciliations.every((row) => {
    if (row.state !== "reconciled" || row.unresolvedResidualCanPassAlone !== false ||
        row.accountedPowerRaw === null || row.residualUpperRaw === null ||
        row.totalVotingPowerRaw === null || row.pinnedVotingSupplyRaw === null) return false;
    const total = BigInt(row.totalVotingPowerRaw);
    return total > 0n && BigInt(row.accountedPowerRaw) + BigInt(row.residualUpperRaw) === total &&
      total === BigInt(row.pinnedVotingSupplyRaw);
  });
}

/** Referenced proof data cannot be replaced or supplemented by inline row evidence. */
function boundIssuanceFacts(control: V9DeploymentControlFactV2, facts?: V1005AssetIssuanceFacts): V1005AssetIssuanceFacts | undefined {
  return facts && control.issuanceFactsRef === facts.ref &&
    control.issuanceGovernance === undefined && control.issuanceProcess === undefined && control.processDiagnostics === undefined
    ? facts : undefined;
}

/** Exact rational representation of a finite nonnegative policy scalar. */
function decimalRatio(value: number): readonly [bigint, bigint] {
  const [mantissa, exponentText] = value.toString().split("e");
  const [whole, fraction = ""] = mantissa!.split(".");
  const exponent = Number(exponentText ?? 0) - fraction.length;
  const numerator = BigInt(whole! + fraction);
  return exponent >= 0 ? [numerator * 10n ** BigInt(exponent), 1n] : [numerator, 10n ** BigInt(-exponent)];
}

/** H admission reads only neutral compiled facts; numerical failures do not alter their coverage. */
export function isV9OperationallyGovernedIssuanceQualified(
  control: V9DeploymentControlFactV2,
  policy: V9MethodologySemantic,
  issuanceFacts?: V1005AssetIssuanceFacts,
): { qualified: boolean; diagnostics: readonly V1005ProcessDiagnostic[] } {
  const referenced = control.issuanceFactsRef !== undefined;
  const shared = referenced ? boundIssuanceFacts(control, issuanceFacts) : undefined;
  const process = referenced ? shared?.process : control.issuanceProcess;
  if (!process) return { qualified: false, diagnostics: [] };
  const diagnostics: V1005ProcessDiagnostic[] = [];
  const controlRef = normalizeDeploymentId(control.authority?.authorityKey ?? "") || null;
  const fail = (code: V1005ProcessDiagnostic["code"], gate: V1005ProcessDiagnostic["gate"], field: string) => {
    diagnostics.push({ code, gate, field, controlRef, pathId: null, classId: null, memberRef: null,
      evidenceRefIds: shared ? [] : process.evidenceRefIds,
      ...(shared ? { issuanceFactsRef: shared.ref } : {}) });
  };
  const governance = referenced ? shared?.governance : control.issuanceGovernance;
  const governed = policy.control.governedIssuance;
  const screens = governed.operationalFlow;
  if (governance?.decisionRule !== "affirmative-vote") {
    fail("operational-decision-rule-inadmissible", "H0", "issuanceGovernance.decisionRule");
  }
  if (control.incidentState === "active") fail("active-incident", "H0", "incidentState");
  const semanticQuestionOpen = control.scopedQuestionFresh === true && control.scopedQuestionSubject !== "key-custody-independence";
  if (!isKnownRequired(control.status) || semanticQuestionOpen) {
    fail(semanticQuestionOpen ? "scoped-question-open" : "review-incomplete", "H0", "status");
  }
  if (control.controlKind === "bridge" || control.economicLossScope === "unknown" ||
      (control.capSemantics.kind !== "unbounded" && control.claimImpairment !== "unbounded") ||
      process.coverage !== "complete" || process.authorityCoverage !== "complete" ||
      process.executionCoverage !== "complete" || !process.economicReachClosed || !process.inventoryComplete ||
      process.memberCount <= 0 || process.matchedMemberCount !== process.memberCount || process.unknownMemberCount !== 0 ||
      process.discretionaryPathCount <= 0 || process.operationalPathCount <= 0 ||
      process.formulaPathCount + process.keeperInitialPathCount + process.keeperRecurringPathCount +
        process.otherOperationalPathCount !== process.operationalPathCount ||
      !Number.isSafeInteger(process.fundedKeeperRecurringPathCount) || process.fundedKeeperRecurringPathCount < 0 ||
      process.fundedKeeperRecurringPathCount > process.keeperRecurringPathCount ||
      process.nonGovernorDiscretionaryPathKeys.length > 0 || process.unclassifiedExpansionPathKeys.length > 0 ||
      process.unknownRecipientPathKeys.length > 0 || process.diagnostics.some((diagnostic) => diagnostic.code !== "external-accounting-trust")) {
    fail("process-certificate-unavailable", "H0", "issuanceProcess.coverage");
  }
  if (!governance?.enumerable || !governed.admissibleVotingPower.includes(governance.votingPower as "lock-escrowed" | "past-block-checkpoint")) {
    fail("voting-power-inadmissible", "H1", "issuanceGovernance.votingPower");
  }
  for (const voting of [governance?.votingControl, process.votingControl]) {
    if (isV1005VotingControlQualified(voting, governed)) continue;
    if (voting?.diagnostics.length) {
      diagnostics.push(...voting.diagnostics);
    } else if (voting?.affiliatedUnilateralRouteIds.length) {
      fail("voting-affiliated-unilateral", "D32", "votingControl.affiliatedUnilateralRouteIds");
    } else if (voting?.otherHolderVoteOperatorControllerIds.length) {
      fail("voting-other-holder-operator", "D32", "votingControl.otherHolderVoteOperatorControllerIds");
    } else if (voting?.unknownAboveThresholdVoteOwnershipControllerIds.length) {
      fail("voting-provenance-unknown", "D32", "votingControl.unknownAboveThresholdVoteOwnershipControllerIds");
    } else if (voting?.privilegedVoteCreation === "independent" || voting?.forcedDelegation === "independent") {
      fail("voting-privilege-independent", "D32", "votingControl.votingPrivilege");
    } else if (voting?.censusReconciliations.some((row) => row.state === "unreconciled" ||
        (row.accountedPowerRaw !== null && row.residualUpperRaw !== null && row.totalVotingPowerRaw !== null &&
          BigInt(row.accountedPowerRaw) + BigInt(row.residualUpperRaw) !== BigInt(row.totalVotingPowerRaw)))) {
      fail("voting-census-unreconciled", "D32", "votingControl.censusReconciliations");
    } else {
      fail("voting-control-unproved", "D32", "votingControl");
    }
  }
  for (const field of ["minDiscretionaryPublicDelaySec", "minEnvelopeRaisePublicDelaySec"] as const) {
    if (field === "minEnvelopeRaisePublicDelaySec" && process.envelopeTransitionPathCount === 0) continue;
    const delay = process[field];
    if (delay === null) fail("delay-unproved", "H1", field);
    else if (delay < governed.minUnavoidableDelaySec) fail("delay-too-short", "H1", field);
  }
  if (!process.formulaQualified) fail("formula-principal-unproved", "H2", "formulaQualified");
  if (!process.keeperQualified) fail("keeper-activity-unproved", "H2", "keeperQualified");
  if (!process.otherClassesQualified) fail("economic-reach-unclosed", "H4", "otherClassesQualified");
  if (process.minOperationalExerciseDelaySec === null) fail("delay-unproved", "H2", "minOperationalExerciseDelaySec");
  const maximum = (field: "maxAnnualInterestGrowthPpm" | "maxKeeperProportionalRewardPpm", bound: number) => {
    const measured = process[field];
    if (measured === null) fail("operational-cap-unproved", "H2", field);
    else if (measured > bound) fail("operational-screen-failed", "H2", field);
  };
  if (process.formulaPathCount > 0) maximum("maxAnnualInterestGrowthPpm", screens.maxAnnualOperationalRatePpm);
  const keeperCount = process.keeperInitialPathCount + process.keeperRecurringPathCount;
  const basis = process.keeperSupplyScreenBasis;
  if (process.fundedKeeperRecurringPathCount === 0 &&
      ((process.maxKeeperRepeatRewardSupplyPpmPer86400Sec !== null && process.maxKeeperRepeatRewardSupplyPpmPer86400Sec !== 0) ||
        (basis?.maxRepeatRewardRawPer86400Sec !== null && basis?.maxRepeatRewardRawPer86400Sec !== undefined &&
          BigInt(basis.maxRepeatRewardRawPer86400Sec) > 0n))) {
    fail("process-certificate-unavailable", "H0", "fundedKeeperRecurringPathCount");
  }
  if (keeperCount > 0) {
    maximum("maxKeeperProportionalRewardPpm", screens.maxKeeperProportionalRewardPpm);
    if (!basis || basis.nativeSupplyRaw === null || BigInt(basis.nativeSupplyRaw) <= 0n ||
        basis.maxFixedRewardRaw === null || process.maxKeeperFixedRewardSupplyPpm === null) {
      fail("operational-cap-unproved", "H2", "maxKeeperFixedRewardSupplyPpm");
    } else {
      const [numerator, denominator] = decimalRatio(screens.maxKeeperFixedRewardSupplyPpm);
      if (BigInt(basis.maxFixedRewardRaw) * 1_000_000n * denominator > BigInt(basis.nativeSupplyRaw) * numerator) {
        fail("operational-screen-failed", "H2", "maxKeeperFixedRewardSupplyPpm");
      }
    }
  }
  if (process.fundedKeeperRecurringPathCount !== 0) {
    const interval = process.minKeeperRecurringIntervalSec;
    if (interval === null) fail("operational-cap-unproved", "H2", "minKeeperRecurringIntervalSec");
    else if (interval < screens.minKeeperRepeatSec) fail("operational-screen-failed", "H2", "minKeeperRecurringIntervalSec");
  }
  const annual = process.formulaPathCount > 0 ? process.maxAnnualInterestGrowthPpm : 0;
  const recurring = process.keeperRecurringPathCount > 0;
  if (governed.minUnavoidableDelaySec > screens.annualWindowSec) {
    fail("aggregate-flow-unproved", "H3", "operationalExposurePpm");
  } else if (annual === null || (recurring && (!basis || basis.nativeSupplyRaw === null ||
      BigInt(basis.nativeSupplyRaw) <= 0n || basis.maxRepeatRewardRawPer86400Sec === null ||
      process.maxKeeperRepeatRewardSupplyPpmPer86400Sec === null))) {
    fail("aggregate-flow-unproved", "H3", "operationalExposurePpm");
  } else {
    const ceilRatio = (n: bigint, d: bigint) => (n + d - 1n) / d;
    const window = BigInt(governed.minUnavoidableDelaySec);
    const interest = ceilRatio(BigInt(annual) * window, BigInt(screens.annualWindowSec));
    const repeatPpm = recurring ? ceilRatio(BigInt(basis!.maxRepeatRewardRawPer86400Sec!) * 1_000_000n,
      BigInt(basis!.nativeSupplyRaw!)) : 0n;
    const repeat = ceilRatio(repeatPpm * window, BigInt(screens.keeperWindowSec));
    const [capNumerator, capDenominator] = decimalRatio(policy.backing.structural.severityShares.moderate);
    if ((interest + repeat) * capDenominator > capNumerator * 1_000_000n) {
      fail("operational-screen-failed", "H3", "operationalExposurePpm");
    }
  }
  return { qualified: diagnostics.length === 0, diagnostics: sortV1005ProcessDiagnostics(diagnostics) };
}
/** Admit only complete, delayed, flash-resistant and enumerable governance issuance. */
export function isV9GovernedIssuanceQualified(
  control: V9DeploymentControlFactV2,
  policy: V9GovernedIssuancePolicy,
  issuanceFacts?: V1005AssetIssuanceFacts,
): boolean {
  const governance = control.issuanceFactsRef === undefined
    ? control.issuanceGovernance : boundIssuanceFacts(control, issuanceFacts)?.governance;
  const admissibleVotingPower: readonly string[] = policy.admissibleVotingPower;
  return governance !== undefined &&
    governance.decisionRule === "affirmative-vote" &&
    isV1005VotingControlQualified(governance.votingControl, policy) &&
    governance.coverage === "complete" &&
    governance.incompleteReasons.length === 0 &&
    governance.nonGovernorUnboundedPathKeys.length === 0 &&
    governance.minUnavoidableDelaySec !== null &&
    governance.minUnavoidableDelaySec >= policy.minUnavoidableDelaySec &&
    admissibleVotingPower.includes(governance.votingPower) &&
    governance.enumerable;
}

/** D30: admit only unavoidable, flash-resistant minority vetoes on every issuer admission. */
export function isV9VetoGuardedIssuanceQualified(
  control: V9DeploymentControlFactV2,
  policy: V9GovernedIssuancePolicy,
  issuanceFacts?: V1005AssetIssuanceFacts,
): boolean {
  const governance = control.issuanceFactsRef === undefined
    ? control.issuanceGovernance : boundIssuanceFacts(control, issuanceFacts)?.governance;
  const vetoPolicy = policy.minorityVeto;
  const admissibleVotingPower: readonly string[] = vetoPolicy.admissibleVotingPower;
  const admissibleOverride: readonly string[] = vetoPolicy.admissibleOverride;
  return governance !== undefined &&
    governance.decisionRule === "minority-veto" &&
    isV1005VotingControlQualified(governance.votingControl, policy) &&
    governance.coverage === "complete" &&
    governance.incompleteReasons.length === 0 &&
    governance.nonGovernorUnboundedPathKeys.length === 0 &&
    governance.minUnavoidableDelaySec !== null &&
    governance.minUnavoidableDelaySec >= vetoPolicy.minVetoWindowSec &&
    governance.vetoQuorumBps !== null &&
    governance.vetoQuorumBps <= vetoPolicy.maxVetoQuorumBps &&
    admissibleVotingPower.includes(governance.votingPower) &&
    governance.vetoOverride !== null &&
    admissibleOverride.includes(governance.vetoOverride) &&
    governance.enumerable;
}

/** Derive posture from recorded semantics; aggregate review confidence cannot clear an adverse fact. */
export function deriveV9MintPosture(
  control: V9DeploymentControlFactV2 | null,
  mint: V9MintMechanismReview,
  immutableMechanism: boolean,
  policy: V9MethodologySemantic,
  issuanceFacts?: V1005AssetIssuanceFacts,
): V9MintPosture {
  const governedPolicy = policy.control.governedIssuance;
  if (control?.incidentState === "active") return "compromised";
  if (!control) return immutableMechanism ? "none-resolved" : "unknown";
  if (control.economicLossScope === "unknown") return "unknown";
  if (control.capSemantics.kind === "unbounded" || control.claimImpairment === "unbounded") {
    const reconciled = mint.reconciliation === "continuous" || mint.reconciliation === "periodic";
    if (reconciled && (mint.supervision === "prudential" || mint.supervision === "attestation-only")) {
      return "unbounded-reconciled";
    }
    // D30 minority-veto due process outranks D29 affirmative governance, but
    // neither process rung displaces independently graded reconciliation.
    if (isV9VetoGuardedIssuanceQualified(control, governedPolicy, issuanceFacts)) return "unbounded-veto-guarded";
    if (isV9GovernedIssuanceQualified(control, governedPolicy, issuanceFacts)) return "unbounded-governed";
    if (isV9OperationallyGovernedIssuanceQualified(control, policy, issuanceFacts).qualified) return "unbounded-operationally-governed";
    if (reconciled || mint.supervision === "prudential") return "unbounded-reconciled";
    // Reconciliation availability does not change known adverse economics.
    // Internal-ledger disclosure can resolve a process question, not earn a rung.
    return "unbounded-adverse";
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
