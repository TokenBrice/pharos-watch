import { deriveEffectiveDependencySet } from "@shared/lib/dependency-derivation";
import { type DependencyGraphEdge } from "@shared/lib/dependency-graph";
import { compareText } from "@shared/lib/safety-score-v9/primitives";
import { stableJsonStringifyV1 } from "@shared/lib/stable-json";
import { defaultV9DependencyEconomicRole, type V9DependencyEconomicRole } from "@shared/types/dependency-types";
import type { DependencyReview, DependencyWeight } from "@shared/types/stablecoin-meta-primitives";
import type { V9FailureDomainRef } from "@shared/types/safety-score-v9-facts";
import { type ReserveSlice } from "@shared/types/reserves";
import type { SafetyScoreV9FactSetExtensionV2 } from "./fact-set-schema";
import { type SafetyScoreV9CompilerInput } from "./native-input";
import { dependencyReserveSlices, resolveReviewedReserveAdmission } from "./extension-reserves";
import { collateralExposureMappingIssues } from "./fact-set-context";
import { ReviewEvidenceBuilder } from "@shared/lib/safety-score-v9/review-evidence";
import { confidenceForResearch, type V9ExtensionRegistryMeta } from "./extension-shared";

export interface PreparedDependency {
  dependency: NonNullable<SafetyScoreV9FactSetExtensionV2["assets"][number]["dependencies"]>;
  graphEdges: (DependencyGraphEdge & { economicRole: V9DependencyEconomicRole })[];
  issueCodes: string[];
}

function dependencyFailureDomains(
  dependency: Pick<DependencyWeight, "id" | "type">,
  economicRole: V9DependencyEconomicRole,
): V9FailureDomainRef[] {
  const kind: V9FailureDomainRef["kind"] =
    economicRole === "basket-exposure"
      ? "reserve-issuer"
      : economicRole === "exit-dependency"
        ? "redemption-rail"
        : economicRole === "oracle-nav"
          ? "oracle-feed"
          : "mint-control";
  return [
    { kind, key: `asset:${dependency.id}` },
  ];
}

export function prepareDependency(
  meta: V9ExtensionRegistryMeta,
  liveReserveSlices: readonly ReserveSlice[] | undefined,
  activeIds: ReadonlySet<string>,
  clockSec: number,
  fixedInput: Readonly<SafetyScoreV9CompilerInput>,
): PreparedDependency {
  const liveDependencyMapping = liveReserveSlices
    ? dependencyReserveSlices(liveReserveSlices, meta, clockSec)
    : undefined;
  const effectiveLiveReserveSlices = liveDependencyMapping?.slices;
  const derived = deriveEffectiveDependencySet(meta, {
    ...(liveDependencyMapping
      ? { liveReserveSlices: liveDependencyMapping.slices, rejectionReasons: liveDependencyMapping.rejectionReasons }
      : {}),
  });
  // Curated derivation is reachable only without a live composition. Its
  // basket links must also pass the reserve-envelope admission gate; serial
  // and manual relationships do not assert curated basket composition.
  const suppressCuratedBasketEdges =
    derived.baseSource === "curated-reserve" &&
    derived.dependencies.some(
      (dependency) => (dependency.type ?? "collateral") === "collateral",
    ) &&
    resolveReviewedReserveAdmission({ meta, clockSec, fixedInput, liveReserveRows: [] }).projected === null;
  const issueCodes: string[] = [];
  issueCodes.push(...derived.rejectionReasons
    .filter((rejection) => rejection.reason === "coinId-without-depType" || rejection.reason === "reviewed-dependency-type-conflict" || rejection.reason === "reviewed-dependency-identity-conflict" || rejection.reason === "manual-collateral-not-in-reserves")
    .map((rejection) => rejection.reason));
  const expectedRelationships = derived.dependencies
    .map((dependency) => ({
      id: dependency.id,
      type: dependency.type ?? "collateral",
    }))
    .sort((left, right) => compareText(`${left.type}:${left.id}`, `${right.type}:${right.id}`));
  const reviewedBaseRelationships = (meta.dependencyReview?.relationships ?? [])
    .map((relationship) => ({
      id: relationship.id,
      type: relationship.type,
    }))
    .sort((left, right) => compareText(`${left.type}:${left.id}`, `${right.type}:${right.id}`));
  const uniqueReviewedBaseRelationships = [
    ...new Map(
      reviewedBaseRelationships.map((relationship) => [`${relationship.type}:${relationship.id}`, relationship]),
    ).values(),
  ];
  // Reserve composition owns basket weights; separately reviewed roles need
  // an exact authored anchor and cannot replace those measured exposures.
  const roleReviewCoexists =
    (derived.baseSource === "live-reserve" || derived.baseSource === "curated-reserve") &&
    meta.dependencyReview !== undefined &&
    meta.dependencyReview.relationships.every((relationship) =>
      relationship.economicRole != null &&
      relationship.economicRole !== defaultV9DependencyEconomicRole(relationship.type) &&
      meta.dependencies?.some((anchor) =>
        anchor.id === relationship.id &&
        (anchor.type ?? "collateral") === relationship.type &&
        anchor.weight === relationship.weight,
      ) === true &&
      derived.dependencies.some((dependency) =>
        dependency.id === relationship.id && (dependency.type ?? "collateral") === relationship.type,
      ),
    );
  const reviewMatchesDerived =
    meta.dependencyReview !== undefined &&
    (roleReviewCoexists || stableJsonStringifyV1(expectedRelationships) === stableJsonStringifyV1(uniqueReviewedBaseRelationships));
  if (derived.source === "manual" && !meta.dependencyReview) {
    issueCodes.push("dependency-review-missing");
  }
  if (meta.dependencyReview && !reviewMatchesDerived) {
    issueCodes.push("dependency-review-mismatch");
  }
  if (meta.dependencyReview?.confidence === "unknown") {
    issueCodes.push(`dependency-review-confidence:${meta.dependencyReview.confidence}`);
  }
  const reviewedRelationships =
    meta.dependencyReview && reviewMatchesDerived
      ? meta.dependencyReview.relationships.map((relationship) => {
          const derivedRelationship = derived.dependencies.find(
            (dependency) =>
              dependency.id === relationship.id &&
              (dependency.type ?? "collateral") === relationship.type,
          );
          if (!derivedRelationship) {
            throw new Error(`Reviewed dependency relationship did not match derived structure for ${meta.id}`);
          }
          return {
            id: relationship.id,
            type: relationship.type,
            weight: roleReviewCoexists ? relationship.weight : derivedRelationship.weight,
            economicRole: relationship.economicRole ?? defaultV9DependencyEconomicRole(relationship.type),
            ...(derivedRelationship.intermediary === undefined ? {} : { intermediary: derivedRelationship.intermediary }),
          };
        })
      : null;
  const defaultRelationships = derived.dependencies.map((dependency) => {
      const dependencyType = dependency.type ?? "collateral";
      return {
        id: dependency.id,
        type: dependencyType,
        weight: dependency.weight,
        economicRole: defaultV9DependencyEconomicRole(dependencyType),
        ...(dependency.intermediary === undefined ? {} : { intermediary: dependency.intermediary }),
      };
    });
  const dependencyRelationships = [...new Map((
    roleReviewCoexists
      ? [...defaultRelationships, ...(reviewedRelationships ?? [])]
      : reviewedRelationships ?? defaultRelationships
  ).map((relationship) => [
    `${relationship.id}\u0000${relationship.type}\u0000${relationship.economicRole}`,
    relationship,
  ] as const)).values()].filter(
    (dependency) =>
      !suppressCuratedBasketEdges || dependency.economicRole !== "basket-exposure",
  );
  const edges = dependencyRelationships.flatMap((dependency) => {
    const dependencyType = dependency.type ?? "collateral";
    if (!activeIds.has(dependency.id)) {
      issueCodes.push(`outside-active-set:${dependency.id}`);
      return [];
    }
    if (dependency.id === meta.id) {
      issueCodes.push("self-dependency");
      return [];
    }
    if (dependency.economicRole === "serial-claim" && dependency.weight !== 1) {
      issueCodes.push(`invalid-serial-weight:${dependency.id}`);
      return [];
    }
    if (dependency.economicRole === "serial-claim" && dependencyType === "collateral") {
      issueCodes.push(`invalid-serial-type:${dependency.id}`);
      return [];
    }
    if (dependency.economicRole === "basket-exposure" && dependencyType !== "collateral") {
      issueCodes.push(`invalid-basket-type:${dependency.id}`);
      return [];
    }
    if (
      dependency.economicRole !== "serial-claim" &&
      dependency.economicRole !== "basket-exposure" &&
      dependencyType === "wrapper"
    ) {
      issueCodes.push(`invalid-role-type:${dependency.id}`);
      return [];
    }
    return [
      {
        upstreamAssetId: dependency.id,
        dependencyType,
        weight: dependency.weight,
        economicRole: dependency.economicRole,
        failureDomains: dependencyFailureDomains(dependency, dependency.economicRole),
        ...(dependency.intermediary === undefined ? {} : { intermediary: dependency.intermediary }),
      },
    ];
  });
  const collateralWeight = edges
    .filter((edge) => edge.economicRole === "basket-exposure")
    .reduce((sum, edge) => sum + edge.weight, 0);
  const validEdges = collateralWeight <= 1.000001 ? edges : [];
  if (collateralWeight > 1.000001) issueCodes.push("collateral-weight-exceeds-one");
  const reconciliationSlices =
    derived.source === "curated-reserve" && effectiveLiveReserveSlices === undefined
      ? meta.reserves
      : effectiveLiveReserveSlices;
  issueCodes.push(
    ...collateralExposureMappingIssues(
      validEdges,
      (reconciliationSlices ?? [])
        .filter((slice) => slice.coinId && (slice.depType ?? "collateral") === "collateral")
        .map((slice) => ({ trackedAssetId: slice.coinId!, weight: slice.pct / 100 })),
    ),
  );
  const dependencyReviewUnresolved = issueCodes.some(
    (code) => code.startsWith("dependency-review-") || code.startsWith("collateral-edge-exposure-"),
  );
  return {
    dependency: {
      source: derived.source,
      baseSource: derived.baseSource,
      dependencyFromLive: derived.dependencyFromLive,
      mappedLiveReserveWeight: derived.mappedLiveReserveWeight,
      fallbackReason: derived.fallbackReason,
      rejectionReasons: derived.rejectionReasons,
      edges: validEdges,
      diagnostics: {
        graphState: dependencyReviewUnresolved ? "unresolved" : issueCodes.length > 0 ? "invalid" : "valid",
        issueCodes: [...new Set(issueCodes)].sort(compareText),
        sccMemberAssetIds: [],
      },
    },
    graphEdges: validEdges.map((edge) => ({
      from: edge.upstreamAssetId,
      to: meta.id,
      weight: edge.weight,
      type: edge.dependencyType,
      economicRole: edge.economicRole,
    })),
    issueCodes,
  };
}

export function addDependencyEvidence(meta: V9ExtensionRegistryMeta, evidence: ReviewEvidenceBuilder): void {
  const review: DependencyReview | undefined = meta.dependencyReview;
  if (!review) return;
  evidence.add({
    componentKeys: ["dependencies"],
    sourceId: "stablecoin-meta.dependency-review",
    reviewedAt: review.reviewedAt,
    publishedBy: "unknown",
    confidence: confidenceForResearch(review.confidence),
    sources: review.sources,
    payload: review,
  });
}
