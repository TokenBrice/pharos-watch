import { resolveChainId } from "@shared/types/chain-identity";
import { V9_ACCESS_EVIDENCE_MAX_AGE_SEC } from "@shared/lib/safety-score-v9/access-posture";
import { compareText } from "@shared/lib/safety-score-v9/primitives";
import type { BlacklistabilityReview } from "@shared/types/stablecoin-meta-compliance-schemas";
import { providerRowExclusionShares } from "@shared/lib/safety-score-v9/control-bridge-join";
import { resolveSafetyScoreV9ReviewedTransferFact, safetyScoreV9TransferDeploymentKey, type SafetyScoreV9ReviewedTransferFact, type SafetyScoreV9TransferMaterialScope } from "./extension-transfer";
import { transferMaterialScopeFromOnchainGeneration, transferMaterialScopeFromSingleDeploymentAttribution, transferMaterialScopeFromEconomicDeploymentPartition, type SafetyScoreV9TransferMaterialityGeneration } from "./transfer-materiality";
import { hasCompleteEligibleProviderSupply, REVIEWED_ECONOMIC_SUPPLY_PLANS } from "./supply-attribution-contract";
import { type SafetyScoreV9CompilerInput } from "./native-input";
import { safetyScoreV9ChainRows } from "./supply-attribution";
import { accessEvidenceObservationState, type ExtensionAsset, type V9ExtensionRegistryMeta, DEPLOYMENT_MATERIAL_SHARE_THRESHOLD } from "./extension-shared";
import overlayJson from "@shared/data/safety-score-v9/access-lookthrough-reviews-v1.json";
import { V9AccessClaimGraphSchema, V9AccessClaimGraphReviewSchema, V9AccessLookthroughOverlayEnvelopeSchema, type V9AccessClaimGraph, type V9AccessClaimGraphReview } from "@shared/types/safety-score-v9-access-lookthrough";
import { V9_CANDIDATE_POLICY_V1 } from "@shared/lib/safety-score-v9/policy";
import { domainDigest } from "@shared/lib/safety-score-v9/primitives";
import { requiredStatus } from "./extension-shared";
import type { ReviewEvidenceBuilder, ReviewEvidenceComponentKey } from "@shared/lib/safety-score-v9/review-evidence";
import { canonicalizeReviewedRegistryDigest, createReviewedAssetRegistry, reviewedRegistryDigestKey } from "@shared/lib/safety-score-v9/reviewed-registry";

const envelope = V9AccessLookthroughOverlayEnvelopeSchema.parse(overlayJson);
const overlay = canonicalizeReviewedRegistryDigest(envelope, {
  "reviews.*.nodes": reviewedRegistryDigestKey("nodeKey"),
  "reviews.*.edges": reviewedRegistryDigestKey("edgeKey"),
  "reviews.*.authorities": reviewedRegistryDigestKey("authorityKey"),
  "reviews.*.partitions": reviewedRegistryDigestKey("partitionKey"),
  "reviews.*.unresolved": reviewedRegistryDigestKey("branchKey"),
  "reviews.*.authorities.*.failureDomains": (value) => {
    const row = value as { kind?: unknown; key?: unknown };
    return `${row?.kind}:${row?.key}`;
  },
}) as typeof envelope;
const reviews = createReviewedAssetRegistry({ rows: envelope.reviews, schema: V9AccessClaimGraphReviewSchema, path: "accessLookthrough.reviews" });
function getSafetyScoreV9AccessClaimGraphReview(assetId: string): V9AccessClaimGraphReview | undefined {
  return reviews.get(assetId);
}
export function computeSafetyScoreV9AccessClaimGraphReviewsDigest(overrides?: Iterable<V9AccessClaimGraphReview>): string {
  const selected = overrides ? { ...overlay, reviews: [...overrides].sort((a, b) => a.assetId < b.assetId ? -1 : a.assetId > b.assetId ? 1 : 0) } : overlay;
  return domainDigest("safety-score-v9.access-lookthrough-reviews.v1", selected);
}
/** Dates are admitted before evidence creation; future reviews cannot quarantine other assets. */
export function buildSafetyScoreV9AccessClaimGraph(args: {
  assetId: string; clockSec: number; generationId: string; evidence: ReviewEvidenceBuilder;
  review?: V9AccessClaimGraphReview;
}): V9AccessClaimGraph | undefined {
  const review = args.review
    ? createReviewedAssetRegistry({ rows: [args.review], schema: V9AccessClaimGraphReviewSchema, path: "accessLookthrough.reviews" }).get(args.review.assetId)
    : getSafetyScoreV9AccessClaimGraphReview(args.assetId);
  if (!review) return undefined;
  if (review.assetId !== args.assetId) throw new Error("Access claim graph receiving identity mismatch");
  const maxAge = V9_CANDIDATE_POLICY_V1.policy.semantic.evidence.evidenceExpiry.accessReviewMaxAgeSec;
  const unresolved: V9AccessClaimGraph["unresolved"] = [];
  function compileStatus(metadata: V9AccessClaimGraphReview["nodes"][number]["review"], componentKey: ReviewEvidenceComponentKey, nodeKey: string) {
    const reviewedSec = Date.parse(metadata.reviewedAt) / 1000;
    const future = reviewedSec > args.clockSec;
    const stale = args.clockSec - reviewedSec > maxAge;
    const evidenceKeys = future ? [] : args.evidence.add({
      componentKeys: [componentKey], sourceId: "safety-score-v9.access-lookthrough-review",
      reviewedAt: metadata.reviewedAt, sources: metadata.sources.map((url) => ({ label: "Reviewed access claim evidence", url })),
      confidence: "manual-review", payload: { graph: review, componentKey, metadata }, maxAgeSec: maxAge,
    });
    if (future || stale) unresolved.push({ branchKey: `${componentKey}:admission`, nodeKey, reason: future ? "future-dated" : "stale", responsibility: metadata.responsibility,
      status: requiredStatus("v9.access.freeze-review", future ? "missing" : "stale", `${componentKey}:admission`, evidenceKeys) });
    return requiredStatus("v9.access.freeze-review", future ? "missing" : stale ? "stale" : "known", componentKey, evidenceKeys);
  }
  const nodes = review.nodes.map(({ review: metadata, ...node }) => ({ ...node, status: compileStatus(metadata, `access:graph:node:${node.nodeKey}`, node.nodeKey) }));
  const edges = review.edges.map(({ review: metadata, ...edge }) => ({ ...edge,
    weight: edge.basis.kind === "serial-claim" && edge.basis.entireClaim && edge.enabled && edge.reachesHeldClaim ? 1 : null,
    status: compileStatus(metadata, `access:graph:edge:${edge.edgeKey}`, edge.fromNodeKey),
  }));
  const authorities = review.authorities.map(({ review: metadata, ...authority }) => ({ ...authority, status: compileStatus(metadata, `access:graph:authority:${authority.authorityKey}`, authority.nodeKey) }));
  const partitions = review.partitions.map(({ review: metadata, ...partition }) => ({ ...partition,
    denominatorEstablished: edges.filter((e) => e.partitionKey === partition.partitionKey).length > 0 && edges.filter((e) => e.partitionKey === partition.partitionKey).every((e) => e.basis.kind === "serial-claim" && e.basis.entireClaim),
    status: compileStatus(metadata, `access:graph:partition:${partition.partitionKey}`, partition.nodeKey),
  }));
  for (const { review: metadata, ...branch } of review.unresolved) {
    const status = compileStatus(metadata, `access:graph:unresolved:${branch.branchKey}`, branch.nodeKey);
    unresolved.push({ ...branch, status: requiredStatus("v9.access.freeze-review", status.observationState === "known" ? "bounded-unknown" : status.observationState, `access:graph:unresolved:${branch.branchKey}`, status.evidenceRefIds) });
  }
  return V9AccessClaimGraphSchema.parse({ assetId: args.assetId, graphKey: review.graphKey, rootNodeKey: review.rootNodeKey, clockSec: args.clockSec, generationId: args.generationId, nodes, edges, authorities, partitions, unresolved });
}

export function transferMaterialScope(
  fixedInput: Readonly<SafetyScoreV9CompilerInput>,
  assetId: string,
  meta: V9ExtensionRegistryMeta,
  generation: SafetyScoreV9TransferMaterialityGeneration | null,
  review: SafetyScoreV9ReviewedTransferFact | undefined,
  supplyReview: ExtensionAsset["supplyReview"],
): SafetyScoreV9TransferMaterialScope {
  const rows = safetyScoreV9ChainRows(fixedInput, assetId);
  const admittedExcludedRows = supplyReview ? providerRowExclusionShares(assetId, supplyReview).byDeployment : undefined;
  const exclusions = (supplyReview?.providerRowExclusions ?? []).filter((exclusion) =>
    admittedExcludedRows?.has(exclusion.deploymentRouteKey));
  const excludedProviderLabels = new Set(exclusions.map((exclusion) => exclusion.review.providerChainLabel));
  // Exclude identities, never a chain: another legacy liability on this chain
  // still needs its own supply and transfer census after the foreign row is removed.
  const ownContracts = (meta.contracts ?? []).filter((deployment) => !exclusions.some((exclusion) =>
    safetyScoreV9TransferDeploymentKey(deployment.chain, deployment.address) ===
      safetyScoreV9TransferDeploymentKey(exclusion.review.chainId, exclusion.review.contractAddress)));
  const totalSupplyUsd = !REVIEWED_ECONOMIC_SUPPLY_PLANS.has(assetId) ||
    fixedInput.safetyScoreV9SupplyAttributionById?.[assetId] ||
    hasCompleteEligibleProviderSupply(fixedInput, assetId, { contracts: meta.contracts, bridgeRouteRisk: meta.bridgeRouteRisk })
    ? Object.values(rows).reduce((sum, row) => sum + row.current, 0) : 0;
  const authoritativeDeployments = ownContracts.flatMap((deployment) => {
    const chainId = resolveChainId(deployment.chain);
    return chainId === null ? [] : [{ chainId, key: safetyScoreV9TransferDeploymentKey(chainId, deployment.address) }];
  });
  const authoritativeDeploymentKeys = [...new Set(authoritativeDeployments.map(({ key }) => key))].sort(compareText);
  const unresolvedDeclaredChainIds = ownContracts
    .filter((deployment) => resolveChainId(deployment.chain) === null)
    .map((deployment) => deployment.chain.trim().toLowerCase());
  const unresolvedDeclaredDeploymentKeys = ownContracts
    .filter((deployment) => resolveChainId(deployment.chain) === null)
    .map((deployment) => safetyScoreV9TransferDeploymentKey(deployment.chain.trim().toLowerCase(), deployment.address));
  if (fixedInput.safetyScoreV9SupplyAttributionById?.[assetId]?.model === "reviewed-economic-deployment-partition-v1" ||
    (REVIEWED_ECONOMIC_SUPPLY_PLANS.has(assetId) &&
      !hasCompleteEligibleProviderSupply(fixedInput, assetId, { contracts: meta.contracts, bridgeRouteRisk: meta.bridgeRouteRisk }))) {
    return transferMaterialScopeFromEconomicDeploymentPartition({ assetId, fixedInput, baseScope: {
      authoritativeDeploymentKeys, materialDeploymentKeys: [], materialDeploymentScopeComplete: false,
      deploymentModel: "contract-addressable",
    } });
  }
  if (totalSupplyUsd <= 0) {
    const baseScope: SafetyScoreV9TransferMaterialScope = {
      authoritativeDeploymentKeys,
      unresolvedMaterialChainIds: unresolvedDeclaredChainIds,
      unresolvedDeclaredDeploymentKeys,
      materialDeploymentKeys: [],
      materialDeploymentScopeComplete: false,
      // No supply rows at all: only a declared supported-chain contract can
      // make this asset addressable by the contract-scope machinery.
      deploymentModel: authoritativeDeploymentKeys.length > 0 ? "contract-addressable" : "non-contract-native",
    };
    const observedScope = transferMaterialScopeFromOnchainGeneration({
      assetId,
      meta,
      baseScope,
      generation,
      registryFingerprint: fixedInput.registryFingerprint,
      baseInputGenerationId: fixedInput.baseInputGenerationId,
      clockSec: fixedInput.clockSec,
    });
    // Even an observed zero is evidence: never replace it with attribution.
    if (observedScope !== baseScope || Object.keys(rows).length > 0) return observedScope;
    return transferMaterialScopeFromSingleDeploymentAttribution({
      meta,
      review,
      aggregateCirculating: fixedInput.aggregateCirculatingById[assetId] ?? {},
      baseScope: observedScope,
      clockSec: fixedInput.clockSec,
    });
  }

  const supplyByChainId = new Map<string, number>();
  let unresolvedSupplyUsd = 0;
  for (const [chain, row] of Object.entries(rows)) {
    if (excludedProviderLabels.has(chain)) continue;
    const chainId = resolveChainId(chain);
    if (chainId === null) {
      unresolvedSupplyUsd += row.current;
    } else {
      supplyByChainId.set(chainId, (supplyByChainId.get(chainId) ?? 0) + row.current);
    }
  }
  const deploymentsByChainId = new Map<string, string[]>();
  for (const deployment of authoritativeDeployments) {
    deploymentsByChainId.set(deployment.chainId, [
      ...(deploymentsByChainId.get(deployment.chainId) ?? []),
      deployment.key,
    ]);
  }
  const unattributedOwnDeploymentKeys = authoritativeDeployments
    .filter((deployment) => exclusions.some((exclusion) => exclusion.review.chainId === deployment.chainId))
    .map((deployment) => deployment.key);
  const materialChainIds = [...supplyByChainId.entries()]
    .filter(([, supplyUsd]) => supplyUsd / totalSupplyUsd >= DEPLOYMENT_MATERIAL_SHARE_THRESHOLD)
    .map(([chainId]) => chainId)
    .sort(compareText);
  const materialDeploymentKeys = [
    ...new Set([...materialChainIds.flatMap((chainId) => deploymentsByChainId.get(chainId) ?? []), ...unattributedOwnDeploymentKeys]),
  ].sort(compareText);
  return {
    authoritativeDeploymentKeys,
    unresolvedDeclaredDeploymentKeys,
    unresolvedMaterialChainIds: [...new Set([
      ...unresolvedDeclaredChainIds,
      ...Object.entries(rows)
        .filter(([chain, row]) => !excludedProviderLabels.has(chain) &&
          resolveChainId(chain) === null && row.current / totalSupplyUsd >= DEPLOYMENT_MATERIAL_SHARE_THRESHOLD)
        .map(([chain]) => chain.trim().toLowerCase()),
    ])].sort(compareText),
    materialDeploymentKeys,
    materialDeploymentScopeComplete:
      unattributedOwnDeploymentKeys.length === 0 &&
      unresolvedSupplyUsd / totalSupplyUsd < DEPLOYMENT_MATERIAL_SHARE_THRESHOLD &&
      materialChainIds.length > 0 &&
      materialChainIds.every((chainId) => (deploymentsByChainId.get(chainId)?.length ?? 0) > 0),
    // Addressable as soon as the registry names one supported-chain contract or
    // one supported chain carries a material share of supply. Everything else
    // is a chain-native deployment the contract-scope machinery cannot reach.
    deploymentModel:
      authoritativeDeploymentKeys.length > 0 || materialChainIds.length > 0
        ? "contract-addressable"
        : "non-contract-native",
  };
}

// Preserve the reviewed inherited disposition when no claim graph is available.
// This names a directly freeze-capable active reserve upstream; it does not
// establish transitive reach or price the reserve exposure.
function resolveReserveSliceUpstreamAssetId(
  meta: V9ExtensionRegistryMeta,
  metaById: ReadonlyMap<string, V9ExtensionRegistryMeta>,
  activeAssetIds: ReadonlySet<string>,
): string | null {
  let best: { assetId: string; pct: number } | null = null;
  for (const slice of meta.reserves ?? []) {
    const upstreamId = slice.coinId;
    if (upstreamId === undefined || upstreamId === meta.id) continue;
    // Fact-set references must resolve to an active scored asset.
    if (!activeAssetIds.has(upstreamId)) continue;
    const upstream = metaById.get(upstreamId);
    if (upstream === undefined) continue;
    const upstreamReview = upstream.blacklistabilityReview;
    const directlyFreezeCapable =
      upstreamReview?.reviewedStatus === true ||
      (upstreamReview === undefined && upstream.flags?.governance === "centralized");
    if (!directlyFreezeCapable) continue;
    // Largest share, then lexicographic id: independent of registry order.
    if (best === null || slice.pct > best.pct || (slice.pct === best.pct && upstreamId < best.assetId)) {
      best = { assetId: upstreamId, pct: slice.pct };
    }
  }
  return best?.assetId ?? null;
}

export function adaptAccessReview(
  meta: V9ExtensionRegistryMeta,
  metaById: ReadonlyMap<string, V9ExtensionRegistryMeta>,
  activeAssetIds: ReadonlySet<string>,
  evidence: ReviewEvidenceBuilder,
  transferReview: SafetyScoreV9ReviewedTransferFact | undefined,
  materialScope: SafetyScoreV9TransferMaterialScope,
  clockSec: number,
  claimGraph?: V9AccessClaimGraph,
): ExtensionAsset["accessReview"] {
  const review: BlacklistabilityReview | undefined = meta.blacklistabilityReview;
  if (!review && !transferReview && !claimGraph) return null;

  const transferResolution = transferReview
    ? resolveSafetyScoreV9ReviewedTransferFact(transferReview, clockSec, materialScope)
    : null;
  const transferEvidenceKeys = transferReview
    ? evidence.add({
        componentKeys: ["access:transfer"],
        sourceId: "safety-score-v9.reviewed-transfer-overlay",
        reviewedAt: transferReview.reviewedAt,
        publishedBy: "unknown",
        confidence: "manual-review",
        sources: transferReview.deployments.flatMap((deployment) => deployment.sources),
        payload: transferReview,
        maxAgeSec: V9_ACCESS_EVIDENCE_MAX_AGE_SEC,
      })
    : [];
  if (materialScope.scopeAttestation && transferResolution?.observationState === "known") {
    const attestation = materialScope.scopeAttestation;
    transferEvidenceKeys.push(...evidence.add({
      componentKeys: ["access:transfer"],
      sourceId: "safety-score-v9.single-deployment-attribution.v1",
      reviewedAt: attestation.reviewedAt,
      confidence: "manual-review",
      sources: attestation.sources,
      payload: attestation,
      maxAgeSec: (Date.parse(attestation.expiresAt) - Date.parse(attestation.reviewedAt)) / 1_000,
    }));
  }

  const blacklistFreshness = review ? accessEvidenceObservationState(review.reviewedAt, clockSec) : null;
  const blacklistEvidenceKeys = review
    ? evidence.add({
        // The blacklist fact owns freeze posture. Its transfer binding remains
        // only as the compatibility fallback when no dedicated fact exists.
        componentKeys: [
          ...(transferReview ? [] : ["access:transfer"] as const),
          "access:freeze",
          `access:freeze:blacklist:${meta.id}`,
        ],
        sourceId: "stablecoin-meta.blacklistability-review",
        reviewedAt: review.reviewedAt,
        publishedBy: "unknown",
        confidence: "manual-review",
        sources: review.sources,
        payload: review,
        maxAgeSec: V9_ACCESS_EVIDENCE_MAX_AGE_SEC,
      })
    : [];
  const status = review?.reviewedStatus;
  const declaredInheritedFrom = meta.mintAuthority?.inheritedFrom ?? meta.variantOf ?? null;
  const declaredResolvable = declaredInheritedFrom !== null && activeAssetIds.has(declaredInheritedFrom);
  // A declared active parent wins over reserve attribution. A reviewed graph
  // owns reserve look-through when present, including its unknown branches:
  // never fill those gaps with the legacy raw-registry reserve fallback.
  const reserveInheritedFrom =
    claimGraph || declaredResolvable || status !== "inherited"
      ? null
      : resolveReserveSliceUpstreamAssetId(meta, metaById, activeAssetIds);
  const inheritedFrom = declaredResolvable ? declaredInheritedFrom : (reserveInheritedFrom ?? declaredInheritedFrom);
  const inheritedResolvable = declaredResolvable || reserveInheritedFrom !== null;
  const freezeKnown = status === true || status === false;
  const freezeState =
    blacklistFreshness === "stale" ? "stale" : freezeKnown ? "known" : review ? "bounded-unknown" : "missing";
  const legacyTransferState =
    status === false || review === undefined
      ? "missing"
      : blacklistFreshness === "stale"
        ? "stale"
        : status === true
          ? "known"
          : "bounded-unknown";
  const transferState = transferResolution?.observationState ?? legacyTransferState;
  const transferPosture = transferResolution
    ? transferResolution.posture
    : legacyTransferState === "known"
      ? "restrictable"
      : null;
  // Owner ruling 2026-08-10: an "inherited" verdict whose upstream resolves to
  // no tracked asset used to drop the whole freeze review, which published the
  // asset as never reviewed and erased the exposure the reviewer measured. The
  // review is retained instead, without asserting an upstream identity this
  // branch cannot verify: no `upstreamAssetId`, no failure domain, and the
  // ordinary `possible` reach an unproven freeze surface carries.
  const namedUpstream = status === "inherited" && inheritedResolvable;
  const freezeReview =
    review === undefined
      ? []
      : [
          {
            reviewKey: `blacklist:${meta.id}`,
            source: namedUpstream ? ("upstream" as const) : ("blacklist" as const),
            status: requiredStatus(
              "v9.access.freeze-review",
              freezeState,
              `access-freeze:${meta.id}`,
              blacklistEvidenceKeys,
            ),
            reach:
              status === false ? ("none" as const) : status === true ? ("individual" as const) : ("possible" as const),
            controlKey: null,
            upstreamAssetId: namedUpstream ? inheritedFrom : null,
            failureDomains:
              namedUpstream && inheritedFrom
                ? [
                    {
                      kind: reserveInheritedFrom !== null ? ("reserve-issuer" as const) : ("mint-control" as const),
                      key: `asset:${inheritedFrom}`,
                    },
                  ]
                : [],
          },
        ];
  return {
    transfer: {
      status: requiredStatus(
        "v9.access.transfer-review",
        transferState,
        `access-transfer:${meta.id}`,
        transferReview ? transferEvidenceKeys : legacyTransferState === "missing" ? [] : blacklistEvidenceKeys,
      ),
      posture: transferPosture,
      ...(transferState === "known" && materialScope.scopeBasis === "attributed"
        ? { scopeBasis: "attributed" as const } : {}),
      // Owner ruling 2026-08-10: the applicability basis for a transfer fact
      // that is known from the curated review alone because the asset has no
      // contract deployment scope to complete (see `reviewIsOutsideContractScope`).
      ...(transferResolution?.structuralDisposition !== undefined
        ? { structuralDisposition: transferResolution.structuralDisposition }
        : {}),
    },
    freeze: {
      status: requiredStatus(
        "v9.access.freeze-review",
        freezeState,
        `access-freeze:${meta.id}`,
        review ? blacklistEvidenceKeys : [],
      ),
      reviews: freezeReview,
      ...(claimGraph ? { claimGraph } : {}),
      // Owner ruling 2026-07-27: a current review whose honest verdict is
      // "inherited from a named tracked upstream" is a measured structural
      // fact, not missing data. The freeze facts stay bounded-unknown for
      // scoring; the disposition only suppresses the missing-data gap.
      // Owner ruling 2026-08-10: when the same current review names no tracked
      // upstream, the honest fact is still structural — inherited exposure with
      // an untracked counterparty — so it is measured as such rather than
      // reported as an unreviewed asset.
      ...(status === "inherited" && freezeState === "bounded-unknown"
        ? {
            structuralDisposition: inheritedResolvable
              ? ("inherited-upstream" as const)
              : ("inherited-untracked-upstream" as const),
          }
        : status === "possible" && freezeState === "bounded-unknown"
          ? { structuralDisposition: "reviewed-possible" as const }
          : {}),
    },
  };
}
