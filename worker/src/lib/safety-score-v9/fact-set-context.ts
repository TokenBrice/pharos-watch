import { resolveChainId } from "@shared/types/chain-identity";
import { getRedemptionBackstopConfig } from "@shared/lib/redemption-backstops";
import {
  createV9EvidenceReference,
  createV9ClassificationEvidence,
  createV9TypedReviewEvidence,
  createV9FactStatus,
  requiredV9Applicability,
  resolveV9EvidenceCause,
  type V9PublishedEvidenceAttribution,
  type V9ResolvedEvidenceCause,
} from "@shared/lib/safety-score-v9/evidence";
import { createV9FactGapV3 } from "@shared/lib/safety-score-v9/reasons";
import { compareText, domainDigest } from "@shared/lib/safety-score-v9/primitives";
import { deepFreeze } from "@shared/types/safety-score-v9-immutable";
import { stableJsonStringifyV1 } from "@shared/lib/stable-json";
import type {
  V9EvidenceReferenceV2,
  V9EvidenceResponsibility,
  V9FactGapV3,
  V9FactStatusV2,
  V9FailureDomainRef,
} from "@shared/types/safety-score-v9-facts";
import type { V9AssetFactsV3, V9ExitRouteFactV2 } from "@shared/types/safety-score-v9-facts";
import type { SafetyScoreV9CompilerInput } from "./native-input";
import type {
  AssetExtension,
  SafetyScoreV9FactSetExtensionV2,
} from "./fact-set-schema";
import classificationsAsset from "@shared/data/safety-score-v9/evidence-gap-classifications-v1.json";
import {
  V9EvidenceGapClassificationSchema, V9TypedReviewGapClassificationSchema, v9EvidenceCauseScopeKey,
  type V9EvidenceCauseScope, type V9RuntimeProducerVerdict, type V9CauseResolutionDiagnostic,
} from "@shared/types/safety-score-v9-causes";
import { createReviewedAssetRegistry } from "./extension-reviewed-registry";
import { usesPrimaryRedemptionReviewTerms } from "../redemption-exit-route-observations";

// Immutable imported evaluation input; validation failures stay asset-local.
const classifications = createReviewedAssetRegistry({
  rows: classificationsAsset.entries,
  schema: V9EvidenceGapClassificationSchema,
  path: "evidenceGapClassifications.entries",
  keyOf: (row) => typeof row.id === "string" ? row.id : undefined,
  keyPath: "id",
});

function scopeForGap(gap: Pick<V9FactGapV3, "path" | "ownerDomain" | "policyRuleId">): V9EvidenceCauseScope {
  const pillar = gap.ownerDomain === "exit" ? "exit" : gap.ownerDomain === "control" ? "control" : "backing";
  const path = gap.path;
  const routeKey = path.kind === "optional-exit" ? path.routeKey : null;
  const exposureId = path.kind === "collateral-exposure" ? path.exposureKey : null;
  const componentKey = "componentKey" in path ? path.componentKey
    : path.kind === "deployment-control" ? `control:${path.controlKey}`
      : path.kind === "serial-dependency" ? `serial-dependency:${path.dependencyType}:${path.upstreamAssetId}`
        : routeKey !== null ? "exit-route" : exposureId !== null ? "reserve-exposure" : gap.policyRuleId;
  return { pillar, componentKey, factorKey: null, routeKey, exposureId, requiredDatum: componentKey };
}

export function createRuntimeGapVerdict(args: {
  assetId: string; scope: V9EvidenceCauseScope; sourceId: string; sourceGenerationId: string;
  observedAtSec: number; asOfSec: number; producerState: V9RuntimeProducerVerdict["proof"]["producerState"];
  rejectionCode: string; reason: string; contentSha256?: string | null; url?: string | null;
}): { verdict: V9RuntimeProducerVerdict; evidence: V9EvidenceReferenceV2 } {
  const evidenceId = `${args.assetId}:pipeline:${args.sourceGenerationId}:${domainDigest("safety-score-v9.pipeline-gap-scope.v1", args.scope).slice(0, 24)}`;
  const evidence = createV9EvidenceReference({
    evidenceId, sourceId: args.sourceId, sourceGenerationId: args.sourceGenerationId,
    observedAtSec: args.observedAtSec, disposition: "rejected", contentSha256: args.contentSha256, url: args.url,
    rejection: { code: args.rejectionCode, reason: args.reason, rejectedAtSec: args.observedAtSec },
    causeBinding: { assetId: args.assetId, scope: args.scope, producerState: args.producerState,
      rejectionCode: args.rejectionCode, adverseFactId: null },
  }, args.asOfSec);
  return { evidence, verdict: { assetId: args.assetId, scope: args.scope, proof: {
    cause: "A", producerState: args.producerState, sourceId: args.sourceId, sourceGenerationId: args.sourceGenerationId,
    observedAtSec: args.observedAtSec, rejectionCode: args.rejectionCode, evidenceRefIds: [evidenceId],
  } } };
}


export interface AssetBuildContext {
  readonly fixedInput: SafetyScoreV9CompilerInput;
  readonly extension: SafetyScoreV9FactSetExtensionV2;
  readonly asset: AssetExtension;
  readonly researchPayloadSha256: string;
  readonly evidence: Map<string, V9EvidenceReferenceV2>;
  readonly evidencePublisherById: Map<string, V9PublishedEvidenceAttribution>;
  readonly gaps: Map<string, V9FactGapV3>;
  readonly causeResolutionDiagnostics: V9CauseResolutionDiagnostic[];
}

export function projectResearchOverlayPayload(value: unknown): unknown {
  if (Array.isArray(value)) {
    let projected: unknown[] | undefined;
    for (let index = 0; index < value.length; index++) {
      const entry = projectResearchOverlayPayload(value[index]);
      if (entry !== value[index]) projected ??= value.slice();
      if (projected) projected[index] = entry;
    }
    return projected ?? value;
  }
  if (value === null || typeof value !== "object") return value;
  const record = value as Record<string, unknown>;
  if ("applicability" in record && "observationState" in record && "evidenceRefIds" in record && "gapIds" in record) {
    const applicability = record.applicability as Record<string, unknown>;
    return {
      applicability: {
        state: applicability.state,
        policyRuleId: applicability.policyRuleId,
        rationale: applicability.rationale,
      },
      observationState: record.observationState,
    };
  }
  let projected: Record<string, unknown> | undefined;
  for (const key of Object.keys(record)) {
    if (key === "cdpStressCoverage") {
      projected ??= { ...record };
      delete projected[key];
      continue;
    }
    const entry = projectResearchOverlayPayload(record[key]);
    if (entry !== record[key]) projected ??= { ...record };
    if (projected) projected[key] = entry;
  }
  return projected ?? value;
}

export function stableFailureDomains(domains: readonly V9FailureDomainRef[]): V9FailureDomainRef[] {
  const normalized = domains.map((domain): V9FailureDomainRef => {
    if (domain.kind !== "chain") return domain;
    return { kind: "chain", key: resolveChainId(domain.key) ?? domain.key.toLowerCase() };
  });
  return [...new Map(normalized.map((domain) => [`${domain.kind}:${domain.key}`, domain])).values()].sort(
    (left, right) => compareText(`${left.kind}:${left.key}`, `${right.kind}:${right.key}`),
  );
}

export function normalizeCompiledFailureDomains<T>(value: T): T {
  if (Array.isArray(value)) {
    let normalized: unknown[] | undefined;
    for (let index = 0; index < value.length; index++) {
      const entry: unknown = normalizeCompiledFailureDomains<unknown>(value[index]);
      if (entry !== value[index]) normalized ??= value.slice();
      if (normalized) normalized[index] = entry;
    }
    return (normalized ?? value) as T;
  }
  if (value === null || typeof value !== "object") return value;
  const record = value as Record<string, unknown>;
  let normalized: Record<string, unknown> | undefined;
  for (const key of Object.keys(record)) {
    const current = record[key];
    let entry: unknown;
    if (key === "failureDomains" && Array.isArray(current)) {
      const domains = current as V9FailureDomainRef[];
      const canonical = stableFailureDomains(domains);
      entry = domains.length === canonical.length && domains.every((domain, index) =>
        domain.kind === canonical[index]!.kind && domain.key === canonical[index]!.key)
        ? current : canonical;
    } else {
      entry = normalizeCompiledFailureDomains(current);
    }
    if (entry !== current) normalized ??= { ...record };
    if (normalized) normalized[key] = entry;
  }
  return (normalized ?? value) as T;
}

export function addEvidence(context: AssetBuildContext, evidence: V9EvidenceReferenceV2): string {
  const existing = context.evidence.get(evidence.evidenceId);
  if (existing && stableJsonStringifyV1(existing) !== stableJsonStringifyV1(evidence)) {
    throw new Error(`Conflicting Safety Score v9 evidence identity ${evidence.evidenceId}`);
  }
  context.evidence.set(evidence.evidenceId, evidence);
  return evidence.evidenceId;
}

function capturedReserveFailure(context: AssetBuildContext, scope: V9EvidenceCauseScope) {
  if (scope.pillar !== "backing" || scope.componentKey !== "reserve-composition" ||
      scope.factorKey !== null || scope.routeKey !== null || scope.exposureId !== null ||
      scope.requiredDatum !== "reserve-composition") return undefined;
  const records = context.fixedInput.evidenceJournalById?.[context.asset.assetId] ?? [];
  let latest: typeof records[number] | undefined;
  for (const record of records) {
    if (record.completedAtSec > context.fixedInput.clockSec) continue;
    if (!latest || record.completedAtSec > latest.completedAtSec ||
        (record.completedAtSec === latest.completedAtSec && compareText(record.attemptId, latest.attemptId) < 0)) latest = record;
  }
  if (latest?.attemptCode === "reserve.collector.attempted" &&
      latest.admissionCode.startsWith("reserve.admission.rejected-")) {
    return createRuntimeGapVerdict({
      assetId: context.asset.assetId, scope, sourceId: latest.sourceId, sourceGenerationId: latest.attemptId,
      observedAtSec: latest.completedAtSec, asOfSec: context.fixedInput.clockSec,
      producerState: latest.admissionCode === "reserve.admission.rejected-sidecar-mismatch" ? "config-mismatch"
        : latest.admissionCode === "reserve.admission.rejected-stale" ? "stale-producer" : "producer-failed",
      rejectionCode: latest.admissionCode, reason: latest.admissionCode,
      contentSha256: latest.admissionCode === "reserve.admission.rejected-sidecar-mismatch"
        ? latest.sidecarMaterializationSha256 : latest.contentSha256,
    });
  }
  const provenance = context.fixedInput.liveReserveProvenanceMap[context.asset.assetId];
  const failure = provenance?.reserveObservationFailure;
  return failure && provenance.fetchedAt <= context.fixedInput.clockSec ? createRuntimeGapVerdict({
    assetId: context.asset.assetId, scope, sourceId: provenance.source,
    sourceGenerationId: `rejected-reserve-observation:${failure.sourceSha256}`,
    observedAtSec: provenance.fetchedAt, asOfSec: context.fixedInput.clockSec,
    producerState: "producer-failed", rejectionCode: failure.reason, reason: failure.reason,
    contentSha256: failure.sourceSha256,
  }) : undefined;
}

export function addGap(context: AssetBuildContext, gap: V9FactGapV3): string {
  const scope = gap.causeScope ?? scopeForGap(gap);
  const scopeKey = v9EvidenceCauseScopeKey(context.asset.assetId, scope, "research");
  const entries = classifications.getAll(context.asset.assetId);
  const scoped = entries.filter((entry) => v9EvidenceCauseScopeKey(entry.assetId, entry.scope, "research") === scopeKey);
  if (scoped.length > 1) throw new Error(`Conflicting evidence classifications for ${scopeKey}`);
  const exactScopeKey = v9EvidenceCauseScopeKey(context.asset.assetId, scope);
  const captured = context.fixedInput.pipelineGapByAssetId?.[context.asset.assetId]?.find(
    ({ verdict }) => v9EvidenceCauseScopeKey(verdict.assetId, verdict.scope) === exactScopeKey,
  ) ?? capturedReserveFailure(context, scope);
  if (captured) addEvidence(context, captured.evidence);
  const classification = scoped[0];
  let typedReview: unknown;
  if (scope.componentKey.startsWith("mechanism-review:") && scope.factorKey === null) {
    const componentKey = scope.componentKey.slice("mechanism-review:".length);
    const reviewed = context.asset.mechanismReviewedUnavailable?.find((row) => row.componentKey === componentKey);
    if (reviewed) typedReview = {
      id: `mechanism-review:${context.asset.assetId}:${componentKey}:${reviewed.reviewedAt}`,
      assetId: context.asset.assetId, scope, cause: "C", assertion: "researched-nondisclosure",
      reviewedAt: reviewed.reviewedAt, sources: [{ url: reviewed.sourceUrl }],
      searchedSurfaces: reviewed.searchedSurfaces, rationale: reviewed.rationale,
    };
  }
  const classificationEvidence = classification && Date.parse(classification.reviewedAt) / 1000 <= context.fixedInput.clockSec
    ? createV9ClassificationEvidence(classification, context.fixedInput.clockSec) : undefined;
  if (classificationEvidence) addEvidence(context, classificationEvidence);
  let typedReviewEvidence: V9EvidenceReferenceV2 | undefined;
  let historyDiagnostic: V9CauseResolutionDiagnostic | undefined;
  const parsedTypedReview = typedReview === undefined ? undefined : V9TypedReviewGapClassificationSchema.safeParse(typedReview);
  if (parsedTypedReview?.success && Date.parse(parsedTypedReview.data.reviewedAt) / 1000 <= context.fixedInput.clockSec) {
    try {
      typedReviewEvidence = createV9TypedReviewEvidence(parsedTypedReview.data, context.fixedInput.clockSec);
      addEvidence(context, typedReviewEvidence);
    } catch (error) {
      historyDiagnostic = { code: "cause-proof-conversion-failed", scope,
        message: error instanceof Error ? error.message : "Typed research history could not be bound" };
    }
  }
  const referenceIds = new Set([...gap.evidenceRefIds, ...gap.causeProof.evidenceRefIds,
    ...(captured ? [captured.evidence.evidenceId] : []),
    ...(classificationEvidence ? [classificationEvidence.evidenceId] : []),
    ...(typedReviewEvidence ? [typedReviewEvidence.evidenceId] : [])]);
  const references = [...referenceIds].flatMap((id) => {
    const reference = context.evidence.get(id);
    return reference ? [reference] : [];
  });
  const result: V9ResolvedEvidenceCause = gap.causeProof.cause === "U"
    ? resolveV9EvidenceCause({
        assetId: context.asset.assetId, scope, asOfSec: context.fixedInput.clockSec,
        sourceGenerationId: captured?.verdict.proof.sourceGenerationId ?? context.fixedInput.sourceGeneration,
        evidenceReferences: references, runtimeVerdict: captured?.verdict, classification, typedReview,
      })
    : { causeProof: gap.causeProof, responsibility: gap.responsibility, evidenceReferences: references };
  const diagnostics = result.diagnostics ?? (historyDiagnostic ? [historyDiagnostic] : undefined);
  if (diagnostics) context.causeResolutionDiagnostics.push(...diagnostics);
  for (const evidence of result.evidenceReferences) {
    if (!context.evidence.has(evidence.evidenceId)) addEvidence(context, evidence);
  }
  const resolved = createV9FactGapV3({
    ...gap, causeScope: scope, causeProof: result.causeProof, responsibility: result.responsibility,
    evidenceRefIds: result.evidenceReferences.map((reference) => reference.evidenceId),
    evidenceHistory: { publishedBy: gap.evidenceHistory?.publishedBy ?? "unknown", references: result.evidenceReferences },
  });
  const existing = context.gaps.get(resolved.gapId);
  if (existing && stableJsonStringifyV1(existing) !== stableJsonStringifyV1(resolved)) {
    throw new Error(`Conflicting Safety Score v9 gap identity ${resolved.gapId}`);
  }
  context.gaps.set(resolved.gapId, resolved);
  return resolved.gapId;
}

export function fallbackResearchEvidence(context: AssetBuildContext): string {
  const source = context.extension.sources.researchOverlays;
  return addEvidence(
    context,
    createV9EvidenceReference(
      {
        evidenceId: `${context.asset.assetId}:research-overlay`,
        sourceId: "safety-score-v9-research-overlay",
        sourceGenerationId: source.generationId,
        disposition: "observed",
        observedAtSec: source.observedAtSec,
        contentSha256: context.researchPayloadSha256,
        maxAgeSec: source.maxAgeSec,
      },
      context.fixedInput.clockSec,
    ),
  );
}

export function componentResearchEvidence(context: AssetBuildContext, componentKey: string): string[] {
  const binding = context.asset.componentEvidence.find((candidate) => candidate.componentKey === componentKey);
  if (!binding) return [fallbackResearchEvidence(context)];
  const evidenceByKey = new Map(context.asset.researchEvidence.map((evidence) => [evidence.evidenceKey, evidence]));
  return binding.evidenceKeys.map((evidenceKey) => {
    const evidence = evidenceByKey.get(evidenceKey);
    if (!evidence) {
      throw new Error(
        `Safety Score v9 component ${context.asset.assetId}:${componentKey} has unknown evidence ${evidenceKey}`,
      );
    }
    const evidenceId = addEvidence(
      context,
      createV9EvidenceReference(
        {
          evidenceId: `${context.asset.assetId}:research:${evidence.evidenceKey}`,
          sourceId: evidence.sourceId,
          sourceGenerationId: context.extension.sources.researchOverlays.generationId,
          disposition: evidence.publishedAtSec === null ? "observed" : "published",
          observedAtSec: evidence.observedAtSec,
          publishedAtSec: evidence.publishedAtSec,
          url: evidence.url,
          contentSha256: evidence.contentSha256,
          maxAgeSec: evidence.maxAgeSec,
        },
        context.fixedInput.clockSec,
      ),
    );
    context.evidencePublisherById.set(evidenceId, evidence.publishedBy ?? "unknown");
    return evidenceId;
  });
}

export function evidenceHistoryFor(
  context: AssetBuildContext,
  evidenceRefIds: readonly string[],
): {
  publishedBy: V9PublishedEvidenceAttribution;
  references: V9EvidenceReferenceV2[];
} {
  const references = evidenceRefIds.flatMap((evidenceId) => {
    const reference = context.evidence.get(evidenceId);
    return reference ? [reference] : [];
  });
  const publishers = new Set(
    evidenceRefIds.map((evidenceId) => context.evidencePublisherById.get(evidenceId) ?? "unknown"),
  );
  return {
    publishedBy: publishers.size === 1 ? [...publishers][0]! : "unknown",
    references,
  };
}
export interface CanonicalCollateralDependencyEdge {
  readonly upstreamAssetId: string;
  readonly weight: number;
  readonly economicRole: string;
}

export interface CanonicalCollateralExposure {
  readonly trackedAssetId: string | null;
  readonly weight: number;
}

export function collateralExposureMappingIssues(
  edges: readonly CanonicalCollateralDependencyEdge[],
  exposures: readonly CanonicalCollateralExposure[],
): string[] {
  const mappedWeightByUpstream = new Map<string, number>();
  for (const exposure of exposures) {
    if (exposure.trackedAssetId === null) continue;
    mappedWeightByUpstream.set(
      exposure.trackedAssetId,
      (mappedWeightByUpstream.get(exposure.trackedAssetId) ?? 0) + exposure.weight,
    );
  }
  return edges.flatMap((edge) => {
    if (edge.economicRole !== "basket-exposure") return [];
    const mappedWeight = mappedWeightByUpstream.get(edge.upstreamAssetId);
    if (mappedWeight === undefined) return [`collateral-edge-exposure-unmapped:${edge.upstreamAssetId}`];
    if (Math.abs(mappedWeight - edge.weight) > 0.000001) {
      return [`collateral-edge-exposure-weight-mismatch:${edge.upstreamAssetId}`];
    }
    return [];
  });
}



export function assertKnownComponentEvidenceCurrent(
  context: AssetBuildContext,
  componentKey: string,
  evidenceIds: readonly string[],
): void {
  const stale = evidenceIds.find((evidenceId) => context.evidence.get(evidenceId)?.freshness.state === "stale");
  if (stale) {
    throw new Error(
      `Safety Score v9 component ${context.asset.assetId}:${componentKey} cannot be known with stale evidence ${stale}`,
    );
  }
}

export function researchEvidence(context: AssetBuildContext, componentKey?: string): string {
  return componentKey ? componentResearchEvidence(context, componentKey)[0]! : fallbackResearchEvidence(context);
}


export function timestampSec(value: string, label: string, asOfSec: number): number {
  const timestampMs = Date.parse(value);
  if (!Number.isFinite(timestampMs)) throw new Error(`Safety Score v9 ${label} has an invalid timestamp`);
  const timestamp = Math.floor(timestampMs / 1_000);
  if (timestamp > asOfSec) throw new Error(`Safety Score v9 ${label} is later than the scoring clock`);
  return timestamp;
}

/** Observation state alone certifies no responsibility. */
export function reviewedGapResponsibility(
  _observationState: Exclude<V9FactStatusV2["observationState"], "known">,
): V9EvidenceResponsibility {
  return "unresearched";
}

export function normalizeReviewedFactStatus(
  context: AssetBuildContext,
  original: V9FactStatusV2,
  descriptor: {
    bindingKey: string;
    staleEvidenceError: string;
    gapId: string;
    reasonCode: V9FactGapV3["reasonCode"];
    ownerDomain: V9FactGapV3["ownerDomain"];
    componentKey: string;
    message: string;
    responsibility?: V9EvidenceResponsibility;
    causeScope?: V9EvidenceCauseScope;
    adverseFactId?: string;
  },
): V9FactStatusV2 {
  const evidenceIds =
    original.observationState === "known" ||
    original.observationState === "stale" ||
    original.observationState === "bounded-unknown"
      ? componentResearchEvidence(context, descriptor.bindingKey)
      : [];
  if (original.observationState === "known") {
    assertKnownComponentEvidenceCurrent(context, descriptor.bindingKey, evidenceIds);
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
    throw new Error(descriptor.staleEvidenceError);
  }
  const evidenceRefIds = keepEvidence ? evidenceIds : [];
  const evidenceHistory = evidenceHistoryFor(context, evidenceRefIds);
  const causeScope = descriptor.causeScope ?? scopeForGap({
    ownerDomain: descriptor.ownerDomain,
    policyRuleId: original.applicability.policyRuleId,
    path: { kind: "local-component", componentKey: descriptor.componentKey },
  });
  const adverseFactId = descriptor.adverseFactId;
  let adverseEvidenceRefIds: string[] = [];
  if (adverseFactId !== undefined) {
    assertKnownComponentEvidenceCurrent(context, descriptor.bindingKey, evidenceRefIds);
    adverseEvidenceRefIds = evidenceRefIds.map((evidenceId) => {
      const source = context.evidence.get(evidenceId);
      if (!source || source.rejection !== null) throw new Error(`Adverse fact ${adverseFactId} lacks admitted source evidence`);
      return addEvidence(context, createV9EvidenceReference({
        ...source,
        evidenceId: `${evidenceId}:adverse:${adverseFactId}`,
        disposition: "observed",
        publishedAtSec: null,
        maxAgeSec: source.freshness.maxAgeSec,
        causeBinding: {
          assetId: context.asset.assetId, scope: causeScope,
          producerState: null, rejectionCode: null, adverseFactId,
        },
      }, context.fixedInput.clockSec));
    });
  }
  const fallbackResponsibility = "unresearched";
  const gapId = addGap(
    context,
    createV9FactGapV3({
      gapId: descriptor.gapId,
      reasonCode: descriptor.reasonCode,
      ownerDomain: descriptor.ownerDomain,
      policyRuleId: original.applicability.policyRuleId,
      observationState: original.observationState,
      responsibility: adverseFactId === undefined ? fallbackResponsibility : "measured-adverse",
      ...(adverseFactId === undefined ? {} : {
        causeProof: { cause: "D" as const, adverseFactId, evidenceRefIds: adverseEvidenceRefIds },
      }),
      causeScope,
      path: { kind: "local-component", componentKey: descriptor.componentKey },
      message: descriptor.message,
      evidenceRefIds,
      evidenceHistory,
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

export function missingLocalFact(
  context: AssetBuildContext,
  args: {
    componentKey: string;
    path?: V9FactGapV3["path"];
    reasonCode: V9FactGapV3["reasonCode"];
    ownerDomain: V9FactGapV3["ownerDomain"];
    responsibility: V9EvidenceResponsibility;
    policyRuleId: string;
    message: string;
    observationState?: Exclude<V9FactStatusV2["observationState"], "known">;
    evidenceRefIds?: readonly string[];
    causeScope?: V9EvidenceCauseScope;
  },
): { gapId: string; status: V9FactStatusV2 } {
  const observationState = args.observationState ?? "missing";
  const gapId = addGap(
    context,
    createV9FactGapV3({
      gapId: `${context.asset.assetId}:gap:${args.componentKey}`,
      reasonCode: args.reasonCode,
      ownerDomain: args.ownerDomain,
      policyRuleId: args.policyRuleId,
      observationState,
      responsibility: args.responsibility,
      ...(args.causeScope === undefined ? {} : { causeScope: args.causeScope }),
      path: args.path ?? { kind: "local-component", componentKey: args.componentKey },
      message: args.message,
      evidenceRefIds: args.evidenceRefIds,
      evidenceHistory: evidenceHistoryFor(context, args.evidenceRefIds ?? []),
    }),
  );
  return {
    gapId,
    status: createV9FactStatus({
      applicability: requiredV9Applicability(args.policyRuleId),
      observationState,
      evidenceRefIds: args.evidenceRefIds,
      gapIds: [gapId],
    }),
  };
}
/** Complete atomic route scopes without upgrading an unproven legacy capacity tier. */
export function compileRouteFactorStatuses(
  context: AssetBuildContext,
  route: V9ExitRouteFactV2,
): V9AssetFactsV3["exitRoutes"][number] {
  const capacityEvidenceTier = route.capacityEvidenceTier ?? "unknown";
  const factorStatuses = { ...route.factorStatuses };
  let knownFactorStatus: V9FactStatusV2 | undefined;
  const config = route.lane === "redemption" ? getRedemptionBackstopConfig(context.asset.assetId) : null;
  const reviewed = config?.v9RouteReviewTerms;
  const reviewSec = reviewed?.reviewedAt ? Date.parse(`${reviewed.reviewedAt}T00:00:00Z`) / 1_000 : NaN;
  const certificate = route.executionCertificate;
  const certifiedPoint = certificate?.points.find((point) =>
    point.requestedNotionalUsd === route.request?.requestedNotionalUsd &&
    point.maxCostBps === route.request?.maxCostBps);
  // A later admitted exact execution supersedes an older terms-gap review,
  // but a new producer clock, another rail, or diagnostic proof does not.
  const newerExactEvidence = certificate !== undefined &&
    certificate.identity.assetId === context.asset.assetId &&
    route.executionModelId === certificate.modelId &&
    route.status.observationState === "known" &&
    certifiedPoint !== undefined && certifiedPoint.certification !== "diagnostic" &&
    certificate.observedAtSec >= reviewSec + 86_400 &&
    certificate.source.timestamp >= reviewSec + 86_400 &&
    route.status.evidenceRefIds.some((id) => {
      const evidence = context.evidence.get(id);
      return evidence !== undefined && evidence.disposition !== "rejected" &&
        evidence.freshness.state !== "stale";
    });
  const explicitMissing = reviewed?.scoringDisposition === "bounded-terms-gap" &&
    usesPrimaryRedemptionReviewTerms(context.asset.assetId, route) &&
    Number.isFinite(reviewSec) && reviewSec <= context.fixedInput.clockSec && !newerExactEvidence
    ? reviewed.missingScoringFields : undefined;
  for (const [factorKey, missing] of [
    ["access", route.holderAccess === "unknown"],
    ["holderEligibility", route.holderAccess === "unknown"],
    ["executionConfidence", route.executionCertainty === "unknown" || route.modelConfidence === "unknown"],
    ["observationConfidence", route.observationConfidence === "unknown"],
    ["capacityEvidenceTier", capacityEvidenceTier === "unknown"],
    ["capacity", route.capacityCurve.length === 0 || route.status.observationState !== "known"],
    ["output", route.output.status.observationState !== "known"],
    ["cost", route.feeEvidence !== undefined || route.capacityCurve.some((point) => point.executionCostBps === null)],
    ["settlement", route.settlementBoundUnproven === true || route.settlementSlaSec === null],
  ] as const) {
    const explicitlyMissing = explicitMissing?.some((field) => field === factorKey) === true;
    const existing = factorStatuses[factorKey];
    if (existing && (!explicitlyMissing || existing.observationState !== "known")) continue;
    factorStatuses[factorKey] = missing || explicitlyMissing
      ? missingLocalFact(context, {
          componentKey: `exit-route:${route.routeKey}:${factorKey}`, reasonCode: "missing-same-notional-route",
          ownerDomain: "exit", responsibility: "unresearched", policyRuleId: "v9.exit.route-factors",
          path: { kind: "optional-exit", routeKey: route.routeKey },
          message: `The ${factorKey} datum for route ${route.routeKey} has not been established.`,
          evidenceRefIds: route.status.evidenceRefIds,
          causeScope: { pillar: "exit", componentKey: "exit-route", factorKey,
            routeKey: route.routeKey, exposureId: null, requiredDatum: factorKey },
        }).status
      : (knownFactorStatus ??= deepFreeze(createV9FactStatus({
          applicability: route.status.applicability, observationState: "known",
          evidenceRefIds: route.status.evidenceRefIds,
        })));
  }
  return { ...route, factorStatuses, capacityEvidenceTier };
}

export function createAssetBuildContext(
  fixedInput: SafetyScoreV9CompilerInput,
  extension: SafetyScoreV9FactSetExtensionV2,
  asset: AssetExtension,
  researchPayloadSha256: string,
): AssetBuildContext {
  return {
    fixedInput,
    extension,
    asset,
    researchPayloadSha256,
    evidence: new Map(),
    evidencePublisherById: new Map(),
    gaps: new Map(),
    causeResolutionDiagnostics: [],
  };
}
