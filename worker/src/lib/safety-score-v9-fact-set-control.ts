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
} from "@shared/types/safety-score-v9-facts";
import type { AssetExtension } from "./safety-score-v9-fact-set-schema";
import {
  addGap,
  assertKnownComponentEvidenceCurrent,
  componentResearchEvidence,
  missingLocalFact,
  reviewedGapResponsibility,
  type AssetBuildContext,
} from "./safety-score-v9-fact-set-context";

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
  const status =
    review.state === "reviewed-controls"
      ? createV9FactStatus({
          applicability: requiredV9Applicability("v9.control.review"),
          observationState: "known",
          evidenceRefIds: evidenceIds,
        })
      : missingLocalFact(context, {
          componentKey: "deployment-controls",
          reasonCode: "unresolved-control-identity",
          ownerDomain: "control",
          responsibility: "issuer-undisclosed",
          policyRuleId: "v9.control.review",
          message: review.rationale,
          observationState: "bounded-unknown",
          evidenceRefIds: evidenceIds,
        }).status;
  const hasKnownControl = review.controls.some(controlCanCarryKnownStatus);
  if (review.state === "reviewed-controls" || hasKnownControl) {
    assertKnownComponentEvidenceCurrent(context, "control", evidenceIds);
  }
  return {
    controlStatus: status,
    controls: review.controls.map((control) => {
      const controlStatus = controlCanCarryKnownStatus(control)
        ? createV9FactStatus({
            applicability: requiredV9Applicability("v9.control.review"),
            observationState: "known",
            evidenceRefIds: evidenceIds,
          })
        : boundedControlSemanticsStatus(context, control, evidenceIds);
      return {
        ...control,
        sourceGenerationId: context.extension.sources.researchOverlays.generationId,
        status: controlStatus,
      };
    }),
  };
}

function controlCanCarryKnownStatus(control: ExtensionControlOverlay): boolean {
  return (
    control.authority !== null &&
    control.authority.model !== "unknown" &&
    control.failureDomains.length > 0 &&
    control.capSemantics.kind !== "unknown" &&
    control.claimImpairment !== "unknown" &&
    control.economicLossScope !== "unknown" &&
    control.incidentState !== "unknown"
  );
}

function boundedControlSemanticsStatus(
  context: AssetBuildContext,
  control: ExtensionControlOverlay,
  evidenceRefIds: readonly string[],
): V9FactStatusV2 {
  const gapId = addGap(
    context,
    createV9FactGapV3({
      gapId: `${context.asset.assetId}:gap:deployment-control:${control.controlKey}`,
      reasonCode: "unresolved-control-identity",
      ownerDomain: "control",
      policyRuleId: "v9.control.review",
      observationState: "bounded-unknown",
      responsibility: "issuer-undisclosed",
      path:
        control.scope === "deployment"
          ? { kind: "deployment-control", deploymentKey: control.deploymentKey, controlKey: control.controlKey }
          : { kind: "local-component", componentKey: `control:${control.controlKey}` },
      message: "The control inventory is known, but this control's authority or economic semantics remain unresolved.",
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
  const bindingKey = `economic-control:${componentKey}`;
  const evidenceIds =
    original.observationState === "known" ||
    original.observationState === "stale" ||
    original.observationState === "bounded-unknown"
      ? componentResearchEvidence(context, bindingKey)
      : [];
  if (original.observationState === "known") {
    assertKnownComponentEvidenceCurrent(context, bindingKey, evidenceIds);
    return createV9FactStatus({
      applicability: original.applicability,
      observationState: "known",
      evidenceRefIds: evidenceIds,
    });
  }
  const keepEvidence = original.observationState === "stale" || original.observationState === "bounded-unknown";
  if (
    original.observationState === "stale" &&
    !evidenceIds.some((evidenceId) => context.evidence.get(evidenceId)?.freshness.state === "stale")
  ) {
    throw new Error(
      `Economic-control review ${context.asset.assetId}:${componentKey} is stale but its source is current`,
    );
  }
  const evidenceRefIds = keepEvidence ? evidenceIds : [];
  const gapId = addGap(
    context,
    createV9FactGapV3({
      gapId: `${context.asset.assetId}:gap:economic-control:${componentKey}`,
      reasonCode,
      ownerDomain: "control",
      policyRuleId: original.applicability.policyRuleId,
      observationState: original.observationState,
      responsibility: reviewedGapResponsibility(original.observationState),
      path: { kind: "local-component", componentKey: `economic-control:${componentKey}` },
      message: `The ${componentKey} economic-control review is not a current known fact.`,
      evidenceRefIds,
    }),
  );
  return createV9FactStatus({
    applicability:
      original.applicability.state === "unresolved" ? { ...original.applicability, gapId } : original.applicability,
    observationState: original.observationState,
    evidenceRefIds,
    gapIds: [gapId],
  });
}

export function buildEconomicControlReview(context: AssetBuildContext): V9EconomicControlReviewV2 {
  const review = context.asset.economicControlReview;
  if (review === null) {
    return {
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
    };
  }
  const normalized = structuredClone(review);
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
  return normalized;
}

function normalizeAccessStatus(
  context: AssetBuildContext,
  original: V9FactStatusV2,
  componentKey: string,
  structurallyReviewed = false,
): V9FactStatusV2 {
  const bindingKey = `access:${componentKey}`;
  const evidenceIds =
    original.observationState === "known" ||
    original.observationState === "stale" ||
    original.observationState === "bounded-unknown"
      ? componentResearchEvidence(context, bindingKey)
      : [];
  if (original.observationState === "known") {
    assertKnownComponentEvidenceCurrent(context, bindingKey, evidenceIds);
    return createV9FactStatus({
      applicability: original.applicability,
      observationState: "known",
      evidenceRefIds: evidenceIds,
    });
  }
  const keepEvidence = original.observationState === "stale" || original.observationState === "bounded-unknown";
  if (
    original.observationState === "stale" &&
    !evidenceIds.some((evidenceId) => context.evidence.get(evidenceId)?.freshness.state === "stale")
  ) {
    throw new Error(`Access review ${context.asset.assetId}:${componentKey} is stale but its source is current`);
  }
  const evidenceRefIds = keepEvidence ? evidenceIds : [];
  // Owner ruling 2026-07-27: a current, evidenced structural verdict
  // (inherited-upstream) is a measured fact, not missing data. The status
  // stays bounded-unknown for scoring and the gap invariant is preserved, but
  // the gap carries the measured classification (same diagnostic treatment)
  // instead of missing-access-review. Stale and missing states still report
  // missing data regardless of the disposition.
  const structural = structurallyReviewed && original.observationState === "bounded-unknown";
  const gapId = addGap(
    context,
    createV9FactGapV3({
      gapId: `${context.asset.assetId}:gap:access:${componentKey}`,
      reasonCode: structural ? "inherited-access-exposure" : "missing-access-review",
      ownerDomain: "control",
      policyRuleId: original.applicability.policyRuleId,
      observationState: original.observationState,
      responsibility: structural ? "measured-adverse" : reviewedGapResponsibility(original.observationState),
      path: { kind: "local-component", componentKey: `access:${componentKey}` },
      message: structural
        ? `The ${componentKey} access posture is a reviewed structural fact: exposure is inherited from a named upstream asset.`
        : `The ${componentKey} access/censorship review is not a current known fact.`,
      evidenceRefIds,
    }),
  );
  return createV9FactStatus({
    applicability:
      original.applicability.state === "unresolved" ? { ...original.applicability, gapId } : original.applicability,
    observationState: original.observationState,
    evidenceRefIds,
    gapIds: [gapId],
  });
}

export function buildAccessReview(context: AssetBuildContext): V9AccessReviewV2 {
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
  const normalized = structuredClone(review);
  const structurallyReviewed = normalized.freeze.structuralDisposition != null;
  normalized.transfer.status = normalizeAccessStatus(context, normalized.transfer.status, "transfer");
  normalized.freeze.status = normalizeAccessStatus(context, normalized.freeze.status, "freeze", structurallyReviewed);
  normalized.freeze.reviews = normalized.freeze.reviews.map((freezeReview) => ({
    ...freezeReview,
    status: normalizeAccessStatus(
      context,
      freezeReview.status,
      `freeze:${freezeReview.reviewKey}`,
      structurallyReviewed,
    ),
  }));
  return normalized;
}
