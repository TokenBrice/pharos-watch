import { canonicalV9DependencyEdgeKey } from "@shared/lib/safety-score-v9/facts";
import { V9_CANDIDATE_POLICY_V1 } from "@shared/lib/safety-score-v9/policy";
import {
  createV9EvidenceReference,
  createV9FactStatus,
  notApplicableV9Fact,
  requiredV9Applicability,
} from "@shared/lib/safety-score-v9/evidence";
import {
  collateralExposureV9Path,
  createV9FactGapV3,
} from "@shared/lib/safety-score-v9/reasons";
import { compareText, domainDigest } from "@shared/lib/safety-score-v9/primitives";
import { stableJsonStringifyV1 } from "@shared/lib/stable-json";
import {
  defaultV9DependencyEconomicRole,
  type V9DependencyEconomicRole,
} from "@shared/types/dependency-types";
import type {
  V9AssetFactsV2,
  V9EffectiveDependenciesV3,
  V9FactStatusV2,
  V9MechanismExitFactV1,
  V9MechanismRiskReviewFactV2,
  V9ReserveExposureFactV2,
} from "@shared/types/safety-score-v9-facts";
import type {
  V9CdpStressCoverageFact,
  V9MechanismRiskReview,
} from "@shared/types/safety-score-v9-backing";
import type { ReserveSlice } from "@shared/types/reserves";
import { computeSafetyScoreV9ReserveExposureKey } from "./safety-score-v9-fact-set-schema";
import {
  addEvidence,
  addGap,
  assertKnownComponentEvidenceCurrent,
  componentResearchEvidence,
  evidenceHistoryFor,
  missingLocalFact,
  researchEvidence,
  reviewedGapResponsibility,
  stableFailureDomains,
  type AssetBuildContext,
} from "./safety-score-v9-fact-set-context";

export function buildImplementation(context: AssetBuildContext): V9AssetFactsV2["implementation"] {
  if (context.asset.launchedAtSec === null) {
    return {
      status: missingLocalFact(context, {
        componentKey: "implementation-date",
        reasonCode: "missing-implementation-date",
        ownerDomain: "evidence",
        responsibility: "integration-missing",
        policyRuleId: "v9.implementation.launch-date",
        message: "No reviewed implementation launch date is present in the v9 research overlay.",
      }).status,
      launchedAtSec: null,
    };
  }
  return {
    status: createV9FactStatus({
      applicability: requiredV9Applicability("v9.implementation.launch-date"),
      observationState: "known",
      evidenceRefIds: [researchEvidence(context)],
    }),
    launchedAtSec: context.asset.launchedAtSec,
  };
}

function normalizeMechanismReview(
  context: AssetBuildContext,
  review: V9MechanismRiskReview,
): V9MechanismRiskReviewFactV2 {
  const evidenceIds = componentResearchEvidence(context, "mechanism-risk-review");
  const evidence = context.evidence.get(evidenceIds[0]!)!;
  const normalized = structuredClone(review) as V9MechanismRiskReview;
  const componentGapIds: string[] = [];
  const componentEvidenceIds = new Set<string>();
  let hasStale = false;
  let hasIncomplete = false;

  const metricApplicability =
    "metricApplicability" in normalized
      ? (normalized.metricApplicability as
          | Record<string, { state: string; evidenceRefIds?: string[] }>
          | undefined)
      : undefined;
  if (metricApplicability) {
    for (const applicability of Object.values(metricApplicability)) {
      if (applicability.state === "measured") continue;
      applicability.evidenceRefIds = evidenceIds;
      for (const evidenceId of evidenceIds) componentEvidenceIds.add(evidenceId);
    }
  }

  for (const [componentKey, value] of Object.entries(normalized)) {
    if (value === null || typeof value !== "object" || !("status" in value)) continue;
    const fact = value as { status: V9FactStatusV2 };
    const original = fact.status;
    if (original.observationState === "known") {
      fact.status = createV9FactStatus({
        applicability: original.applicability,
        observationState: "known",
        evidenceRefIds: evidenceIds,
      });
      for (const evidenceId of evidenceIds) componentEvidenceIds.add(evidenceId);
      continue;
    }
    // A missing non-serial component is bounded like a stale or
    // bounded-unknown one: it scores at the bounded-unknown quality and the
    // serial-component rule in the evaluator still fails closed when a
    // required serial claim is absent. Only an unsupported design stays a
    // critical evidence failure.
    const gapId = addGap(
      context,
      createV9FactGapV3({
        gapId: `${context.asset.assetId}:gap:mechanism-review:${componentKey}`,
        reasonCode:
          original.observationState === "unsupported" ? "missing-pillar-evidence" : "bounded-mechanism-review",
        ownerDomain: "backing",
        policyRuleId: original.applicability.policyRuleId,
        observationState: original.observationState,
        responsibility:
          context.asset.mechanismReviewGapDisposition?.componentKeys.includes(componentKey) === true
            ? context.asset.mechanismReviewGapDisposition.responsibility
            : reviewedGapResponsibility(original.observationState),
        path: { kind: "local-component", componentKey: `mechanism-review:${componentKey}` },
        message:
          context.asset.mechanismReviewGapDisposition?.componentKeys.includes(componentKey) === true
            ? context.asset.mechanismReviewGapDisposition.rationale
            : `The ${componentKey} mechanism review is not a current known fact.`,
        evidenceRefIds:
          original.observationState === "stale" || original.observationState === "bounded-unknown" ? evidenceIds : [],
        evidenceHistory: evidenceHistoryFor(context, evidenceIds),
      }),
    );
    const applicability =
      original.applicability.state === "unresolved" ? { ...original.applicability, gapId } : original.applicability;
    fact.status = createV9FactStatus({
      applicability,
      observationState: original.observationState,
      evidenceRefIds:
        original.observationState === "stale" || original.observationState === "bounded-unknown" ? evidenceIds : [],
      gapIds: [gapId],
    });
    if (original.observationState === "stale") {
      hasStale = true;
      if (evidence.freshness.state !== "stale") {
        throw new Error(`Mechanism review ${context.asset.assetId}:${componentKey} is stale but its source is current`);
      }
    } else {
      hasIncomplete = true;
    }
    componentGapIds.push(gapId);
    if (fact.status.evidenceRefIds.length > 0) {
      for (const evidenceId of evidenceIds) componentEvidenceIds.add(evidenceId);
    }
  }

  const observationState = hasIncomplete ? "bounded-unknown" : hasStale ? "stale" : "known";
  return {
    status: createV9FactStatus({
      applicability: requiredV9Applicability("v9.backing.mechanism-review"),
      observationState,
      evidenceRefIds: [...componentEvidenceIds],
      gapIds: componentGapIds,
    }),
    review: normalized,
  };
}

export function buildMechanismReview(context: AssetBuildContext): V9MechanismRiskReviewFactV2 {
  if (context.asset.mechanismRiskReview === null) {
    const unresolvedArchetype = context.asset.archetype === "unresolved";
    if (unresolvedArchetype) {
      // A missing archetype is a METHODOLOGY classification failure, not a
      // backing evidence gap: the policy binds missing-archetype to the
      // methodology owner and path (queue-contract reconciliation).
      const gapId = addGap(
        context,
        createV9FactGapV3({
          gapId: `${context.asset.assetId}:gap:mechanism-risk-review`,
          reasonCode: "missing-archetype",
          ownerDomain: "methodology",
          policyRuleId: "v9.backing.mechanism-review",
          observationState: "missing",
          responsibility: "method-unsupported",
          path: { kind: "methodology", componentKey: "mechanism-risk-review" },
          message: "The asset does not yet have a resolved Safety Score v9 mechanism archetype.",
        }),
      );
      return {
        status: createV9FactStatus({
          applicability: requiredV9Applicability("v9.backing.mechanism-review"),
          observationState: "missing",
          gapIds: [gapId],
        }),
        review: null,
      };
    }
    return {
      status: missingLocalFact(context, {
        componentKey: "mechanism-risk-review",
        // An absent review with a resolved archetype is bounded under the
        // candidate policy: the backing pillar scores at the bounded-unknown
        // quality instead of reason-coding NR.
        reasonCode: "bounded-mechanism-review",
        ownerDomain: "backing",
        responsibility:
          context.asset.mechanismReviewGapDisposition?.responsibility ?? "integration-missing",
        policyRuleId: "v9.backing.mechanism-review",
        message:
          context.asset.mechanismReviewGapDisposition?.rationale ??
          "No policy-independent archetype mechanism review is present in the v9 overlay.",
      }).status,
      review: null,
    };
  }
  if (context.asset.mechanismRiskReview.archetype !== context.asset.archetype) {
    throw new Error(`Mechanism review archetype mismatch for ${context.asset.assetId}`);
  }
  return normalizeMechanismReview(context, context.asset.mechanismRiskReview);
}

export function buildMechanismExitFacts(context: AssetBuildContext): V9MechanismExitFactV1[] {
  if ((context.asset.mechanismExitFacts?.length ?? 0) === 0) return [];
  const evidenceRefIds = componentResearchEvidence(context, "mechanism-risk-review");
  return context.asset.mechanismExitFacts!.map((fact) => ({
    ...fact,
    evidenceRefIds,
  }));
}

export function buildCdpStressCoverage(context: AssetBuildContext): V9CdpStressCoverageFact | undefined {
  if (context.asset.archetype !== "cdp") return undefined;
  const selected = context.asset.cdpStressCoverage;
  if (selected === undefined) return undefined;
  const fact = structuredClone(selected);
  if (fact.source !== null) {
    fact.evidenceRefIds = [
      addEvidence(
        context,
        createV9EvidenceReference(
          {
            evidenceId: `${context.asset.assetId}:cdp-shock-coverage:${fact.source.journalSha256.slice(0, 16)}`,
            sourceId: "safety-score-v9.cdp-shock-coverage-measurement",
            sourceGenerationId: `cdp-shock-coverage:v1:${fact.source.journalSha256}`,
            disposition: "observed",
            observedAtSec: fact.source.block.timestampUnix,
            url: fact.source.sourcePin.repository,
            contentSha256: fact.source.journalSha256,
            // D12: the owner-ratified 72h stress-measurement freshness bound
            // already gates selection in the CDP shock adapter; the evidence
            // ref now carries the same window.
            maxAgeSec:
              V9_CANDIDATE_POLICY_V1.policy.semantic.backing.structural.cdp.stressMeasurementFreshness.maxAgeSec,
          },
          context.fixedInput.clockSec,
        ),
      ),
    ];
  }
  // Already validated: the extension's `cdpStressCoverage` is parsed at the
  // extension boundary, and this function only rewrites `evidenceRefIds`.
  return fact;
}

function dependencyPathKind(
  role: V9DependencyEconomicRole,
): "serial-dependency" | "collateral-exposure" | "local-component" {
  if (role === "serial-claim") return "serial-dependency";
  return role === "basket-exposure" ? "collateral-exposure" : "local-component";
}

export function buildDependencies(context: AssetBuildContext): V9EffectiveDependenciesV3 {
  const overlay = context.asset.dependencies;
  if (overlay === null) {
    return {
      status: missingLocalFact(context, {
        componentKey: "effective-dependencies",
        reasonCode: "unreviewed-dependency-relationships",
        ownerDomain: "dependency",
        responsibility: "integration-missing",
        policyRuleId: "v9.dependencies.effective-set",
        message: "The exact effective dependency set has not been reviewed for v9.",
      }).status,
      sourceGenerationId: context.extension.sources.researchOverlays.generationId,
      source: "none",
      baseSource: "none",
      dependencyFromLive: false,
      mappedLiveReserveWeight: null,
      fallbackReason: null,
      edges: [],
      diagnostics: { graphState: "unresolved", issueCodes: ["missing-v9-review"], sccMemberAssetIds: [] },
    };
  }

  const source = overlay.dependencyFromLive
    ? context.extension.sources.liveReserves
    : context.extension.sources.researchOverlays;
  const evidenceIds = overlay.dependencyFromLive
    ? [
        addEvidence(
          context,
          createV9EvidenceReference(
            {
              evidenceId: `${context.asset.assetId}:effective-dependencies`,
              sourceId: "report-cards-live-reserves",
              sourceGenerationId: source.generationId,
              disposition: "observed",
              observedAtSec: source.observedAtSec,
              contentSha256: domainDigest("safety-score-v9.effective-dependencies.v1", overlay),
              maxAgeSec: source.maxAgeSec,
            },
            context.fixedInput.clockSec,
          ),
        ),
      ]
    : componentResearchEvidence(context, "dependencies");
  let status: V9FactStatusV2;
  if (overlay.diagnostics.graphState === "valid") {
    assertKnownComponentEvidenceCurrent(context, "dependencies", evidenceIds);
    status = createV9FactStatus({
      applicability: requiredV9Applicability("v9.dependencies.effective-set"),
      observationState: "known",
      evidenceRefIds: evidenceIds,
    });
  } else {
    status = missingLocalFact(context, {
      componentKey: "effective-dependencies",
      reasonCode: "unreviewed-dependency-relationships",
      ownerDomain: "dependency",
      responsibility: "method-unsupported",
      policyRuleId: "v9.dependencies.effective-set",
      message: `The effective dependency graph is ${overlay.diagnostics.graphState}.`,
      observationState: "bounded-unknown",
      evidenceRefIds: evidenceIds,
    }).status;
  }
  return {
    status,
    sourceGenerationId: source.generationId,
    source: overlay.source,
    baseSource: overlay.baseSource,
    dependencyFromLive: overlay.dependencyFromLive,
    mappedLiveReserveWeight: overlay.mappedLiveReserveWeight,
    fallbackReason: overlay.fallbackReason,
    edges: overlay.edges.map((edge) => {
      const economicRole = edge.economicRole ?? defaultV9DependencyEconomicRole(edge.dependencyType);
      return {
        edgeKey: canonicalV9DependencyEdgeKey(edge.dependencyType, edge.upstreamAssetId, economicRole),
        upstreamAssetId: edge.upstreamAssetId,
        dependencyType: edge.dependencyType,
        pathKind: dependencyPathKind(economicRole),
        weight: edge.weight,
        economicRole,
        evidenceRefIds: evidenceIds,
        failureDomains: edge.failureDomains,
      };
    }),
    diagnostics: overlay.diagnostics,
  };
}

function reserveSourceEvidence(
  context: AssetBuildContext,
  exposureKey: string,
  slices: readonly ReserveSlice[],
): string {
  const source = context.extension.sources.liveReserves;
  const provenance = context.fixedInput.liveReserveProvenanceMap[context.asset.assetId];
  return addEvidence(
    context,
    createV9EvidenceReference(
      {
        evidenceId: `${context.asset.assetId}:reserve:${exposureKey}`,
        sourceId: provenance?.source ?? "report-cards-live-reserves",
        sourceGenerationId: source.generationId,
        disposition: "observed",
        observedAtSec: provenance?.fetchedAt ?? source.observedAtSec,
        contentSha256: domainDigest("safety-score-v9.reserve-exposure.v1", slices),
        maxAgeSec: source.maxAgeSec,
      },
      context.fixedInput.clockSec,
    ),
  );
}

function assertCompatibleReserveClassification(
  assetId: string,
  raw: ReserveSlice,
  classification: AssetBuildContext["asset"]["reserveClassifications"][number] | undefined,
): void {
  if (!classification) return;
  for (const [rawField, overlayField] of [
    [raw.assetClass, classification.assetClass],
    [raw.issuerOrObligor, classification.issuerOrObligorKey],
    [raw.liquidityHorizon, classification.liquidityHorizon],
    [raw.maturityDaysMax, classification.maturityDaysMax],
  ] as const) {
    if (rawField !== undefined && overlayField !== null && rawField !== overlayField) {
      throw new Error(`Reserve classification overlay conflicts with exact base facts for ${assetId}`);
    }
  }
}

export function buildReserves(context: AssetBuildContext): {
  reserveStatus: V9FactStatusV2;
  reserveExposures: V9ReserveExposureFactV2[];
} {
  if (context.asset.reserveApplicability.state === "not-applicable") {
    if (
      (context.fixedInput.liveReserveMap[context.asset.assetId] ?? []).length > 0 ||
      context.asset.reviewedStaticReserveRows != null
    ) {
      throw new Error(`Reserve applicability for ${context.asset.assetId} conflicts with captured reserve rows`);
    }
    return {
      reserveStatus: createV9FactStatus({
        applicability: notApplicableV9Fact(
          "v9.backing.reserve-composition",
          context.asset.reserveApplicability.rationale,
        ),
        observationState: "known",
        evidenceRefIds: [researchEvidence(context)],
      }),
      reserveExposures: [],
    };
  }

  const liveSlices = context.fixedInput.liveReserveMap[context.asset.assetId] ?? [];
  const reviewedStatic = liveSlices.length === 0 ? (context.asset.reviewedStaticReserveRows ?? null) : null;
  const slices = reviewedStatic?.rows ?? liveSlices;
  if (slices.length === 0) {
    const hasReserveHistory = context.asset.componentEvidence.some(
      (binding) => binding.componentKey === "reserve-composition-history",
    );
    const reserveHistoryEvidenceIds = hasReserveHistory
      ? componentResearchEvidence(context, "reserve-composition-history")
      : [];
    const expiredPublishedHistory = reserveHistoryEvidenceIds.some(
      (evidenceId) => context.evidence.get(evidenceId)?.freshness.state === "stale",
    );
    return {
      reserveStatus: missingLocalFact(context, {
        componentKey: "reserve-composition",
        reasonCode: "missing-reserve-composition",
        ownerDomain: "backing",
        // Fallback only: `resolveV9EvidenceResponsibility` upgrades this to
        // `published-evidence-expired` when the stale evidence carries an
        // attributable publisher. Deciding it here would mislabel a document
        // whose publisher is unknown as something the issuer published.
        responsibility: "issuer-undisclosed",
        policyRuleId: "v9.backing.reserve-composition",
        message: expiredPublishedHistory
          ? "The last published reserve composition is older than the v9 freshness bound."
          : "No reserve composition is present in the exact fixed input.",
        ...(expiredPublishedHistory
          ? { observationState: "stale" as const, evidenceRefIds: reserveHistoryEvidenceIds }
          : {}),
      }).status,
      reserveExposures: [],
    };
  }

  const grouped = new Map<string, ReserveSlice[]>();
  for (const slice of slices) {
    if (!slice.name.trim()) throw new Error(`Reserve slice for ${context.asset.assetId} has no stable identity`);
    const key = computeSafetyScoreV9ReserveExposureKey(slice);
    grouped.set(key, [...(grouped.get(key) ?? []), slice]);
  }
  const classificationByKey = new Map(
    context.asset.reserveClassifications.map((classification) => [classification.exposureKey, classification]),
  );
  const consumedClassifications = new Set<string>();
  const exposures: V9ReserveExposureFactV2[] = [];
  const envelopeGapIds: string[] = [];
  const envelopeEvidenceIds: string[] = [];
  if (
    reviewedStatic &&
    !context.asset.componentEvidence.some((binding) => binding.componentKey === "reviewed-static-reserves")
  ) {
    throw new Error(`Reviewed static reserve admission has no bound evidence for ${context.asset.assetId}`);
  }
  const reviewedStaticEvidenceIds = reviewedStatic
    ? componentResearchEvidence(context, "reviewed-static-reserves")
    : [];

  for (const [exposureKey, groupedSlices] of [...grouped].sort(([left], [right]) => compareText(left, right))) {
    const raw = groupedSlices[0]!;
    if (
      groupedSlices.some(
        (slice) =>
          stableJsonStringifyV1({ ...slice, pct: undefined }) !== stableJsonStringifyV1({ ...raw, pct: undefined }),
      )
    ) {
      throw new Error(`Reserve exposure identity ${exposureKey} is ambiguous for ${context.asset.assetId}`);
    }
    const weight = groupedSlices.reduce((sum, slice) => sum + slice.pct / 100, 0);
    if (weight > 1.000001) throw new Error(`Reserve exposure ${exposureKey} exceeds full notional weight`);
    const classification = classificationByKey.get(exposureKey);
    if (classification) consumedClassifications.add(exposureKey);
    assertCompatibleReserveClassification(context.asset.assetId, raw, classification);
    const evidenceIds = reviewedStatic
      ? reviewedStaticEvidenceIds
      : [reserveSourceEvidence(context, exposureKey, groupedSlices)];
    const reviewedNonLink = classification?.trackedAssetDisposition === "reviewed-non-link";
    const trackedAssetId = reviewedNonLink
      ? null
      : (raw.coinId ?? classification?.trackedAssetId ?? null);
    const issuerOrObligorKey = classification?.issuerOrObligorKey ?? raw.issuerOrObligor ?? null;
    const assetClass = classification?.assetClass ?? raw.assetClass ?? (trackedAssetId ? ("stablecoin" as const) : null);
    const failureDomains = stableFailureDomains([
      ...(classification?.failureDomains ?? []),
      ...(issuerOrObligorKey ? [{ kind: "reserve-issuer" as const, key: issuerOrObligorKey }] : []),
      ...(trackedAssetId ? [{ kind: "reserve-issuer" as const, key: `asset:${trackedAssetId}` }] : []),
    ]);
    const classificationKnown = assetClass !== null && failureDomains.length > 0;
    let status: V9FactStatusV2;
    if (!classificationKnown) {
      const gapId = addGap(
        context,
        createV9FactGapV3({
          gapId: `${context.asset.assetId}:gap:reserve:${exposureKey}`,
          reasonCode: "material-reserve-slice-unstructured",
          ownerDomain: "backing",
          policyRuleId: "v9.backing.reserve-classification",
          observationState: "bounded-unknown",
          responsibility: "integration-missing",
          path: collateralExposureV9Path(exposureKey),
          message: "The captured reserve slice lacks a complete v9 classification or failure-domain identity.",
          evidenceRefIds: evidenceIds,
          evidenceHistory: evidenceHistoryFor(context, evidenceIds),
        }),
      );
      envelopeGapIds.push(gapId);
      status = createV9FactStatus({
        applicability: requiredV9Applicability("v9.backing.reserve-classification"),
        observationState: "bounded-unknown",
        evidenceRefIds: evidenceIds,
        gapIds: [gapId],
      });
    } else if (evidenceIds.some((evidenceId) => context.evidence.get(evidenceId)?.freshness.state === "stale")) {
      const gapId = addGap(
        context,
        createV9FactGapV3({
          gapId: `${context.asset.assetId}:gap:reserve:${exposureKey}:stale`,
          reasonCode: "partial-reserve-review",
          ownerDomain: "backing",
          policyRuleId: "v9.backing.reserve-freshness",
          observationState: "stale",
          responsibility: "producer-failed",
          path: collateralExposureV9Path(exposureKey),
          message: "The last-known reserve exposure is older than the v9 freshness bound.",
          evidenceRefIds: evidenceIds,
          evidenceHistory: evidenceHistoryFor(context, evidenceIds),
        }),
      );
      envelopeGapIds.push(gapId);
      status = createV9FactStatus({
        applicability: requiredV9Applicability("v9.backing.reserve-classification"),
        observationState: "stale",
        evidenceRefIds: evidenceIds,
        gapIds: [gapId],
      });
    } else {
      status = createV9FactStatus({
        applicability: requiredV9Applicability("v9.backing.reserve-classification"),
        observationState: "known",
        evidenceRefIds: evidenceIds,
      });
    }
    envelopeEvidenceIds.push(...evidenceIds);
    exposures.push({
      exposureKey,
      classificationKey: classification?.classificationKey ?? `base:${exposureKey}`,
      sourceGenerationId: reviewedStatic
        ? context.extension.sources.researchOverlays.generationId
        : context.extension.sources.liveReserves.generationId,
      provenance: reviewedStatic ? reviewedStatic.provenance : "live",
      ...(reviewedStatic
        ? {
            evidenceClass: reviewedStatic.evidenceClass,
          }
        : {}),
      status,
      name: raw.name.trim(),
      weight,
      trackedAssetId,
      assetClass,
      issuerOrObligorKey,
      riskFactors: classification?.riskFactors ?? raw.riskFactors ?? [],
      liquidityHorizon: classification?.liquidityHorizon ?? raw.liquidityHorizon ?? null,
      maturityDaysMax: classification?.maturityDaysMax ?? raw.maturityDaysMax ?? null,
      failureDomains,
    });
  }
  const unconsumed = [...classificationByKey.keys()].filter((key) => !consumedClassifications.has(key));
  if (unconsumed.length > 0) {
    throw new Error(
      `Reserve classifications do not match captured exposures for ${context.asset.assetId}: ${unconsumed}`,
    );
  }
  return {
    reserveStatus: createV9FactStatus({
      applicability: requiredV9Applicability("v9.backing.reserve-composition"),
      observationState: envelopeGapIds.length > 0 ? "bounded-unknown" : "known",
      evidenceRefIds: [...new Set(envelopeEvidenceIds)],
      gapIds: envelopeGapIds,
    }),
    reserveExposures: exposures,
  };
}

export function reconcileCollateralDependencyMappings(
  context: AssetBuildContext,
  dependencies: V9EffectiveDependenciesV3,
  reserveExposures: readonly V9ReserveExposureFactV2[],
): V9EffectiveDependenciesV3 {
  const mappedWeightByUpstream = new Map<string, number>();
  for (const exposure of reserveExposures) {
    if (exposure.trackedAssetId === null) continue;
    mappedWeightByUpstream.set(
      exposure.trackedAssetId,
      (mappedWeightByUpstream.get(exposure.trackedAssetId) ?? 0) + exposure.weight,
    );
  }
  const mappingIssues = dependencies.edges.flatMap((edge) => {
    if (edge.economicRole !== "basket-exposure") return [];
    const mappedWeight = mappedWeightByUpstream.get(edge.upstreamAssetId);
    if (mappedWeight === undefined) return [`collateral-edge-exposure-unmapped:${edge.upstreamAssetId}`];
    if (Math.abs(mappedWeight - edge.weight) > 0.000001) {
      return [`collateral-edge-exposure-weight-mismatch:${edge.upstreamAssetId}`];
    }
    return [];
  });
  if (mappingIssues.length === 0) return dependencies;

  const evidenceRefIds = [
    ...new Set([
      ...dependencies.status.evidenceRefIds,
      ...reserveExposures.flatMap((exposure) => exposure.status.evidenceRefIds),
    ]),
  ].sort(compareText);
  // A missing reserve envelope is only a producer failure when a reserve
  // producer was expected at all. `liveToFallbackCoins` is exactly the set of
  // assets that declare a `liveReservesConfig` but published no scoring-grade
  // snapshot this run (`summarizeCollateralDriftFromLiveReserveMap`), so the
  // union with `liveReserveMap` is precisely "this asset has a live-reserve
  // adapter". An asset in neither has no producer to fail: its envelope gap is
  // a method limit, not a misattributed producer failure (owner ruling
  // 2026-07-29, usdh-hubble).
  const liveReserveProducerExpected =
    context.fixedInput.liveReserveMap[context.asset.assetId] != null ||
    context.fixedInput.liveToFallbackCoins.includes(context.asset.assetId);
  const omittedCuratedEnvelope =
    reserveExposures.length === 0 &&
    dependencies.source === "curated-reserve" &&
    dependencies.edges.some((edge) => edge.economicRole === "basket-exposure");
  const producerOmittedCuratedEnvelope = omittedCuratedEnvelope && liveReserveProducerExpected;
  const unsupportedCuratedEnvelope = omittedCuratedEnvelope && !liveReserveProducerExpected;
  const status =
    dependencies.status.observationState === "known"
      ? missingLocalFact(context, {
          componentKey: "effective-dependencies",
          reasonCode: "unreviewed-dependency-relationships",
          ownerDomain: "dependency",
          responsibility: producerOmittedCuratedEnvelope
            ? "producer-failed"
            : unsupportedCuratedEnvelope
              ? "method-unsupported"
              : "integration-missing",
          policyRuleId: "v9.dependencies.edge-exposure-mapping",
          message: producerOmittedCuratedEnvelope
            ? "Reviewed collateral identities exist, but the exact fixed input contains no reserve envelope to reconcile."
            : unsupportedCuratedEnvelope
              ? "Reviewed collateral identities exist, but no live-reserve adapter is configured for this asset, so no reserve envelope can be measured."
              : "A collateral dependency edge lacks an exact mapping to the captured reserve exposures.",
          observationState: "bounded-unknown",
          evidenceRefIds,
        }).status
      : dependencies.status;
  return {
    ...dependencies,
    status,
    diagnostics: {
      graphState: dependencies.diagnostics.graphState === "valid" ? "unresolved" : dependencies.diagnostics.graphState,
      issueCodes: [...new Set([...dependencies.diagnostics.issueCodes, ...mappingIssues])].sort(compareText),
      sccMemberAssetIds: dependencies.diagnostics.sccMemberAssetIds,
    },
  };
}
