import { resolveMechanismArchetype } from "@shared/lib/classification/resolve-mechanism-archetype";
import { resolveChainId } from "@shared/lib/chains";
import { deriveEffectiveDependencySet } from "@shared/lib/dependency-derivation";
import { diagnoseDependencyGraph, type DependencyGraphEdge } from "@shared/lib/dependency-graph";
import { V9_EVIDENCE_PRODUCER_INTERVAL_SEC } from "@shared/lib/cron-cadences";
import { computeReportCardsRegistryFingerprint } from "@shared/lib/report-cards-fixed-input-identity";
import { V9_ACCESS_EVIDENCE_MAX_AGE_SEC } from "@shared/lib/safety-score-v9/access-posture";
import { V9_REVIEW_EVIDENCE_MAX_AGE_SEC } from "@shared/lib/safety-score-v9/evidence";
import { compareText, domainDigest } from "@shared/lib/safety-score-v9/primitives";
import { stableJsonStringifyV1 } from "@shared/lib/stable-json";
import { ACTIVE_META_BY_ID } from "@shared/lib/stablecoins/registry";
import {
  defaultV9DependencyEconomicRole,
  type V9DependencyEconomicRole,
} from "@shared/types/dependency-types";
import type {
  BlacklistabilityReview,
  DependencyReview,
  DependencyWeight,
  MintAuthorityControl,
  MintAuthorityEconomicCapSemantics,
  MintAuthorityProfile,
} from "@shared/types/core";
import type { V9FailureDomainRef } from "@shared/types/safety-score-v9-facts";
import {
  type ReserveSlice,
} from "@shared/types/reserves";
import {
  type SafetyScoreV9FactSetExtensionV2,
} from "./safety-score-v9-fact-set";
import {
  buildSafetyScoreV9MechanismReview,
  getSafetyScoreV9MechanismExitFacts,
  getSafetyScoreV9MechanismOverlayEvidence,
  getSafetyScoreV9MechanismReviewGapDisposition,
  SAFETY_SCORE_V9_MECHANISM_REVIEW_OVERLAYS_DIGEST,
} from "./safety-score-v9-extension-mechanism";
import {
  getSafetyScoreV9OperationalResilienceOverlay,
  SAFETY_SCORE_V9_OPERATIONAL_RESILIENCE_OVERLAYS_DIGEST,
} from "./safety-score-v9-extension-operational-resilience";
import {
  computeSafetyScoreV9ReviewedTransferFactsDigest,
  resolveSafetyScoreV9ReviewedTransferFact,
  SAFETY_SCORE_V9_REVIEWED_TRANSFER_FACTS,
  safetyScoreV9TransferDeploymentKey,
  type SafetyScoreV9ReviewedTransferFact,
  type SafetyScoreV9TransferMaterialScope,
} from "./safety-score-v9-extension-transfer";
import { SAME_NOTIONAL_EXIT_OBSERVATION_FRESHNESS_POLICY } from "@shared/lib/redemption-backstop-scoring";
import {
  transferMaterialScopeFromOnchainGeneration,
  type SafetyScoreV9TransferMaterialityGeneration,
} from "./safety-score-v9-transfer-materiality";
import {
  buildSafetyScoreV9RetainedRoutes,
  buildSafetyScoreV9RouteReviews,
} from "./safety-score-v9-extension-routes";
import {
  buildSafetyScoreV9SupplyReview,
} from "./safety-score-v9-extension-supply";
import {
  normalizeSafetyScoreV9CompilerInput,
  type SafetyScoreV9CompilerInput,
} from "./safety-score-v9-native-input";
import {
  safetyScoreV9ChainRows,
  safetyScoreV9ChainSupplySourceGenerationId,
} from "./safety-score-v9-supply-attribution";
import { adaptBridgeReview } from "./safety-score-v9-extension-bridge";
import { adaptOracleReview, deriveOracleBranchMateriality } from "./safety-score-v9-extension-oracle";
import {
  addReserveClassificationEvidence,
  addReviewedStaticReserveEvidence,
  buildReviewedReserveClassifications,
  buildSafetyScoreV9ReviewedCuratedFallbackReserveRows,
  buildSafetyScoreV9ReviewedStandaloneReserveRows,
  buildSafetyScoreV9ReviewedStaticReserveRows,
  dependencyReserveSlices,
} from "./safety-score-v9-extension-reserves";
import {
  ReviewEvidenceBuilder,
  accessEvidenceObservationState,
  boundedObservedAt,
  confidenceForResearch,
  conservativeDateEndSec,
  maximumObservedAt,
  requiredStatus,
  researchReviewObservationState,
  reviewedObservationState,
  type ControlOverlay,
  type ExtensionAsset,
  type V9ExtensionRegistryMeta,
  DEPLOYMENT_MATERIAL_SHARE_THRESHOLD,
} from "./safety-score-v9-extension-shared";

// The registry-meta projection now lives beside the adapters that read it.
export type { V9ExtensionRegistryMeta } from "./safety-score-v9-extension-shared";
export { deriveOracleBranchMateriality };
export {
  buildReviewedReserveClassifications,
  buildSafetyScoreV9ReviewedCuratedFallbackReserveRows,
  buildSafetyScoreV9ReviewedStandaloneReserveRows,
  buildSafetyScoreV9ReviewedStaticReserveRows,
};

export interface BuildSafetyScoreV9BaselineExtensionOptions {
  metaById?: ReadonlyMap<string, V9ExtensionRegistryMeta>;
  registryFingerprint?: string;
  reviewedTransferFacts?: ReadonlyMap<string, SafetyScoreV9ReviewedTransferFact>;
  transferMaterialityGeneration?: SafetyScoreV9TransferMaterialityGeneration | null;
  /**
   * Replay-only operator override. The registry fingerprint check exists so a
   * production publication can never score a capture against a registry it was
   * not captured from. An equivalence replay deliberately does exactly that when
   * it carries a frozen capture across a curation commit, so the operator can
   * accept the mismatch explicitly.
   *
   * Never set on the production publication path: the runner and cron callers
   * leave it undefined, so the check is unchanged for every non-replay caller.
   */
  allowRegistryMismatch?: boolean;
}

interface PreparedDependency {
  dependency: NonNullable<SafetyScoreV9FactSetExtensionV2["assets"][number]["dependencies"]>;
  graphEdges: (DependencyGraphEdge & { economicRole: V9DependencyEconomicRole })[];
  issueCodes: string[];
}


const ISSUER_ENTITY_STOPWORDS = new Set([
  "llc",
  "ltd",
  "limited",
  "ltda",
  "inc",
  "corp",
  "corporation",
  "company",
  "co",
  "trust",
  "bank",
  "n",
  "a",
  "s",
  "de",
  "c",
  "v",
  "cv",
  "sa",
  "sas",
  "gmbh",
  "ag",
  "pte",
  "pty",
  "bv",
  "je",
  "the",
  "of",
  "and",
  "by",
  "dba",
  "dao",
  "llp",
  "plc",
  "se",
  "oy",
  "ab",
  "as",
]);

// Curated issuer-identity aliases. Some issuers publish the SAME legal or
// governance identity under different display strings; without an explicit
// mapping their normalized issuer keys diverge, so a same-issuer control group
// (an issuer's own controller shared across its own products) fails closed.
// Each entry maps a fully-normalized issuer-entity phrase to one canonical
// issuer key. This is MINIMAL and NAMED — the only entry is the
// MakerDAO <-> Sky Protocol governance identity: Sky is the rebranded MakerDAO,
// governed by the same PauseProxy, described as "MakerDAO / Sky Protocol
// governance" (DAI) and "Sky Protocol governance" (USDS/sUSDS). Matching is
// exact on the normalized phrase (no fuzzy matching), so unrelated issuers that
// merely share a leading token are never merged.
const CANONICAL_ISSUER_KEY_BY_NORMALIZED_ENTITY = new Map<string, string>([
  ["makerdao sky protocol governance", "makerdao"],
  ["sky protocol governance", "makerdao"],
]);

function normalizedIssuerEntity(value: string): string | null {
  const tokens = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .split(" ")
    .filter((token) => token.length > 0 && !ISSUER_ENTITY_STOPWORDS.has(token));
  if (tokens.length === 0) return null;
  return CANONICAL_ISSUER_KEY_BY_NORMALIZED_ENTITY.get(tokens.join(" ")) ?? tokens[0]!;
}

function rawIssuerKey(assetId: string, meta: V9ExtensionRegistryMeta): string | null {
  const geniusEntity = meta.genius?.issuerEntity;
  if (typeof geniusEntity === "string" && geniusEntity.trim().length > 0) {
    const normalized = normalizedIssuerEntity(geniusEntity);
    if (normalized) return normalized;
  }
  const dash = assetId.indexOf("-");
  const slug = dash >= 0 ? assetId.slice(dash + 1) : "";
  return slug.length > 0 ? slug : null;
}

/** Mirrors the accepted D2 matrix issuer join, including its five-hop bound. */
export function resolveSafetyScoreV9AssetIssuerKey(
  assetId: string,
  metaById: ReadonlyMap<string, V9ExtensionRegistryMeta>,
): string | null {
  const seen = new Set([assetId]);
  let current = assetId;
  for (let hop = 0; hop < 5; hop += 1) {
    const meta = metaById.get(current);
    if (!meta) return null;
    const next = meta.mintAuthority?.inheritedFrom ?? meta.variantOf ?? null;
    if (next === null) return rawIssuerKey(current, meta);
    if (seen.has(next)) return null;
    seen.add(next);
    current = next;
  }
  return null;
}



function issuerAuthorityKey(assetId: string, control: MintAuthorityControl): string | null {
  if (control.authorityType !== "issuer-backend" && control.authorityType !== "custodian") return null;
  const slug = control.label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return `issuer-backend:${assetId}:${slug || "unlabeled"}`;
}

function canonicalAuthorityType(assetId: string, control: MintAuthorityControl): ControlOverlay["authority"] {
  const authorityKey = control.address
    ? `${control.chain ?? "chain-unresolved"}:${control.address.toLowerCase()}`
    : (control.failureDomainKeys?.[0] ?? issuerAuthorityKey(assetId, control));
  if (authorityKey === null) return null;
  const model: NonNullable<ControlOverlay["authority"]>["model"] = (() => {
    if (control.authorityType === "safe" || control.authorityType === "multisig") return "multisig";
    if (control.authorityType === "eoa") return "eoa";
    if (control.authorityType === "dao-governor") return "governance";
    if (control.authorityType === "issuer-backend") return "issuer-backend";
    if (control.authorityType === "contract" || control.authorityType === "timelock") return "contract";
    if (control.authorityType === "none") return "none";
    return "unknown";
  })();
  const threshold =
    model === "multisig" && control.threshold != null && control.signerCount != null
      ? { required: control.threshold, total: control.signerCount }
      : null;
  return { authorityKey, model, threshold };
}

function mintControlKind(control: MintAuthorityControl): ControlOverlay["controlKind"] {
  if (control.directMintAbility === "upgrade-only" || control.role === "proxy-admin") return "upgrade";
  if (control.role === "bridge-admin" || control.authorityType === "bridge") return "bridge";
  if (control.role === "governor" || control.role === "timelock") return "governance";
  if (control.role === "custodian") return "custody";
  return "mint";
}

function mintCapabilities(control: MintAuthorityControl, upgradeCapable: boolean): ControlOverlay["capabilities"] {
  const capabilities = new Set<ControlOverlay["capabilities"][number]>();
  if (["direct", "cap-limited", "can-authorize"].includes(control.directMintAbility)) capabilities.add("mint");
  if (control.directMintAbility === "upgrade-only" || upgradeCapable) capabilities.add("upgrade");
  if (control.directMintAbility === "parameter-only") capabilities.add("parameter-change");
  if (control.role === "bridge-admin" || control.authorityType === "bridge") capabilities.add("bridge-mint");
  return [...capabilities].sort(compareText);
}

function controlFailureDomains(
  assetId: string,
  control: MintAuthorityControl,
  controlKind: ControlOverlay["controlKind"],
): ControlOverlay["failureDomains"] {
  const kind =
    controlKind === "upgrade" ? "upgrade-control" : controlKind === "bridge" ? "bridge-route" : "mint-control";
  const issuerKey = issuerAuthorityKey(assetId, control);
  const exactKeys = control.failureDomainKeys?.length
    ? control.failureDomainKeys
    : control.address
      ? [`${control.chain ?? "chain-unresolved"}:${control.address.toLowerCase()}`]
      : issuerKey
        ? [issuerKey]
        : [];
  return [...new Set(exactKeys)].sort(compareText).map((key) => ({ kind, key: key || `asset:${assetId}` }));
}

function adaptMintControl(
  assetId: string,
  control: MintAuthorityControl,
  index: number,
  incidents: MintAuthorityProfile["mintIncidents"],
  reviewComplete: boolean,
  upgradeCapable: boolean,
  hasSeparateCapRaiser: boolean,
  reviewedEconomicCapSemantics: MintAuthorityEconomicCapSemantics | undefined,
): ControlOverlay {
  const controlKind = mintControlKind(control);
  const capabilities = mintCapabilities(control, upgradeCapable);
  const hasMint = capabilities.includes("mint");
  const capped = control.directMintAbility === "cap-limited" || control.canRaiseCap === true;
  // A reviewed economic cap supersedes the contract-encoding cap for a
  // mint-capable control (owner USDC verdict): economic reality overrides the
  // on-chain cap without falsifying directMintAbility. It only applies where the
  // control actually mints and the reviewed value is decided.
  const reviewedCap =
    hasMint && reviewedEconomicCapSemantics && reviewedEconomicCapSemantics !== "unknown"
      ? reviewedEconomicCapSemantics
      : null;
  const capSemantics: ControlOverlay["capSemantics"] = (() => {
    if (!hasMint) return { kind: "not-applicable", bound: null };
    // "bounded" carries no authored numeric ceiling, so it uses the maximal
    // schema-valid supply-fraction marker; scoring keys off the kind, not the
    // bound value.
    if (reviewedCap === "unbounded") return { kind: "unbounded", bound: null };
    if (reviewedCap === "raiseable") return { kind: "raiseable", bound: null };
    if (reviewedCap === "bounded") return { kind: "bounded", bound: { amount: 1, unit: "supply-fraction" } };
    if (control.directMintAbility === "direct") return { kind: "unbounded", bound: null };
    if (capped) {
      // Reviewed caps exist but the campaign records raise authority, not the
      // numeric bound, so a raiseable cap is the strongest claimable state.
      return control.canRaiseCap === true || hasSeparateCapRaiser
        ? { kind: "raiseable", bound: null }
        : { kind: "unknown", bound: null };
    }
    return control.directMintAbility === "can-authorize"
      ? { kind: "unbounded", bound: null }
      : { kind: "unknown", bound: null };
  })();
  const claimImpairment: ControlOverlay["claimImpairment"] = (() => {
    if (hasMint) {
      if (reviewedCap === "unbounded") return "unbounded";
      if (reviewedCap === "raiseable" || reviewedCap === "bounded") return "bounded";
      return capped ? "bounded" : "unbounded";
    }
    if (capabilities.includes("upgrade") || capabilities.includes("bridge-mint")) return "unbounded";
    if (capabilities.includes("parameter-change")) return "bounded";
    return "none";
  })();
  const economicLossScope: ControlOverlay["economicLossScope"] =
    claimImpairment === "none" ? "access-only" : "global-claim";
  const incidentState: ControlOverlay["incidentState"] = incidents?.some((incident) => incident.status === "active")
    ? "active"
    : incidents?.some((incident) => incident.status === "resolved")
      ? "resolved"
      : reviewComplete
        ? "none"
        : "unknown";
  const controlKey = `mint-meta:${assetId}:${index}:${domainDigest("safety-score-v9.mint-control-key.v1", {
    chain: control.chain ?? null,
    address: control.address?.toLowerCase() ?? null,
    label: control.label,
    role: control.role,
  }).slice(0, 20)}`;
  return {
    controlKey,
    deploymentKey: `asset:${assetId}`,
    ...(control.controllerAssetId ? { controllerAssetId: control.controllerAssetId } : {}),
    controlKind,
    scope: "global",
    capabilities,
    capSemantics,
    claimImpairment,
    economicLossScope,
    authority: canonicalAuthorityType(assetId, control),
    delaySec: control.timelockDelaySec ?? null,
    materialSupplyShare: null,
    keyCustody: control.keyCustodyAttestation?.kind ?? "unknown",
    modulesOrGuards: control.modulesOrGuardsStatus ?? "unknown",
    incidentState,
    failureDomains: controlFailureDomains(assetId, control, controlKind),
  };
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

function collateralExposureMappingIssues(
  edges: Readonly<NonNullable<SafetyScoreV9FactSetExtensionV2["assets"][number]["dependencies"]>["edges"]>,
  reserveSlices: readonly ReserveSlice[] | undefined,
): string[] {
  const mappedWeightByUpstream = new Map<string, number>();
  for (const slice of reserveSlices ?? []) {
    if (!slice.coinId || (slice.depType ?? "collateral") !== "collateral") continue;
    mappedWeightByUpstream.set(slice.coinId, (mappedWeightByUpstream.get(slice.coinId) ?? 0) + slice.pct / 100);
  }
  return edges.flatMap((edge) => {
    const role = edge.economicRole ?? defaultV9DependencyEconomicRole(edge.dependencyType);
    if (role !== "basket-exposure") return [];
    const mappedWeight = mappedWeightByUpstream.get(edge.upstreamAssetId);
    if (mappedWeight === undefined) return [`collateral-edge-exposure-unmapped:${edge.upstreamAssetId}`];
    if (Math.abs(mappedWeight - edge.weight) > 0.000001) {
      return [`collateral-edge-exposure-weight-mismatch:${edge.upstreamAssetId}`];
    }
    return [];
  });
}

function prepareDependency(
  meta: V9ExtensionRegistryMeta,
  liveReserveSlices: readonly ReserveSlice[] | undefined,
  activeIds: ReadonlySet<string>,
  clockSec: number,
): PreparedDependency {
  const effectiveLiveReserveSlices = liveReserveSlices
    ? dependencyReserveSlices(liveReserveSlices, meta, clockSec)
    : undefined;
  const derived = deriveEffectiveDependencySet(meta, {
    ...(effectiveLiveReserveSlices ? { liveReserveSlices: effectiveLiveReserveSlices } : {}),
  });
  const issueCodes: string[] = [];
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
  const reviewMatchesDerived =
    meta.dependencyReview !== undefined &&
    stableJsonStringifyV1(expectedRelationships) === stableJsonStringifyV1(uniqueReviewedBaseRelationships);
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
            weight: derivedRelationship.weight,
            economicRole: relationship.economicRole ?? defaultV9DependencyEconomicRole(relationship.type),
          };
        })
      : null;
  const dependencyRelationships =
    reviewedRelationships ??
    derived.dependencies.map((dependency) => {
      const dependencyType = dependency.type ?? "collateral";
      return {
        id: dependency.id,
        type: dependencyType,
        weight: dependency.weight,
        economicRole: defaultV9DependencyEconomicRole(dependencyType),
      };
    });
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
  issueCodes.push(...collateralExposureMappingIssues(validEdges, reconciliationSlices));
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

function addDependencyEvidence(meta: V9ExtensionRegistryMeta, evidence: ReviewEvidenceBuilder): void {
  const review: DependencyReview | undefined = meta.dependencyReview;
  if (!review) return;
  evidence.add({
    componentKeys: ["dependencies"],
    sourceId: "stablecoin-meta.dependency-review",
    reviewedAt: review.reviewedAt,
    confidence: confidenceForResearch(review.confidence),
    sources: review.sources,
    payload: review,
  });
}

function addWrapperCustodyEvidence(meta: V9ExtensionRegistryMeta, evidence: ReviewEvidenceBuilder): void {
  const review = meta.custodyProfile;
  if (!review) return;
  evidence.add({
    componentKeys: [
      "wrapper-local:custodyEscrow",
      "wrapper-local:rehypothecationCorrelation",
    ],
    sourceId: "stablecoin-meta.custody-profile",
    reviewedAt: review.reviewedAt,
    confidence: confidenceForResearch(review.confidence),
    sources: review.sources,
    payload: review,
  });
}


function transferMaterialScope(
  fixedInput: Readonly<SafetyScoreV9CompilerInput>,
  assetId: string,
  meta: V9ExtensionRegistryMeta,
  generation: SafetyScoreV9TransferMaterialityGeneration | null,
): SafetyScoreV9TransferMaterialScope {
  const rows = safetyScoreV9ChainRows(fixedInput, assetId);
  const totalSupplyUsd = Object.values(rows).reduce((sum, row) => sum + row.current, 0);
  const authoritativeDeployments = (meta.contracts ?? []).flatMap((deployment) => {
    const chainId = resolveChainId(deployment.chain);
    return chainId === null ? [] : [{ chainId, key: safetyScoreV9TransferDeploymentKey(chainId, deployment.address) }];
  });
  const authoritativeDeploymentKeys = [...new Set(authoritativeDeployments.map(({ key }) => key))].sort(compareText);
  if (totalSupplyUsd <= 0) {
    const baseScope: SafetyScoreV9TransferMaterialScope = {
      authoritativeDeploymentKeys,
      materialDeploymentKeys: [],
      materialDeploymentScopeComplete: false,
      // No supply rows at all: only a declared supported-chain contract can
      // make this asset addressable by the contract-scope machinery.
      deploymentModel: authoritativeDeploymentKeys.length > 0 ? "contract-addressable" : "non-contract-native",
    };
    return transferMaterialScopeFromOnchainGeneration({
      assetId,
      meta,
      baseScope,
      generation,
      registryFingerprint: fixedInput.registryFingerprint,
      baseInputGenerationId: fixedInput.baseInputGenerationId,
      clockSec: fixedInput.clockSec,
    });
  }

  const supplyByChainId = new Map<string, number>();
  let unresolvedSupplyUsd = 0;
  for (const [chain, row] of Object.entries(rows)) {
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
  const materialChainIds = [...supplyByChainId.entries()]
    .filter(([, supplyUsd]) => supplyUsd / totalSupplyUsd >= DEPLOYMENT_MATERIAL_SHARE_THRESHOLD)
    .map(([chainId]) => chainId)
    .sort(compareText);
  const materialDeploymentKeys = [
    ...new Set(materialChainIds.flatMap((chainId) => deploymentsByChainId.get(chainId) ?? [])),
  ].sort(compareText);
  return {
    authoritativeDeploymentKeys,
    materialDeploymentKeys,
    materialDeploymentScopeComplete:
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

// A reviewed inherited verdict may have no parent declaration. The V9 branch
// still needs a named upstream to attribute a failure domain, so it checks
// explicit reserve `coinId` edges. The id must resolve to an active tracked
// asset whose own review confirms a direct holder freeze; an upstream that is
// itself inherited does not establish the chain this branch needs to verify.
function resolveReserveSliceUpstreamAssetId(
  meta: V9ExtensionRegistryMeta,
  metaById: ReadonlyMap<string, V9ExtensionRegistryMeta>,
  activeAssetIds: ReadonlySet<string>,
): string | null {
  let best: { assetId: string; pct: number } | null = null;
  for (const slice of meta.reserves ?? []) {
    const upstreamId = slice.coinId;
    if (upstreamId === undefined || upstreamId === meta.id) continue;
    // `upstreamAssetId` is validated against the compiled fact set's active
    // asset set, so a tracked-but-unscored id would make the whole fact set
    // unparseable. Registry membership alone is not enough.
    if (!activeAssetIds.has(upstreamId)) continue;
    const upstream = metaById.get(upstreamId);
    if (upstream === undefined) continue;
    // Mirrors the report card's blacklistable SEED set: an explicit `true`
    // review, or centralized governance when the asset carries no review at all.
    const directlyFreezeCapable =
      upstream.blacklistabilityReview?.reviewedStatus === true ||
      (upstream.blacklistabilityReview === undefined && upstream.flags?.governance === "centralized");
    if (!directlyFreezeCapable) continue;
    // Deterministic pick: largest reserve share, then lexicographic id. The
    // fact set is replayed byte-for-byte, so ties must never resolve on
    // iteration order.
    if (best === null || slice.pct > best.pct || (slice.pct === best.pct && upstreamId < best.assetId)) {
      best = { assetId: upstreamId, pct: slice.pct };
    }
  }
  return best?.assetId ?? null;
}

function adaptAccessReview(
  meta: V9ExtensionRegistryMeta,
  metaById: ReadonlyMap<string, V9ExtensionRegistryMeta>,
  activeAssetIds: ReadonlySet<string>,
  evidence: ReviewEvidenceBuilder,
  transferReview: SafetyScoreV9ReviewedTransferFact | undefined,
  materialScope: SafetyScoreV9TransferMaterialScope,
  clockSec: number,
): ExtensionAsset["accessReview"] {
  const review: BlacklistabilityReview | undefined = meta.blacklistabilityReview;
  if (!review && !transferReview) return null;

  const transferResolution = transferReview
    ? resolveSafetyScoreV9ReviewedTransferFact(transferReview, clockSec, materialScope)
    : null;
  const transferEvidenceKeys = transferReview
    ? evidence.add({
        componentKeys: ["access:transfer"],
        sourceId: "safety-score-v9.reviewed-transfer-overlay",
        reviewedAt: transferReview.reviewedAt,
        confidence: "manual-review",
        sources: transferReview.deployments.flatMap((deployment) => deployment.sources),
        payload: transferReview,
        maxAgeSec: V9_ACCESS_EVIDENCE_MAX_AGE_SEC,
      })
    : [];

  const blacklistFreshness = review ? accessEvidenceObservationState(review.reviewedAt, clockSec) : null;
  const blacklistEvidenceKeys = review
    ? evidence.add({
        // The blacklist fact owns freeze posture. Its transfer binding remains
        // only as the compatibility fallback when no dedicated fact exists.
        componentKeys: [
          ...(transferReview ? [] : ["access:transfer"]),
          "access:freeze",
          `access:freeze:blacklist:${meta.id}`,
        ],
        sourceId: "stablecoin-meta.blacklistability-review",
        reviewedAt: review.reviewedAt,
        confidence: "manual-review",
        sources: review.sources,
        payload: review,
        maxAgeSec: V9_ACCESS_EVIDENCE_MAX_AGE_SEC,
      })
    : [];
  const status = review?.reviewedStatus;
  const declaredInheritedFrom = meta.mintAuthority?.inheritedFrom ?? meta.variantOf ?? null;
  const declaredResolvable = declaredInheritedFrom !== null && activeAssetIds.has(declaredInheritedFrom);
  // A declared parent wins: it is the tighter claim (the whole token inherits
  // its parent's freeze surface). The reserve-slice edge is the fallback for an
  // honest "inherited" verdict that has no parent, which is the ordinary shape
  // for a collateralized asset holding a freezable stablecoin in reserve.
  const reserveInheritedFrom =
    declaredResolvable || status !== "inherited"
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
                      // A declared parent transmits freeze reach through the
                      // upstream's mint/control surface; a reserve-slice
                      // upstream transmits it through the reserve holding it
                      // can freeze. Different domains, so they never merge in
                      // common-mode analysis.
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
      // Owner ruling 2026-07-27: a current review whose honest verdict is
      // "inherited from a named tracked upstream" is a measured structural
      // fact, not missing data. The freeze facts stay bounded-unknown for
      // scoring; the disposition only suppresses the missing-data gap.
      // The upstream may be named by a declared parent OR by a curated reserve
      // slice (see `resolveReserveSliceUpstreamAssetId`) — both are named
      // tracked assets, which is the whole requirement.
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

function buildPegReference(meta: V9ExtensionRegistryMeta): ExtensionAsset["pegReference"] {
  // Pure NAV tokens track fund NAV by design: they have no fixed peg to
  // deviate from, so the peg fact is published not-applicable (the v8 pure
  // NAV carve-over) instead of failing on a missing peg reference.
  if (meta.flags?.navToken === true) {
    return { referenceKind: "nav", referenceKey: `nav:${meta.id}`, failureDomains: [] };
  }
  const pegCurrency = meta.flags?.pegCurrency;
  if (pegCurrency === undefined) return null;
  if (pegCurrency === "VAR" || pegCurrency === "OTHER") {
    return { referenceKind: "other", referenceKey: `unreviewed:${pegCurrency.toLowerCase()}`, failureDomains: [] };
  }
  if (pegCurrency === "GOLD" || pegCurrency === "SILVER") {
    return {
      referenceKind: "asset",
      referenceKey: pegCurrency === "GOLD" ? "commodity:xau" : "commodity:xag",
      failureDomains: [],
    };
  }
  return { referenceKind: "fiat", referenceKey: pegCurrency, failureDomains: [] };
}


/**
 * Epoch second of the most recent *resolved* mint incident, bounded by the
 * evaluation clock. Active incidents are excluded: they drive the existing
 * critical `active-control-incident` path and must not also feed the decay
 * ladder. An unparseable date is retained as the clock itself so an
 * undatable resolved incident decays from "now" (strictest tier), matching
 * the retired Mint Authority engine's fail-conservative treatment.
 */
function latestResolvedMintIncidentAtSec(
  incidents: MintAuthorityProfile["mintIncidents"],
  clockSec: number,
): number | null {
  let latest: number | null = null;
  for (const incident of incidents ?? []) {
    if (incident.status !== "resolved") continue;
    const parsed = Date.parse(`${incident.date}T00:00:00Z`);
    const atSec = Number.isFinite(parsed) ? Math.min(clockSec, Math.max(0, Math.floor(parsed / 1_000))) : clockSec;
    if (latest === null || atSec > latest) latest = atSec;
  }
  return latest;
}

function adaptMintReview(
  meta: V9ExtensionRegistryMeta,
  dependencies: PreparedDependency["dependency"],
  evidence: ReviewEvidenceBuilder,
  clockSec: number,
): {
  review: NonNullable<ExtensionAsset["economicControlReview"]>["mint"];
  controls: ControlOverlay[];
} {
  const profile: MintAuthorityProfile | undefined = meta.mintAuthority;
  if (!profile) {
    return {
      review: {
        status: requiredStatus("v9.control.mint-review", "missing", `mint:${meta.id}`),
        controlKey: null,
        reconciliation: "unknown",
        supervision: "unknown",
        latestResolvedIncidentAtSec: null,
        upgrade: { state: "unknown", controlKey: null },
      },
      controls: [],
    };
  }
  const confidence = confidenceForResearch(profile.confidence);
  const reviewStale = researchReviewObservationState(profile.review.reviewedAt, clockSec) === "stale";
  const evidenceKeys = evidence.add({
    // A stale review still evidences the mint fact itself, but it cannot
    // carry known claims in the umbrella deployment-control inventory.
    componentKeys: reviewStale ? ["economic-control:mint"] : ["economic-control:mint", "control"],
    sourceId: "stablecoin-meta.mint-authority",
    reviewedAt: profile.review.reviewedAt,
    confidence,
    sources: profile.review.sources,
    payload: profile,
    maxAgeSec: V9_REVIEW_EVIDENCE_MAX_AGE_SEC,
  });
  if (reviewStale) {
    return {
      review: {
        status: requiredStatus("v9.control.mint-review", "stale", `mint:${meta.id}`, evidenceKeys),
        controlKey: null,
        reconciliation: "unknown",
        supervision: "unknown",
        latestResolvedIncidentAtSec: null,
        upgrade: { state: "unknown", controlKey: null },
      },
      controls: [],
    };
  }
  const reviewComplete =
    profile.review.disposition !== "unresolved" &&
    (profile.review.unresolvedQuestions?.length ?? 0) === 0 &&
    reviewedObservationState(confidence) === "known";
  const upgradeability = profile.upgradeability;
  // An unresolved aggregate inventory does not erase controls that were
  // individually identified. Retain those controls in a partial review while
  // the unresolved deployment surfaces remain bounded and fail closed.
  const controls = (profile.controls ?? []).map((control, index, allControls) =>
    adaptMintControl(
      meta.id,
      control,
      index,
      profile.mintIncidents,
      reviewComplete,
      upgradeability?.canChangeMintLogic === true && upgradeability.controlRef === control.label,
      control.directMintAbility === "cap-limited" &&
        control.canRaiseCap === false &&
        allControls.some(
          (candidate, candidateIndex) =>
            candidateIndex !== index && candidate.chain === control.chain && candidate.canRaiseCap === true,
        ),
      profile.economicCapSemantics,
    ),
  );
  const directMintControl = controls.find((control) => control.capabilities.includes("mint")) ?? null;
  const inheritedFrom = profile.inheritedFrom;
  const hasExactInheritedWrapperDependency =
    profile.mintPath === "wrapped-or-variant-inherited" &&
    inheritedFrom !== undefined &&
    dependencies.diagnostics.graphState === "valid" &&
    dependencies.edges.some(
      (edge) =>
        edge.dependencyType === "wrapper" &&
        edge.economicRole === "serial-claim" &&
        edge.upstreamAssetId === inheritedFrom &&
        edge.weight === 1 &&
        edge.failureDomains.some(
          (domain) => domain.kind === "mint-control" && domain.key === `asset:${inheritedFrom}`,
        ),
    );
  const inheritedShareControlIndex = hasExactInheritedWrapperDependency
    ? (profile.controls ?? []).findIndex(
        (control) =>
          control.role === "wrapper" &&
          control.directMintAbility === "none" &&
          control.canRaiseCap === false,
      )
    : -1;
  // An exact serial wrapper does not create durable parent supply. Its reviewed
  // share-accounting control therefore represents the local mint component when
  // no explicit durable-mint control exists. The parent mint domain remains on
  // the serial dependency, while every local upgrade control stays in this
  // asset's control inventory and continues to constrain the wrapper layer.
  const inheritedShareControl =
    directMintControl === null && inheritedShareControlIndex >= 0
      ? (controls[inheritedShareControlIndex] ?? null)
      : null;
  const mintControl = directMintControl ?? inheritedShareControl;
  const referencedUpgradeIndex =
    upgradeability?.controlRef == null
      ? -1
      : (profile.controls ?? []).findIndex((control) => control.label === upgradeability.controlRef);
  const referencedUpgrade = referencedUpgradeIndex >= 0 ? (controls[referencedUpgradeIndex] ?? null) : null;
  const reviewedUpgradeControl =
    referencedUpgrade?.capabilities.includes("upgrade") === true
      ? referencedUpgrade
      : (controls.find((control) => control.capabilities.includes("upgrade")) ?? null);
  const upgrade =
    upgradeability?.model === "immutable" && upgradeability.canChangeMintLogic === false
      ? { state: "immutable" as const, controlKey: null }
      : reviewedUpgradeControl !== null
        ? { state: "reviewed" as const, controlKey: reviewedUpgradeControl.controlKey }
        : { state: "unknown" as const, controlKey: null };
  const issuerBackendMint = mintControl?.authority?.model === "issuer-backend";
  const inferredReconciliation: NonNullable<ExtensionAsset["economicControlReview"]>["mint"]["reconciliation"] =
    mintControl === null
      ? upgrade.state === "immutable"
        ? "not-applicable"
        : "unknown"
      : issuerBackendMint
        ? meta.proofOfReserves?.latestReport || meta.proofOfReserves?.cadence
          ? "periodic"
          : "unknown"
        : "not-applicable";
  // A reviewed reconciliation cadence supersedes the inferred one; absent or
  // "unknown" keeps the inference (fail-closed inertness).
  const reconciliation =
    profile.reconciliation && profile.reconciliation !== "unknown" ? profile.reconciliation : inferredReconciliation;
  const immutableWithoutMint = mintControl === null && upgrade.state === "immutable";
  const state = !reviewComplete
    ? profile.review.disposition === "unresolved" && evidenceKeys.length > 0
      ? "bounded-unknown"
      : reviewedObservationState(confidence) === "missing"
        ? "missing"
        : "bounded-unknown"
    : reconciliation === "unknown" && (issuerBackendMint || (mintControl === null && !immutableWithoutMint))
      ? "bounded-unknown"
      : "known";
  return {
    review: {
      status: requiredStatus(
        "v9.control.mint-review",
        state,
        `mint:${meta.id}`,
        state === "known" || state === "bounded-unknown" ? evidenceKeys : [],
      ),
      controlKey: mintControl?.controlKey ?? null,
      reconciliation,
      // A reviewed prudential-supervision fact graduates the reconciled mint
      // rung; absent or "unknown" stays fail-closed at "unknown".
      supervision: profile.supervision && profile.supervision !== "unknown" ? profile.supervision : "unknown",
      latestResolvedIncidentAtSec: latestResolvedMintIncidentAtSec(profile.mintIncidents, clockSec),
      upgrade,
    },
    controls,
  };
}

/**
 * Builds a conservative baseline overlay from structured, reviewed fields in
 * the exact publication capture or registry. Unreviewed mechanism, exit, and
 * other critical semantics remain explicit gaps. These adapters enrich the
 * shadow fact set; they are not expected to make the current cohort rateable.
 */
export function buildSafetyScoreV9BaselineExtension(
  fixedInputValue: unknown,
  options: BuildSafetyScoreV9BaselineExtensionOptions = {},
): SafetyScoreV9FactSetExtensionV2 {
  return buildSafetyScoreV9BaselineExtensionFromNormalizedInput(normalizeSafetyScoreV9CompilerInput(fixedInputValue), options);
}

/**
 * Trusted runtime entrypoint for callers that already paid the strict fixed-
 * input parse cost at their storage boundary.
 */
export function buildSafetyScoreV9BaselineExtensionFromNormalizedInput(
  fixedInput: Readonly<SafetyScoreV9CompilerInput>,
  options: BuildSafetyScoreV9BaselineExtensionOptions = {},
): SafetyScoreV9FactSetExtensionV2 {
  const metaById = options.metaById ?? ACTIVE_META_BY_ID;
  const reviewedTransferFacts = options.reviewedTransferFacts ?? SAFETY_SCORE_V9_REVIEWED_TRANSFER_FACTS;
  const localRegistryFingerprint = options.registryFingerprint ?? computeReportCardsRegistryFingerprint();
  const allowRegistryMismatch = options.allowRegistryMismatch === true;
  if (!allowRegistryMismatch && localRegistryFingerprint !== fixedInput.registryFingerprint) {
    throw new Error(
      `Safety Score v9 registry fingerprint ${localRegistryFingerprint} does not match fixed input ${fixedInput.registryFingerprint}`,
    );
  }
  // With the mismatch accepted, the extension adopts the *capture's* registry
  // identity. The compiled fact set already stamps its registry provenance from
  // the fixed input, and the trusted compile path re-asserts extension identity
  // against it, so adopting it here is what keeps the replay internally
  // coherent. The registry rows themselves are still the local tree's: the
  // resulting artifact measures code and curation together and is replay-only.
  const registryFingerprint = allowRegistryMismatch ? fixedInput.registryFingerprint : localRegistryFingerprint;
  const clockSec = fixedInput.clockSec;
  const activeIds = new Set(fixedInput.activeAssetIds);
  const preparedById = new Map<string, PreparedDependency>();
  for (const assetId of fixedInput.activeAssetIds) {
    const meta = metaById.get(assetId);
    if (!meta) throw new Error(`Safety Score v9 baseline extension has no registry metadata for ${assetId}`);
    preparedById.set(assetId, prepareDependency(meta, fixedInput.liveReserveMap[assetId], activeIds, clockSec));
  }
  const graph = diagnoseDependencyGraph(
    [...preparedById.values()]
      .flatMap((prepared) => prepared.graphEdges)
      .filter((edge) => edge.economicRole === "serial-claim"),
  );
  const cycleByAsset = new Map<string, string[]>();
  for (const component of graph.stronglyConnectedComponents) {
    for (const assetId of component) cycleByAsset.set(assetId, component);
  }

  const reserveObservedAtSec = maximumObservedAt(
    Object.values(fixedInput.liveReserveProvenanceMap).map((provenance) => provenance?.fetchedAt),
    fixedInput.updatedAt,
    clockSec,
  );
  const pegObservedAtSec = maximumObservedAt(
    [
      ...Object.values(fixedInput.pegDataById).map((peg) => peg.priceObservedAt),
      ...Object.values(fixedInput.navPriceById ?? {}).map((navPrice) => navPrice.observedAtSec),
    ],
    fixedInput.updatedAt,
    clockSec,
  );
  const registryObservedAtSec = boundedObservedAt(fixedInput.updatedAt, clockSec);
  const liveReservesGenerationDigest = domainDigest("safety-score-v9.live-reserves.v1", {
    reserves: fixedInput.liveReserveMap,
    provenance: fixedInput.liveReserveProvenanceMap,
  });
  const chainSupplyGenerationId = safetyScoreV9ChainSupplySourceGenerationId(fixedInput);
  const chainSupplyObservedAtSec = maximumObservedAt(
    Object.values(fixedInput.safetyScoreV9SupplyAttributionById).map(
      (attribution) => attribution.observedAtSec,
    ),
    fixedInput.updatedAt,
    clockSec,
  );
  const pegGenerationDigest = domainDigest("safety-score-v9.peg.v1", {
    pegDataById: fixedInput.pegDataById,
    navPriceById: fixedInput.navPriceById ?? {},
    activeDepegPeakBpsById: fixedInput.activeDepegPeakBpsById,
  });
  const researchOverlaysGenerationDigest = domainDigest("safety-score-v9.research-overlays.v3", {
    registryRevision: fixedInput.registryRevision,
    mechanismReviewOverlaysDigest: SAFETY_SCORE_V9_MECHANISM_REVIEW_OVERLAYS_DIGEST,
    operationalResilienceOverlaysDigest: SAFETY_SCORE_V9_OPERATIONAL_RESILIENCE_OVERLAYS_DIGEST,
    reviewedTransferFactsDigest: computeSafetyScoreV9ReviewedTransferFactsDigest(reviewedTransferFacts.values()),
  });
  const sources = {
    registryObservedAtSec,
    unavailableRedemptionObservedAtSec: boundedObservedAt(
      fixedInput.inputFreshness.redemptionBackstops.updatedAt,
      clockSec,
    ),
    liveReserves: {
      generationId: `live-reserves:v1:${liveReservesGenerationDigest}`,
      observedAtSec: reserveObservedAtSec,
      maxAgeSec: V9_EVIDENCE_PRODUCER_INTERVAL_SEC["sync-live-reserves"] * 2,
    },
    chainSupply: {
      generationId: chainSupplyGenerationId,
      observedAtSec: chainSupplyObservedAtSec,
      maxAgeSec: V9_EVIDENCE_PRODUCER_INTERVAL_SEC["sync-stablecoins"] * 2,
    },
    peg: {
      generationId: `peg:v1:${pegGenerationDigest}`,
      observedAtSec: pegObservedAtSec,
      maxAgeSec: V9_EVIDENCE_PRODUCER_INTERVAL_SEC["sync-stablecoins"] * 2,
    },
    researchOverlays: {
      generationId: `research-overlays:v3:${researchOverlaysGenerationDigest}`,
      observedAtSec: registryObservedAtSec,
      // Curated mechanism/reserve/route overlays re-bound after twelve months,
      // consistent with the D1 overlay standard and the mechanism-overlay
      // expiry gate (VER2-004). Registry-observed overlays stay current well
      // inside this window, so the current cohort is unaffected.
      maxAgeSec: 31_536_000,
    },
  } satisfies SafetyScoreV9FactSetExtensionV2["sources"];
  const liveToFallbackAssetIds = new Set(fixedInput.liveToFallbackCoins);

  return {
    schemaVersion: 2,
    registryFingerprint,
    compiledAtSec: clockSec,
    sources,
    routeFreshness: {
      dexMaxAgeSec: V9_EVIDENCE_PRODUCER_INTERVAL_SEC["sync-dex-liquidity"] * 2,
      redemptionMaxAgeSec: V9_EVIDENCE_PRODUCER_INTERVAL_SEC["sync-redemption-backstops"] * 2,
      documentedTermsMaxAgeSec: SAME_NOTIONAL_EXIT_OBSERVATION_FRESHNESS_POLICY.documentedTermsMaxAgeSec,
    },
    assets: fixedInput.activeAssetIds.map((assetId) => {
      const meta = metaById.get(assetId)!;
      const prepared = preparedById.get(assetId)!;
      const cycle = cycleByAsset.get(assetId);
      const archetype = resolveMechanismArchetype(meta, metaById) ?? "unresolved";
      const liveReserves = fixedInput.liveReserveMap[assetId] ?? [];
      const reviewedStaticReserveRows =
        liveReserves.length === 0
          ? buildSafetyScoreV9ReviewedStaticReserveRows(meta, clockSec) ??
            (meta.liveReservesConfig != null
              ? liveToFallbackAssetIds.has(assetId)
                ? buildSafetyScoreV9ReviewedCuratedFallbackReserveRows(meta, clockSec)
                : null
              : buildSafetyScoreV9ReviewedStandaloneReserveRows(meta, clockSec))
          : null;
      const reserveRows = reviewedStaticReserveRows?.rows ?? liveReserves;
      const reviewEvidence = new ReviewEvidenceBuilder(assetId, clockSec);
      const mechanismRiskReview = buildSafetyScoreV9MechanismReview(fixedInput, meta, archetype);
      const mechanismReviewGapDisposition =
        getSafetyScoreV9MechanismReviewGapDisposition(assetId, archetype, clockSec);
      const mechanismOverlayEvidence = getSafetyScoreV9MechanismOverlayEvidence(assetId, archetype, clockSec);
      if (mechanismRiskReview && mechanismOverlayEvidence) {
        reviewEvidence.add({
          componentKeys: ["mechanism-risk-review"],
          sourceId: "safety-score-v9.mechanism-review-overlay",
          reviewedAt: mechanismOverlayEvidence.reviewedAt,
          confidence: "manual-review",
          sources: mechanismOverlayEvidence.sources,
          payload: mechanismOverlayEvidence.payload,
          maxAgeSec: mechanismOverlayEvidence.maxAgeSec,
        });
      }
      const reserveClassifications = buildReviewedReserveClassifications(reserveRows, meta, clockSec);
      addReserveClassificationEvidence(meta, reserveClassifications, reviewEvidence);
      addReviewedStaticReserveEvidence(meta, reviewedStaticReserveRows, reviewEvidence);
      addDependencyEvidence(meta, reviewEvidence);
      addWrapperCustodyEvidence(meta, reviewEvidence);
      const supplyReview = buildSafetyScoreV9SupplyReview(
        fixedInput,
        assetId,
        meta.bridgeRouteRisk,
        {
          meta,
          transferMaterialityGeneration: options.transferMaterialityGeneration ?? null,
        },
      );
      const deployedChainCount = Object.keys(safetyScoreV9ChainRows(fixedInput, assetId)).length;
      const assetIssuerKey = resolveSafetyScoreV9AssetIssuerKey(assetId, metaById);
      const mint = adaptMintReview(meta, prepared.dependency, reviewEvidence, clockSec);
      const oracle = adaptOracleReview(meta, archetype, reviewEvidence, clockSec);
      const bridge = adaptBridgeReview(meta, supplyReview, deployedChainCount, reviewEvidence, clockSec);
      const controls = [...mint.controls, ...bridge.controls].sort((left, right) =>
        compareText(left.controlKey, right.controlKey),
      );
      const accessReview = adaptAccessReview(
        meta,
        metaById,
        activeIds,
        reviewEvidence,
        reviewedTransferFacts.get(assetId),
        transferMaterialScope(
          fixedInput,
          assetId,
          meta,
          options.transferMaterialityGeneration ?? null,
        ),
        clockSec,
      );
      const reviewedEvidence = reviewEvidence.finish();
      const controlsFullyResolved =
        controls.length > 0 &&
        controls.every(
          (control) =>
            control.economicLossScope === "access-only" ||
            (control.economicLossScope === "deployment" &&
              control.materialSupplyShare !== null &&
              control.materialSupplyShare < DEPLOYMENT_MATERIAL_SHARE_THRESHOLD) ||
            (control.capSemantics.kind !== "unknown" &&
              control.claimImpairment !== "unknown" &&
              control.economicLossScope !== "unknown" &&
              control.incidentState !== "unknown" &&
              control.authority !== null &&
              control.authority.model !== "unknown"),
        );
      return {
        assetId,
        assetIssuerKey,
        archetype,
        variantKind: meta.variantKind ?? null,
        ...(meta.wrapperOperator === undefined ? {} : { wrapperOperator: meta.wrapperOperator }),
        launchedAtSec: conservativeDateEndSec(meta.implementationLaunchDate ?? meta.launchDate, clockSec),
        mechanismRiskReview,
        ...(mechanismReviewGapDisposition ? { mechanismReviewGapDisposition } : {}),
        mechanismExitFacts: getSafetyScoreV9MechanismExitFacts(assetId, archetype, clockSec),
        dependencies: {
          ...prepared.dependency,
          diagnostics: cycle
            ? {
                graphState: "cycle",
                issueCodes: [...new Set([...prepared.issueCodes, "dependency-cycle"])].sort(compareText),
                sccMemberAssetIds: [...cycle].sort(compareText),
              }
            : prepared.dependency.diagnostics,
        },
        reserveApplicability: { state: "required" },
        reserveClassifications,
        reviewedStaticReserveRows,
        routeReviews: buildSafetyScoreV9RouteReviews(fixedInput, assetId),
        retainedRoutes: buildSafetyScoreV9RetainedRoutes(fixedInput, assetId),
        controlReview:
          controls.length > 0
            ? controlsFullyResolved
              ? { state: "reviewed-controls", controls }
              : {
                  state: "partially-reviewed-controls",
                  controls,
                  rationale:
                    "Reviewed metadata identifies controls, but reconciliation, incident, cap, economic-loss, or materiality semantics remain unresolved.",
                }
            : null,
        economicControlReview:
          meta.mintAuthority || meta.oracleRisk || meta.bridgeRouteRisk
            ? {
                mint: mint.review,
                oracle,
                bridge: bridge.review,
              }
            : null,
        accessReview,
        pegReference: buildPegReference(meta),
        supplyReview,
        operationalResilience: getSafetyScoreV9OperationalResilienceOverlay(assetId, clockSec),
        wrapperCustodyReview:
          (meta.variantKind === "savings-passthrough" ||
            meta.variantKind === "risk-absorption" ||
            meta.variantKind === "strategy-vault") &&
          meta.custodyProfile
          ? {
              providers: meta.custodyProfile.providers.map((provider) => ({
                providerKey: provider.name,
                role: provider.role,
                shareFraction: provider.sharePct === undefined ? null : provider.sharePct / 100,
              })),
              segregation: meta.custodyProfile.segregation,
              bankruptcyRemoteness: meta.custodyProfile.bankruptcyRemoteness,
              rehypothecation: meta.custodyProfile.rehypothecation,
              knownUnknownExposureShare:
                meta.custodyProfile.knownUnknownExposurePct === undefined
                  ? null
                  : meta.custodyProfile.knownUnknownExposurePct / 100,
            }
          : null,
        ...reviewedEvidence,
      };
    }),
  };
}
