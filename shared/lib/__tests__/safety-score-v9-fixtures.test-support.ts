import type {
  V9DeploymentControlFactV2,
  V9FactStatusV2,
  V9FailureDomainRef,
  V1005CompiledVotingControl,
  V1005IssuanceProcess,
  V1005ProcessDiagnostic,
} from "../../types/safety-score-v9-facts";
import {
  type EvaluateV9EconomicControlArgs,
  type V9BridgeControlReview,
  type V9EconomicControlAssetFacts,
  type V9MintMechanismReview,
  type V9OracleControlReview,
} from "../safety-score-v9/control-primitives";
import { V9_CANDIDATE_POLICY_V1 } from "../safety-score-v9/policy";
import { SafetyScoreV9IssuanceSummarySchema, type SafetyScoreV9IssuanceSummary } from "../../types/safety-score-v9-public-breakdowns";

export function requiredKnown(rule = "fixture.required"): V9FactStatusV2 {
  return {
    applicability: { state: "required", policyRuleId: rule, rationale: null, gapId: null },
    observationState: "known",
    evidenceRefIds: [`evidence:${rule}`],
    gapIds: [],
  };
}

export function notApplicable(rule = "fixture.not-applicable"): V9FactStatusV2 {
  return {
    applicability: {
      state: "not-applicable",
      policyRuleId: rule,
      rationale: "Reviewed as not applicable.",
      gapId: null,
    },
    observationState: "known",
    evidenceRefIds: [],
    gapIds: [],
  };
}

export function stale(rule = "fixture.stale"): V9FactStatusV2 {
  return {
    applicability: { state: "required", policyRuleId: rule, rationale: null, gapId: null },
    observationState: "stale",
    evidenceRefIds: [`evidence:${rule}`],
    gapIds: [`gap:${rule}`],
  };
}

export function boundedUnknown(rule = "fixture.bounded-unknown"): V9FactStatusV2 {
  return {
    applicability: { state: "required", policyRuleId: rule, rationale: null, gapId: null },
    observationState: "bounded-unknown",
    evidenceRefIds: [`evidence:${rule}`],
    gapIds: [`gap:${rule}`],
  };
}

export function missing(rule = "fixture.missing"): V9FactStatusV2 {
  return {
    applicability: { state: "required", policyRuleId: rule, rationale: null, gapId: null },
    observationState: "missing",
    evidenceRefIds: [],
    gapIds: [`gap:${rule}`],
  };
}

function failureDomain(kind: V9FailureDomainRef["kind"], key: string): V9FailureDomainRef {
  return { kind, key };
}

export function makeDeploymentControl(
  controlKey: string,
  controlKind: V9DeploymentControlFactV2["controlKind"],
  overrides: Partial<V9DeploymentControlFactV2> = {},
): V9DeploymentControlFactV2 {
  const domainKind = {
    mint: "mint-control",
    upgrade: "upgrade-control",
    custody: "reserve-custodian",
    oracle: "oracle-feed",
    bridge: "bridge-route",
    freeze: "upgrade-control",
    governance: "upgrade-control",
  } as const;
  const capability = {
    mint: "mint",
    upgrade: "upgrade",
    custody: "custody-transfer",
    oracle: "oracle-update",
    bridge: "bridge-mint",
    freeze: "freeze",
    governance: "parameter-change",
  } as const;
  return {
    controlKey,
    deploymentKey: `deployment:${controlKey}`,
    sourceGenerationId: "research:fixture",
    controlKind,
    scope: "global",
    status: requiredKnown(`control.${controlKey}`),
    capabilities: [capability[controlKind]],
    capSemantics:
      controlKind === "freeze"
        ? { kind: "not-applicable", bound: null }
        : { kind: "bounded", bound: { amount: 0.1, unit: "supply-fraction" } },
    claimImpairment: controlKind === "freeze" ? "none" : "bounded",
    economicLossScope: controlKind === "freeze" ? "access-only" : "global-claim",
    authority: {
      authorityKey: `authority:${controlKey}`,
      model: "multisig",
      threshold: { required: 2, total: 3 },
    },
    delaySec: 86_400,
    materialSupplyShare: null,
    keyCustody: "unknown",
    modulesOrGuards: "unknown",
    incidentState: "none",
    failureDomains: [failureDomain(domainKind[controlKind], controlKey)],
    ...overrides,
  };
}

export function makeEconomicControlFacts(
  controls: readonly V9DeploymentControlFactV2[] = [],
  overrides: Partial<V9EconomicControlAssetFacts> = {},
): V9EconomicControlAssetFacts {
  return {
    assetId: "fixture-asset",
    archetype: "fiat-cash",
    controlStatus: controls.length > 0 ? requiredKnown("controls") : notApplicable("controls"),
    controls,
    supply: {
      status: requiredKnown("supply"),
      selectedBridgeRoutes: [],
      selectedRouteSupplyShare: 1,
      unknownRouteSupplyShare: 0,
      unreviewedRouteSupplyShare: 0,
    },
    ...overrides,
  };
}
type SupplyPartition = V9EconomicControlAssetFacts["supply"];
type SupplyPartitionRouteInput = Omit<SupplyPartition["selectedBridgeRoutes"][number], "supplyUsd"> & {
  supplyUsd?: number;
};

export type SupplyPartitionOptions = {
  routes: readonly SupplyPartitionRouteInput[];
  status?: SupplyPartition["status"];
} & Partial<Omit<SupplyPartition, "status" | "selectedBridgeRoutes">>;

export function makeSupplyPartition({
  routes,
  status = requiredKnown("supply"),
  ...overrides
}: SupplyPartitionOptions): SupplyPartition {
  const selectedRouteSupplyShare = routes
    .filter((route) => route.reviewState === "selected-reviewed")
    .reduce((sum, route) => sum + route.supplyShare, 0);
  const unknownRouteSupplyShare = routes
    .filter((route) => route.reviewState === "unmatched")
    .reduce((sum, route) => sum + route.supplyShare, 0);
  const unreviewedRouteSupplyShare = routes
    .filter((route) => route.reviewState === "selected-unresolved")
    .reduce((sum, route) => sum + route.supplyShare, 0);

  return {
    status,
    selectedBridgeRoutes: routes.map((route) => ({
      ...route,
      supplyUsd: route.supplyUsd ?? route.supplyShare * 100,
    })),
    selectedRouteSupplyShare,
    unknownRouteSupplyShare,
    unreviewedRouteSupplyShare,
    ...overrides,
  };
}

export function noMintReview(): V9MintMechanismReview {
  return {
    status: notApplicable("mint"),
    controlKey: null,
    reconciliation: "not-applicable",
    supervision: "unknown",
    upgrade: { state: "not-applicable", controlKey: null },
  };
}

export function noOracleReview(): V9OracleControlReview {
  return { status: notApplicable("oracle"), tier: null, branches: [] };
}

export function noBridgeReview(): V9BridgeControlReview {
  return { status: notApplicable("bridge"), routes: [] };
}

export function makeReviewedMintInput(
  controlKey: string,
  overrides: Partial<V9MintMechanismReview> = {},
): V9MintMechanismReview {
  return {
    status: requiredKnown("mint"),
    controlKey,
    reconciliation: "not-applicable",
    supervision: "unknown",
    upgrade: { state: "immutable", controlKey: null },
    ...overrides,
  };
}

export function makeEconomicControlArgs(
  overrides: Partial<EvaluateV9EconomicControlArgs> = {},
): EvaluateV9EconomicControlArgs {
  return {
    policy: V9_CANDIDATE_POLICY_V1,
    facts: makeEconomicControlFacts(),
    mint: noMintReview(),
    oracle: noOracleReview(),
    bridge: noBridgeReview(),
    ...overrides,
  };
}

/** Modeled complete own-lock voting census; no claim about a deployed governor. */
export function makeCompiledVotingControl(overrides: Partial<V1005CompiledVotingControl> = {}): V1005CompiledVotingControl {
  return {
    observationState: "known", qualified: true, largestSingleControllerShareBps: 6000,
    affiliatedAggregateShareBps: 0, affiliatedUnilateralRouteIds: [],
    unknownAboveThresholdVoteOwnershipControllerIds: [], otherHolderVoteOperatorControllerIds: [],
    privilegedVoteCreation: "none", forcedDelegation: "none",
    censusReconciliations: [{
      routeId: "own-lock-route", state: "reconciled", accountedPowerRaw: "100",
      residualUpperRaw: "0", totalVotingPowerRaw: "100", pinnedVotingSupplyRaw: "100",
      unresolvedResidualCanPassAlone: false, evidenceRefIds: ["pinned-votes"],
    }],
    diagnostics: [], ...overrides,
  };
}

/** Modeled neutral measurements at each H per-action boundary, not production evidence. */
export function makeOperationalIssuanceProcess(overrides: Partial<V1005IssuanceProcess> = {}): V1005IssuanceProcess {
  return {
    kind: "affirmative-operational-flow", coverage: "complete", authorityCoverage: "complete",
    executionCoverage: "complete", economicReachClosed: true, inventoryComplete: true,
    memberCount: 3, matchedMemberCount: 3, unknownMemberCount: 0, discretionaryPathCount: 1,
    operationalPathCount: 3, formulaPathCount: 1, keeperInitialPathCount: 1, keeperRecurringPathCount: 1,
    fundedKeeperRecurringPathCount: 1,
    envelopeTransitionPathCount: 1,
    otherOperationalPathCount: 0, nonGovernorDiscretionaryPathKeys: [], unclassifiedExpansionPathKeys: [],
    unknownRecipientPathKeys: [], minDiscretionaryPublicDelaySec: 172800, minEnvelopeRaisePublicDelaySec: 172800,
    minOperationalExerciseDelaySec: 0, formulaQualified: true, keeperQualified: true, otherClassesQualified: true,
    maxAnnualInterestGrowthPpm: 500000, maxKeeperProportionalRewardPpm: 1000,
    maxKeeperFixedRewardSupplyPpm: 10, minKeeperRecurringIntervalSec: 3600,
    maxKeeperRepeatRewardSupplyPpmPer86400Sec: 6896,
    keeperSupplyScreenBasis: { nativeSupplyRaw: "1000000", maxFixedRewardRaw: "10",
      maxRepeatRewardRawPer86400Sec: "6896", nativeUnits: "native" },
    votingControl: makeCompiledVotingControl(), diagnostics: [], evidenceRefIds: ["process-proof"],
    sourceGenerationId: "operational-flow-fixture", freshnessBudgetSec: 17280,
    observedAtSec: 1791107172, expiresAtSec: 1791124452, ...overrides,
  };
}

export function makePublishedProcessDiagnostic(
  diagnostic: V1005ProcessDiagnostic,
  overrides: Partial<SafetyScoreV9IssuanceSummary["diagnostics"][number]> = {},
): SafetyScoreV9IssuanceSummary["diagnostics"][number] {
  const evidenceRefIds = [...new Set(diagnostic.evidenceRefIds)].sort();
  return {
    code: diagnostic.code, gate: diagnostic.gate, classId: diagnostic.classId, field: diagnostic.field,
    count: 1, controlRefs: [diagnostic.controlRef],
    exemplars: [{ ...diagnostic, evidenceRefIds: evidenceRefIds.slice(0, 3), evidenceRefCount: evidenceRefIds.length }],
    ...overrides,
  };
}

export function makePublishedIssuanceSummary(
  overrides: Partial<V1005IssuanceProcess> = {},
  diagnostics: SafetyScoreV9IssuanceSummary["diagnostics"] = [],
): SafetyScoreV9IssuanceSummary {
  const process = makeOperationalIssuanceProcess(overrides);
  return {
    process: SafetyScoreV9IssuanceSummarySchema.shape.process.unwrap().strip().parse({
      ...process,
      nonGovernorDiscretionaryPathCount: process.nonGovernorDiscretionaryPathKeys.length,
      unclassifiedExpansionPathCount: process.unclassifiedExpansionPathKeys.length,
      unknownRecipientPathCount: process.unknownRecipientPathKeys.length,
      evidenceRefCount: process.evidenceRefIds.length,
      diagnosticCount: process.diagnostics.length,
    }),
    diagnostics,
  };
}
