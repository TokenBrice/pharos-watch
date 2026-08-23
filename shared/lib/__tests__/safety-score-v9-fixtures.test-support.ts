import type {
  V9DeploymentControlFactV2,
  V9FactStatusV2,
  V9FailureDomainRef,
} from "../../types/safety-score-v9-facts";

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
