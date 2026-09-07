import { resolveChainId } from "@shared/lib/chains";
import {
  createV9EvidenceReference,
  createV9FactStatus,
  requiredV9Applicability,
  type V9PublishedEvidenceAttribution,
} from "@shared/lib/safety-score-v9/evidence";
import { createV9FactGapV3 } from "@shared/lib/safety-score-v9/reasons";
import { compareText } from "@shared/lib/safety-score-v9/primitives";
import { stableJsonStringifyV1 } from "@shared/lib/stable-json";
import type {
  V9EvidenceReferenceV2,
  V9EvidenceResponsibility,
  V9FactGapV3,
  V9FactStatusV2,
  V9FailureDomainRef,
} from "@shared/types/safety-score-v9-facts";
import type { SafetyScoreV9CompilerInput } from "./native-input";
import type {
  AssetExtension,
  SafetyScoreV9FactSetExtensionV2,
} from "./fact-set-schema";

export interface AssetBuildContext {
  readonly fixedInput: SafetyScoreV9CompilerInput;
  readonly extension: SafetyScoreV9FactSetExtensionV2;
  readonly asset: AssetExtension;
  readonly researchPayloadSha256: string;
  readonly evidence: Map<string, V9EvidenceReferenceV2>;
  readonly evidencePublisherById: Map<string, V9PublishedEvidenceAttribution>;
  readonly gaps: Map<string, V9FactGapV3>;
}

export function projectResearchOverlayPayload(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(projectResearchOverlayPayload);
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
  return Object.fromEntries(
    Object.entries(record)
      .filter(([key]) => key !== "cdpStressCoverage")
      .map(([key, entry]) => [key, projectResearchOverlayPayload(entry)]),
  );
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
  if (Array.isArray(value)) return value.map((entry) => normalizeCompiledFailureDomains(entry)) as T;
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [
      key,
      key === "failureDomains" && Array.isArray(entry)
        ? stableFailureDomains(entry as V9FailureDomainRef[])
        : normalizeCompiledFailureDomains(entry),
    ]),
  ) as T;
}

export function addEvidence(context: AssetBuildContext, evidence: V9EvidenceReferenceV2): string {
  const existing = context.evidence.get(evidence.evidenceId);
  if (existing && stableJsonStringifyV1(existing) !== stableJsonStringifyV1(evidence)) {
    throw new Error(`Conflicting Safety Score v9 evidence identity ${evidence.evidenceId}`);
  }
  context.evidence.set(evidence.evidenceId, evidence);
  return evidence.evidenceId;
}

export function addGap(context: AssetBuildContext, gap: V9FactGapV3): string {
  const existing = context.gaps.get(gap.gapId);
  if (existing && stableJsonStringifyV1(existing) !== stableJsonStringifyV1(gap)) {
    throw new Error(`Conflicting Safety Score v9 gap identity ${gap.gapId}`);
  }
  context.gaps.set(gap.gapId, gap);
  return gap.gapId;
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

function stalePublishedEvidenceFallback(
  observationState: Exclude<V9FactStatusV2["observationState"], "known">,
  references: readonly V9EvidenceReferenceV2[],
  fallback: V9EvidenceResponsibility,
): V9EvidenceResponsibility {
  return observationState === "stale" && references.some((reference) => reference.disposition === "published")
    ? "issuer-undisclosed"
    : fallback;
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

export function isoDateStartSec(value: string, label: string, asOfSec: number): number {
  const timestampMs = Date.parse(`${value}T00:00:00.000Z`);
  if (!Number.isFinite(timestampMs)) throw new Error(`Safety Score v9 ${label} has an invalid date`);
  const timestampSec = Math.floor(timestampMs / 1_000);
  if (timestampSec > asOfSec) throw new Error(`Safety Score v9 ${label} is later than the scoring clock`);
  return timestampSec;
}

export function timestampSec(value: string, label: string, asOfSec: number): number {
  const timestampMs = Date.parse(value);
  if (!Number.isFinite(timestampMs)) throw new Error(`Safety Score v9 ${label} has an invalid timestamp`);
  const timestamp = Math.floor(timestampMs / 1_000);
  if (timestamp > asOfSec) throw new Error(`Safety Score v9 ${label} is later than the scoring clock`);
  return timestamp;
}

export function reviewedGapResponsibility(
  observationState: Exclude<V9FactStatusV2["observationState"], "known">,
): V9EvidenceResponsibility {
  if (observationState === "stale") return "producer-failed";
  if (observationState === "unsupported") return "method-unsupported";
  if (observationState === "bounded-unknown") return "issuer-undisclosed";
  return "integration-missing";
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
  const fallbackResponsibility = descriptor.responsibility ?? reviewedGapResponsibility(original.observationState);
  const gapId = addGap(
    context,
    createV9FactGapV3({
      gapId: descriptor.gapId,
      reasonCode: descriptor.reasonCode,
      ownerDomain: descriptor.ownerDomain,
      policyRuleId: original.applicability.policyRuleId,
      observationState: original.observationState,
      responsibility: stalePublishedEvidenceFallback(
        original.observationState,
        evidenceHistory.references,
        fallbackResponsibility,
      ),
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
    reasonCode: V9FactGapV3["reasonCode"];
    ownerDomain: V9FactGapV3["ownerDomain"];
    responsibility: V9EvidenceResponsibility;
    policyRuleId: string;
    message: string;
    observationState?: Exclude<V9FactStatusV2["observationState"], "known">;
    evidenceRefIds?: readonly string[];
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
      path: { kind: "local-component", componentKey: args.componentKey },
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
  };
}
