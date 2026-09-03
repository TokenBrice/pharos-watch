import { resolveMechanismArchetype } from "@shared/lib/classification/resolve-mechanism-archetype";
import { resolveChainId } from "@shared/lib/chains";
import { normalizeDeploymentId } from "@shared/lib/deployment-id";
import { deriveEffectiveDependencySet } from "@shared/lib/dependency-derivation";
import { diagnoseDependencyGraph, type DependencyGraphEdge } from "@shared/lib/dependency-graph";
import { V9_EVIDENCE_PRODUCER_INTERVAL_SEC } from "@shared/lib/cron-cadences";
import { computeReportCardsRegistryFingerprint } from "@shared/lib/report-cards-fixed-input-identity";
import { V9_ACCESS_EVIDENCE_MAX_AGE_SEC } from "@shared/lib/safety-score-v9/access-posture";
import { V9_REVIEW_EVIDENCE_MAX_AGE_SEC, V9_SCOPED_QUESTION_MAX_AGE_SEC } from "@shared/lib/safety-score-v9/evidence";
import { V9_CANDIDATE_POLICY_V1 } from "@shared/lib/safety-score-v9/policy";
import { compareText, domainDigest } from "@shared/lib/safety-score-v9/primitives";
import { stableJsonStringifyV1 } from "@shared/lib/stable-json";
import { ACTIVE_META_BY_ID } from "@shared/lib/stablecoins/registry";
import {
  hasReviewedNoLocalIssuanceException,
  validateMintBridgeOwnership,
} from "@shared/lib/stablecoins/mint-bridge-ownership";
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
import type { StablecoinMeta } from "@shared/types";
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
  getSafetyScoreV9MechanismReviewedUnavailableComponents,
  SAFETY_SCORE_V9_MECHANISM_REVIEW_OVERLAYS_DIGEST,
} from "./safety-score-v9-extension-mechanism";
import {
  getSafetyScoreV9OperationalResilienceOverlay,
  SAFETY_SCORE_V9_OPERATIONAL_RESILIENCE_OVERLAYS_DIGEST,
} from "./safety-score-v9-extension-operational-resilience";
import {
  addSafetyScoreV9IncidentEvidence,
  getSafetyScoreV9ReviewedIncidents,
  routeSafetyScoreV9ControlIncidents,
  routeSafetyScoreV9OperationalIncidents,
  SAFETY_SCORE_V9_INCIDENT_REVIEWS_DIGEST,
} from "./safety-score-v9-extension-incidents";
import { getSafetyScoreV9WrapperAllocationReview } from "./safety-score-v9-extension-wrapper-allocation";
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
  buildSafetyScoreV9ReviewedAuditedFallbackReserveRows,
  buildSafetyScoreV9ReviewedCuratedFallbackReserveRows,
  buildSafetyScoreV9ReviewedStandaloneReserveRows,
  buildSafetyScoreV9ReviewedStaticReserveRows,
  dependencyReserveSlices,
} from "./safety-score-v9-extension-reserves";
import {
  ReviewEvidenceBuilder,
  accessEvidenceObservationState,
  authorityModelForType,
  boundedObservedAt,
  confidenceForResearch,
  conservativeDateEndSec,
  isoDateStartSec,
  maximumObservedAt,
  notApplicableStatus,
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
  buildSafetyScoreV9ReviewedAuditedFallbackReserveRows,
  buildSafetyScoreV9ReviewedCuratedFallbackReserveRows,
  buildSafetyScoreV9ReviewedStandaloneReserveRows,
  buildSafetyScoreV9ReviewedStaticReserveRows,
};

type ReviewedReserveRows = ReturnType<typeof buildSafetyScoreV9ReviewedStaticReserveRows>;

/**
 * Resolve the reviewed reserve rows admitted by the production extension.
 * Operator tooling calls this helper so preventive queues cannot drift from
 * the score-bearing static/fallback/standalone branch order.
 */
export function resolveReviewedReserveRows(input: {
  meta: V9ExtensionRegistryMeta;
  clockSec: number;
  liveReserveRows: readonly ReserveSlice[];
  liveFallbackAllowed: boolean;
}): ReviewedReserveRows {
  if (input.liveReserveRows.length > 0) return null;
  return (
    buildSafetyScoreV9ReviewedStaticReserveRows(input.meta, input.clockSec) ??
    (input.meta.liveReservesConfig != null
      ? input.liveFallbackAllowed
        ? buildSafetyScoreV9ReviewedAuditedFallbackReserveRows(input.meta, input.clockSec) ??
          buildSafetyScoreV9ReviewedCuratedFallbackReserveRows(input.meta, input.clockSec)
        : null
      : buildSafetyScoreV9ReviewedStandaloneReserveRows(input.meta, input.clockSec))
  );
}

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
  const model = authorityModelForType(control.authorityType);
  const threshold =
    model === "multisig" && control.threshold != null && control.signerCount != null
      ? { required: control.threshold, total: control.signerCount }
      : null;
  return { authorityKey, model, threshold };
}

function mintControlKind(control: MintAuthorityControl): ControlOverlay["controlKind"] {
  if (control.directMintAbility === "upgrade-only" || control.role === "proxy-admin") return "upgrade";
  if (control.role === "governor" || control.role === "timelock") return "governance";
  if (control.role === "custodian") return "custody";
  return "mint";
}

function mintCapabilities(control: MintAuthorityControl, upgradeCapable: boolean): ControlOverlay["capabilities"] {
  const capabilities = new Set<ControlOverlay["capabilities"][number]>();
  if (["direct", "cap-limited", "can-authorize"].includes(control.directMintAbility)) capabilities.add("mint");
  if (control.directMintAbility === "upgrade-only" || upgradeCapable) capabilities.add("upgrade");
  if (control.directMintAbility === "parameter-only") capabilities.add("parameter-change");
  return [...capabilities].sort(compareText);
}

function controlFailureDomains(
  assetId: string,
  control: MintAuthorityControl,
  controlKind: ControlOverlay["controlKind"],
): ControlOverlay["failureDomains"] {
  const kind = controlKind === "upgrade" ? "upgrade-control" : "mint-control";
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

const MINT_CONTROL_SUPPLY_RECONCILIATION_TOLERANCE = 0.000001;

interface MintControlDeploymentScope {
  deploymentKey: string;
  materialSupplyShare: number;
}

/**
 * Resolve a reviewed mint/upgrade authority onto the already-compiled bridge
 * materiality partition. The control remains global unless the partition is
 * complete, every authored deployment ref joins exactly once, and at least one
 * other liability deployment sits outside the authority's reach.
 */
function resolveMintControlDeploymentScopes(
  control: Pick<MintAuthorityControl, "deploymentRefs">,
  supplyReview: ExtensionAsset["supplyReview"],
  reviewComplete: boolean,
): MintControlDeploymentScope[] | null {
  const deploymentRefs = [...new Set((control.deploymentRefs ?? []).map(normalizeDeploymentId))].sort(compareText);
  if (!reviewComplete || deploymentRefs.length === 0 || deploymentRefs.some((ref) => ref.length === 0)) return null;
  if (supplyReview === null || supplyReview.selectedBridgeRoutes.length === 0) return null;

  const rows = supplyReview.selectedBridgeRoutes;
  const totalShare = rows.reduce((sum, row) => sum + row.supplyShare, 0);
  const completePartition =
    rows.every(
      (row) =>
        row.reviewState === "selected-reviewed" &&
        Number.isFinite(row.supplyShare) &&
        row.supplyShare >= 0 &&
        row.supplyShare <= 1,
    ) &&
    Math.abs(totalShare - 1) <= MINT_CONTROL_SUPPLY_RECONCILIATION_TOLERANCE &&
    Math.abs(supplyReview.selectedRouteSupplyShare - 1) <= MINT_CONTROL_SUPPLY_RECONCILIATION_TOLERANCE &&
    supplyReview.unknownRouteSupplyShare <= MINT_CONTROL_SUPPLY_RECONCILIATION_TOLERANCE &&
    supplyReview.unreviewedRouteSupplyShare <= MINT_CONTROL_SUPPLY_RECONCILIATION_TOLERANCE;
  if (!completePartition) return null;

  const rowByDeployment = new Map(rows.map((row) => [row.deploymentRouteKey, row]));
  const matched = deploymentRefs.map((deploymentKey) => rowByDeployment.get(deploymentKey));
  if (matched.some((row) => row === undefined)) return null;
  // Reaching every reconciled deployment is economically asset-wide even when
  // the review happens to enumerate those deployments one by one.
  if (deploymentRefs.length === rows.length) return null;

  return matched.map((row) => ({
    deploymentKey: row!.deploymentRouteKey,
    materialSupplyShare: row!.supplyShare,
  }));
}

function adaptMintControl(
  assetId: string,
  control: MintAuthorityControl,
  incidents: MintAuthorityProfile["mintIncidents"],
  reviewComplete: boolean,
  upgradeCapable: boolean,
  hasSeparateCapRaiser: boolean,
  reviewedEconomicCapSemantics: MintAuthorityEconomicCapSemantics | undefined,
  scopedQuestionFresh: boolean,
  supplyReview: ExtensionAsset["supplyReview"],
): ControlOverlay[] {
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
    // MINT-LADDER 9.32 (2026-08-21): collateral-gated is a distinct reviewed
    // economic bound, not an arbitrary-mint or raiseable-cap fallback.
    if (reviewedCap === "collateral-gated") return { kind: "collateral-gated", bound: null };
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
      if (
        reviewedCap === "raiseable" ||
        reviewedCap === "bounded" ||
        reviewedCap === "collateral-gated"
      ) {
        return "bounded";
      }
      return capped ? "bounded" : "unbounded";
    }
    if (capabilities.includes("upgrade")) return "unbounded";
    if (capabilities.includes("parameter-change")) return "bounded";
    return "none";
  })();
  const deploymentScopes = resolveMintControlDeploymentScopes(control, supplyReview, reviewComplete);
  const incidentState: ControlOverlay["incidentState"] = incidents?.some((incident) => incident.status === "active")
    ? "active"
    : incidents?.some((incident) => incident.status === "resolved")
      ? "resolved"
      : reviewComplete
        ? "none"
        : "unknown";
  const controlKey = `mint-meta:${assetId}:${domainDigest("safety-score-v9.mint-control-key.v1", {
    chain: control.chain ?? null,
    address: control.address?.toLowerCase() ?? null,
    label: control.label,
    role: control.role,
    authorityType: control.authorityType,
    directMintAbility: control.directMintAbility,
    deploymentRefs: [...(control.deploymentRefs ?? [])]
      .map(normalizeDeploymentId)
      .sort(compareText),
  }).slice(0, 20)}`;
  const globalControl: ControlOverlay = {
    controlKey,
    deploymentKey: `asset:${assetId}`,
    ...(control.controllerAssetId ? { controllerAssetId: control.controllerAssetId } : {}),
    controlKind,
    scope: "global",
    capabilities,
    capSemantics,
    claimImpairment,
    economicLossScope: claimImpairment === "none" ? "access-only" : "global-claim",
    authority: canonicalAuthorityType(assetId, control),
    delaySec: control.timelockDelaySec ?? null,
    materialSupplyShare: null,
    ...(scopedQuestionFresh ? { scopedQuestionFresh: true } : {}),
    keyCustody: control.keyCustodyAttestation?.kind ?? "unknown",
    modulesOrGuards: control.modulesOrGuardsStatus ?? "unknown",
    incidentState,
    failureDomains: controlFailureDomains(assetId, control, controlKind),
  };
  if (deploymentScopes === null) return [globalControl];
  return deploymentScopes.map((deployment, index) => ({
    ...globalControl,
    controlKey:
      index === 0
        ? controlKey
        : `${controlKey}:deployment:${domainDigest(
            "safety-score-v9.mint-control-deployment-key.v1",
            deployment.deploymentKey,
          ).slice(0, 12)}`,
    deploymentKey: deployment.deploymentKey,
    scope: "deployment",
    economicLossScope: claimImpairment === "none" ? "access-only" : "deployment",
    materialSupplyShare: deployment.materialSupplyShare,
  }));
}

function assertMintBridgeOwnership(meta: V9ExtensionRegistryMeta): void {
  const violations = validateMintBridgeOwnership(meta, { enforce: true });
  const errors = violations.filter((violation) => violation.severity === "error");
  if (errors.length === 0) return;
  throw new Error(
    `Safety Score v9 mint/bridge ownership validation failed for ${meta.id}: ${errors
      .map((violation) => `${violation.code} at ${String(violation.path)}: ${violation.message}`)
      .join("; ")}`,
  );
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

function hasAdmissibleCuratedReserveComposition(
  meta: V9ExtensionRegistryMeta,
  clockSec: number,
): boolean {
  if (buildSafetyScoreV9ReviewedStaticReserveRows(meta, clockSec) !== null) return true;
  return meta.liveReservesConfig !== undefined
    ? buildSafetyScoreV9ReviewedCuratedFallbackReserveRows(meta, clockSec) !== null
    : buildSafetyScoreV9ReviewedStandaloneReserveRows(meta, clockSec) !== null;
}

function prepareDependency(
  meta: V9ExtensionRegistryMeta,
  liveReserveSlices: readonly ReserveSlice[] | undefined,
  activeIds: ReadonlySet<string>,
  clockSec: number,
): PreparedDependency {
  const hasLiveReserveSlices = (liveReserveSlices?.length ?? 0) > 0;
  const effectiveLiveReserveSlices = liveReserveSlices
    ? dependencyReserveSlices(liveReserveSlices, meta, clockSec)
    : undefined;
  const derived = deriveEffectiveDependencySet(meta, {
    ...(effectiveLiveReserveSlices ? { liveReserveSlices: effectiveLiveReserveSlices } : {}),
  });
  // Curated basket links are only scoreable when the same composition can enter
  // the reserve envelope. A missing live snapshot must not keep stale curated
  // collateral edges alive; serial/manual relationships and live-derived edges
  // deliberately stay on their existing paths.
  const suppressCuratedBasketEdges =
    !hasLiveReserveSlices &&
    derived.baseSource === "curated-reserve" &&
    derived.dependencies.some(
      (dependency) => (dependency.type ?? "collateral") === "collateral",
    ) &&
    !hasAdmissibleCuratedReserveComposition(meta, clockSec);
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
  const dependencyRelationships = (
    reviewedRelationships ??
    derived.dependencies.map((dependency) => {
      const dependencyType = dependency.type ?? "collateral";
      return {
        id: dependency.id,
        type: dependencyType,
        weight: dependency.weight,
        economicRole: defaultV9DependencyEconomicRole(dependencyType),
      };
    })
  ).filter(
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
    publishedBy: "unknown",
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
    publishedBy: "unknown",
    confidence: confidenceForResearch(review.confidence),
    sources: review.sources,
    payload: review,
  });
}

function addWrapperAllocationEvidence(
  review: ReturnType<typeof getSafetyScoreV9WrapperAllocationReview>,
  evidence: ReviewEvidenceBuilder,
): void {
  if (!review) return;
  evidence.add({
    componentKeys: [
      "wrapper-local:custodyEscrow",
      "wrapper-local:leverage",
      "wrapper-local:rehypothecationCorrelation",
    ],
    sourceId: "safety-score-v9.wrapper-allocation-review",
    reviewedAt: review.reviewedAt,
    publishedBy: "unknown",
    confidence: "verified",
    sources: review.sources,
    payload: review,
    maxAgeSec:
      Math.floor(Date.parse(`${review.expiresAt}T00:00:00.000Z`) / 1_000) -
      Math.floor(Date.parse(`${review.reviewedAt}T00:00:00.000Z`) / 1_000),
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
        publishedBy: "unknown",
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

type PegReferenceRegistryMeta = V9ExtensionRegistryMeta & Pick<StablecoinMeta, "pegReferenceId">;

const PEG_REFERENCE_ID_MARKER = ":peg-reference:";
const PEG_REFERENCE_UNRESOLVED_PREFIX = "unresolved:peg-reference:";

function unresolvedPegReference(
  reason: "self-reference" | "unresolvable" | "cycle",
): NonNullable<ExtensionAsset["pegReference"]> {
  return {
    referenceKind: "other",
    referenceKey: `${PEG_REFERENCE_UNRESOLVED_PREFIX}${reason}`,
    failureDomains: [],
  };
}

function pegReferenceId(meta: V9ExtensionRegistryMeta): string | undefined {
  return (meta as PegReferenceRegistryMeta).pegReferenceId;
}

function buildOwnPegReference(meta: V9ExtensionRegistryMeta): ExtensionAsset["pegReference"] {
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

function buildPegReference(
  meta: V9ExtensionRegistryMeta,
  metaById: ReadonlyMap<string, V9ExtensionRegistryMeta>,
): ExtensionAsset["pegReference"] {
  const ownReference = buildOwnPegReference(meta);
  const configuredReferenceId = pegReferenceId(meta);
  if (configuredReferenceId === undefined) return ownReference;
  if (meta.variantOf != null && meta.variantOf !== configuredReferenceId) {
    throw new Error(
      `Safety Score v9 peg reference data error for ${meta.id}: variantOf (${meta.variantOf}) must equal ` +
        `pegReferenceId (${configuredReferenceId}) when both are present`,
    );
  }
  if (configuredReferenceId === meta.id) return unresolvedPegReference("self-reference");
  const parent = metaById.get(configuredReferenceId);
  if (!parent || parent.id !== configuredReferenceId || ownReference === null) {
    return unresolvedPegReference("unresolvable");
  }
  if (pegReferenceId(parent) === meta.id) return unresolvedPegReference("cycle");
  return {
    ...ownReference,
    referenceKey: `${ownReference.referenceKey}${PEG_REFERENCE_ID_MARKER}${configuredReferenceId}`,
  };
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

/**
 * Whether the curated proof-of-reserves block evidences a *published* periodic
 * reconciliation of issued supply to reserves.
 *
 * This used to be a truthiness read of `cadence`, which made the sentinel
 * values self-defeating: `"none"` and `"undisclosed"` are non-empty strings, so
 * an issuer that publishes no reconciliation at all was inferred to have a
 * `"periodic"` one. That is the same absence-as-fact defect the 9.25 access
 * posture work fixed, inverted — here the missing evidence flattered the issuer
 * instead of accusing it.
 *
 * `"unknown"` is the correct fallback rather than a known negative: an
 * undisclosed cadence tells us nothing about whether the issuer reconciles
 * internally, only that it publishes nothing we can check. MINT-LADDER 9.32
 * (2026-08-21) adds explicit reviewed `"none"` reconciliation; unlike this
 * inference helper, `adaptMintReview` passes that reviewed value through
 * alongside the other non-unknown cadences.
 */
export function hasPublishedReserveReconciliationEvidence(
  proof: StablecoinMeta["proofOfReserves"] | undefined,
): boolean {
  if (proof?.latestReport) return true;
  const cadence = proof?.cadence;
  return cadence != null && cadence !== "none" && cadence !== "undisclosed";
}

function adaptMintReview(
  meta: V9ExtensionRegistryMeta,
  dependencies: PreparedDependency["dependency"],
  supplyReview: ExtensionAsset["supplyReview"],
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
    publishedBy: "unknown",
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
  // A scoped question softens only the one control it names, and only while
  // its review date sits inside the freshness window.
  const freshScopedQuestionRefs = new Set(
    (profile.review.scopedQuestions ?? [])
      .filter(
        (question) =>
          clockSec - isoDateStartSec(question.reviewedAt, clockSec, `${meta.id}:scoped-question`) <=
          V9_SCOPED_QUESTION_MAX_AGE_SEC,
      )
      .map((question) => question.controlRef.toLowerCase()),
  );
  // An unresolved aggregate inventory does not erase controls that were
  // individually identified. Retain those controls in a partial review while
  // the unresolved deployment surfaces remain bounded and fail closed.
  const controls = (profile.controls ?? []).flatMap((control, index, allControls) =>
    adaptMintControl(
      meta.id,
      control,
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
      (control.address != null &&
        freshScopedQuestionRefs.has(`${control.chain ?? ""}:${control.address.toLowerCase()}`)) ||
        freshScopedQuestionRefs.has(control.label.toLowerCase()),
      supplyReview,
    ),
  );
  const directMintControl =
    controls.find((control) => control.controlKind !== "bridge" && control.capabilities.includes("mint")) ?? null;
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
        ? hasPublishedReserveReconciliationEvidence(meta.proofOfReserves)
          ? "periodic"
          : "unknown"
        : "not-applicable";
  // A reviewed reconciliation cadence supersedes the inferred one; an ABSENT
  // field keeps the inference (fail-closed inertness). MINT-LADDER 9.32
  // (2026-08-21): reviewed "none" is intentionally passed through here, and a
  // reviewer's EXPLICIT "unknown" on a reviewed non-issuer-backend mint control
  // now also passes through instead of being swallowed by the not-applicable
  // inference — the reviewer looked and could not establish a cadence, which is
  // limited evidence (the 9.27 scoped-question doctrine), priced at the
  // unbounded-reconciliation-unknown rung rather than the confirmed floor.
  // Issuer-backend, inherited-share-fallback, and absent-mint-control paths
  // keep the inference: PoR evidence may establish "periodic" for a backend
  // minter, a share wrapper's cadence is structurally not-applicable by the
  // wrapper convention, and a missing control is not a cadence finding.
  const reconciliation =
    profile.reconciliation && profile.reconciliation !== "unknown"
      ? profile.reconciliation
      : profile.reconciliation === "unknown" && directMintControl !== null && !issuerBackendMint
        ? "unknown"
        : inferredReconciliation;
  const immutableWithoutMint = mintControl === null && upgrade.state === "immutable";
  // A reviewed no-local-issuance exception is a measured fact, not missing data: the
  // product genuinely holds no canonical issuance authority. It is granted only when
  // the risk it displaces is carried somewhere else — an inherited claim needs the
  // compiled serial-claim edge to its parent, and an external-only representation
  // needs the reviewed route inventory that `hasReviewedNoLocalIssuanceException`
  // already requires to cover every authored deployment. Any authored control keeps
  // the section required so no reviewed upgrade authority is dropped from the grade.
  const reviewedNoLocalIssuance =
    controls.length === 0 &&
    hasReviewedNoLocalIssuanceException(meta) &&
    (profile.review.noLocalIssuance?.kind === "external-only-representation" ||
      hasExactInheritedWrapperDependency);
  if (reviewedNoLocalIssuance) {
    return {
      review: {
        status: notApplicableStatus(
          "v9.control.mint-review",
          profile.review.noLocalIssuance?.kind === "inherited-parent-issuance"
            ? `Issuance is inherited from ${String(profile.inheritedFrom)}; no local canonical mint authority exists.`
            : "Every authored deployment is an external representation; no local canonical mint authority exists.",
          evidenceKeys,
        ),
        controlKey: null,
        reconciliation: "not-applicable",
        supervision: profile.supervision && profile.supervision !== "unknown" ? profile.supervision : "unknown",
        latestResolvedIncidentAtSec: latestResolvedMintIncidentAtSec(profile.mintIncidents, clockSec),
        upgrade: { state: "not-applicable" as const, controlKey: null },
      },
      controls,
    };
  }
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
    incidentReviewsDigest: SAFETY_SCORE_V9_INCIDENT_REVIEWS_DIGEST,
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
      maxAgeSec: V9_CANDIDATE_POLICY_V1.policy.semantic.evidence.evidenceExpiry.researchOverlayMaxAgeSec,
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
      assertMintBridgeOwnership(meta);
      const prepared = preparedById.get(assetId)!;
      const cycle = cycleByAsset.get(assetId);
      const archetype = resolveMechanismArchetype(meta, metaById) ?? "unresolved";
      const liveReserves = fixedInput.liveReserveMap[assetId] ?? [];
      // The audited fallback rung applies only where a live producer was
      // observed returning nothing this capture. It sits inside that gate, not
      // ahead of it, so an asset excluded from falling back is not rescued; and
      // it is deliberately absent from the standalone branch, where no live
      // producer exists and nothing has gone stale.
      const reviewedStaticReserveRows = resolveReviewedReserveRows({
        meta,
        clockSec,
        liveReserveRows: liveReserves,
        liveFallbackAllowed: liveToFallbackAssetIds.has(assetId),
      });
      const reserveRows = reviewedStaticReserveRows?.rows ?? liveReserves;
      const reviewEvidence = new ReviewEvidenceBuilder(assetId, clockSec);
      const reviewedIncidents = getSafetyScoreV9ReviewedIncidents(assetId, clockSec);
      addSafetyScoreV9IncidentEvidence(reviewEvidence, reviewedIncidents);
      const wrapperAllocationReview = getSafetyScoreV9WrapperAllocationReview(assetId, clockSec);
      const mechanismRiskReview = buildSafetyScoreV9MechanismReview(fixedInput, meta, archetype);
      const mechanismReviewGapDisposition =
        getSafetyScoreV9MechanismReviewGapDisposition(assetId, archetype, clockSec);
      const mechanismReviewedUnavailable = getSafetyScoreV9MechanismReviewedUnavailableComponents(
        assetId,
        archetype,
        clockSec,
      );
      const mechanismOverlayEvidence = getSafetyScoreV9MechanismOverlayEvidence(assetId, archetype, clockSec);
      if (mechanismRiskReview && mechanismOverlayEvidence) {
        reviewEvidence.add({
          componentKeys: ["mechanism-risk-review"],
          sourceId: "safety-score-v9.mechanism-review-overlay",
          reviewedAt: mechanismOverlayEvidence.reviewedAt,
          publishedBy: "unknown",
          confidence: "manual-review",
          sources: mechanismOverlayEvidence.sources,
          payload: mechanismOverlayEvidence.payload,
          maxAgeSec: mechanismOverlayEvidence.maxAgeSec,
        });
      }
      const reserveClassifications = buildReviewedReserveClassifications(
        reserveRows,
        meta,
        clockSec,
        V9_CANDIDATE_POLICY_V1.policy.semantic.evidence.evidenceExpiry.reviewedReserveClassificationMaxAgeSec,
      );
      addReserveClassificationEvidence(meta, reserveClassifications, reviewEvidence);
      addReviewedStaticReserveEvidence(meta, reviewedStaticReserveRows, reviewEvidence, clockSec);
      addDependencyEvidence(meta, reviewEvidence);
      addWrapperCustodyEvidence(meta, reviewEvidence);
      addWrapperAllocationEvidence(wrapperAllocationReview, reviewEvidence);
      const supplyReview = buildSafetyScoreV9SupplyReview(
        fixedInput,
        assetId,
        meta.bridgeRouteRisk,
        {
          meta,
          transferMaterialityGeneration: options.transferMaterialityGeneration ?? null,
        },
      );
      const chainRows = safetyScoreV9ChainRows(fixedInput, assetId);
      const deployedChainCount = Object.keys(chainRows).length;
      const assetIssuerKey = resolveSafetyScoreV9AssetIssuerKey(assetId, metaById);
      const mint = adaptMintReview(meta, prepared.dependency, supplyReview, reviewEvidence, clockSec);
      const oracle = adaptOracleReview(meta, archetype, reviewEvidence, clockSec);
      const bridge = adaptBridgeReview(
        meta,
        supplyReview,
        deployedChainCount,
        reviewEvidence,
        clockSec,
        chainRows,
      );
      const incidentControlRoute = routeSafetyScoreV9ControlIncidents(
        mint.controls,
        mint.review,
        reviewedIncidents,
      );
      const controls = [...incidentControlRoute.controls, ...bridge.controls].sort((left, right) =>
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
        ...(mechanismReviewedUnavailable.length > 0 ? { mechanismReviewedUnavailable } : {}),
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
                mint: incidentControlRoute.mintReview,
                oracle,
                bridge: bridge.review,
              }
            : null,
        accessReview,
        pegReference: buildPegReference(meta, metaById),
        supplyReview,
        operationalResilience: routeSafetyScoreV9OperationalIncidents(
          getSafetyScoreV9OperationalResilienceOverlay(assetId, clockSec),
          reviewedIncidents,
        ),
        wrapperAllocationReview,
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
