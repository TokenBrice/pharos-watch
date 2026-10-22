import type { V9DeploymentControlFactV2, V9FactStatusV2, V1005ProcessDiagnostic } from "../../types/safety-score-v9-facts";
import type {
  V9ReasonCode,
  V9ValidatedPolicyEnvelope,
} from "../../types/safety-score-v9";
import { V9_NEUTRAL_CONTROL_SCORE } from "../../types/safety-score-v9-public-facts";
import {
  assertV9ReasonCodesRegistered,
  assertV9ValidatedPolicyEnvelope,
  resolveV9ReasonTreatment,
  unknownQuality,
} from "./policy";
import { v9StructuralSignalSharePct } from "./backing-primitives";
import { canonicalDomains, compareText, domainKey, uniqueSorted } from "./primitives";
import { isUnboundedMintPosture } from "./mint-posture";
import {
  controlFallbackKind,
  evaluateV9SubthresholdUnresolvedBridgeJoins,
  materialBridgeSeverity,
  provenNullShareDeploymentBound,
  unresolvedDeploymentCohort,
  providerRowExclusionShares,
} from "./control-bridge-join";
import {
  applyResolvedControlIncidentHistory,
  gradeEconomicControlAuthority,
} from "./control-mint-grade";
import {
  bindingByMateriality,
  controlCanRepresent,
  deriveV9MintPosture,
  hasFreshScopedQuestion,
  isControlEconomicallyRelevant,
  isKnownRequired,
  isV9OperationallyGovernedIssuanceQualified,
  mappedControlStatusReason,
  resolveV9StatusCauses,
  v9ScoringDisposition,
  type EvaluateV9EconomicControlArgs,
  type V9CompactControlReason,
  type V9ControlComponent,
  type V9ControlStructuralFailure,
  type V9EconomicControlResult,
  type V9OracleBranchKind,
  type V9OracleBranchReview,
} from "./control-primitives";

const ORACLE_BRANCHES = [
  "feed",
  "collateral-parameter",
  "liquidation",
  "backstop",
  "shutdown-bad-debt",
] as const satisfies readonly V9OracleBranchKind[];

type PendingControlComponent =
  Omit<V9ControlComponent, "cause" | "causeGapIds" | "scoringDisposition" | "effectiveScoringWeight"> &
  { causeStatuses?: readonly (V9FactStatusV2 | undefined)[] };

interface ControlEvaluationContext {
  args: EvaluateV9EconomicControlArgs;
  policy: V9ValidatedPolicyEnvelope["policy"]["semantic"];
  facts: EvaluateV9EconomicControlArgs["facts"];
  controlsByKey: ReadonlyMap<string, V9DeploymentControlFactV2>;
  components: PendingControlComponent[];
  reasons: ReadonlyMap<string, V9CompactControlReason>;
  materialShareThreshold: number;
  unresolvedFullCeilingShareThreshold: number;
  unresolvedCohortShare: number | null;
  unresolvedCohortControlKeys: ReadonlySet<string>;
  controlBinding: (control: V9DeploymentControlFactV2, bound?: number | null) => boolean;
  addReason: (code: V9ReasonCode, pathKind: V9CompactControlReason["pathKind"],
    path: string, controlKey?: string | null) => void;
  addStructuralFailure: (failure: V9ControlStructuralFailure) => void;
}

export function evaluateV9EconomicControl(args: EvaluateV9EconomicControlArgs): V9EconomicControlResult {
  assertV9ValidatedPolicyEnvelope(args.policy);
  const policy = args.policy.policy.semantic;
  const { facts: inputFacts } = args;
  const controls = [...inputFacts.controls].sort((left, right) => compareText(left.controlKey, right.controlKey));
  const facts = { ...inputFacts, controls, supply: { ...inputFacts.supply,
    selectedBridgeRoutes: [...inputFacts.supply.selectedBridgeRoutes].sort((left, right) =>
      compareText(left.deploymentRouteKey, right.deploymentRouteKey)),
  } };
  const materialShareThreshold = policy.materiality.deploymentMaterialSharePct / 100;
  const unresolvedFullCeilingShareThreshold = policy.materiality.unresolvedDeploymentFullCeilingSharePct / 100;
  const unresolvedCohort = unresolvedDeploymentCohort(facts, facts.controls);
  const controlBinding = (control: V9DeploymentControlFactV2, bound: number | null = null) =>
    bindingByMateriality(
      control,
      unresolvedCohort.share !== null && unresolvedCohort.share < unresolvedFullCeilingShareThreshold &&
        unresolvedCohort.controlKeys.has(control.controlKey) &&
        facts.supply.selectedBridgeRoutes.some(
          (row) => row.deploymentRouteKey === control.deploymentKey && row.reviewState !== "unmatched",
        )
        ? unresolvedFullCeilingShareThreshold
        : materialShareThreshold,
      bound,
    );
  const controlsByKey = new Map(controls.map((control) => [control.controlKey, control]));
  const issuanceFacts = facts.issuanceFacts;
  const processDiagnostics: V1005ProcessDiagnostic[] = controls.flatMap((control) =>
    isV9OperationallyGovernedIssuanceQualified(control, policy, issuanceFacts).diagnostics);
  const components: PendingControlComponent[] = [];
  const reasons = new Map<string, V9CompactControlReason>();
  const structuralFailures = new Map<string, V9ControlStructuralFailure>();

  const addReason = (
    code: V9ReasonCode,
    pathKind: V9CompactControlReason["pathKind"],
    path: string,
    controlKey: string | null = null,
  ) => {
    const status = controlKey !== null ? controlsByKey.get(controlKey)?.status
      : path.startsWith("mint") ? args.mint.status
        : path.startsWith("oracle") ? code === "oracle-topology-undisclosed"
          ? args.oracle.factorStatuses?.tier ?? args.oracle.status : args.oracle.status
          : path.startsWith("bridge") ? args.bridge.status : facts.controlStatus;
    const causal = resolveV9StatusCauses([status], facts.gaps);
    const resolved = resolveV9ReasonTreatment(args.policy, code, causal.cause ?? "U");
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

  const context: ControlEvaluationContext = {
    args, policy, facts, controlsByKey, components, reasons, materialShareThreshold,
    unresolvedFullCeilingShareThreshold, controlBinding, addReason, addStructuralFailure,
    unresolvedCohortShare: unresolvedCohort.share, unresolvedCohortControlKeys: unresolvedCohort.controlKeys,
  };
  evaluateControlInventory(context);
  evaluateMintPhase(context);
  evaluateOraclePhase(context);
  evaluateBridgePhase(context);
  appendControlFallbacks(context);

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
  const normalizedComponents = normalizeControlComponents(context, normalizedStructuralFailures);
  const bindingControlFailureDomains = controls
    .filter(isControlEconomicallyRelevant)
    .filter((control) => isKnownRequired(control.status))
    .filter((control) => controlBinding(control))
    .flatMap((control) => control.failureDomains);
  const failureDomains = canonicalDomains([
    ...bindingControlFailureDomains,
    ...normalizedComponents.filter((component) => component.binding).flatMap((component) => component.failureDomains),
    ...normalizedStructuralFailures.filter((failure) => failure.binding).flatMap((failure) => failure.failureDomains),
  ]);
  const critical = normalizedReasons.some((reason) => reason.critical);
  const inventoryCause = resolveV9StatusCauses(
    normalizedReasons.some((reason) => reason.code === "unresolved-control-identity" && reason.path === "controls")
      ? [facts.controlStatus] : [], facts.gaps,
  );
  const bindingScores = normalizedComponents
    .filter((component) => component.binding && component.score !== null)
    .map((component) => component.score!);
  const neutralWithoutBindingControls =
    normalizedComponents.length === 0 && args.oracle.status.applicability.state === "not-applicable";
  const score = critical
    ? null
    : bindingScores.length > 0
      ? Math.min(...bindingScores)
      : neutralWithoutBindingControls ? V9_NEUTRAL_CONTROL_SCORE : null;

  const excluded = normalizedComponents.filter((component) => component.score === null);
  const aggregationDisposition = score === null && excluded.length > 0 &&
    normalizedComponents.every((component) => component.effectiveScoringWeight === 0) ? "excluded-a-b" : "included";
  return {
    score,
    aggregationDisposition,
    causeGapIds: uniqueSorted([...inventoryCause.causeGapIds, ...normalizedComponents.flatMap((component) => component.causeGapIds)]),
    limitedEvidenceCauses: uniqueSorted([
      ...normalizedComponents.flatMap((component) =>
        component.binding && component.score === score && (component.cause === "C" || component.cause === "U")
          ? [component.cause] : []),
    ]) as ("C" | "U" | "D")[],
    supportedComponentKeys: normalizedComponents.filter((component) =>
      component.score !== null && component.effectiveScoringWeight > 0).map((component) => component.componentKey),
    state: score === null ? "not-rated" : "rated",
    oracleApplicability: args.oracle.status.applicability.state,
    components: normalizedComponents,
    controlFacts: controls,
    processDiagnostics,
    ...(issuanceFacts ? { issuanceFacts } : {}),
    reasons: normalizedReasons,
    structuralFailures: normalizedStructuralFailures,
    failureDomains,
  };
}

function evaluateControlInventory(context: ControlEvaluationContext): void {
  const { facts, unresolvedCohortShare, unresolvedCohortControlKeys, unresolvedFullCeilingShareThreshold, materialShareThreshold,
    controlBinding, addReason, addStructuralFailure } = context;
  const controls = facts.controls;
  if (facts.controlStatus.applicability.state === "unresolved") {
    addReason("unresolved-control-identity", "local-component", "controls");
  } else if (
    facts.controlStatus.applicability.state === "required" &&
    facts.controlStatus.observationState !== "known"
  ) {
    // An inventory demoted only by reviewer-scoped open questions inherits the
    // scoped ceiling; any unresolved control without one keeps the hard reason.
    const unresolvedControls = controls.filter(
      (control) =>
        isControlEconomicallyRelevant(control) &&
        control.status.applicability.state !== "not-applicable" &&
        !isKnownRequired(control.status),
    );
    // A measured unresolved deployment cohort owns its smooth exposure charge.
    // Its still-bounded inventory is evidence, not a second whole-coin ceiling.
    // Any unresolved control outside that exact cohort keeps the aggregate gap.
    const inventoryPricedByDeployment =
      unresolvedCohortShare !== null &&
      unresolvedCohortShare < unresolvedFullCeilingShareThreshold &&
      unresolvedControls.length > 0 &&
      controls.every((control) =>
        control.status.applicability.state === "not-applicable" ||
        isKnownRequired(control.status) ||
        unresolvedCohortControlKeys.has(control.controlKey));
    const allScoped = unresolvedControls.length > 0 && unresolvedControls.every(hasFreshScopedQuestion);
    if (!inventoryPricedByDeployment) {
      addReason(allScoped ? "scoped-control-question" : "unresolved-control-identity", "local-component", "controls");
    }
  }

  for (const control of controls) {
    if (!isControlEconomicallyRelevant(control)) continue;
    if (control.status.applicability.state === "not-applicable") continue;
    const nullShareBound = provenNullShareDeploymentBound(facts, control);
    const provenImmaterial = nullShareBound !== null && nullShareBound < materialShareThreshold;
    const binding = controlBinding(control, nullShareBound);
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
        materialSharePct:
          control.materialSupplyShare === null
            ? null
            : v9StructuralSignalSharePct(
                facts.assetId,
                "structuralSignals[*].materialSharePct",
                control.materialSupplyShare,
              ),
        controlKeys: [control.controlKey],
        failureDomains: control.failureDomains,
      });
    }
    if (
      control.economicLossScope === "deployment" &&
      control.materialSupplyShare === null &&
      control.scope !== "global" &&
      !provenImmaterial
    ) {
      addReason(
        control.controlKind === "bridge" ? "runtime-bridge-materiality-unavailable" : "unresolved-control-identity",
        pathKind,
        `${path}:materiality`,
        control.controlKey,
      );
    }
  }
}

function evaluateMintPhase(context: ControlEvaluationContext): void {
  const { args, policy, facts, controlsByKey, components, controlBinding, addReason, addStructuralFailure } = context;
  const mint = args.mint;
  if (mint.status.applicability.state === "unresolved") {
    addReason("mint-control-question", "local-component", "mint");
  } else if (mint.status.applicability.state !== "not-applicable" && mint.status.observationState !== "known") {
    addReason(mint.status.observationState === "missing" ? "missing-mint-authority" : "unresolved-mint-authority",
      "local-component", "mint", mint.controlKey);
  }
  if (mint.upgrade.state === "unknown" || (mint.upgrade.state === "reviewed" &&
      (mint.upgrade.controlKey === null || !controlsByKey.has(mint.upgrade.controlKey)))) {
    addReason("unknown-upgrade-authority", "local-component", "mint:upgrade", mint.upgrade.controlKey);
    components.push({
      componentKey: "mint:upgrade", kind: "mint", posture: "unknown",
      score: unknownQuality("control", resolveV9StatusCauses([mint.status, mint.factorStatuses?.upgrade], facts.gaps).cause, policy),
      binding: true, controlKeys: [], failureDomains: [], causeStatuses: [mint.status, mint.factorStatuses?.upgrade],
    });
    addStructuralFailure({
      kind: "unreviewed-upgrade", severity: "high", binding: true,
      reason: "Economically effective upgrade authority is not fully reviewed.",
      materialSharePct: null, controlKeys: [], failureDomains: [],
    });
  }
  // The mint review's anchor is not an exhaustive authority inventory. Upgrade,
  // custody, fee/accountant, allocator and parameter paths compete on the same
  // ladder even when minting itself is immutable or its wider review is partial.
  const economicControls = facts.controls.filter((control) =>
    control.status.applicability.state !== "not-applicable" && isControlEconomicallyRelevant(control));
  for (const control of economicControls) {
    if (control.controlKind !== "bridge" && control.capSemantics.kind === "unknown") {
      addReason("unknown-control-cap-authority", "local-component", "mint:cap", control.controlKey);
    }
    if (control.controlKind !== "bridge" && control.claimImpairment === "unknown") {
      addReason("unknown-control-mint-ability", "local-component", "mint:claim-impairment", control.controlKey);
    }
    if (control.authority?.model === "issuer-backend" && control.claimImpairment !== "none" &&
        (mint.reconciliation === "not-applicable" || mint.reconciliation === "unknown")) {
      addReason("mint-control-question", "local-component", "mint:reconciliation", control.controlKey);
    }
    const posture = deriveV9MintPosture(control, mint, false, policy, facts.issuanceFacts);
    const score = applyResolvedControlIncidentHistory(
      gradeEconomicControlAuthority(control, mint, policy, facts.gaps, facts.issuanceFacts, facts.assetId),
      control, args.resolvedIncidentAgeMonths, policy.control,
    );
    const binding = controlBinding(control, provenNullShareDeploymentBound(facts, control));
    components.push({
      componentKey: control.controlKind === "bridge" ? `mint:bridge:${control.controlKey}` : "mint",
      kind: "mint", posture, score, binding,
      controlKeys: [control.controlKey], failureDomains: canonicalDomains(control.failureDomains),
    });
    if (control.controlKind !== "bridge" && isUnboundedMintPosture(posture)) {
      addStructuralFailure({
        kind: "centralized-mint",
        severity: control.incidentState === "active" ? "critical" : "high",
        binding,
        reason: control.incidentState === "active"
          ? "An economically effective authority is under an active incident."
          : "An economically effective authority has unbounded power over the holder claim.",
        materialSharePct: control.materialSupplyShare === null ? null : v9StructuralSignalSharePct(
          facts.assetId, "structuralSignals[*].materialSharePct", control.materialSupplyShare),
        controlKeys: [control.controlKey], failureDomains: canonicalDomains(control.failureDomains),
      });
    }
  }
  if (economicControls.length === 0 || mint.status.applicability.state === "not-applicable") {
    const mintControl = mint.controlKey === null ? undefined : controlsByKey.get(mint.controlKey);
    const immutable = mint.status.applicability.state === "not-applicable" ||
      (isKnownRequired(mint.status) && mint.upgrade.state === "immutable" &&
        ((mint.controlKey === null && mint.reconciliation === "not-applicable") ||
          (mintControl?.claimImpairment === "none" && mintControl.economicLossScope === "access-only")));
    if (immutable) {
      components.push({
        componentKey: "mint", kind: "mint", posture: "none-resolved",
        score: applyResolvedControlIncidentHistory(policy.control.authorityLadder.immutableNoPower,
          null, args.resolvedIncidentAgeMonths, policy.control),
        binding: true, controlKeys: [], failureDomains: [],
      });
    } else if (isKnownRequired(mint.status)) {
      addReason("missing-mint-authority", "local-component", "mint", mint.controlKey);
    }
  }
}

function evaluateOraclePhase(context: ControlEvaluationContext): void {
  const { args, policy, facts, controlsByKey, components, addReason, addStructuralFailure } = context;
  const oracle = args.oracle;
  const retainedOracleTier = oracle.status.applicability.state === "unresolved" &&
    oracle.paths?.some((path) => path.applicability.state === "required" && path.observationState === "known")
    ? oracle.knownPathTier ?? null
    : null;
  if (oracle.status.applicability.state === "not-applicable") {
    // No price-sensitive oracle or internal valuation path exists to score.
    // Not-applicable is neutral rather than evidence of a strong control.
  } else if (oracle.status.applicability.state === "unresolved") {
    addReason("unresolved-oracle-branch-applicability", "local-component", "oracle");
    if (retainedOracleTier !== null) {
      // Keep sibling uncertainty binding independently of the reviewed paths.
      // Components compete by minimum quality; they are not additive charges.
      components.push({
        componentKey: "oracle", kind: "oracle", posture: "opaque-or-unknown",
        score: unknownQuality("control", resolveV9StatusCauses([oracle.status], facts.gaps).cause, policy), binding: true,
        controlKeys: [], failureDomains: [],
      });
    }
  } else if (oracle.status.observationState !== "known") {
    const code =
      oracle.status.observationState === "missing"
        ? "missing-oracle-profile"
        : oracle.status.observationState === "stale"
          ? "unreviewed-oracle-profile"
          : "incomplete-oracle-liquidation-branch";
    addReason(code, "local-component", "oracle");
  }
  if (isKnownRequired(oracle.status) || retainedOracleTier !== null) {
    const oracleTier = retainedOracleTier ?? oracle.tier;
    const branchesByKind = new Map<V9OracleBranchKind, V9OracleBranchReview>();
    for (const branch of [...oracle.branches].sort((left, right) =>
      compareText(left.branch, right.branch) ||
      compareText(left.controlKey ?? "", right.controlKey ?? "") ||
      compareText(left.mechanismKey ?? "", right.mechanismKey ?? ""))) {
      if (branchesByKind.has(branch.branch)) throw new Error(`Duplicate v9 oracle branch ${branch.branch}`);
      branchesByKind.set(branch.branch, branch);
    }
    const oracleControls = new Map<string, V9DeploymentControlFactV2>();
    const missingBranches =
      oracle.liquidationBranchesApplicable === false
        ? []
        : ORACLE_BRANCHES.filter((branch) => !branchesByKind.has(branch));
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
    if (oracleTier === null) {
      addReason("missing-oracle-profile", "local-component", "oracle:tier");
    } else {
      const linkedControls = [...oracleControls.values()];
      const failureDomains = canonicalDomains(linkedControls.flatMap((control) => control.failureDomains));
      components.push({
        componentKey: retainedOracleTier === null ? "oracle" : "oracle:known-paths",
        kind: "oracle",
        posture: oracleTier,
        score: oracleTier === "opaque-or-unknown"
          ? unknownQuality("control", resolveV9StatusCauses([oracle.factorStatuses?.tier, oracle.status], facts.gaps).cause, policy)
          : policy.control.oracleTierQuality[oracleTier],
        binding: true,
        controlKeys: linkedControls.map((control) => control.controlKey).sort(compareText),
        failureDomains,
      });
      if (oracleTier === "opaque-or-unknown") {
        // A reviewed inventory can establish non-disclosure, not unsafe topology.
        addReason("oracle-topology-undisclosed", "local-component", "oracle:topology");
      } else if (oracleTier === "single-source-or-laggy") {
        addStructuralFailure({
          kind: "weak-oracle-branch",
          severity: "high",
          binding: true,
          reason: `Oracle control topology is ${oracleTier}.`,
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
          failureDomains: [{ kind: "oracle-feed", key: `oracle:${facts.assetId}:sub-material-weak` }],
        });
      }
    }
  }
}

function evaluateBridgePhase(context: ControlEvaluationContext): void {
  const { args, policy, facts, controlsByKey, components, materialShareThreshold,
    unresolvedFullCeilingShareThreshold, controlBinding, addReason, addStructuralFailure } = context;
  const controls = facts.controls;
  // A bounded bridge review keeps the rows it did review only when the supply it
  // could not attribute is itself immaterial. An unavailable share fails closed:
  // an unknown residual cannot license scoring the known part.
  // An absent share is never read as a measured zero. A null share means no supply
  // partition was produced for this asset at all, not that the partition ran and
  // found no bridge route: on the 2026-08-18 catalogue every one of the 225
  // partitioned assets returned at least one bridge route row, and all 112 assets
  // with an empty partition had null shares. "Partitioned but empty" is not a
  // reachable state, so treating null as zero would only ever license scoring an
  // inventory whose residual was never measured.
  const excludedSupply = providerRowExclusionShares(facts.assetId, facts.supply);
  const unknownRouteSupplyShare = facts.supply.unknownRouteSupplyShare === null ? null :
    Math.max(0, facts.supply.unknownRouteSupplyShare - excludedSupply.unknown);
  const unreviewedRouteSupplyShare = facts.supply.unreviewedRouteSupplyShare === null ? null :
    Math.max(0, facts.supply.unreviewedRouteSupplyShare - excludedSupply.unreviewed);
  const unattributedBridgeShare =
    unknownRouteSupplyShare === null || unreviewedRouteSupplyShare === null
      ? null
      : Math.min(1, unknownRouteSupplyShare + unreviewedRouteSupplyShare);
  const boundedBridgeGapIsImmaterial =
    unattributedBridgeShare !== null && unattributedBridgeShare < unresolvedFullCeilingShareThreshold;

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
  } else if (bridge.status.applicability.state === "unresolved" && !resolveV9StatusCauses([bridge.status], facts.gaps).excluded) {
    addReason("runtime-bridge-materiality-unavailable", "deployment-control", "bridge");
  } else if (bridge.status.observationState === "missing" && !resolveV9StatusCauses([bridge.status], facts.gaps).excluded) {
    addReason("missing-bridge-routes", "deployment-control", "bridge");
  } else if (bridge.status.observationState !== "known" && !boundedBridgeGapIsImmaterial && !resolveV9StatusCauses([bridge.status], facts.gaps).excluded) {
    // Ownership is shape-specific: missing/invalid profiles and ambiguous joins
    // are integration-missing; stale chain input and rejected runtime capture
    // are producer-failed. The fact compiler persists that causal supply gap,
    // so this evaluator emits only the common reason code.
    addReason("runtime-bridge-materiality-unavailable", "deployment-control", "bridge");
  } else {
    // Retain reviewed rows under a bounded residual. An unresolved route
    // contributes no component, but needs no whole-coin fallback when the
    // full cohort is bounded and every selected supply row has a proved join.
    // A reconciled partition may prove a null-share deployment immaterial;
    // that join relief is not admission of an exact share for pricing.
    const completeSubthresholdUnresolvedJoins = evaluateV9SubthresholdUnresolvedBridgeJoins(
      facts,
      controls,
      bridge.routes,
      materialShareThreshold,
      policy.materiality.commonModeShareThreshold,
      unresolvedFullCeilingShareThreshold,
    ).complete;
    if (
      bridge.status.observationState !== "known" &&
      !(bridge.status.observationState === "bounded-unknown" && completeSubthresholdUnresolvedJoins)
    ) {
      addReason("runtime-bridge-materiality-unavailable", "deployment-control", "bridge");
    }
    const unresolvedBridgeResidueBinds =
      unattributedBridgeShare === null ||
      (unattributedBridgeShare > 0 && !completeSubthresholdUnresolvedJoins);
    const hasUnresolvedSupplyRows = facts.supply.selectedBridgeRoutes.some(
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
      const nullShareBound = provenNullShareDeploymentBound(facts, control);
      const provenImmaterial = nullShareBound !== null && nullShareBound < materialShareThreshold;
      const binding = controlBinding(control, nullShareBound);
      if (!isKnownRequired(control.status)) {
        if (binding) {
          addReason("selected-bridge-route-unresolved", "deployment-control", "bridge:route", route.controlKey);
        }
      }
      if (control.economicLossScope === "deployment" && control.materialSupplyShare === null && !provenImmaterial) {
        addReason(
          "runtime-bridge-materiality-unavailable",
          "deployment-control",
          "bridge:route:materiality",
          route.controlKey,
        );
      }
      const selectedSupplyRoute = facts.supply.selectedBridgeRoutes.find(
        (supplyRoute) => supplyRoute.deploymentRouteKey === control.deploymentKey,
      );
      if (facts.supply.selectedBridgeRoutes.length > 0 && !selectedSupplyRoute && binding) {
        addReason("selected-bridge-route-missing", "deployment-control", "bridge:route:supply", route.controlKey);
      }
      if (selectedSupplyRoute?.reviewState === "selected-unresolved" && binding) {
        addReason("selected-bridge-route-unresolved", "deployment-control", "bridge:route:supply", route.controlKey);
      }
      if (
        selectedSupplyRoute?.reviewState === "unmatched" &&
        Math.max(0, selectedSupplyRoute.supplyShare - (excludedSupply.byDeployment.get(selectedSupplyRoute.deploymentRouteKey) ?? 0)) >= materialShareThreshold
      ) {
        addReason("material-bridge-supply-unmatched", "deployment-control", "bridge:supply", route.controlKey);
      }
      components.push({
        componentKey: `bridge:${control.deploymentKey}:${control.controlKey}`,
        kind: "bridge",
        posture: route.tier,
        score: route.tier === "opaque-or-unknown"
          ? unknownQuality("control", resolveV9StatusCauses([route.factorStatuses?.tier, bridge.status, control.status], facts.gaps).cause, policy)
          : policy.control.bridgeTierQuality[route.tier],
        binding,
        controlKeys: [control.controlKey],
        failureDomains: canonicalDomains(control.failureDomains),
      });
      if (route.tier === "external-lock-mint") {
        addStructuralFailure({
          kind: binding ? "material-bridge" : "peripheral-bridge",
          severity: materialBridgeSeverity(
            route.tier,
            control.materialSupplyShare,
            args.policy.policy.semantic.control.materialBridgeHighShareThreshold,
          ),
          binding,
          reason: `Bridge control topology is ${route.tier}.`,
          materialSharePct:
            control.materialSupplyShare === null
              ? null
              : v9StructuralSignalSharePct(
                  facts.assetId,
                  "structuralSignals[*].materialSharePct",
                  control.materialSupplyShare,
                ),
          controlKeys: [control.controlKey],
          failureDomains: control.failureDomains,
        });
      }
    }
    // Deliberately null-as-zero, unlike the null-as-unknown residual above: a
    // missing partition never fires the aggregate-residue reasons itself — the
    // non-known observation branches above already carry the fail-closed
    // runtime reason for that case.
    const unknownBridgeShare = Math.min(
      1,
      (unknownRouteSupplyShare ?? 0) + (unreviewedRouteSupplyShare ?? 0),
    );
    // Unknown route supply keeps the deployment-material floor (including the
    // RULED D-J pool). Joined unresolved routes instead use the full-cohort
    // band, so they cannot regain the old 10% ceiling through this residue path.
    if (
      (unknownRouteSupplyShare ?? 0) >= materialShareThreshold ||
      (unknownBridgeShare >= materialShareThreshold && !completeSubthresholdUnresolvedJoins)
    ) {
      addReason("material-bridge-supply-unmatched", "deployment-control", "bridge:supply");
    } else if (unknownBridgeShare > 0 && !completeSubthresholdUnresolvedJoins) {
      addReason("nonmaterial-bridge-supply-unmatched", "deployment-control", "bridge:supply");
    }
  }
}

function appendControlFallbacks(context: ControlEvaluationContext): void {
  const { args, policy, facts, controlsByKey, components, reasons } = context;
  const fallbacks = [
    { kind: "mint", componentKey: "mint", posture: "unknown" },
    { kind: "oracle", componentKey: "oracle", posture: "opaque-or-unknown" },
    { kind: "bridge", componentKey: "bridge:unverified", posture: "opaque-or-unknown" },
  ] as const;
  for (const fallback of fallbacks) {
    if (components.some((component) => component.kind === fallback.kind)) continue;
    const section = fallback.kind === "mint" ? args.mint : fallback.kind === "oracle" ? args.oracle : args.bridge;
    const causeStatuses: (V9FactStatusV2 | undefined)[] = [section.status];
    let hasBindingGap = resolveV9StatusCauses([section.status], facts.gaps).excluded;
    for (const reason of reasons.values()) {
      if (resolveV9ReasonTreatment(args.policy, reason.code).reason.defaultTreatment === "diagnostic") continue;
      const sectionMatch = reason.path === fallback.kind || reason.path.startsWith(`${fallback.kind}:`);
      const control = reason.controlKey === null ? undefined : controlsByKey.get(reason.controlKey);
      if (!sectionMatch && !(control && controlFallbackKind(control) === fallback.kind)) continue;
      hasBindingGap = true;
      if (control) causeStatuses.push(control.status, ...Object.values(control.factorStatuses ?? {}));
      if (sectionMatch && (reason.path.includes("supply") || reason.path.includes("materiality"))) {
        causeStatuses.push(facts.supply.status);
      }
    }
    if (!hasBindingGap) continue;
    components.push({
      componentKey: fallback.componentKey, kind: fallback.kind, posture: fallback.posture,
      score: unknownQuality("control", resolveV9StatusCauses(causeStatuses, facts.gaps).cause, policy),
      binding: true, controlKeys: [], failureDomains: [], causeStatuses,
    });
  }
}

function normalizeControlComponents(
  context: ControlEvaluationContext,
  normalizedStructuralFailures: readonly V9ControlStructuralFailure[],
): V9ControlComponent[] {
  const { args, facts, controlsByKey, components, controlBinding } = context;
  const controls = facts.controls;
  // Deployment-local adverse loss is owned by proportional deployment risk;
  // retain its component for publication even when it cannot bind the pillar.
  const pricedDeploymentControlKeys = new Set(
    normalizedStructuralFailures
      .filter((failure) => failure.binding && failure.materialSharePct !== null)
      .flatMap((failure) =>
        failure.controlKeys.filter((controlKey) => {
          const control = controlsByKey.get(controlKey);
          return control?.economicLossScope === "deployment" && control.materialSupplyShare !== null;
        }),
      ),
  );
  const scopedDeploymentControlKeys = new Set([
    ...pricedDeploymentControlKeys,
    ...controls
      .filter(
        (control) =>
          control.economicLossScope === "deployment" &&
          !controlBinding(control),
      )
      .map((control) => control.controlKey),
  ]);
  const normalizedComponents: V9ControlComponent[] = [];
  let worstMint: V9ControlComponent | null = null;
  let worstBindingMint: V9ControlComponent | null = null;
  const scopedMintComponents: V9ControlComponent[] = [];
  for (const component of components) {
    const unknown = component.posture === "unknown" || component.posture === "opaque-or-unknown";
    const section = component.kind === "mint" ? args.mint : component.kind === "oracle" ? args.oracle : args.bridge;
    const linkedControls = component.controlKeys.flatMap((key) => controlsByKey.get(key) ?? []);
    const factorStatuses = component.kind === "mint"
      ? linkedControls.flatMap((control) => [control.status, control.factorStatuses?.capAuthority,
          control.factorStatuses?.claimImpairment, control.factorStatuses?.economicLossScope])
      : component.kind === "bridge"
        ? [args.bridge.factorStatuses?.tier,
            ...args.bridge.routes.filter((route) => component.controlKeys.includes(route.controlKey)).map((route) => route.factorStatuses?.tier)]
        : [args.oracle.factorStatuses?.tier];
    const reconciliationQuestion = component.kind === "mint" &&
      linkedControls.some((control) => controlCanRepresent(control, "mint") &&
        (control.capSemantics.kind === "unbounded" || control.claimImpairment === "unbounded")) &&
      (args.mint.reconciliation === "unknown" ||
        (args.mint.reconciliation === "internal-ledger" && args.mint.supervision !== "prudential"));
    const uncertainty = component.kind === "mint"
      ? linkedControls.flatMap((control) => [control.factorStatuses?.authority, control.factorStatuses?.topology,
          control.factorStatuses?.multisigTopology]) : [];
    if (reconciliationQuestion) uncertainty.push(args.mint.factorStatuses?.reconciliation);
    const causal = resolveV9StatusCauses(
      unknown ? [section.status, ...factorStatuses, ...uncertainty, ...(component.causeStatuses ?? [])] : uncertainty,
      facts.gaps,
    );
    if (causal.cause === null && (unknown ||
      (component.kind === "mint" && linkedControls.some((control) => control.authority?.model === "multisig" &&
        control.authority.threshold === null && control.authority.weightedQuorum === undefined)))) {
      causal.cause = "U";
      causal.causes = ["U"];
    }
    const usableAuthority = component.kind === "mint" && linkedControls.some((control) =>
      control.status.evidenceRefIds.length > 0 && (control.authority !== null && control.authority.model !== "unknown" ||
        control.claimImpairment !== "unknown" || control.capSemantics.kind !== "unknown"));
    const excludedUnknown = unknown && causal.excluded && !usableAuthority;
    const effectiveCause = causal.excluded && !excludedUnknown ? null : causal.cause;
    const metadata = {
      cause: effectiveCause, causeGapIds: causal.causeGapIds,
      scoringDisposition: v9ScoringDisposition(effectiveCause),
      effectiveScoringWeight: excludedUnknown ? 0 : 1,
      score: excludedUnknown ? null : unknown && (component.kind !== "mint" || linkedControls.length === 0)
        ? unknownQuality("control", causal.cause, context.policy) : component.score,
      binding: excludedUnknown ? false : component.binding,
    };
    const { causeStatuses: _causeStatuses, ...componentFacts } = component;
    const priced = Object.assign(componentFacts, metadata);
    if (priced.score === null) {
      normalizedComponents.push(priced);
      continue;
    }
    const normalized =
      priced.binding &&
      priced.controlKeys.length > 0 &&
      priced.controlKeys.every((controlKey) => scopedDeploymentControlKeys.has(controlKey))
        ? { ...priced, binding: false }
        : priced;
    // Bridge authority competes with the pillar, not with native mint
    // attribution; its separately admitted route tier remains independent.
    if (normalized.kind !== "mint" || normalized.componentKey.startsWith("mint:bridge:")) {
      normalizedComponents.push(normalized);
      continue;
    }
    if (!normalized.binding) scopedMintComponents.push(normalized);
    if (normalized.binding && (worstBindingMint === null || normalized.score! < worstBindingMint.score!)) {
      worstBindingMint = normalized;
    }
    if (
      worstMint === null ||
      normalized.score! < worstMint.score! ||
      (normalized.score === worstMint.score && normalized.binding && !worstMint.binding)
    ) {
      worstMint = normalized;
    }
  }
  if (worstMint !== null) normalizedComponents.push(worstMint);
  for (const component of scopedMintComponents) {
    if (component !== worstMint) normalizedComponents.push({
      ...component,
      componentKey: `mint:deployment:${component.controlKeys.join("+")}`,
    });
  }
  if (worstBindingMint !== null && worstBindingMint !== worstMint) {
    normalizedComponents.push({ ...worstBindingMint, componentKey: "mint:binding" });
  }
  normalizedComponents.sort((left, right) => compareText(left.componentKey, right.componentKey));
  return normalizedComponents;
}
