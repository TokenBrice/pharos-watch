import type { V9DeploymentControlFactV2, V9FactGapV3, V1005AssetIssuanceFacts } from "../../types/safety-score-v9-facts";
import type { V9MethodologySemantic } from "../../types/safety-score-v9";
import {
  isV1005VotingControlQualified,
  isV9GovernedIssuanceQualified,
  isV9VetoGuardedIssuanceQualified,
  resolveV9StatusCauses,
  type V9MintMechanismReview,
} from "./control-primitives";
import { economicControlExecutionPaths, effectiveAuthoritySignatureRequirement } from "./control-scope";
import { unknownQuality } from "./policy";

/** Resolved failures share the realized-holder-loss clock; active failures do not decay. */
export function applyResolvedControlIncidentHistory(
  score: number,
  control: V9DeploymentControlFactV2 | null,
  ageDays: number | undefined,
  policy: V9MethodologySemantic,
): number {
  if (control?.incidentState === "active") return policy.control.authorityLadder.compromised;
  if (control?.incidentState !== "resolved" && (control !== null || ageDays === undefined)) return score;
  const initialLimit = policy.control.resolvedIncidentHistory.initialLimit;
  const { holdDays, recoveryDays } = policy.formula.realizedHolderLoss;
  const limit = Math.min(100, initialLimit +
    (100 - initialLimit) * Math.max(0, (ageDays ?? 0) - holdDays) / recoveryDays);
  return Math.min(score, limit);
}

/** One scorer for complete and partial reviews, regardless of the path's role. */
export function gradeEconomicControlAuthority(
  control: V9DeploymentControlFactV2 | null,
  mint: V9MintMechanismReview,
  policy: V9MethodologySemantic,
  gaps: readonly V9FactGapV3[] = [],
  issuanceFacts?: V1005AssetIssuanceFacts,
  assetId?: string,
): number {
  const ladder = policy.control.authorityLadder;
  if (control?.incidentState === "active") return ladder.compromised;
  const topologyCause = resolveV9StatusCauses(control
    ? [control.factorStatuses?.authority, control.factorStatuses?.topology, control.factorStatuses?.multisigTopology,
        control.authority?.model === "contract" ? control.factorStatuses?.executionScope : undefined,
        control.authority === null || control.authority.model === "unknown" ? control.status : undefined]
    : [mint.status], gaps).cause;
  let score = topologyCause === "D" ? ladder.opaqueController : unknownQuality("control", topologyCause, policy);
  if (control === null) return Math.min(score, ladder.maxComponentQuality);

  const authority = control.authority;
  const signatures = effectiveAuthoritySignatureRequirement(authority);
  const governance = control.issuanceFactsRef === undefined ? control.issuanceGovernance
    : issuanceFacts?.ref === control.issuanceFactsRef && control.issuanceGovernance === undefined &&
        control.issuanceProcess === undefined && control.processDiagnostics === undefined ? issuanceFacts.governance : undefined;
  const affirmative = governance?.decisionRule === "affirmative-vote" && governance.enumerable &&
    governance.coverage === "complete" && governance.incompleteReasons.length === 0 &&
    governance.nonGovernorUnboundedPathKeys.length === 0 &&
    isV1005VotingControlQualified(governance.votingControl, policy.control.governedIssuance);
  const governedDelay = isV9GovernedIssuanceQualified(control, policy.control.governedIssuance, issuanceFacts) ||
    isV9VetoGuardedIssuanceQualified(control, policy.control.governedIssuance, issuanceFacts);
  const hasReviewedScope = control.executionScopeContributors
    ? control.executionScopeContributors.every((entry) => entry.scope !== undefined)
    : control.executionScope !== undefined;
  const relevantPaths = economicControlExecutionPaths(control, assetId);
  // Only a complete execution inventory can establish an unavoidable delay.
  const delayed = control.executionScopeComplete === true && relevantPaths.length > 0 &&
    control.delaySec !== null && control.delaySec > 0 &&
    relevantPaths.every((path) => path.unavoidableDelaySec !== null && path.unavoidableDelaySec > 0);
  const noPower = authority?.model === "none" && control.claimImpairment === "none" &&
    control.capSemantics.kind === "not-applicable" && control.executionScopeComplete === true &&
    hasReviewedScope && relevantPaths.every((path) => path.claimImpairment === "none" &&
      path.capSemantics.kind === "not-applicable" && path.upgradeRefs.length === 0 && path.bypassRefs.length === 0);
  if (noPower) score = ladder.immutableNoPower;
  else if (signatures === 1) score = ladder.singleSigner;
  else if (governedDelay) score = ladder.governanceTimelock;
  else if (authority?.model === "multisig" && signatures !== null && signatures > 1) {
    score = delayed ? ladder.quorumTimelock : ladder.quorum;
  } else if (affirmative) score = ladder.quorum;

  // All reachable economic paths, including upgrade/allocator bypasses, must
  // preserve the bound. A missing inventory or raiseable cap earns no credit.
  const bounded = control.capSemantics.kind === "bounded" && control.capSemantics.bound !== null &&
    control.claimImpairment !== "unknown" && control.claimImpairment !== "unbounded" &&
    control.executionScopeComplete === true && hasReviewedScope && relevantPaths.length > 0 && relevantPaths.every((path) =>
      path.claimImpairment === "none" || (path.claimImpairment === "bounded" &&
        path.capSemantics.kind === "bounded" && path.capSemantics.bound !== null));
  if (bounded) score += ladder.economicBoundCredit;
  const reconciliation = mint.reconciliation === "continuous" || mint.reconciliation === "periodic"
    ? ladder.reconciliationCredit : 0;
  const supervision = mint.supervision === "prudential" ? ladder.prudentialSupervisionCredit
    : mint.supervision === "attestation-only" ? ladder.attestationCredit : 0;
  return Math.min(ladder.maxComponentQuality, score + Math.min(ladder.maximumAssuranceCredit, reconciliation + supervision));
}
