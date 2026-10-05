import {
  createV9FactStatus,
  notApplicableV9Fact,
  requiredV9Applicability,
} from "@shared/lib/safety-score-v9/evidence";
import { createV9FactGapV3 } from "@shared/lib/safety-score-v9/reasons";
import type {
  V9AccessReviewV2,
  V9DeploymentControlFactV2,
  V9EconomicControlReviewV2,
  V9FactGapV3,
  V9FactStatusV2,
  V9AssetFactsBase,
  V9EffectiveDependenciesV3,
} from "@shared/types/safety-score-v9-facts";
import type { AssetExtension } from "./fact-set-schema";
import {
  addGap,
  assertKnownComponentEvidenceCurrent,
  componentResearchEvidence,
  missingLocalFact,
  normalizeReviewedFactStatus,
  type AssetBuildContext,
} from "./fact-set-context";
import { compileReviewedControlScope, weightedReviewIsCurrent, sortV1005ProcessDiagnostics } from "@shared/lib/safety-score-v9/control-scope";
import { V9_REVIEW_EVIDENCE_MAX_AGE_SEC } from "@shared/lib/safety-score-v9/evidence";
import { DEPLOYMENT_MATERIAL_SHARE_THRESHOLD } from "./extension-shared";
import { v9AccessClaimGraphStatuses } from "@shared/types/safety-score-v9-access-lookthrough";
import { computeSafetyScoreV9ReserveExposureKey } from "./fact-set-schema";
import { evaluateV9AccessLookthrough } from "@shared/lib/safety-score-v9/access-lookthrough";

type ExtensionControlOverlay = Extract<
  NonNullable<AssetExtension["controlReview"]>,
  { state: "reviewed-controls" }
>["controls"][number];

export function buildControls(context: AssetBuildContext): {
  controlStatus: V9FactStatusV2;
  controls: V9DeploymentControlFactV2[];
} {
  const review = context.asset.controlReview;
  if (review === null) {
    return {
      controlStatus: missingLocalFact(context, {
        componentKey: "deployment-controls",
        reasonCode: "missing-upgradeability-review",
        ownerDomain: "control",
        responsibility: "integration-missing",
        policyRuleId: "v9.control.review",
        message: "No reviewed deployment-control posture is present in the v9 overlay.",
      }).status,
      controls: [],
    };
  }
  const evidenceIds = componentResearchEvidence(context, "control");
  if (review.state === "no-privileged-controls") {
    assertKnownComponentEvidenceCurrent(context, "control", evidenceIds);
    return {
      controlStatus: createV9FactStatus({
        applicability: notApplicableV9Fact("v9.control.review", review.rationale),
        observationState: "known",
        evidenceRefIds: evidenceIds,
      }),
      controls: [],
    };
  }
  // Each authority's own certificate is checked; a friendly sibling's proof
  // cannot close an unreviewed contributor on the same deployment.
  const reviewedControls = review.controls.map((control) => {
    if (!control.executionScope && !control.executionScopeContributors && !control.authority?.weightedQuorum) return control;
    const projections = control.executionScopeContributors
      ? control.executionScopeContributors.map((entry) => compileReviewedControlScope(entry.scope, entry.authorityKey, context.asset.assetId, context.fixedInput.clockSec, V9_REVIEW_EVIDENCE_MAX_AGE_SEC))
      : [compileReviewedControlScope(control.executionScope, control.authority?.authorityKey ?? "", context.asset.assetId, context.fixedInput.clockSec, V9_REVIEW_EVIDENCE_MAX_AGE_SEC)];
    return {
      ...control,
      ...(control.executionScope || control.executionScopeContributors ? {
        executionScopeComplete: control.executionScopeComplete !== false && projections.every((projection) => projection.complete),
        moduleImpact: projections.some((projection) => projection.moduleImpact === "relevant") ? "relevant" as const
          : projections.every((projection) => projection.moduleImpact === "verified-noninterfering" || projection.moduleImpact === "not-applicable") ? "verified-noninterfering" as const : "unresolved" as const,
        scopeDiagnostics: [...new Set([...(control.scopeDiagnostics ?? []), ...projections.flatMap((projection) => projection.diagnostics)])].sort(),
      } : {}),
      ...((control.issuanceGovernance || control.issuanceProcess || control.processDiagnostics) ? {
        processDiagnostics: sortV1005ProcessDiagnostics([...(control.processDiagnostics ?? []),
          ...(control.issuanceGovernance?.diagnostics ?? []), ...(control.issuanceProcess?.diagnostics ?? [])]),
      } : {}),
      ...(control.authority?.weightedQuorum && !weightedReviewIsCurrent(control.authority.weightedQuorum, context.fixedInput.clockSec, V9_REVIEW_EVIDENCE_MAX_AGE_SEC)
        ? { authority: { ...control.authority, weightedQuorum: { ...control.authority.weightedQuorum, status: "unknown" as const } } } : {}),
    };
  });
  // unresolved control without one keeps the hard reason.
  const unresolvedControls = reviewedControls.filter((control) => !controlCanCarryKnownStatus(control));
  const allUnresolvedScoped =
    unresolvedControls.length > 0 &&
    unresolvedControls.every((control) => control.scopedQuestionFresh === true);
  const status =
    review.state === "reviewed-controls" && unresolvedControls.length === 0
      ? createV9FactStatus({
          applicability: requiredV9Applicability("v9.control.review"),
          observationState: "known",
          evidenceRefIds: evidenceIds,
        })
      : missingLocalFact(context, {
          componentKey: "deployment-controls",
          reasonCode: allUnresolvedScoped ? "scoped-control-question" : "unresolved-control-identity",
          ownerDomain: "control",
          responsibility: "unresearched",
          policyRuleId: "v9.control.review",
          message: review.state === "partially-reviewed-controls" ? review.rationale : "One or more independently identified authorities remain unreviewed.",
          observationState: "bounded-unknown",
          evidenceRefIds: evidenceIds,
        }).status;
  const hasKnownControl = reviewedControls.some(controlCanCarryKnownStatus);
  if (review.state === "reviewed-controls" || hasKnownControl) {
    assertKnownComponentEvidenceCurrent(context, "control", evidenceIds);
  }
  return {
    controlStatus: status,
    controls: reviewedControls.map((control) => {
      // Materiality bounds the charge, not our knowledge of the authority.
      const controlStatus = (!controlHasExactAuthorityReview(control) && control.economicLossScope === "access-only") || controlSemanticsAreKnown(control)
        ? createV9FactStatus({
            applicability: !controlHasExactAuthorityReview(control) && controlNeedsNonApplicableStatus(control)
              ? notApplicableV9Fact("v9.control.review", "This resolved control does not bind the control pillar.")
              : requiredV9Applicability("v9.control.review"),
            observationState: "known",
            evidenceRefIds: evidenceIds,
          })
        : boundedControlSemanticsStatus(context, control, evidenceIds);
      const factorStatuses: NonNullable<V9DeploymentControlFactV2["factorStatuses"]> = {};
      for (const [factorKey, unknown] of [
        ["authority", control.authority === null || control.authority.model === "unknown"],
        ["capAuthority", control.capSemantics.kind === "unknown"],
        ["claimImpairment", control.claimImpairment === "unknown"],
        ["economicLossScope", control.economicLossScope === "unknown"],
        ["incidentState", control.incidentState === "unknown"],
        ["materialSupplyShare", control.scope === "deployment" && control.materialSupplyShare === null],
        ["executionScope", control.executionScopeComplete === false],
        ["multisigTopology", control.authority?.model === "multisig" && control.authority.threshold === null],
      ] as const) {
        if (!unknown) continue;
        factorStatuses[factorKey] = missingLocalFact(context, {
          componentKey: `control:${control.controlKey}:${factorKey}`, reasonCode: "unresolved-control-identity",
          ownerDomain: "control", responsibility: "unresearched", policyRuleId: "v9.control.review",
          message: `The ${factorKey} datum for independently identified control ${control.controlKey} remains unresolved.`,
          evidenceRefIds: evidenceIds,
          causeScope: { pillar: "control", componentKey: `control:${control.controlKey}`, factorKey,
            routeKey: null, exposureId: control.scope === "deployment" ? control.deploymentKey : null, requiredDatum: factorKey },
        }).status;
      }
      return {
        ...control,
        sourceGenerationId: context.extension.sources.researchOverlays.generationId,
        status: controlStatus,
        factorStatuses,
      };
    }),
  };
}

function controlHasExactAuthorityReview(control: ExtensionControlOverlay): boolean {
  return control.executionScopeComplete === true;
}

function controlIsNonBinding(control: ExtensionControlOverlay): boolean {
  return control.economicLossScope === "access-only" ||
    (control.economicLossScope === "deployment" && control.materialSupplyShare !== null &&
      control.materialSupplyShare < DEPLOYMENT_MATERIAL_SHARE_THRESHOLD);
}

function controlNeedsNonApplicableStatus(control: ExtensionControlOverlay): boolean {
  return controlIsNonBinding(control) &&
    (control.capSemantics.kind === "unknown" || control.claimImpairment === "unknown" ||
      control.authority === null || control.failureDomains.length === 0);
}


function controlSemanticsAreKnown(control: ExtensionControlOverlay): boolean {
  return (
    control.capSemantics.kind !== "unknown" &&
    control.claimImpairment !== "unknown" &&
    control.economicLossScope !== "unknown" &&
    control.incidentState !== "unknown" &&
    control.authority !== null &&
    control.authority.model !== "unknown"
  );
}

export function controlCanCarryKnownStatus(control: ExtensionControlOverlay): boolean {
  return (!controlHasExactAuthorityReview(control) && controlIsNonBinding(control)) || controlSemanticsAreKnown(control);
}

function boundedControlSemanticsStatus(
  context: AssetBuildContext,
  control: ExtensionControlOverlay,
  evidenceRefIds: readonly string[],
): V9FactStatusV2 {
  const scopedQuestion = control.scopedQuestionFresh === true;
  const gapId = addGap(
    context,
    createV9FactGapV3({
      gapId: `${context.asset.assetId}:gap:deployment-control:${control.controlKey}`,
      reasonCode: scopedQuestion ? "scoped-control-question" : "unresolved-control-identity",
      ownerDomain: "control",
      policyRuleId: "v9.control.review",
      observationState: "bounded-unknown",
      responsibility: "unresearched",
      path:
        control.scope === "deployment"
          ? { kind: "deployment-control", deploymentKey: control.deploymentKey, controlKey: control.controlKey }
          : { kind: "local-component", componentKey: `control:${control.controlKey}` },
      message: scopedQuestion
        ? "A reviewer-scoped open question names this control; its semantics stay bounded until it is resolved."
        : "The control inventory is known, but this control's authority or economic semantics remain unresolved.",
      evidenceRefIds,
    }),
  );
  return createV9FactStatus({
    applicability: requiredV9Applicability("v9.control.review"),
    observationState: "bounded-unknown",
    evidenceRefIds,
    gapIds: [gapId],
  });
}

function normalizeEconomicControlStatus(
  context: AssetBuildContext,
  original: V9FactStatusV2,
  componentKey: string,
  reasonCode: V9FactGapV3["reasonCode"],
): V9FactStatusV2 {
  return normalizeReviewedFactStatus(context, original, {
    bindingKey: `economic-control:${componentKey}`,
    staleEvidenceError: `Economic-control review ${context.asset.assetId}:${componentKey} is stale but its source is current`,
    gapId: `${context.asset.assetId}:gap:economic-control:${componentKey}`,
    reasonCode,
    ownerDomain: "control",
    componentKey: `economic-control:${componentKey}`,
    message: `The ${componentKey} economic-control review is not a current known fact.`,
  });
}

function compileEconomicFactorStatuses(
  context: AssetBuildContext,
  review: V9EconomicControlReviewV2,
): V9EconomicControlReviewV2 {
  const missingFactor = (componentKey: string, factorKey: string, routeKey: string | null = null) =>
    missingLocalFact(context, {
      componentKey: `${componentKey}:${routeKey ?? ""}:${factorKey}`,
      reasonCode: componentKey.endsWith("mint") ? "missing-mint-authority"
        : componentKey.endsWith("oracle") ? "missing-oracle-profile" : "missing-bridge-routes",
      ownerDomain: "control", responsibility: "unresearched", policyRuleId: `v9.control.${factorKey}`,
      message: componentKey === "economic-control:mint" && factorKey === "reconciliation" &&
        review.mint.reconciliation === "internal-ledger"
        ? "The reviewed internal ledger establishes the mint process, not whole-supply reconciliation against reserves for unbounded minting."
        : `The ${factorKey} datum for ${componentKey}${routeKey ? ` route ${routeKey}` : ""} has not been established.`,
      causeScope: { pillar: "control", componentKey, factorKey, routeKey, exposureId: null, requiredDatum: factorKey },
    }).status;
  // Reuse the same scoped factor-gap factory for an unanswered cadence and the
  // internal ledger's whole-supply question. Neither gap changes known authority
  // semantics; none/NA remain reviewed findings, not missing-factor defaults.
  // An internal ledger establishes the mint process, not reconciliation of
  // otherwise unbounded supply against reserves.
  const missingWholeSupplyReconciliation = review.mint.reconciliation === "internal-ledger" &&
    review.mint.supervision !== "prudential" &&
    (context.asset.controlReview?.state === "reviewed-controls" ||
      context.asset.controlReview?.state === "partially-reviewed-controls") &&
    context.asset.controlReview.controls.some((control) =>
      control.controlKind !== "bridge" &&
      (control.capabilities.includes("mint") || control.controlKey === review.mint.controlKey) &&
      (control.capSemantics.kind === "unbounded" || control.claimImpairment === "unbounded"));
  if (review.mint.status.applicability.state !== "not-applicable") {
    review.mint.factorStatuses = {};
    for (const [factorKey, unknown] of [
      ["reconciliation", review.mint.reconciliation === "unknown" || missingWholeSupplyReconciliation],
      ["supervision", review.mint.supervision === "unknown"],
      ["upgrade", review.mint.upgrade.state === "unknown"],
    ] as const) {
      if (unknown) review.mint.factorStatuses[factorKey] = missingFactor("economic-control:mint", factorKey);
    }
  }
  if (review.oracle.status.applicability.state !== "not-applicable" &&
      (review.oracle.tier === null || review.oracle.tier === "opaque-or-unknown")) {
    review.oracle.factorStatuses = { tier: missingFactor("economic-control:oracle", "tier") };
  }
  if (review.bridge.status.applicability.state !== "not-applicable" && review.bridge.routes.length === 0) {
    review.bridge.factorStatuses = { tier: missingFactor("economic-control:bridge", "tier") };
  }
  for (const route of review.bridge.routes) {
    if (route.tier === "opaque-or-unknown") {
      route.factorStatuses = { tier: missingFactor("economic-control:bridge", "tier", route.controlKey) };
    }
  }
  return review;
}

export function buildEconomicControlReview(context: AssetBuildContext): V9EconomicControlReviewV2 {
  const review = context.asset.economicControlReview;
  if (review === null) {
    return compileEconomicFactorStatuses(context, {
      mint: {
        status: missingLocalFact(context, {
          componentKey: "economic-control:mint",
          reasonCode: "missing-mint-authority",
          ownerDomain: "control",
          responsibility: "integration-missing",
          policyRuleId: "v9.control.mint-review",
          message: "Mint reconciliation and upgrade linkage have not been reviewed.",
        }).status,
        controlKey: null,
        reconciliation: "unknown",
        supervision: "unknown",
        latestResolvedIncidentAtSec: null,
        upgrade: { state: "unknown", controlKey: null },
      },
      oracle: {
        status: missingLocalFact(context, {
          componentKey: "economic-control:oracle",
          reasonCode: "missing-oracle-profile",
          ownerDomain: "control",
          responsibility: "integration-missing",
          policyRuleId: "v9.control.oracle-review",
          message: "Oracle tier and branch applicability have not been reviewed.",
        }).status,
        tier: null,
        branches: [],
      },
      bridge: {
        status: missingLocalFact(context, {
          componentKey: "economic-control:bridge",
          reasonCode: "missing-bridge-routes",
          ownerDomain: "control",
          responsibility: "integration-missing",
          policyRuleId: "v9.control.bridge-review",
          message: "Bridge-route control tiers have not been reviewed.",
        }).status,
        routes: [],
      },
    });
  }
  const normalized: V9EconomicControlReviewV2 = structuredClone(review);
  normalized.mint.status = normalizeEconomicControlStatus(
    context,
    normalized.mint.status,
    "mint",
    "missing-mint-authority",
  );
  normalized.oracle.status = normalizeEconomicControlStatus(
    context,
    normalized.oracle.status,
    "oracle",
    "missing-oracle-profile",
  );
  normalized.oracle.branches = normalized.oracle.branches.map((branch) => ({
    ...branch,
    status: normalizeEconomicControlStatus(
      context,
      branch.status,
      `oracle:${branch.branch}`,
      "incomplete-oracle-liquidation-branch",
    ),
  }));
  normalized.bridge.status = normalizeEconomicControlStatus(
    context,
    normalized.bridge.status,
    "bridge",
    "missing-bridge-routes",
  );
  return compileEconomicFactorStatuses(context, normalized);
}

function normalizeAccessStatus(
  context: AssetBuildContext,
  original: V9FactStatusV2,
  componentKey: string,
  structuralDisposition?: NonNullable<V9AccessReviewV2["freeze"]["structuralDisposition"]>,
): V9FactStatusV2 {
  // Owner ruling 2026-07-27: a current, evidenced structural verdict
  // (inherited-upstream) is a measured fact, not missing data. The status
  // stays bounded-unknown for scoring and the gap invariant is preserved, but
  // the gap carries the measured classification (same diagnostic treatment)
  // instead of missing-access-review. Stale and missing states still report
  // missing data regardless of the disposition.
  // Owner ruling 2026-08-10 extends the same treatment to
  // `inherited-untracked-upstream`, where the reviewer measured inherited
  // exposure but the upstream is not a tracked asset, so none may be named.
  // Owner ruling 2026-08-12: a current `possible` verdict is the same shape —
  // the reviewer looked and could not prove true or false — so it is measured
  // rather than reported as an unreviewed asset.
  const structural = structuralDisposition !== undefined && original.observationState === "bounded-unknown";
  const structuralReasonCode =
    structuralDisposition === "reviewed-possible" ? "reviewed-possible-access" : "inherited-access-exposure";
  const structuralMessage =
    structuralDisposition === "reviewed-possible"
      ? `The ${componentKey} access posture is a reviewed structural fact: freeze reach is possible, not proven true or false.`
      : structuralDisposition === "inherited-untracked-upstream"
        ? `The ${componentKey} access posture is a reviewed structural fact: exposure is inherited from an upstream that is not a tracked asset.`
        : `The ${componentKey} access posture is a reviewed structural fact: exposure is inherited from a named upstream asset.`;
  return normalizeReviewedFactStatus(context, original, {
    bindingKey: `access:${componentKey}`,
    staleEvidenceError: `Access review ${context.asset.assetId}:${componentKey} is stale but its source is current`,
    gapId: `${context.asset.assetId}:gap:access:${componentKey}`,
    reasonCode: structural ? structuralReasonCode : "missing-access-review",
    ownerDomain: "control",
    componentKey: `access:${componentKey}`,
    message: structural
      ? structuralMessage
      : `The ${componentKey} access/censorship review is not a current known fact.`,
    adverseFactId: structural ? `${context.asset.assetId}:access:${componentKey}:${structuralDisposition}` : undefined,
  });
}

export function buildAccessReview(
  context: AssetBuildContext,
  reserves?: Pick<V9AssetFactsBase, "reserveStatus" | "reserveExposures">,
  dependencies?: V9EffectiveDependenciesV3,
): V9AccessReviewV2 {
  const review = context.asset.accessReview;
  if (review === null) {
    return {
      transfer: {
        status: missingLocalFact(context, {
          componentKey: "access:transfer",
          reasonCode: "missing-access-review",
          ownerDomain: "control",
          responsibility: "integration-missing",
          policyRuleId: "v9.access.transfer-review",
          message: "Transfer permissioning posture has not been reviewed.",
        }).status,
        posture: null,
      },
      freeze: {
        status: missingLocalFact(context, {
          componentKey: "access:freeze",
          reasonCode: "missing-access-review",
          ownerDomain: "control",
          responsibility: "integration-missing",
          policyRuleId: "v9.access.freeze-review",
          message: "Direct and upstream freeze reach have not been reviewed.",
        }).status,
        reviews: [],
      },
    };
  }
  const normalized: V9AccessReviewV2 = {
    ...review, transfer: { ...review.transfer }, freeze: { ...review.freeze },
  };
  const freezeDisposition = normalized.freeze.structuralDisposition;
  normalized.transfer.status = normalizeAccessStatus(context, normalized.transfer.status, "transfer");
  normalized.freeze.status = normalizeAccessStatus(context, normalized.freeze.status, "freeze", freezeDisposition);
  normalized.freeze.reviews = normalized.freeze.reviews.map((freezeReview) => ({
    ...freezeReview,
    status: normalizeAccessStatus(context, freezeReview.status, `freeze:${freezeReview.reviewKey}`, freezeDisposition),
  }));
  const sourceGraph = normalized.freeze.claimGraph;
  if (sourceGraph) {
    // Interned equal statuses and empty arrays may be shared across fields.
    // Copy only the rows/statuses/lists this compiler mutates; structuredClone
    // preserves aliases and would let an unresolved push corrupt failure domains.
    const copyStatus = <T extends { status: V9FactStatusV2 }>(row: T): T => ({
      ...row, status: { ...row.status },
    });
    const graph = {
      ...sourceGraph,
      nodes: sourceGraph.nodes.map(copyStatus),
      edges: sourceGraph.edges.map(copyStatus),
      authorities: sourceGraph.authorities.map(copyStatus),
      partitions: sourceGraph.partitions.map(copyStatus),
      unresolved: sourceGraph.unresolved.map(copyStatus),
    };
    normalized.freeze.claimGraph = graph;
    const pricedScopes = (context.asset.reserveScopeAdmissions ?? []).filter((scope) => scope.admitted && scope.wholeAssetComposition && (scope.kind === "portfolio-observation" || scope.kind === "onchain-observation"));
    // Receiving-book fractions may cross unit claims, never a second reserve denominator.
    const receivingBookNodes = new Set([graph.rootNodeKey]);
    let expanded = true;
    while (expanded) {
      expanded = false;
      for (const edge of graph.edges) {
        if (edge.basis.kind === "serial-claim" && edge.weight === 1 && edge.enabled && edge.reachesHeldClaim &&
          edge.status.observationState === "known" && receivingBookNodes.has(edge.fromNodeKey) && !receivingBookNodes.has(edge.toNodeKey)) {
          receivingBookNodes.add(edge.toNodeKey);
          expanded = true;
        }
      }
    }
    for (const edge of graph.edges) {
      if (edge.basis.kind === "reserve-position") {
        const basis = edge.basis;
        const target = graph.nodes.find((node) => node.nodeKey === edge.toNodeKey);
        const exposure = reserves?.reserveExposures.find((row) => row.exposureKey === basis.exposureKey);
        const liveObservation = context.fixedInput.liveReserveProvenanceMap[context.asset.assetId]?.reserveObservation;
        const staticRows = context.asset.reviewedStaticReserveRows;
        const scopeComplete = pricedScopes.some((scope) => exposure?.provenance === "live"
          ? liveObservation?.scopeId === scope.scopeId && liveObservation.observedAtSec === scope.observedAtSec
          : staticRows?.sourceKind === scope.kind && staticRows.scopeId === scope.scopeId);
        const exactKey = basis.sourceKey === null || computeSafetyScoreV9ReserveExposureKey({ name: "identity", pct: 100, risk: "low", sourceKey: basis.sourceKey }) === basis.exposureKey;
        const matched = exactKey && exposure?.status.observationState === "known" && (exposure.trackedAssetId === null || exposure.trackedAssetId === target?.assetId);
        edge.weight = matched && scopeComplete && receivingBookNodes.has(edge.fromNodeKey) && reserves?.reserveStatus.observationState === "known" ? exposure!.weight : null;
        if (!matched) edge.reachesHeldClaim = false;
      } else if (edge.basis.kind === "serial-claim" && edge.basis.dependencyEdgeKey !== null) {
        const key = edge.basis.dependencyEdgeKey;
        const target = graph.nodes.find((node) => node.nodeKey === edge.toNodeKey);
        if (dependencies?.status.observationState !== "known" || !dependencies.edges.some((row) => row.edgeKey === key && row.economicRole === "serial-claim" && row.upstreamAssetId === target?.assetId)) {
          edge.weight = null;
          edge.reachesHeldClaim = false;
        }
      }
    }
    for (const partition of graph.partitions) {
      const edges = graph.edges.filter((edge) => edge.partitionKey === partition.partitionKey);
      partition.denominatorEstablished = edges.length > 0 && edges.every((edge) => edge.weight !== null);
    }
    for (const { label, status } of v9AccessClaimGraphStatuses(graph)) {
      const branch = graph.unresolved.find((row) => label === `access:graph:unresolved:${row.branchKey}`);
      const binding = label.endsWith(":admission") ? label.slice(0, -":admission".length).replace("access:graph:unresolved:", "") : label;
      Object.assign(status, normalizeReviewedFactStatus(context, status, {
        bindingKey: binding, staleEvidenceError: `Access graph ${label} has inconsistent stale evidence`,
        gapId: `${context.asset.assetId}:gap:${label}`, reasonCode: "missing-access-review", ownerDomain: "control",
        componentKey: label, message: `Diagnostic reserve-access uncertainty: ${branch?.reason ?? "review incomplete"}.`,
        responsibility: branch?.responsibility,
      }));
    }
    const summary = evaluateV9AccessLookthrough(graph);
    if (summary.unresolvedCoverageShare === null) {
      for (const branch of summary.unresolved) {
        if (graph.unresolved.some((row) => row.branchKey === branch.branchKey)) continue;
        const evidenceRefIds = graph.nodes.find((node) => node.nodeKey === branch.nodeKey)?.status.evidenceRefIds ?? [];
        const fact = missingLocalFact(context, {
          componentKey: `access:graph:unresolved:${branch.branchKey}`, reasonCode: "missing-access-review", ownerDomain: "control",
          responsibility: branch.responsibility, policyRuleId: "v9.access.freeze-review",
          message: `Diagnostic reserve-access uncertainty: ${branch.reason}.`,
          observationState: evidenceRefIds.length > 0 ? "bounded-unknown" : "missing", evidenceRefIds,
        });
        graph.unresolved.push({ ...branch, status: fact.status });
      }
    }
  }
  return normalized;
}
