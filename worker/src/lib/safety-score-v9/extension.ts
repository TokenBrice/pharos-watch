import { buildSafetyScoreV9ReserveBoundFacts, SAFETY_SCORE_V9_RESERVE_BOUND_FACTS_DIGEST } from "./extension-reserve-bounds";
import { buildSafetyScoreV10ScopedReserveAdmissions, addScopedReserveEvidence } from "./extension-reserves";
import { resolveMechanismArchetype } from "@shared/lib/classification/resolve-mechanism-archetype";
import { resolveChainId } from "@shared/types/chain-identity";
import { normalizeDeploymentId } from "@shared/types/deployment-id";
import { canonicalExitRouteScopedId, canonicalExitRouteScopedKey } from "@shared/types/exit-route-identity";
import { deriveEffectiveDependencySet } from "@shared/lib/dependency-derivation";
import { diagnoseDependencyGraph, type DependencyGraphEdge } from "@shared/lib/dependency-graph";
import { V9_EVIDENCE_PRODUCER_INTERVAL_SEC } from "@shared/lib/cron-cadences";
import { computeReportCardsRegistryFingerprint } from "@shared/lib/report-cards-fixed-input-identity";
import { V9_ACCESS_EVIDENCE_MAX_AGE_SEC } from "@shared/lib/safety-score-v9/access-posture";
import type { V9AccessClaimGraph, V9AccessClaimGraphReview } from "@shared/types/safety-score-v9-access-lookthrough";
import { buildSafetyScoreV9AccessClaimGraph, computeSafetyScoreV9AccessClaimGraphReviewsDigest } from "./extension-access-lookthrough";
import { V9_REVIEW_EVIDENCE_MAX_AGE_SEC, V9_SCOPED_QUESTION_MAX_AGE_SEC } from "@shared/lib/safety-score-v9/evidence";
import { V9_CANDIDATE_POLICY_V1 } from "@shared/lib/safety-score-v9/policy";
import { compileReviewedMintControlScopes, resolveV1005MintAuthorityProfile, partialControlScopeSemantics, weightedReviewIsCurrent, sortV1005ProcessDiagnostics, v1005ProofIsClosed, v1005ReviewIsCurrent, type V9ReviewedControlProjection } from "@shared/lib/safety-score-v9/control-scope";
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
import type { V9FailureDomainRef, V1005ProcessDiagnostic, V1005CompiledVotingControl } from "@shared/types/safety-score-v9-facts";
import { V1005VotingControllerSchema, createV9ControlExecutionScopeRootReuse } from "@shared/types/safety-score-v9-control-scope";
import type { StablecoinMeta } from "@shared/types";
import {
  type ReserveSlice,
} from "@shared/types/reserves";
import {
  type SafetyScoreV9FactSetExtensionV2,
} from "./fact-set";
import { admitSafetyScoreV9ExtensionAsset, quarantinedSafetyScoreV9ExtensionAsset } from "./fact-set-schema";
import { toErrorMessage } from "@shared/lib/error-utils";
import { createReviewedAssetRegistry, ReviewedRegistryEntryError } from "./extension-reviewed-registry";
import { SafetyScoreV9ReviewedTransferFactSchema } from "@shared/types/safety-score-v9-transfer-overlays";
import { controlCanCarryKnownStatus } from "./fact-set-control";
import { validateSafetyScoreV9ShockRegistryAsset } from "./extension-shock";
import {
  buildSafetyScoreV9MechanismReview,
  getSafetyScoreV9MechanismExitFacts,
  getSafetyScoreV9MechanismOverlayEvidence,
  getSafetyScoreV9MechanismReviewGapDisposition,
  getSafetyScoreV9MechanismReviewedUnavailableComponents,
  hasAdmittedSafetyScoreV9NativeFamily,
  SAFETY_SCORE_V9_MECHANISM_REVIEW_OVERLAYS_DIGEST,
} from "./extension-mechanism";
import {
  getSafetyScoreV9OperationalResilienceOverlay,
  SAFETY_SCORE_V9_OPERATIONAL_RESILIENCE_OVERLAYS_DIGEST,
} from "./extension-operational-resilience";
import {
  addSafetyScoreV9IncidentEvidence,
  addSafetyScoreV9NegativeIncidentEvidence,
  getSafetyScoreV9NegativeIncidentReviews,
  routeSafetyScoreV9NegativeIncidentReviews,
  getSafetyScoreV9ReviewedIncidents,
  routeSafetyScoreV9ControlIncidents,
  routeSafetyScoreV9OperationalIncidents,
  SAFETY_SCORE_V9_INCIDENT_REVIEWS_DIGEST,
} from "./extension-incidents";
import { getSafetyScoreV9WrapperAllocationReview, SAFETY_SCORE_V9_WRAPPER_ALLOCATION_REVIEWS_DIGEST } from "./extension-wrapper-allocation";
import { getSafetyScoreV9WrapperLocalReviews, SAFETY_SCORE_V9_WRAPPER_LOCAL_REVIEWS_DIGEST } from "./extension-wrapper-local-review";
import { allocationReviewClockSec, type V9AllocationScopeIdentityReview, type SafetyScoreV9WrapperAllocationReview } from "@shared/types/safety-score-v9-allocation";
import {
  computeSafetyScoreV9ReviewedTransferFactsDigest,
  resolveSafetyScoreV9ReviewedTransferFact,
  getSafetyScoreV9ReviewedTransferFact,
  safetyScoreV9TransferDeploymentKey,
  type SafetyScoreV9ReviewedTransferFact,
  type SafetyScoreV9TransferMaterialScope,
} from "./extension-transfer";
import { SAME_NOTIONAL_EXIT_OBSERVATION_FRESHNESS_POLICY } from "@shared/lib/redemption-backstop-scoring";
import {
  transferMaterialScopeFromOnchainGeneration,
  transferMaterialScopeFromSingleDeploymentAttribution,
  transferMaterialScopeFromEconomicDeploymentPartition,
  type SafetyScoreV9TransferMaterialityGeneration,
} from "./transfer-materiality";
import { hasCompleteEligibleProviderSupply, REVIEWED_ECONOMIC_SUPPLY_PLANS } from "./supply-attribution-contract";
import {
  buildSafetyScoreV9RetainedRoutes,
  buildSafetyScoreV9RouteReviews,
} from "./extension-routes";
import {
  buildSafetyScoreV9SupplyReview,
} from "./extension-supply";
import {
  normalizeSafetyScoreV9CompilerInput,
  type SafetyScoreV9CompilerInput,
} from "./native-input";
import {
  safetyScoreV9ChainRows,
  safetyScoreV9ChainSupplySourceGenerationId,
} from "./supply-attribution";
import { adaptBridgeReview } from "./extension-bridge";
import { adaptOracleReview, deriveOracleBranchMateriality } from "./extension-oracle";
import {
  addReserveClassificationEvidence,
  addReviewedStaticReserveEvidence,
  buildReviewedReserveClassifications,
  buildSafetyScoreV9ReviewedAuditedFallbackReserveRows,
  buildSafetyScoreV9ReviewedCuratedFallbackReserveRows,
  buildSafetyScoreV9ReviewedStandaloneReserveRows,
  buildSafetyScoreV9ReviewedStaticReserveRows,
  dependencyReserveSlices,
} from "./extension-reserves";
import { collateralExposureMappingIssues } from "./fact-set-context";
import {
  ReviewEvidenceBuilder,
  accessEvidenceObservationState,
  projectControlAuthority,
  boundedObservedAt,
  confidenceForResearch,
  conservativeDateEndSec,
  parseBoundedDateSec,
  maximumObservedAt,
  notApplicableStatus,
  requiredStatus,
  researchReviewObservationState,
  reviewedObservationState,
  type ControlOverlay,
  type ExtensionAsset,
  type V9ExtensionRegistryMeta,
  DEPLOYMENT_MATERIAL_SHARE_THRESHOLD,
} from "./extension-shared";

// The registry-meta projection now lives beside the adapters that read it.
export type { V9ExtensionRegistryMeta } from "./extension-shared";
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
  fixedInput?: Readonly<SafetyScoreV9CompilerInput>;
}): ReviewedReserveRows {
  if (input.liveReserveRows.length > 0) return null;
  return (
    buildSafetyScoreV9ReviewedStaticReserveRows(input.meta, input.clockSec, input.fixedInput) ??
    (input.meta.liveReservesConfig != null
      ? input.liveFallbackAllowed
        ? buildSafetyScoreV9ReviewedAuditedFallbackReserveRows(input.meta, input.clockSec, input.fixedInput) ??
          buildSafetyScoreV9ReviewedCuratedFallbackReserveRows(input.meta, input.clockSec, input.fixedInput)
        : null
      : buildSafetyScoreV9ReviewedStandaloneReserveRows(input.meta, input.clockSec, input.fixedInput))
  );
}

export interface BuildSafetyScoreV9BaselineExtensionOptions {
  metaById?: ReadonlyMap<string, V9ExtensionRegistryMeta>;
  registryFingerprint?: string;
  reviewedTransferFacts?: ReadonlyMap<string, SafetyScoreV9ReviewedTransferFact>;
  accessClaimGraphReviews?: ReadonlyMap<string, V9AccessClaimGraphReview>;
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
  return projectControlAuthority({ ...control, fallbackKey: control.failureDomainKeys?.[0] ?? issuerAuthorityKey(assetId, control) });
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
      ? [control.executionScope || control.weightedQuorum
        ? normalizeDeploymentId(`${control.chain ?? "chain-unresolved"}:${control.address}`)
        : `${control.chain ?? "chain-unresolved"}:${control.address.toLowerCase()}`]
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
 * Resolve a reviewed deployment-local authority onto a complete liability
 * partition. Durable native issuance reaches the root claim, not just the
 * supply currently residing on the minter's chain.
 */
function resolveMintControlDeploymentScopes(
  control: MintAuthorityControl,
  supplyReview: ExtensionAsset["supplyReview"],
  reviewComplete: boolean,
  rootIssuance: boolean,
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
  if (rootIssuance && matched.some((row) => row?.reviewedRouteKind === "native")) return null;
  // Reaching every reconciled deployment is economically asset-wide even when
  // the review happens to enumerate those deployments one by one.
  if (deploymentRefs.length === rows.length) return null;

  return matched.map((row) => ({
    deploymentKey: row!.deploymentRouteKey,
    materialSupplyShare: row!.supplyShare,
  }));
}

function compileMintVotingControl(profile: MintAuthorityProfile, clockSec: number): V1005CompiledVotingControl {
  const voting = profile.governedIssuance!.votingControl;
  const certificates = profile.executionCertificates;
  const graph = profile.authorityGraph;
  const diagnostics: V1005ProcessDiagnostic[] = [];
  const add = (code: V1005ProcessDiagnostic["code"], field: string, route?: typeof voting.routes[number]) => {
    diagnostics.push({ code, gate: "D32", controlRef: route?.path.controlRef ?? null, pathId: route?.path.pathId ?? null,
      classId: null, memberRef: null, field, evidenceRefIds: [] });
  };
  const closed = (ref: string) => v1005ProofIsClosed(certificates, ref, voting.review.pin);
  const holders = new Map(voting.holderCensus.map((holder) => [holder.id, holder]));
  const expandedControllers = voting.controllers.flatMap((row) => {
    if (!("templateRef" in row)) return [row];
    const template = voting.controllerTemplates?.find((entry) => entry.id === row.templateRef);
    const holder = row.holderRowRef ? holders.get(row.holderRowRef) : undefined;
    const { templateRef, holderRowRef, ...overrides } = row;
    void templateRef; void holderRowRef;
    const parsed = V1005VotingControllerSchema.safeParse({ ...template,
      ...(holder?.provenance === "own" ? { accounts: [holder.deployment], votingPowerRaw: holder.votingPowerRaw, ownedPositionIds: [holder.id] } : {}),
      ...overrides });
    if (!template || row.holderRowRef && (holder?.provenance !== "own" || holder.ownerControllerId !== row.id) || !parsed.success) { add("voting-control-unproved", `controllers.${row.id}.templateRef`); return []; }
    return [parsed.data];
  });
  const controllers = new Map(expandedControllers.map((controller) => [controller.id, controller]));
  const affiliated = new Set(expandedControllers.filter((controller) => ["issuer", "council", "team"].includes(controller.affiliation)).map((controller) => controller.id));
  if (holders.size !== voting.holderCensus.length) add("voting-census-unreconciled", "holderCensus");
  const affiliatedRoutes = new Set<string>(), unknownOwnership = new Set<string>(), operators = new Set<string>();
  const total = voting.totalVotingPowerRaw === null ? null : BigInt(voting.totalVotingPowerRaw);
  const supply = voting.pinnedVotingSupply;
  const supplyProof = certificates?.proofs.find((proof) => proof.id === supply.proofRef);
  const joinedSupply = supply.raw !== null && closed(supply.proofRef) && supplyProof?.evidenceRefIds.some((id) => {
    const row = certificates!.evidence.find((evidence) => evidence.id === id);
    return row?.kind === "onchain-read" && row.deployment === supply.deployment && row.function === supply.function &&
      row.rawResult != null && /^0x[0-9a-fA-F]+$/.test(row.rawResult) && BigInt(row.rawResult) === BigInt(supply.raw!);
  });
  if (!v1005ReviewIsCurrent(voting.review, clockSec, V9_REVIEW_EVIDENCE_MAX_AGE_SEC) || !closed(voting.controllerCensusProofRef) ||
      !graph || graph.governorNodeId !== voting.governorNodeId || controllers.size !== voting.controllers.length) add("voting-control-unproved", "votingControl");
  const passes = (power: bigint, threshold: string | null, comparator: "gte" | "gt" | "not-applicable"): boolean | "unknown" =>
    threshold === null || comparator === "not-applicable" ? "unknown" : comparator === "gt" ? power > BigInt(threshold) : power >= BigInt(threshold);
  const censusReconciliations: V1005CompiledVotingControl["censusReconciliations"] = [];
  let largestDerived: bigint | null = 0n, affiliatedDerived: bigint | null = 0n;
  for (const route of voting.routes) {
    type Partition = { controllerId: string; powerRaw: string | null; ownPowerRaw: string | null; otherHoldersPowerRaw: string | null;
      unknownPowerRaw: string | null; unilateralThresholdRaw: string | null; thresholdComparator: typeof route.thresholdComparator; thresholdProofRef: string };
    const assignments = new Map<string, { controllerId: string; provenance: "own" | "other" | "unknown" }>();
    let ownershipPartition = true;
    const thresholds = new Map(route.controllerPowers.map((row) => [row.controllerId, row]));
    if (thresholds.size !== route.controllerPowers.length) ownershipPartition = false;
    for (const row of route.controllerPowers) for (const [field, provenance] of [["ownHolderRowIds", "own"], ["otherHolderRowIds", "other"], ["unknownProvenanceHolderRowIds", "unknown"]] as const) {
      for (const id of row[field]) {
        if (!holders.has(id) || assignments.has(id)) ownershipPartition = false;
        assignments.set(id, { controllerId: row.controllerId, provenance });
      }
    }
    const partition = new Map<string, { own: bigint; other: bigint; unknown: bigint; known: boolean }>();
    for (const holder of voting.holderCensus) {
      const assignment = assignments.get(holder.id) ?? { controllerId: holder.controllerId ?? holder.ownerControllerId, provenance: holder.provenance ?? "unknown" };
      if (!assignment.controllerId) continue;
      const powers = partition.get(assignment.controllerId) ?? { own: 0n, other: 0n, unknown: 0n, known: true };
      if (holder.votingPowerRaw === null || !holder.evidenceRefIds.every((id) => certificates?.evidence.some((evidence) =>
          evidence.id === id && !evidence.artificial && evidence.pin.hash === voting.review.pin.hash))) powers.known = false;
      else {
        const provenance = assignment.provenance === "own" && (holder.ownerControllerId !== assignment.controllerId ||
          !controllers.get(assignment.controllerId)?.ownedPositionIds.includes(holder.id)) ? "unknown" : assignment.provenance;
        powers[provenance] += BigInt(holder.votingPowerRaw);
      }
      partition.set(assignment.controllerId, powers);
    }
    const routePowers: Partition[] = [...partition].map(([controllerId, powers]) => {
      const threshold = thresholds.get(controllerId);
      return { controllerId, powerRaw: powers.known ? (powers.own + powers.other + powers.unknown).toString() : null,
        ownPowerRaw: powers.known ? powers.own.toString() : null,
        otherHoldersPowerRaw: powers.known ? powers.other.toString() : null,
        unknownPowerRaw: powers.known ? powers.unknown.toString() : null,
        unilateralThresholdRaw: threshold?.unilateralThresholdRaw ?? route.unilateralThresholdRaw,
        thresholdComparator: threshold?.thresholdComparator ?? route.thresholdComparator,
        thresholdProofRef: threshold?.thresholdProofRef ?? route.thresholdProofRef };
    });
    if (routePowers.some((row) => row.powerRaw === null)) { largestDerived = null; affiliatedDerived = null; }
    else {
      for (const row of routePowers) if (largestDerived !== null && BigInt(row.powerRaw!) > largestDerived) largestDerived = BigInt(row.powerRaw!);
      const affiliatedPower = routePowers.filter((row) => affiliated.has(row.controllerId)).reduce((sum, row) => sum + BigInt(row.powerRaw!), 0n);
      if (affiliatedDerived !== null && affiliatedPower > affiliatedDerived) affiliatedDerived = affiliatedPower;
    }
    let accounted: bigint | null = 0n;
    const ids = new Set<string>();
    for (const row of routePowers) {
      const controller = controllers.get(row.controllerId);
      if (!controller || ids.has(row.controllerId) || row.powerRaw === null) { accounted = null; ownershipPartition = false; continue; }
      ids.add(row.controllerId);
      if (accounted !== null) accounted += BigInt(row.powerRaw);
      if (row.unknownPowerRaw === null) ownershipPartition = false;
      if (route.kind === "public-minority-admission") {
        if (row.unilateralThresholdRaw !== null || row.thresholdComparator !== "not-applicable") add("voting-control-unproved", "routes.controllerPowers.threshold", route);
        continue;
      }
      const threshold = row.unilateralThresholdRaw ?? route.unilateralThresholdRaw;
      const comparator = row.thresholdComparator === "not-applicable" ? route.thresholdComparator : row.thresholdComparator;
      const unilateral = closed(row.thresholdProofRef) && closed(route.thresholdProofRef) ? passes(BigInt(row.powerRaw), threshold, comparator) : "unknown";
      if (unilateral === "unknown") { add("voting-control-unproved", `routes.${route.id}.${controller.id}.threshold`, route); continue; }
      if (!unilateral) continue;
      if (affiliated.has(controller.id) && closed(controller.attributionProofRef)) {
        affiliatedRoutes.add(route.id); add("voting-affiliated-unilateral", `controllers.${controller.id}.affiliation`, route);
      } else if (affiliated.has(controller.id)) add("voting-control-unproved", `controllers.${controller.id}.attributionProofRef`, route);
      if (row.ownPowerRaw === null || row.otherHoldersPowerRaw === null || row.unknownPowerRaw === null ||
          BigInt(row.ownPowerRaw) > 0n && !closed(controller.ownVoteOwnershipProofRef) ||
          BigInt(row.otherHoldersPowerRaw) > 0n && !closed(controller.otherHolderVoteAuthorityProofRef) ||
          BigInt(row.ownPowerRaw) + BigInt(row.otherHoldersPowerRaw) + BigInt(row.unknownPowerRaw) !== BigInt(row.powerRaw)) {
        unknownOwnership.add(controller.id); add("voting-control-unproved", `controllers.${controller.id}.voteOwnership`, route); continue;
      }
      const ownPasses = passes(BigInt(row.ownPowerRaw), threshold, comparator);
      const knownPasses = passes(BigInt(row.ownPowerRaw) + BigInt(row.otherHoldersPowerRaw), threshold, comparator);
      if (ownPasses === "unknown" || knownPasses === "unknown") { unknownOwnership.add(controller.id); add("voting-control-unproved", `controllers.${controller.id}.ownThreshold`, route); continue; }
      if (!knownPasses && BigInt(row.unknownPowerRaw) > 0n) {
        unknownOwnership.add(controller.id); add("voting-provenance-unknown", `controllers.${controller.id}.voteOwnership`, route); continue;
      }
      const visited = new Set<string>(), visiting = new Set<string>();
      let keyAlternative = false, unresolved = false;
      const visitVoteAuthority = (id: string): void => {
        if (visiting.has(id)) { unresolved = true; add("voting-origin-cycle-unclosed", `controllers.${controller.id}.voteAuthority`, route); return; }
        if (visited.has(id)) return;
        const node = graph?.nodes.find((candidate) => candidate.id === id);
        if (!node || !closed(node.proofRef)) { unresolved = true; return; }
        if (["eoa", "multisig", "issuer-backend"].includes(node.kind)) keyAlternative = true;
        visiting.add(id);
        let hasAuthorityEdge = false;
        for (const edge of graph?.edges ?? []) if (edge.from === id && edge.activation !== "disabled-final" &&
            edge.pathRefs.some((ref) => ref.controlRef === route.path.controlRef && ref.pathId === route.path.pathId) &&
            ["owner", "ward", "role", "admin", "upgrade", "delegatecall", "execution-hop", "permission-change", "envelope-raise",
              "operator", "delegate", "vote-cast", "vote-replacement", "vote-origin", "reactivation"].includes(edge.kind) &&
            !(id === voting.governorNodeId && node.kind === "token-governor" && (edge.kind === "vote-origin" || edge.kind === "vote-cast"))) {
          hasAuthorityEdge = true;
          if (!closed(edge.proofRef) || edge.activation === "unknown") unresolved = true;
          visitVoteAuthority(edge.to);
        }
        if (!hasAuthorityEdge && (!node.terminal || node.kind === "unknown")) unresolved = true;
        visiting.delete(id); visited.add(id);
      };
      for (const id of controller.voteAuthorityNodeIds) visitVoteAuthority(id);
      if (unresolved) { unknownOwnership.add(controller.id); add("voting-control-unproved", `controllers.${controller.id}.voteAuthority`, route); }
      if (BigInt(row.otherHoldersPowerRaw) > 0n) {
        if (controller.voteReplacementApproval === "unknown") {
          unknownOwnership.add(controller.id); add("voting-control-unproved", `controllers.${controller.id}.voteReplacementApproval`, route);
        }
        if (!ownPasses || controller.voteReplacementApproval === "key-discretion" || keyAlternative) {
          operators.add(controller.id); add("voting-other-holder-operator", `controllers.${controller.id}.otherHoldersPowerRaw`, route);
        }
      }
    }
    const residual = route.residualUpperRaw === null ? null : BigInt(route.residualUpperRaw);
    let residualCanPass: boolean | "unknown" = "unknown";
    if (residual === 0n) residualCanPass = false;
    else if (residual !== null && closed(route.residualProofRef)) residualCanPass = passes(residual, route.unilateralThresholdRaw, route.thresholdComparator);
    if (route.kind === "public-minority-admission" && closed(route.minorityProtectionProofRef ?? "")) residualCanPass = false;
    const routeTotal = route.totalVotingPowerRaw === null ? null : BigInt(route.totalVotingPowerRaw);
    const reconciled = accounted !== null && residual !== null && total !== null && total > 0n && routeTotal === total &&
      accounted + residual === total && supply.raw !== null && total === BigInt(supply.raw) && joinedSupply === true &&
      closed(route.residualProofRef) && closed(voting.controllerCensusProofRef) && ownershipPartition;
    if (!reconciled) add("voting-census-unreconciled", `routes.${route.id}.controllerPowers`, route);
    if (residualCanPass !== false) add("voting-control-unproved", `routes.${route.id}.residualUpperRaw`, route);
    censusReconciliations.push({ routeId: route.id, state: reconciled ? "reconciled" : "unreconciled", accountedPowerRaw: accounted?.toString() ?? null,
      residualUpperRaw: route.residualUpperRaw, totalVotingPowerRaw: route.totalVotingPowerRaw, pinnedVotingSupplyRaw: supply.raw,
      unresolvedResidualCanPassAlone: residualCanPass, evidenceRefIds: supplyProof?.evidenceRefIds ?? [] });
    if (route.kind === "public-minority-admission") {
      if (!closed(route.minorityProtectionProofRef ?? "") || route.unilateralThresholdRaw !== null || route.thresholdComparator !== "not-applicable") add("voting-control-unproved", `routes.${route.id}.minorityProtection`, route);
    } else {
      const expectedIds = [...affiliated].filter((id) => ids.has(id)).sort();
      const actualIds = [...route.affiliatedControllerIds].sort();
      const powers = routePowers.filter((row) => affiliated.has(row.controllerId));
      const aggregate = powers.every((row) => row.powerRaw !== null) ? powers.reduce((sum, row) => sum + BigInt(row.powerRaw!), 0n) : null;
      if (stableJsonStringifyV1(expectedIds) !== stableJsonStringifyV1(actualIds) || aggregate === null ||
          route.affiliatedAggregatePowerRaw === null || aggregate !== BigInt(route.affiliatedAggregatePowerRaw) || !closed(route.affiliatedAggregateThresholdProofRef)) add("voting-control-unproved", `routes.${route.id}.affiliatedAggregate`, route);
      else if (aggregate > 0n) {
        const thresholdOutcome = passes(aggregate, route.affiliatedAggregateUnilateralThresholdRaw, route.affiliatedAggregateThresholdComparator);
        if (thresholdOutcome === "unknown") add("voting-control-unproved", `routes.${route.id}.affiliatedThreshold`, route);
        else if (thresholdOutcome) { affiliatedRoutes.add(route.id); add("voting-affiliated-unilateral", `routes.${route.id}.affiliatedAggregate`, route); }
      }
    }
  }
  for (const [field, privilege] of [["privilegedVoteCreation", voting.privilegedVoteCreation], ["forcedDelegation", voting.forcedDelegation]] as const) {
    if (!closed(privilege.proofRef) || privilege.state === "unknown") add("voting-control-unproved", field);
    else if (privilege.state === "independent") add("voting-privilege-independent", field);
  }
  const reconciled = censusReconciliations.every((row) => row.state === "reconciled" && row.unresolvedResidualCanPassAlone !== "unknown");
  const largest = largestDerived;
  const aggregate = affiliatedDerived;
  return { observationState: reconciled ? "known" : "unknown", qualified: reconciled && diagnostics.length === 0,
    largestSingleControllerShareBps: reconciled && total && largest !== null ? Number((largest * 10000n + total - 1n) / total) : null,
    affiliatedAggregateShareBps: reconciled && total && aggregate !== null ? Number((aggregate * 10000n + total - 1n) / total) : null,
    affiliatedUnilateralRouteIds: [...affiliatedRoutes].sort(), unknownAboveThresholdVoteOwnershipControllerIds: [...unknownOwnership].sort(),
    otherHolderVoteOperatorControllerIds: [...operators].sort(), privilegedVoteCreation: voting.privilegedVoteCreation.state,
    forcedDelegation: voting.forcedDelegation.state, censusReconciliations, diagnostics: sortV1005ProcessDiagnostics(diagnostics) };
}

function compileMintIssuanceGovernance(
  assetId: string,
  profile: MintAuthorityProfile,
  projections: readonly V9ReviewedControlProjection[],
  reviewComplete: boolean,
  hasFreshScopedQuestion: boolean,
  clockSec: number,
): ControlOverlay["issuanceGovernance"] {
  const governed = profile.governedIssuance;
  if (!governed) return undefined;
  const authoredControls = profile.controls ?? [];
  const incompleteReasons = new Set<string>();
  const votingControl = compileMintVotingControl(profile, clockSec);
  const diagnostics = sortV1005ProcessDiagnostics([...projections.flatMap((projection) => projection.processDiagnostics ?? []), ...votingControl.diagnostics]);
  for (const diagnostic of diagnostics) incompleteReasons.add(`${diagnostic.code}${diagnostic.controlRef ? `:${diagnostic.controlRef}${diagnostic.pathId ? `#${diagnostic.pathId}` : ""}` : ""}`);
  const fail = (code: V1005ProcessDiagnostic["code"], field: string, controlRef: string | null = null, pathId: string | null = null) => {
    incompleteReasons.add(`${code}${controlRef ? `:${controlRef}${pathId ? `#${pathId}` : ""}` : ""}`);
    diagnostics.push({ code, gate: governed.decisionRule === "minority-veto" ? "D30" : "D29",
      controlRef, pathId, classId: null, memberRef: null, field, evidenceRefIds: [] });
  };
  if (!reviewComplete) fail("review-incomplete", "review");
  if (hasFreshScopedQuestion) fail("scoped-question-open", "review.scopedQuestions");
  if (profile.mintIncidents?.some((incident) => incident.status === "active")) fail("active-incident", "mintIncidents");
  const governedReviewSec = Date.parse(`${governed.reviewedAt}T00:00:00Z`) / 1000;
  if (governedReviewSec > clockSec || clockSec - governedReviewSec > V9_REVIEW_EVIDENCE_MAX_AGE_SEC) {
    fail(governedReviewSec > clockSec ? "review-future" : "review-expired", "governedIssuance.reviewedAt");
  }
  const governorIndexes = authoredControls.flatMap((control, index) =>
    control.chain != null && control.address != null &&
    `${control.chain}:${control.address.toLowerCase()}` === governed.governorControlRef ? [index] : []);
  const governorIndex = governorIndexes.length === 1 ? governorIndexes[0]! : -1;
  const governor = governorIndex >= 0 ? authoredControls[governorIndex] : undefined;
  if (!governor) {
    fail("governor-control-missing", "governedIssuance.governorControlRef", governed.governorControlRef);
  } else if (canonicalAuthorityType(assetId, governor)?.model !== "governance" ||
      ((governed.votingPower === "holding-period-weighted" || governed.votingPower === "lock-escrowed" ||
        governed.votingPower === "past-block-checkpoint") &&
        (governor.weightedQuorum != null || governor.threshold != null || governor.signerCount != null))) {
    fail("governor-not-governance", "governedIssuance.governorControlRef", governed.governorControlRef);
  }
  if (governed.decisionRule === "minority-veto") {
    for (const [index, control] of authoredControls.entries()) {
      if (!projections[index]?.paths.some((path) =>
        path.capSemantics.kind === "unbounded" || path.capSemantics.kind === "unknown" ||
        path.claimImpairment === "unbounded" || path.claimImpairment === "unknown")) continue;
      const deployment = control.chain != null && control.address != null
        ? normalizeDeploymentId(`${control.chain}:${control.address}`) : "";
      if (!governed.veto || !governor || !projections[governorIndex]!.complete ||
          !projections[governorIndex]!.paths.some((path) =>
            path.activation === "active" && path.capabilities.includes("parameter-change") &&
            governed.veto!.entrypoints.every((entrypoint) => path.entrypoints.includes(entrypoint)) &&
            normalizeDeploymentId(path.targetDeployment) === deployment)) {
        for (const path of projections[index]!.paths) if (path.capSemantics.kind === "unbounded" || path.capSemantics.kind === "unknown" ||
            path.claimImpairment === "unbounded" || path.claimImpairment === "unknown") fail("governor-without-veto-path", "governedIssuance.veto.entrypoints", deployment, path.id);
      }
    }
  } else if (governor && projections[governorIndex]!.complete &&
      !projections[governorIndex]!.paths.some((path) => path.activation !== "disabled-final" &&
        path.capabilities.some((capability) => capability === "mint" || capability === "upgrade" || capability === "bridge-mint"))) {
    fail("governor-without-issuance-path", "executionScope.paths", governed.governorControlRef);
  }
  const excludedRestructurePaths = new Set<string>();
  if (governed.decisionRule === "minority-veto") {
    if (projections[governorIndex]?.paths.some((path) =>
      path.capSemantics.kind === "unbounded" || path.capSemantics.kind === "unknown" ||
      path.claimImpairment === "unbounded" || path.claimImpairment === "unknown")) {
      for (const path of projections[governorIndex]!.paths) if (path.capSemantics.kind === "unbounded" || path.capSemantics.kind === "unknown" ||
          path.claimImpairment === "unbounded" || path.claimImpairment === "unknown") fail("governor-carries-unbounded-path", "executionScope.paths", governed.governorControlRef, path.id);
    }
    const monetaryPolicy = V9_CANDIDATE_POLICY_V1.policy.semantic.control.governedIssuance.minorityVeto.monetaryPolicy;
    const admissibleRateChangeRules: readonly string[] = monetaryPolicy.admissibleRateChangeRules;
    for (const monetaryPath of governed.monetaryPolicyPaths ?? []) {
      const index = authoredControls.findIndex((control) => control.chain != null && control.address != null &&
        `${control.chain}:${control.address.toLowerCase()}` === monetaryPath.controlRef);
      const path = projections[index]?.complete
        ? projections[index]?.paths.find((candidate) => candidate.id === monetaryPath.pathId && candidate.activation !== "disabled-final")
        : undefined;
      if (!path || path.capSemantics.kind !== "raiseable" || path.claimImpairment !== "bounded" ||
          monetaryPath.rateChangeDelaySec < monetaryPolicy.minRateChangeDelaySec ||
          !admissibleRateChangeRules.includes(monetaryPath.rateChangeRule)) {
        fail("monetary-policy-path-inadmissible", "governedIssuance.monetaryPolicyPaths", monetaryPath.controlRef, monetaryPath.pathId);
      }
    }
    for (const [index, control] of authoredControls.entries()) {
      for (const path of projections[index]?.paths ?? []) {
        if (path.activation !== "disabled-final" && path.capSemantics.kind === "raiseable" && path.claimImpairment !== "none" &&
            (path.capabilities.includes("mint") || path.capabilities.includes("bridge-mint")) &&
            !governed.monetaryPolicyPaths?.some((entry) => entry.pathId === path.id &&
              entry.controlRef === `${control.chain}:${control.address?.toLowerCase()}`)) {
          fail("monetary-policy-path-unreviewed", "governedIssuance.monetaryPolicyPaths", normalizeDeploymentId(`${control.chain}:${control.address}`), path.id);
        }
      }
    }
    const restructure = governed.veto?.restructure;
    if (governed.veto?.override === "insolvency-gated-restructure" && restructure) {
      const multiple = V9_CANDIDATE_POLICY_V1.policy.semantic.control.governedIssuance.minorityVeto.restructureMinEquityMultiple;
      const unreachable = restructure.observedEquityUnits >= restructure.equityThresholdUnits * multiple;
      if (!projections[governorIndex]?.paths.some((path) => path.activation !== "disabled-final" &&
          restructure.entrypoints.every((entrypoint) => path.entrypoints.includes(entrypoint)))) {
        fail("restructure-path-missing", "governedIssuance.veto.restructure.entrypoints", governed.governorControlRef);
      }
      if (!unreachable) fail("restructure-reachable", "governedIssuance.veto.restructure.observedEquityUnits", governed.governorControlRef);
      for (const dependentPath of restructure.dependentPaths) {
        const index = authoredControls.findIndex((control) => control.chain != null && control.address != null &&
          `${control.chain}:${control.address.toLowerCase()}` === dependentPath.controlRef);
        const path = projections[index]?.paths.find((candidate) => candidate.id === dependentPath.pathId);
        if (!path || path.activation !== "disabled-reactivatable") {
          fail("restructure-dependent-path-invalid", "governedIssuance.veto.restructure.dependentPaths", dependentPath.controlRef, dependentPath.pathId);
        } else if (unreachable) {
          excludedRestructurePaths.add(`${index}:${path.id}`);
        }
      }
    }
  }
  let minUnavoidableDelaySec: number | null = null;
  let hasNullDelay = false;
  const nonGovernorUnboundedPathKeys = new Set<string>();
  for (const [index, control] of authoredControls.entries()) {
    const projection = projections[index]!;
    if (!projection.complete) {
      for (const code of projection.diagnostics) incompleteReasons.add(`${code}:${control.chain}:${control.address?.toLowerCase()}`);
      continue;
    }
    for (const path of projection.paths) {
      if (excludedRestructurePaths.has(`${index}:${path.id}`)) continue;
      if (!(path.capSemantics.kind === "unbounded" || path.capSemantics.kind === "unknown" ||
            path.claimImpairment === "unbounded" || path.claimImpairment === "unknown")) continue;
      const pathKey = `${projection.scope?.controllerDeployment ?? normalizeDeploymentId(`${control.chain}:${control.address}`)}#${path.id}`;
      const authority = projection.authorityPaths?.get(pathKey);
      const publicDelaySec = path.unavoidableDelaySec === null || authority?.publicDelaySec == null
        ? null : Math.min(path.unavoidableDelaySec, authority.publicDelaySec);
      if (publicDelaySec === null) {
        hasNullDelay = true;
      } else {
        minUnavoidableDelaySec = minUnavoidableDelaySec === null
          ? publicDelaySec
          : Math.min(minUnavoidableDelaySec, publicDelaySec);
      }
      if (!authority?.closed || !authority.governorRooted) nonGovernorUnboundedPathKeys.add(pathKey);
    }
  }
  return {
    coverage: incompleteReasons.size === 0 ? "complete" : "incomplete",
    incompleteReasons: [...incompleteReasons].sort(compareText),
    governorAuthorityKey: governed.governorControlRef,
    decisionRule: governed.decisionRule,
    minUnavoidableDelaySec: hasNullDelay ? null : minUnavoidableDelaySec,
    votingPower: governed.votingPower,
    vetoQuorumBps: governed.decisionRule === "minority-veto" ? governed.veto?.quorumBps ?? null : null,
    vetoOverride: governed.decisionRule === "minority-veto" ? governed.veto?.override ?? null : null,
    enumerable: governed.enumerability.authorizationEvents.length > 0 && governed.enumerability.capacityReads.length > 0,
    nonGovernorUnboundedPathKeys: [...nonGovernorUnboundedPathKeys].sort(compareText),
    votingControl,
    diagnostics: sortV1005ProcessDiagnostics(diagnostics),
  };
}

function compileMintIssuanceProcess(
  assetId: string, profile: MintAuthorityProfile, projections: readonly V9ReviewedControlProjection[],
  reviewComplete: boolean, hasFreshScopedQuestion: boolean, clockSec: number,
  governance: ControlOverlay["issuanceGovernance"],
): ControlOverlay["issuanceProcess"] {
  const operational = profile.operationalIssuance;
  if (!operational || !governance) return undefined;
  const certificates = profile.executionCertificates;
  const graph = profile.authorityGraph;
  const diagnostics = [...projections.flatMap((projection) => projection.processDiagnostics ?? []), ...(governance?.votingControl.diagnostics ?? [])];
  for (const diagnostic of governance.diagnostics) if (diagnostic.code === "governor-control-missing" ||
      diagnostic.code === "governor-not-governance" || diagnostic.code === "governor-without-issuance-path") diagnostics.push(diagnostic);
  const add = (code: V1005ProcessDiagnostic["code"], gate: V1005ProcessDiagnostic["gate"], field: string, path?: { controlRef: string; pathId: string }) => {
    diagnostics.push({ code, gate, controlRef: path?.controlRef ?? null, pathId: path?.pathId ?? null,
      classId: null, memberRef: null, field, evidenceRefIds: [] });
  };
  const closed = (ref: string) => v1005ProofIsClosed(certificates, ref, operational.review.pin);
  if (!reviewComplete) add("review-incomplete", "H0", "review");
  if (hasFreshScopedQuestion) add("scoped-question-open", "H0", "review.scopedQuestions");
  if (profile.mintIncidents?.some((incident) => incident.status === "active")) add("active-incident", "H0", "mintIncidents");
  if (!v1005ReviewIsCurrent(operational.review, clockSec, V9_REVIEW_EVIDENCE_MAX_AGE_SEC)) add("review-expired", "H0", "operationalIssuance.review");
  if (profile.governedIssuance?.decisionRule !== "affirmative-vote" || profile.economicCapSemantics !== "unbounded" ||
      profile.inheritedFrom != null || profile.mintPath === "wrapped-or-variant-inherited") add("operational-decision-rule-inadmissible", "H0", "operationalIssuance");
  if (!certificates || !graph || certificates.liabilityBookId !== operational.liabilityBookId || graph.liabilityBookId !== operational.liabilityBookId) add("economic-reach-unclosed", "H3", "liabilityBookId");
  const paths = new Map(projections.flatMap((projection) => projection.paths.map((path) =>
    [`${projection.scope?.controllerDeployment ?? ""}#${path.id}`, { path, projection }] as const)));
  const classes = new Map<string, typeof operational.paths[number]>();
  for (const entry of operational.paths) {
    const key: `${string}#${string}` = `${entry.path.controlRef}#${entry.path.pathId}`;
    if (classes.has(key) || !paths.has(key)) add("operational-path-unclassified", "H0", "operationalIssuance.paths", entry.path);
    classes.set(key, entry);
  }
  const nonGovernor = new Set<string>(), unclassified = new Set<string>(), unknownRecipient = new Set<string>();
  const discretionaryDelays: (number | null)[] = [], envelopeDelays: (number | null)[] = [], operationalDelays: (number | null)[] = [];
  const envelopeTransitions = new Set<string>();
  let discretionaryPathCount = 0, operationalPathCount = 0, formulaPathCount = 0, keeperInitialPathCount = 0, keeperRecurringPathCount = 0, fundedKeeperRecurringPathCount = 0, otherOperationalPathCount = 0;
  let formulaQualified = true, keeperQualified = true, otherClassesQualified = true;
  let authorityPathsClosed = graph != null;
  const annualRates: (number | null)[] = [], coefficients: (number | null)[] = [], fixedRewards: (bigint | null)[] = [], recurringIntervals: (number | null)[] = [];
  const formulaKeys = new Set<string>(), keeperKeys = new Set<string>(), recurringKeys = new Set<string>(), claims = new Set<string>();
  const operationalIndex = new Map<string, typeof operational.paths[number]>();
  for (const [key, { path, projection }] of paths) {
    if (path.activation === "disabled-final" && projection.complete) continue;
    const entry = classes.get(key);
    const ref = { controlRef: projection.scope!.controllerDeployment, pathId: path.id };
    const authority = projection.authorityPaths?.get(key);
    if (authority?.closed !== true) authorityPathsClosed = false;
    const delayedActivation = path.activation === "disabled-reactivatable" && authority?.governorRooted && authority.publicDelaySec !== null && authority.publicDelaySec > 0;
    const relevant = path.capabilities.some((capability) => ["mint", "bridge-mint", "upgrade", "parameter-change", "custody-transfer"].includes(capability)) ||
      path.claimImpairment === "unbounded" || path.claimImpairment === "unknown";
    if (!entry || delayedActivation) {
      if (!relevant) continue;
      discretionaryPathCount++;
      discretionaryDelays.push(authority?.publicDelaySec ?? null);
      if (!authority?.closed || !authority.governorRooted) { nonGovernor.add(key); add("discretionary-root-independent", "H1", "authorityGraph", ref); }
      if (authority?.publicDelaySec == null) add("delay-unproved", "H1", "publicDelaySec", ref);
      if (!entry && path.capabilities.some((capability) => capability === "mint" || capability === "bridge-mint") &&
          !authority?.governorRooted) { unclassified.add(key); add("operational-path-unclassified", "H0", "operationalIssuance.paths", ref); }
      continue;
    }
    operationalPathCount++; operationalDelays.push(path.unavoidableDelaySec); operationalIndex.set(key, entry);
    if (path.unavoidableDelaySec === null) add("delay-unproved", "H0", "operationalExerciseDelaySec", ref);
    if (!authority?.closed || !authority.provenanceClosed) add("economic-reach-unclosed", "H0", "authorityGraph.provenance", ref);
    const envelope = entry.envelope;
    if (envelope) {
      if (!closed(envelope.enforcementProofRef) || !closed(envelope.raiseClosureProofRef) ||
          envelope.setterNodeIds.some((id) => !graph?.nodes.some((node) => node.id === id && closed(node.proofRef)))) add("operational-cap-unproved", "H1", "envelope", ref);
      for (const raise of envelope.raisePathRefs) {
        const raiseKey: `${string}#${string}` = `${raise.controlRef}#${raise.pathId}`;
        envelopeTransitions.add(raiseKey);
        const bound = paths.get(raiseKey)?.projection.authorityPaths?.get(raiseKey);
        envelopeDelays.push(bound?.publicDelaySec ?? null);
        if (!bound?.closed || !bound.governorRooted) { nonGovernor.add(raiseKey); add("discretionary-root-independent", "H1", "envelope.raisePathRefs", raise); }
        if (bound?.publicDelaySec == null) add("delay-unproved", "H1", "envelope.raisePathRefs", raise);
      }
    }
    if (entry.kind === "formula-interest") {
      formulaPathCount++; formulaKeys.add(key); annualRates.push(entry.rate.operationalAnnualRatePpmUpper);
      if (entry.principal.observedPrincipalRaw === null || !closed(entry.principal.proofRef)) { formulaQualified = false; add("formula-principal-unproved", "H2", "principal", ref); }
      if (!closed(entry.time.proofRef)) { formulaQualified = false; add("formula-time-unproved", "H2", "time", ref); }
      if (!closed(entry.beneficiaryProofRef) || !closed(entry.accountingProofRef)) { formulaQualified = false; unknownRecipient.add(key); add("formula-beneficiary-unproved", "H2", "beneficiaryProofRef", ref); }
      if (entry.rate.rawCap === null || entry.rate.operationalAnnualRatePpmUpper === null || !closed(entry.rate.capProofRef) || !closed(entry.rate.unitsCompoundingProofRef) ||
          entry.rate.yearSec !== 31536000 || entry.rate.convention === "other") { formulaQualified = false; add("rate-units-unproved", "H2", "rate", ref); }
      if (claims.has(entry.principal.claimIdentity)) { formulaQualified = false; add("interest-aggregate-unproved", "H3", "principal.claimIdentity", ref); }
      claims.add(entry.principal.claimIdentity);
    } else if (entry.kind === "keeper-incentive") {
      keeperKeys.add(key);
      if (entry.lifecycle === "initial-kick") keeperInitialPathCount++;
      else { keeperRecurringPathCount++; recurringKeys.add(key); }
      coefficients.push(entry.proportionalRewardPpm); fixedRewards.push(entry.fixedRewardRaw === null ? null : BigInt(entry.fixedRewardRaw));
      const rewardMayPay = entry.fixedRewardRaw === null || entry.proportionalRewardPpm === null || BigInt(entry.fixedRewardRaw) > 0n || entry.proportionalRewardPpm > 0;
      const repeatGroups = operational.keeperAggregate?.repeatGroups.filter((group) => group.pathRefs.some((pathRef) => `${pathRef.controlRef}#${pathRef.pathId}` === key));
      const funded = rewardMayPay && (!repeatGroups?.length || repeatGroups.some((group) => group.inFlightCapRaw === null || BigInt(group.inFlightCapRaw) > 0n));
      if (entry.lifecycle !== "initial-kick" && funded) { fundedKeeperRecurringPathCount++; recurringIntervals.push(entry.minimumRepeatSec); }
      if (entry.liabilityBookId !== operational.liabilityBookId || entry.fixedRewardRaw === null || entry.proportionalRewardPpm === null ||
          !closed(entry.principalProvenanceProofRef) || !closed(entry.eligibilityProofRef) || !closed(entry.debtBookChargeProofRef) ||
          entry.sameActivityMayRepeat === "unknown" || entry.lifecycle !== "initial-kick" && funded && entry.minimumRepeatSec === null) {
        keeperQualified = false; add("keeper-activity-unproved", "H2", "keeper-incentive", ref);
      }
      if (entry.lifecycle === "initial-kick") {
        const initial = entry.initialCompensation;
        if (!initial || !closed(initial.newDebtReachProofRef) || !closed(initial.minimumAndPenaltyProofRef) || !closed(initial.historicalStockProofRef) ||
            !closed(initial.oncePerLiquidationProofRef) || entry.sameActivityMayRepeat !== false ||
            initial.historicalStockDebtRaw === null || initial.historicalPaidLiquidationCountUpper === null ||
            initial.historicalDebtPositionCountUpper === null || initial.historicalStockKickRewardRawUpper === null ||
            initial.newDebtAdmission === "unknown") { keeperQualified = false; add("keeper-activity-unproved", "H2", "initialCompensation", ref); }
        else {
          if (initial.newDebtAdmission === "immediate" && (initial.minimumNewPositionDebtRaw === null || BigInt(initial.minimumNewPositionDebtRaw) <= 0n ||
              initial.rewardDebtRawAtMinimum === null || initial.liquidationPenaltyChargeRawAtMinimum === null ||
              entry.fixedRewardRaw === null || entry.proportionalRewardPpm === null ||
              BigInt(entry.fixedRewardRaw) + (BigInt(initial.rewardDebtRawAtMinimum) * BigInt(entry.proportionalRewardPpm) + 999999n) / 1000000n >
                BigInt(initial.liquidationPenaltyChargeRawAtMinimum))) {
            keeperQualified = false; add("keeper-activity-unproved", "H2", "initialCompensation.minimumAndPenalty", ref);
          }
          if (entry.fixedRewardRaw !== null && entry.proportionalRewardPpm !== null) {
            const stock = BigInt(initial.historicalStockDebtRaw!), count = BigInt(initial.historicalPaidLiquidationCountUpper!);
            const lower = (stock * BigInt(entry.proportionalRewardPpm) + 999999n) / 1000000n + BigInt(entry.fixedRewardRaw) * count;
            if (BigInt(initial.historicalStockKickRewardRawUpper!) < lower) { keeperQualified = false; add("keeper-activity-unproved", "H2", "initialCompensation.historicalStockKickRewardRawUpper", ref); }
          }
        }
      } else if (entry.initialCompensation !== null) { keeperQualified = false; add("keeper-activity-unproved", "H2", "initialCompensation", ref); }
    } else {
      otherOperationalPathCount++;
      const stockTransitionsImpossible = path.controlRefs.length === 0 && path.reactivationRefs.length === 0 &&
        path.permissionChangeRefs.length === 0 && path.upgradeRefs.length === 0 && path.bypassRefs.length === 0 &&
        !graph?.edges.some((edge) => edge.activation !== "disabled-final" &&
          ["reactivation", "permission-change", "upgrade", "envelope-raise"].includes(edge.kind) &&
          edge.pathRefs.some((pathRef) => pathRef.controlRef === ref.controlRef && pathRef.pathId === ref.pathId));
      if (!closed(entry.invariantProofRef) || !closed(entry.economicReachProofRef) ||
          entry.kind === "bounded-stock" && (path.capSemantics.kind !== "bounded" || !path.capSemantics.bound || !entry.envelope && !stockTransitionsImpossible) ||
          entry.kind === "collateral-gated" && path.capSemantics.kind !== "collateral-gated" ||
          ["restriction-only", "no-issuance"].includes(entry.kind) && (path.capabilities.includes("mint") || path.claimImpairment === "unbounded")) {
        otherClassesQualified = false; add("economic-reach-unclosed", "H4", "operationalIssuance.invariantProofRef", ref);
      }
      if (entry.kind === "paired-accounting" && entry.externalAccountingTrust === "strategy-reported-assets") add("external-accounting-trust", "H4", "externalAccountingTrust", ref);
    }
  }
  const samePaths = (refs: readonly { controlRef: string; pathId: string }[], expected: Set<string>) => {
    const actual = refs.map((ref) => `${ref.controlRef}#${ref.pathId}`);
    return new Set(actual).size === actual.length && actual.length === expected.size && actual.every((key) => expected.has(key));
  };
  const interest = operational.interestAggregate;
  if (formulaPathCount > 0) {
    if (!interest || !samePaths(interest.pathRefs, formulaKeys) || interest.liabilityBookId !== operational.liabilityBookId ||
        interest.principalRaw === null || interest.annualGrowthPpmUpper === null || new Set(interest.principalClaimIds).size !== interest.principalClaimIds.length ||
        interest.principalClaimIds.length !== claims.size || interest.principalClaimIds.some((id) => !claims.has(id)) ||
        !closed(interest.deduplicationProofRef) || !closed(interest.compoundingProofRef) || !closed(interest.scopeProofRef)) {
      formulaQualified = false; add("interest-aggregate-unproved", "H3", "interestAggregate");
    }
    annualRates.push(interest?.annualGrowthPpmUpper ?? null);
  } else if (interest !== null) { formulaQualified = false; add("interest-aggregate-unproved", "H3", "interestAggregate"); }
  const keeper = operational.keeperAggregate;
  let nativeSupply: bigint | null = null, repeatRaw: bigint | null = null;
  let sourceDenominator: bigint | null = null;
  if (keeper) {
    const reads = keeper.denominatorEvidenceRefIds.flatMap((id) => {
      const evidence = certificates?.evidence.find((row) => row.id === id);
      return evidence?.kind === "onchain-read" && !evidence.artificial && evidence.pin.chain === operational.review.pin.chain &&
        evidence.pin.position === operational.review.pin.position && evidence.pin.hash === operational.review.pin.hash &&
        (evidence.readType === "evm-call" || evidence.readType === "storage") && /^0x[0-9a-fA-F]{64}$/.test(evidence.rawResult ?? "")
        ? [{ id, deployment: evidence.deployment, function: evidence.function, raw: BigInt(evidence.rawResult!) }] : [];
    });
    if (keeper.denominatorTerms) {
      const getters = new Set<string>();
      let measured = 0n, complete = true;
      for (const term of keeper.denominatorTerms) {
        const getterKey = `${term.deployment}#${term.function}`, read = reads.find((row) => row.id === term.evidenceRefId && row.deployment === term.deployment && row.function === term.function);
        const scale = BigInt(term.scaleNumerator), divisor = BigInt(term.scaleDenominator);
        if (!read || getters.has(getterKey) || divisor === 0n || !closed(term.unitsProofRef) || read.raw * scale % divisor !== 0n) complete = false;
        else measured += read.raw * scale / divisor;
        getters.add(getterKey);
      }
      if (complete) sourceDenominator = measured;
    } else if (reads.length === 1) sourceDenominator = reads[0]!.raw;
  }
  if (keeperKeys.size > 0) {
    if (!keeper || !samePaths(keeper.pathRefs, keeperKeys) || keeper.liabilityBookId !== operational.liabilityBookId ||
        keeper.denominatorRaw === null || sourceDenominator === null || sourceDenominator <= 0n || sourceDenominator !== BigInt(keeper.denominatorRaw) || keeper.rewardUnits !== keeper.denominatorUnits ||
        keeper.windowSec !== 86400 || !closed(keeper.activityAntiFarmingProofRef) || !closed(keeper.deduplicationProofRef) ||
        !closed(keeper.initialAndBoundaryProofRef) || !closed(keeper.scopeProofRef) ||
        !keeper.denominatorEvidenceRefIds.every((id) => certificates?.evidence.some((row) => row.id === id && row.kind === "onchain-read" && !row.artificial && row.pin.hash === operational.review.pin.hash))) {
      keeperQualified = false; add("aggregate-flow-unproved", "H3", "keeperAggregate");
    } else {
      nativeSupply = sourceDenominator;
      const groups = new Map<string, { cap: bigint; independent: bigint; numerator: bigint; denominator: bigint }>();
      const represented = new Set<string>();
      let complete = true;
      for (const group of keeper.repeatGroups) {
        if (groups.has(group.id) || group.inFlightCapRaw === null || group.minimumPaidAuctionRaw === null || group.fixedRewardRawUpper === null ||
            group.proportionalRewardPpmUpper === null || group.maxRepeatsPerWindow === null || !closed(group.capAndMultiplicityProofRef) || !closed(group.repeatAndBoundaryProofRef)) { complete = false; continue; }
        const cap = BigInt(group.inFlightCapRaw), minimum = BigInt(group.minimumPaidAuctionRaw), tip = BigInt(group.fixedRewardRawUpper), chip = BigInt(group.proportionalRewardPpmUpper), repeats = BigInt(group.maxRepeatsPerWindow);
        if (minimum <= 0n && cap > 0n) { complete = false; continue; }
        for (const ref of group.pathRefs) {
          const key = `${ref.controlRef}#${ref.pathId}`, entry = operationalIndex.get(key);
          if (represented.has(key) || !recurringKeys.has(key) || entry?.kind !== "keeper-incentive" || entry.fixedRewardRaw === null ||
              entry.proportionalRewardPpm === null || tip < BigInt(entry.fixedRewardRaw) || chip < BigInt(entry.proportionalRewardPpm) ||
              cap > 0n && (tip > 0n || chip > 0n) && (entry.minimumRepeatSec === null || entry.minimumRepeatSec === 0 || Number(repeats) < Math.ceil(86400 / entry.minimumRepeatSec))) complete = false;
          represented.add(key);
        }
        const denominator = minimum > 0n ? minimum * 1000000n : 1000000n;
        const numerator = minimum > 0n ? repeats * (tip * 1000000n + chip * minimum) : 0n;
        const independent = cap === 0n ? 0n : repeats * (tip * (cap / minimum) + (chip * cap + 999999n) / 1000000n);
        groups.set(group.id, { cap, independent, numerator, denominator });
      }
      if (represented.size !== recurringKeys.size || [...recurringKeys].some((key) => !represented.has(key))) complete = false;
      const coupled = new Set<string>();
      let derived = 0n;
      for (const coupling of keeper.repeatCouplingGroups) {
        if (coupling.sharedInFlightCapRaw === null || !closed(coupling.capAndSlackProofRef) || coupling.repeatGroupIds.some((id) => coupled.has(id) || !groups.has(id))) { complete = false; continue; }
        const ordered = coupling.repeatGroupIds.map((id) => ({ id, group: groups.get(id)! })).sort((a, b) => {
          const left = a.group.numerator * b.group.denominator, right = b.group.numerator * a.group.denominator;
          return left === right ? compareText(a.id, b.id) : left > right ? -1 : 1;
        });
        let remaining = BigInt(coupling.sharedInFlightCapRaw), numerator = 0n, denominator = 1n, independent = 0n;
        for (const { id, group } of ordered) {
          coupled.add(id); independent += group.independent;
          const allocated = remaining < group.cap ? remaining : group.cap;
          numerator = numerator * group.denominator + allocated * group.numerator * denominator;
          denominator *= group.denominator; remaining -= allocated;
        }
        const greedy = (numerator + denominator - 1n) / denominator;
        derived += greedy < independent ? greedy : independent;
      }
      for (const [id, group] of groups) if (!coupled.has(id)) derived += group.independent;
      if (!complete || keeper.upperRepeatRewardRaw === null || BigInt(keeper.upperRepeatRewardRaw) < derived) {
        keeperQualified = false; add("aggregate-flow-unproved", "H3", "keeperAggregate.repeatGroups");
      } else repeatRaw = derived;
    }
  } else if (keeper !== null) { keeperQualified = false; add("aggregate-flow-unproved", "H3", "keeperAggregate"); }
  const measuredMax = (values: readonly (number | null)[]): number | null => values.length === 0 || values.some((value) => value === null) ? null : Math.max(...values as number[]);
  const measuredMin = (values: readonly (number | null)[]): number | null => values.length === 0 || values.some((value) => value === null) ? null : Math.min(...values as number[]);
  const fixed = fixedRewards.length === 0 || fixedRewards.some((value) => value === null) ? null : fixedRewards.reduce<bigint>((max, value) => value! > max ? value! : max, 0n);
  const fixedSharePpm = fixed !== null && nativeSupply ? Number((fixed * 1000000000000000000n + nativeSupply - 1n) / nativeSupply) / 1000000000000 : null;
  const repeatPpm = repeatRaw !== null && nativeSupply ? (repeatRaw * 1000000n + nativeSupply - 1n) / nativeSupply : null;
  if (repeatPpm !== null && repeatPpm > BigInt(Number.MAX_SAFE_INTEGER)) { keeperQualified = false; add("aggregate-flow-unproved", "H3", "keeperAggregate.repeatRatio"); }
  const members = new Set(certificates?.censuses.filter((row) => row.kind !== "owner" && row.kind !== "admin").flatMap((row) => row.authoritativeMembers));
  const unknownMembers = new Set(diagnostics.filter((row) => row.memberRef && members.has(row.memberRef)).map((row) => row.memberRef!));
  const inventoryComplete = certificates != null && !diagnostics.some((row) => row.code === "authority-census-incomplete" || row.code === "process-certificate-unavailable");
  const executionCoverage = projections.every((projection) => projection.complete) && !diagnostics.some((row) => ["execution-class-unmatched", "runtime-unmatched", "implementation-unmatched", "instance-state-unmatched"].includes(row.code)) ? "complete" as const : "incomplete" as const;
  const authorityCoverage = authorityPathsClosed &&
    !diagnostics.some((row) => ["graph-reference-unresolved", "graph-cycle-unclosed", "authority-state-mismatch", "governor-not-governance"].includes(row.code)) ? "complete" as const : "incomplete" as const;
  const economicReachClosed = !diagnostics.some((row) => row.code === "economic-reach-unclosed");
  const sorted = sortV1005ProcessDiagnostics(diagnostics);
  const coverage = sorted.every((row) => row.code === "external-accounting-trust") && inventoryComplete && executionCoverage === "complete" &&
    authorityCoverage === "complete" && economicReachClosed && governance?.votingControl.qualified && discretionaryPathCount > 0 && operationalPathCount > 0 &&
    formulaQualified && keeperQualified && otherClassesQualified && unknownMembers.size === 0 ? "complete" as const : "incomplete" as const;
  return {
    kind: "affirmative-operational-flow", coverage, authorityCoverage, executionCoverage, economicReachClosed, inventoryComplete,
    memberCount: members.size, matchedMemberCount: members.size - unknownMembers.size, unknownMemberCount: unknownMembers.size,
    discretionaryPathCount, operationalPathCount, formulaPathCount, keeperInitialPathCount, keeperRecurringPathCount, fundedKeeperRecurringPathCount, otherOperationalPathCount,
    envelopeTransitionPathCount: envelopeTransitions.size,
    nonGovernorDiscretionaryPathKeys: [...nonGovernor].sort(), unclassifiedExpansionPathKeys: [...unclassified].sort(), unknownRecipientPathKeys: [...unknownRecipient].sort(),
    minDiscretionaryPublicDelaySec: measuredMin(discretionaryDelays), minEnvelopeRaisePublicDelaySec: measuredMin(envelopeDelays),
    minOperationalExerciseDelaySec: measuredMin(operationalDelays), formulaQualified, keeperQualified, otherClassesQualified,
    maxAnnualInterestGrowthPpm: measuredMax(annualRates), maxKeeperProportionalRewardPpm: measuredMax(coefficients),
    maxKeeperFixedRewardSupplyPpm: fixedSharePpm,
    minKeeperRecurringIntervalSec: measuredMin(recurringIntervals), maxKeeperRepeatRewardSupplyPpmPer86400Sec: repeatPpm !== null && repeatPpm <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(repeatPpm) : null,
    keeperSupplyScreenBasis: keeperKeys.size > 0 ? { nativeSupplyRaw: nativeSupply?.toString() ?? null, maxFixedRewardRaw: fixed?.toString() ?? null,
      maxRepeatRewardRawPer86400Sec: repeatRaw?.toString() ?? null, nativeUnits: keeper?.denominatorUnits ?? "unknown" } : null,
    votingControl: governance.votingControl, diagnostics: sorted, evidenceRefIds: certificates?.evidence.map((row) => row.id).sort() ?? [],
    sourceGenerationId: domainDigest("v1005-issuance-process", { assetId, certificates, graph, operational, votingControl: profile.governedIssuance?.votingControl }),
    freshnessBudgetSec: V9_REVIEW_EVIDENCE_MAX_AGE_SEC, observedAtSec: Date.parse(`${operational.review.observedAt}T00:00:00Z`) / 1000,
    expiresAtSec: Date.parse(`${operational.review.expiresAt}T00:00:00Z`) / 1000,
  };
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
  clockSec: number,
  projection: V9ReviewedControlProjection,
  issuanceFactsRef: string | undefined,
  scopedQuestionIsCustodyOnly: boolean,
): ControlOverlay[] {
  const controlKind = mintControlKind(control);
  const coarseCapabilities = mintCapabilities(control, upgradeCapable);
  const capabilities = projection.scope && projection.complete
    ? [...new Set(projection.paths.flatMap((path) => path.capabilities))].sort(compareText)
    : [...new Set([...coarseCapabilities, ...projection.provenPaths.flatMap((path) => path.capabilities)])].sort(compareText);
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
  const economicSemantics = projection.reviewed && !projection.complete
    ? partialControlScopeSemantics({ capSemantics, claimImpairment }, projection)
    : { capSemantics, claimImpairment };
  // Unknown execution reach stays bounded without a redundant question record.
  // Independently established legacy adverse economics remain binding unless
  // the scoped review explicitly questions that economic reach.
  const scopedMintReachUnresolved =
    ((scopedQuestionFresh && !scopedQuestionIsCustodyOnly) || (capSemantics.kind !== "unbounded" && claimImpairment !== "unbounded")) &&
    projection.reviewed &&
    !projection.complete &&
    projection.paths.some((path) =>
      path.activation !== "disabled-final" &&
      path.capabilities.includes("mint") &&
      (path.activation === "unknown" || path.reach === "unknown" || path.economicLossScope === "unknown"),
    ) &&
    !projection.provenPaths.some((path) =>
      path.capabilities.includes("mint") &&
      path.economicLossScope === "global-claim" &&
      (path.capSemantics.kind === "unbounded" || path.claimImpairment === "unbounded"),
    );
  const deploymentScopes = resolveMintControlDeploymentScopes(control, supplyReview, reviewComplete && !scopedMintReachUnresolved, hasMint);
  const incidentState: ControlOverlay["incidentState"] = incidents?.some((incident) => incident.status === "active")
    ? "active"
    : incidents?.some((incident) => incident.status === "resolved")
      ? "resolved"
      : reviewComplete && !scopedMintReachUnresolved
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
    ...economicSemantics,
    economicLossScope: scopedMintReachUnresolved ? "unknown" : economicSemantics.claimImpairment === "none" ? "access-only" : "global-claim",
    authority: canonicalAuthorityType(assetId, control),
    delaySec: control.timelockDelaySec ?? null,
    materialSupplyShare: null,
    ...(scopedQuestionFresh ? { scopedQuestionFresh: true } : {}),
    ...(scopedQuestionIsCustodyOnly ? { scopedQuestionSubject: "key-custody-independence" as const } : {}),
    keyCustody: scopedQuestionIsCustodyOnly ? "unknown" : control.keyCustodyAttestation?.kind ?? "unknown",
    modulesOrGuards: control.modulesOrGuardsStatus ?? "unknown",
    ...(projection.scope ? {
      executionScope: projection.scope,
      executionScopeComplete: projection.complete,
      scopeDiagnostics: projection.diagnostics.sort(compareText),
      moduleImpact: projection.moduleImpact,
    } : {}),
    ...(issuanceFactsRef ? { issuanceFactsRef } : {}),
    incidentState,
    failureDomains: controlFailureDomains(assetId, control, controlKind),
    ...(control.weightedQuorum && !weightedReviewIsCurrent(control.weightedQuorum, clockSec, V9_REVIEW_EVIDENCE_MAX_AGE_SEC)
      ? { authority: { ...canonicalAuthorityType(assetId, control)!, weightedQuorum: { ...control.weightedQuorum, status: "unknown" as const } } }
      : {}),
  };
  if (projection.scope && projection.complete) {
    if (projection.paths.length === 0) return [{ ...globalControl, capabilities: [], capSemantics: { kind: "not-applicable", bound: null }, claimImpairment: "none", economicLossScope: "access-only" }];
    return projection.paths.flatMap((path) => {
      const localScopes = path.reach === "deployment" && path.economicLossScope === "deployment"
        ? resolveMintControlDeploymentScopes({ ...control, deploymentRefs: path.affectedDeployments }, supplyReview, true, path.capabilities.includes("mint"))
        : null;
      const row: ControlOverlay = {
        ...globalControl,
        controlKey: `${controlKey}:path:${path.id}`,
        executionPathId: path.id,
        capabilities: [...new Set(path.capabilities)].sort(compareText),
        capSemantics: path.capSemantics,
        claimImpairment: path.claimImpairment,
        economicLossScope: path.claimImpairment === "none" ? "access-only" : "global-claim",
        delaySec: path.unavoidableDelaySec,
      };
      if (localScopes === null) return [row];
      return localScopes.map((deployment) => ({
        ...row,
        controlKey: `${row.controlKey}:deployment:${deployment.deploymentKey}`,
        deploymentKey: deployment.deploymentKey, scope: "deployment" as const,
        economicLossScope: path.claimImpairment === "none" ? "access-only" as const : "deployment" as const,
        materialSupplyShare: deployment.materialSupplyShare,
      }));
    });
  }
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
    economicLossScope: economicSemantics.claimImpairment === "none" ? "access-only" : "deployment",
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


function hasAdmissibleCuratedReserveComposition(
  meta: V9ExtensionRegistryMeta,
  clockSec: number,
  fixedInput: Readonly<SafetyScoreV9CompilerInput>,
): boolean {
  if (buildSafetyScoreV9ReviewedStaticReserveRows(meta, clockSec, fixedInput) !== null) return true;
  return meta.liveReservesConfig !== undefined
    ? buildSafetyScoreV9ReviewedCuratedFallbackReserveRows(meta, clockSec, fixedInput) !== null
    : buildSafetyScoreV9ReviewedStandaloneReserveRows(meta, clockSec, fixedInput) !== null;
}

function prepareDependency(
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
    !hasAdmissibleCuratedReserveComposition(meta, clockSec, fixedInput);
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
  review: SafetyScoreV9WrapperAllocationReview | null,
  evidence: ReviewEvidenceBuilder,
  clockSec: number,
): void {
  if (!review) return;
  if (review.scopeKind === "per-dimension") {
    const maxAgeSec = V9_CANDIDATE_POLICY_V1.policy.semantic.evidence.evidenceExpiry.reviewedResearchMaxAgeSec;
    for (const claim of review.claims) {
      if (allocationReviewClockSec(claim.reviewedAt) > clockSec || claim.observedAtSec > clockSec ||
        clockSec >= claim.expiresAtSec || clockSec - claim.observedAtSec > maxAgeSec) continue;
      const keys: string[] = [];
      for (const source of claim.sources) {
        const contentSha256 = domainDigest("safety-score-v9.scoped-allocation-claim.v1", { claim, source });
        const evidenceKey = `allocation-scope:${claim.claimKey}:${contentSha256.slice(0, 16)}`;
        evidence.evidence.set(evidenceKey, {
          evidenceKey, sourceId: "safety-score-v9.scoped-allocation-review",
          observedAtSec: claim.observedAtSec, publishedAtSec: null, publishedBy: "unknown",
          url: source.url, contentSha256, confidence: "verified",
          maxAgeSec: Math.min(maxAgeSec, claim.expiresAtSec - claim.observedAtSec),
        });
        keys.push(evidenceKey);
      }
      evidence.bindings.set(`allocation-scope:${claim.claimKey}`, new Set(keys));
    }
    return;
  }
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

function buildAllocationScopeIdentityReview(meta: V9ExtensionRegistryMeta): V9AllocationScopeIdentityReview {
  const deployments: V9AllocationScopeIdentityReview["deployments"] = [];
  const registeredDeploymentKeys = (meta.contracts ?? []).flatMap((contract) => {
    const chain = resolveChainId(contract.chain);
    return chain === null ? [] : [canonicalExitRouteScopedKey(chain, contract.address)];
  }).sort(compareText);
  const upgrade = meta.mintAuthority?.upgradeability;
  if (!upgrade?.observedAt || upgrade.observedBlock === undefined || upgrade.sources.length === 0) return { assetId: meta.id, registeredDeploymentKeys, deployments };
  const observedAtSec = allocationReviewClockSec(upgrade.observedAt);
  const sourceUrl = upgrade.sources[0]!.url;
  for (const contract of meta.contracts ?? []) {
    const chain = resolveChainId(contract.chain);
    if (chain === null) continue;
    const address = canonicalExitRouteScopedId(chain, contract.address);
    const deploymentKey = `${chain}:${address}`;
    // Unscoped addresses never identify a deployment across multiple chains.
    const scoped = upgrade.deploymentRefs?.some((ref) => normalizeDeploymentId(ref) === deploymentKey) ||
      (meta.contracts?.length === 1);
    if (!scoped) continue;
    if (upgrade.model === "immutable") {
      deployments.push({ codeKind: "immutable", chain, address, observedAtSec, block: upgrade.observedBlock, sourceUrl });
    } else if (upgrade.proxyAddresses?.some((proxy) => canonicalExitRouteScopedId(chain, proxy) === address) &&
      upgrade.implementationAddresses?.length === 1) {
      deployments.push({ codeKind: "proxy", chain, address, implementation: canonicalExitRouteScopedId(chain, upgrade.implementationAddresses[0]!),
        observedAtSec, block: upgrade.observedBlock, sourceUrl });
    }
  }
  return { assetId: meta.id, registeredDeploymentKeys, deployments };
}


function transferMaterialScope(
  fixedInput: Readonly<SafetyScoreV9CompilerInput>,
  assetId: string,
  meta: V9ExtensionRegistryMeta,
  generation: SafetyScoreV9TransferMaterialityGeneration | null,
  review: SafetyScoreV9ReviewedTransferFact | undefined,
): SafetyScoreV9TransferMaterialScope {
  const rows = safetyScoreV9ChainRows(fixedInput, assetId);
  const totalSupplyUsd = !REVIEWED_ECONOMIC_SUPPLY_PLANS.has(assetId) ||
    fixedInput.safetyScoreV9SupplyAttributionById?.[assetId] ||
    hasCompleteEligibleProviderSupply(fixedInput, assetId, { contracts: meta.contracts, bridgeRouteRisk: meta.bridgeRouteRisk })
    ? Object.values(rows).reduce((sum, row) => sum + row.current, 0) : 0;
  const authoritativeDeployments = (meta.contracts ?? []).flatMap((deployment) => {
    const chainId = resolveChainId(deployment.chain);
    return chainId === null ? [] : [{ chainId, key: safetyScoreV9TransferDeploymentKey(chainId, deployment.address) }];
  });
  const authoritativeDeploymentKeys = [...new Set(authoritativeDeployments.map(({ key }) => key))].sort(compareText);
  const unresolvedDeclaredChainIds = (meta.contracts ?? [])
    .filter((deployment) => resolveChainId(deployment.chain) === null)
    .map((deployment) => deployment.chain.trim().toLowerCase());
  const unresolvedDeclaredDeploymentKeys = (meta.contracts ?? [])
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
    unresolvedDeclaredDeploymentKeys,
    unresolvedMaterialChainIds: [...new Set([
      ...unresolvedDeclaredChainIds,
      ...Object.entries(rows)
        .filter(([chain, row]) => resolveChainId(chain) === null && row.current / totalSupplyUsd >= DEPLOYMENT_MATERIAL_SHARE_THRESHOLD)
        .map(([chain]) => chain.trim().toLowerCase()),
    ])].sort(compareText),
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
    const directlyFreezeCapable =
      upstream.blacklistabilityReview?.reviewedStatus === true ||
      (upstream.blacklistabilityReview === undefined && upstream.flags?.governance === "centralized");
    if (!directlyFreezeCapable) continue;
    // Largest share, then lexicographic id: independent of registry order.
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
  // A scoped appendix is not whole-token operational/mint reconciliation.
  if (proof?.latestReport?.coverage != null) return false;
  if (proof?.latestReport) return true;
  const cadence = proof?.cadence;
  return cadence != null && cadence !== "none" && cadence !== "undisclosed";
}

function adaptMintReview(
  meta: V9ExtensionRegistryMeta,
  metaById: ReadonlyMap<string, V9ExtensionRegistryMeta>,
  dependencies: PreparedDependency["dependency"],
  supplyReview: ExtensionAsset["supplyReview"],
  evidence: ReviewEvidenceBuilder,
  clockSec: number,
): {
  review: NonNullable<ExtensionAsset["economicControlReview"]>["mint"];
  controls: ControlOverlay[];
  issuanceFacts?: ExtensionAsset["issuanceFacts"];
} {
  let profile: MintAuthorityProfile | undefined = meta.mintAuthority;
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
  const resolvedBook = resolveV1005MintAuthorityProfile(profile, meta.id, metaById, clockSec, V9_REVIEW_EVIDENCE_MAX_AGE_SEC);
  profile = resolvedBook.profile;
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
  const reviewComplete =
    !reviewStale && resolvedBook.diagnostics.length === 0 &&
    profile.review.disposition !== "unresolved" &&
    (profile.review.unresolvedQuestions?.length ?? 0) === 0 &&
    reviewedObservationState(confidence) === "known";
  const upgradeability = profile.upgradeability;
  // A scoped question softens only the one control it names, and only while
  // its review date sits inside the freshness window.
  const freshScopedQuestions = (profile.review.scopedQuestions ?? []).filter((question) =>
    clockSec - parseBoundedDateSec(question.reviewedAt, clockSec, `${meta.id}:scoped-question`) <= V9_SCOPED_QUESTION_MAX_AGE_SEC);
  const freshScopedQuestionRefs = new Set(freshScopedQuestions.map((question) => question.controlRef.toLowerCase()));
  const semanticQuestionRefs = new Set(freshScopedQuestions.filter((question) =>
    question.subject !== "key-custody-independence").map((question) => question.controlRef.toLowerCase()));
  const authoredControls = profile.controls ?? [];
  const controlProjections = compileReviewedMintControlScopes(profile, meta.id, clockSec, V9_REVIEW_EVIDENCE_MAX_AGE_SEC).map((projection) =>
    resolvedBook.diagnostics.length === 0 ? projection : { ...projection, processDiagnostics: sortV1005ProcessDiagnostics([...projection.processDiagnostics ?? [], ...resolvedBook.diagnostics]) });
  const issuanceGovernance = compileMintIssuanceGovernance(
    meta.id, profile, controlProjections, reviewComplete, semanticQuestionRefs.size > 0, clockSec,
  );
  const issuanceProcess = compileMintIssuanceProcess(
    meta.id, profile, controlProjections, reviewComplete, semanticQuestionRefs.size > 0, clockSec, issuanceGovernance,
  );
  const issuanceFacts: ExtensionAsset["issuanceFacts"] = issuanceGovernance || resolvedBook.diagnostics.length > 0 ? {
    ref: domainDigest("v1005-asset-issuance-facts", { assetId: meta.id, issuanceGovernance, issuanceProcess, diagnostics: resolvedBook.diagnostics }),
    ...(issuanceGovernance ? { governance: issuanceGovernance } : {}),
    ...(issuanceProcess ? { process: issuanceProcess } : {}),
    diagnostics: [...resolvedBook.diagnostics],
  } : undefined;
  // An unresolved aggregate inventory does not erase controls that were
  // individually identified. Retain those controls in a partial review while
  // the unresolved deployment surfaces remain bounded and fail closed.
  const controls = authoredControls.flatMap((control, index, allControls) =>
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
      clockSec,
      controlProjections[index]!,
      issuanceFacts?.ref,
      !((control.address != null && semanticQuestionRefs.has(`${control.chain ?? ""}:${control.address.toLowerCase()}`)) ||
        semanticQuestionRefs.has(control.label.toLowerCase())) &&
        ((control.address != null && freshScopedQuestionRefs.has(`${control.chain ?? ""}:${control.address.toLowerCase()}`)) ||
          freshScopedQuestionRefs.has(control.label.toLowerCase())),
    ),
  ).map((control) => resolvedBook.diagnostics.length === 0 ? control : { ...control, executionScopeComplete: false,
    scopeDiagnostics: [...new Set([...control.scopeDiagnostics ?? [], ...resolvedBook.diagnostics.map((row) => row.code)])].sort() });
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
  const inheritedShareAuthority = hasExactInheritedWrapperDependency
    ? (profile.controls ?? []).find(
        (control) =>
          control.role === "wrapper" &&
          control.directMintAbility === "none" &&
          control.canRaiseCap === false,
      )
    : undefined;
  // An exact serial wrapper does not create durable parent supply. Its reviewed
  // share-accounting control therefore represents the local mint component when
  // no explicit durable-mint control exists. The parent mint domain remains on
  // the serial dependency, while every local upgrade control stays in this
  // asset's control inventory and continues to constrain the wrapper layer.
  const inheritedShareControl =
    directMintControl === null && inheritedShareAuthority
      ? (controls.find(
          (control) =>
            control.authority?.authorityKey === canonicalAuthorityType(meta.id, inheritedShareAuthority)?.authorityKey &&
            !control.capabilities.includes("mint"),
        ) ?? null)
      : null;
  const mintControl = directMintControl ?? inheritedShareControl;
  const referencedUpgradeAuthority =
    upgradeability?.controlRef == null
      ? undefined
      : (profile.controls ?? []).find((control) => control.label === upgradeability.controlRef);
  const referencedUpgrade = referencedUpgradeAuthority
    ? (controls.find(
        (control) =>
          control.authority?.authorityKey === canonicalAuthorityType(meta.id, referencedUpgradeAuthority)?.authorityKey &&
          control.capabilities.includes("upgrade"),
      ) ?? null)
    : null;
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
  // inference — the reviewer looked and could not establish a cadence. Preserve
  // that scoped unanswered factor independently of the base rung determined by
  // known economic authority and qualifying process evidence.
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
    !reviewStale &&
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
      ...(issuanceFacts ? { issuanceFacts } : {}),
    };
  }
  const state = reviewStale
    ? "stale"
    : !reviewComplete
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
        state === "known" || state === "bounded-unknown" || state === "stale" ? evidenceKeys : [],
      ),
      controlKey: mintControl?.controlKey ?? null,
      reconciliation: reviewStale ? "unknown" : reconciliation,
      // A reviewed prudential-supervision fact graduates the reconciled mint
      // rung; absent or "unknown" stays fail-closed at "unknown".
      supervision: !reviewStale && profile.supervision && profile.supervision !== "unknown" ? profile.supervision : "unknown",
      latestResolvedIncidentAtSec: latestResolvedMintIncidentAtSec(profile.mintIncidents, clockSec),
      upgrade,
    },
    controls,
    ...(issuanceFacts ? { issuanceFacts } : {}),
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
  const reuseScopeRoot = createV9ControlExecutionScopeRootReuse();
  const reviewedTransferFacts = options.reviewedTransferFacts && createReviewedAssetRegistry({
    rows: [...options.reviewedTransferFacts.values()],
    schema: SafetyScoreV9ReviewedTransferFactSchema,
    path: "transferReviews.reviews",
  });
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
    preparedById.set(assetId, prepareDependency(meta, fixedInput.liveReserveMap[assetId], activeIds, clockSec, fixedInput));
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
  // Attribution packets carry their own per-asset observation time and window
  // (safetyScoreV9ChainSupplyObservedAtSec / safetyScoreV9ChainSupplyMaxAgeSec),
  // so the shared source keeps the fixed input's observation time.
  const chainSupplyObservedAtSec = boundedObservedAt(fixedInput.updatedAt, clockSec);
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
    wrapperAllocationReviewsDigest: SAFETY_SCORE_V9_WRAPPER_ALLOCATION_REVIEWS_DIGEST,
    wrapperLocalReviewsDigest: SAFETY_SCORE_V9_WRAPPER_LOCAL_REVIEWS_DIGEST,
    reserveBoundFactsDigest: SAFETY_SCORE_V9_RESERVE_BOUND_FACTS_DIGEST,
    reviewedTransferFactsDigest: computeSafetyScoreV9ReviewedTransferFactsDigest(options.reviewedTransferFacts?.values()),
    accessClaimGraphReviewsDigest: computeSafetyScoreV9AccessClaimGraphReviewsDigest(options.accessClaimGraphReviews?.values()),
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
    schemaVersion: 3,
    registryFingerprint,
    compiledAtSec: clockSec,
    sources,
    routeFreshness: {
      dexMaxAgeSec: V9_EVIDENCE_PRODUCER_INTERVAL_SEC["sync-dex-liquidity"] * 2,
      redemptionMaxAgeSec: V9_EVIDENCE_PRODUCER_INTERVAL_SEC["sync-redemption-backstops"] * 2,
      documentedTermsMaxAgeSec: SAME_NOTIONAL_EXIT_OBSERVATION_FRESHNESS_POLICY.documentedTermsMaxAgeSec,
    },
    assets: fixedInput.activeAssetIds.map((assetId) => {
      // Asset-local admission boundary (R8): a curation, adapter, or
      // point-in-time failure below — including the future-review guards — is
      // recorded on a conservative stub naming the failing field and reason.
      // Compilation quarantines that asset to producer-failed NR and its
      // dependents become unavailable, while the rest of the cohort proceeds to
      // the unchanged publication gate. Registry identity and the dependency
      // graph above stay cohort-global.
      // Admit and seal before assembling the cohort: in-process materialization
      // reuses these identities, while external overlays retain full validation.
      const admitted: Partial<ExtensionAsset> = {};
      let admissionPath = "dependencies";
      try {
        const meta = metaById.get(assetId)!;
        const prepared = preparedById.get(assetId)!;
        const cycle = cycleByAsset.get(assetId);
        const dependencies: NonNullable<ExtensionAsset["dependencies"]> = {
          ...prepared.dependency,
          diagnostics: cycle
            ? {
                graphState: "cycle",
                issueCodes: [...new Set([...prepared.issueCodes, "dependency-cycle"])].sort(compareText),
                sccMemberAssetIds: [...cycle].sort(compareText),
              }
            : prepared.dependency.diagnostics,
        };
        admitted.dependencies = dependencies;
        admitted.variantKind = meta.variantKind ?? null;
        admissionPath = "assetIssuerKey";
        const assetIssuerKey = resolveSafetyScoreV9AssetIssuerKey(assetId, metaById);
        admitted.assetIssuerKey = assetIssuerKey;
        admissionPath = "archetype";
        const resolvedArchetype = resolveMechanismArchetype(meta, metaById) ?? "unresolved";
        const archetype = hasAdmittedSafetyScoreV9NativeFamily(meta, resolvedArchetype, clockSec)
          ? resolvedArchetype
          : "unresolved";
        admitted.archetype = archetype;
        admissionPath = "cdpStressCoverage";
        validateSafetyScoreV9ShockRegistryAsset(assetId);
        admissionPath = "pegReference";
        const pegReference = buildPegReference(meta, metaById);
        admitted.pegReference = pegReference;
        admissionPath = "registry.mintBridgeOwnership";
        assertMintBridgeOwnership(meta);
        const liveReserves = fixedInput.liveReserveMap[assetId] ?? [];
        // The audited fallback rung applies only where a live producer was
        // observed returning nothing this capture. It sits inside that gate, not
        // ahead of it, so an asset excluded from falling back is not rescued; and
        // it is deliberately absent from the standalone branch, where no live
        // producer exists and nothing has gone stale.
        admissionPath = "reviewedStaticReserveRows";
        const reviewedStaticReserveRows = resolveReviewedReserveRows({
          meta,
          clockSec,
          fixedInput,
          liveReserveRows: liveReserves,
          liveFallbackAllowed: liveToFallbackAssetIds.has(assetId),
        });
        const reserveRows = reviewedStaticReserveRows?.rows ?? liveReserves;
        admissionPath = "reserveBoundFacts";
        const reserveBoundFacts = buildSafetyScoreV9ReserveBoundFacts(assetId, reserveRows, { clockSec, liveProvenance: fixedInput.liveReserveProvenanceMap[assetId], liveMaxAgeSec: sources.liveReserves.maxAgeSec });
        const reviewEvidence = new ReviewEvidenceBuilder(assetId, clockSec);
        admissionPath = "reserveScopeAdmissions";
        const reserveScopeAdmissions = buildSafetyScoreV10ScopedReserveAdmissions(meta, fixedInput);
        addScopedReserveEvidence(meta, reserveScopeAdmissions, fixedInput, reviewEvidence);
        admissionPath = "reviewedIncidents";
        const reviewedIncidents = getSafetyScoreV9ReviewedIncidents(assetId, clockSec);
        addSafetyScoreV9IncidentEvidence(reviewEvidence, reviewedIncidents);
        const negativeIncidentReviews = getSafetyScoreV9NegativeIncidentReviews(assetId, clockSec);
        addSafetyScoreV9NegativeIncidentEvidence(reviewEvidence, negativeIncidentReviews);
        admissionPath = "wrapperAllocationReview";
        const wrapperAllocationReview = getSafetyScoreV9WrapperAllocationReview(assetId, clockSec);
        admissionPath = "wrapperLocalReviews";
        const wrapperLocalReviews = getSafetyScoreV9WrapperLocalReviews(assetId);
        admissionPath = "mechanismRiskReview";
        const mechanismRiskReview = buildSafetyScoreV9MechanismReview(fixedInput, meta, archetype);
        admissionPath = "mechanismReviewGapDisposition";
        const mechanismReviewGapDisposition =
          getSafetyScoreV9MechanismReviewGapDisposition(assetId, archetype, clockSec);
        admissionPath = "mechanismReviewedUnavailable";
        const mechanismReviewedUnavailable = getSafetyScoreV9MechanismReviewedUnavailableComponents(
          assetId,
          archetype,
          clockSec,
        );
        admissionPath = "componentEvidence.mechanism-risk-review";
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
        } else if (
          mechanismRiskReview &&
          (archetype === "ucits-trs-fund" || archetype === "shared-reserve" || archetype === "protocol-position") &&
          meta.mechanismArchetypeReview
        ) {
          reviewEvidence.add({
            componentKeys: ["mechanism-risk-review"],
            sourceId: "stablecoin.mechanismArchetypeReview",
            reviewedAt: meta.mechanismArchetypeReview.reviewedAt,
            publishedBy: "unknown",
            confidence: "manual-review",
            sources: meta.mechanismArchetypeReview.sources,
            payload: meta.mechanismArchetypeReview,
            maxAgeSec: V9_CANDIDATE_POLICY_V1.policy.semantic.evidence.evidenceExpiry.mechanismOverlayMaxAgeSec,
          });
        }
        if (!mechanismOverlayEvidence) {
          const history = getSafetyScoreV9MechanismOverlayEvidence(assetId, archetype, clockSec, { history: true });
          if (history) reviewEvidence.add({
            componentKeys: ["mechanism-risk-review-history"],
            sourceId: "safety-score-v9.mechanism-review-overlay", reviewedAt: history.reviewedAt,
            publishedBy: "unknown", confidence: "manual-review", sources: history.sources,
            payload: history.payload, maxAgeSec: history.maxAgeSec,
          });
        }
        const assuranceReport = meta.proofOfReserves?.latestReport;
        const assuranceComponent =
          archetype === "tbill"
            ? "lossRecoveryDesign"
            : archetype === "fiat-cash" || archetype === "commodity-claim"
              ? "assuranceAndReconciliation"
              : null;
        if (
          mechanismRiskReview &&
          assuranceReport?.periodEnd &&
          assuranceReport.publishedAt &&
          assuranceReport.assuranceMethod !== "unknown" &&
          assuranceReport.scope !== "unknown" &&
          assuranceComponent
        ) {
          admissionPath = `componentEvidence.mechanism-risk-review:${assuranceComponent}`;
          reviewEvidence.add({
            componentKeys: [`mechanism-risk-review:${assuranceComponent}`],
            sourceId: "stablecoin.proof-of-reserves.latest-report",
            reviewedAt: assuranceReport.publishedAt,
            observedAt: assuranceReport.periodEnd,
            publishedAt: assuranceReport.publishedAt,
            publishedBy: "issuer",
            confidence: confidenceForResearch(assuranceReport.confidence),
            sources: assuranceReport.sources,
            payload: assuranceReport,
            maxAgeSec:
              V9_CANDIDATE_POLICY_V1.policy.semantic.evidence.evidenceExpiry.assuranceReportMaxAgeSec,
          });
        }
        admissionPath = "reserveClassifications";
        const reserveClassifications = buildReviewedReserveClassifications(
          reserveRows,
          meta,
          clockSec,
          V9_CANDIDATE_POLICY_V1.policy.semantic.evidence.evidenceExpiry.reviewedReserveClassificationMaxAgeSec,
        );
        addReserveClassificationEvidence(meta, reserveClassifications, reviewEvidence);
        admissionPath = "componentEvidence.reviewed-static-reserve-rows";
        addReviewedStaticReserveEvidence(meta, reviewedStaticReserveRows, reviewEvidence, clockSec);
        admissionPath = "componentEvidence.dependencies";
        addDependencyEvidence(meta, reviewEvidence);
        admissionPath = "componentEvidence.wrapper-custody";
        addWrapperCustodyEvidence(meta, reviewEvidence);
        admissionPath = "componentEvidence.wrapper-allocation";
        addWrapperAllocationEvidence(wrapperAllocationReview, reviewEvidence, clockSec);
        if (meta.parentBackingInheritance) {
          admissionPath = "componentEvidence.parent-backing-inheritance";
          reviewEvidence.add({
            componentKeys: ["wrapper-local:parentBackingInheritance"],
            sourceId: "stablecoin-meta.parent-backing-inheritance",
            reviewedAt: meta.parentBackingInheritance.reviewedAt,
            publishedBy: "unknown",
            confidence: "verified",
            sources: meta.parentBackingInheritance.sources,
            payload: meta.parentBackingInheritance,
          });
        }
        admissionPath = "supplyReview";
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
        admissionPath = "economicControlReview.mint";
        const mint = adaptMintReview(meta, metaById, prepared.dependency, supplyReview, reviewEvidence, clockSec);
        admissionPath = "economicControlReview.oracle";
        const oracle = adaptOracleReview(meta, archetype, reviewEvidence, clockSec);
        admissionPath = "economicControlReview.bridge";
        const bridge = adaptBridgeReview(
          meta,
          supplyReview,
          deployedChainCount,
          reviewEvidence,
          clockSec,
          chainRows,
        );
        admissionPath = "controlReview";
        const incidentControlRoute = routeSafetyScoreV9ControlIncidents(
          mint.controls,
          mint.review,
          reviewedIncidents,
        );
        const controls = routeSafetyScoreV9NegativeIncidentReviews(
          [...incidentControlRoute.controls, ...bridge.controls],
          assetId,
          clockSec,
          negativeIncidentReviews,
          reviewedIncidents,
        ).sort((left, right) => compareText(left.controlKey, right.controlKey));
        admissionPath = "accessReview";
        const reviewedTransferFact = reviewedTransferFacts
          ? reviewedTransferFacts.get(assetId)
          : getSafetyScoreV9ReviewedTransferFact(assetId);
        const accessReview = adaptAccessReview(
          meta,
          metaById,
          activeIds,
          reviewEvidence,
          reviewedTransferFact,
          transferMaterialScope(
            fixedInput,
            assetId,
            meta,
            options.transferMaterialityGeneration ?? null,
            reviewedTransferFact,
          ),
          clockSec,
          buildSafetyScoreV9AccessClaimGraph({ assetId, clockSec, generationId: fixedInput.baseInputGenerationId, evidence: reviewEvidence, review: options.accessClaimGraphReviews?.get(assetId) }),
        );
        admissionPath = "researchEvidence";
        const reviewedEvidence = reviewEvidence.finish();
        admissionPath = "controlReview";
        const controlsFullyResolved =
          controls.length > 0 &&
          controls.every(controlCanCarryKnownStatus);
        admissionPath = "launchedAtSec";
        const launchedAtSec = conservativeDateEndSec(meta.implementationLaunchDate ?? meta.launchDate, clockSec);
        admissionPath = "mechanismExitFacts";
        const mechanismExitFacts = getSafetyScoreV9MechanismExitFacts(assetId, archetype, clockSec);
        admissionPath = "routeReviews";
        const routeReviews = buildSafetyScoreV9RouteReviews(fixedInput, assetId);
        admissionPath = "retainedRoutes";
        const retainedRoutes = buildSafetyScoreV9RetainedRoutes(fixedInput, assetId);
        admissionPath = "operationalResilience";
        const operationalResilience = routeSafetyScoreV9OperationalIncidents(
          getSafetyScoreV9OperationalResilienceOverlay(assetId, clockSec),
          reviewedIncidents,
        );
        return admitSafetyScoreV9ExtensionAsset({
          assetId,
          assetIssuerKey,
          archetype,
          variantKind: meta.variantKind ?? null,
          ...(meta.wrapperOperator === undefined ? {} : { wrapperOperator: meta.wrapperOperator }),
          ...(meta.parentBackingInheritance === undefined
            ? {}
            : { parentBackingInheritance: meta.parentBackingInheritance }),
          launchedAtSec,
          mechanismRiskReview,
          ...(mechanismReviewGapDisposition ? { mechanismReviewGapDisposition } : {}),
          ...(mechanismReviewedUnavailable.length > 0 ? { mechanismReviewedUnavailable } : {}),
          mechanismExitFacts,
          dependencies,
          reserveApplicability: { state: "required" },
          reserveClassifications,
          ...(reserveBoundFacts.length > 0 ? { reserveBoundFacts } : {}),
          reviewedStaticReserveRows,
          ...(reserveScopeAdmissions.length > 0 ? { reserveScopeAdmissions } : {}),
          routeReviews,
          retainedRoutes,
          ...(mint.issuanceFacts ? { issuanceFacts: mint.issuanceFacts } : {}),
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
          pegReference,
          supplyReview,
          operationalResilience,
          wrapperAllocationReview,
          wrapperLocalReviews,
          allocationScopeIdentityReview: buildAllocationScopeIdentityReview(meta),
          wrapperCustodyReview:
            (meta.variantKind === "savings-passthrough" ||
              meta.variantKind === "risk-absorption" ||
              meta.variantKind === "strategy-vault") &&
            meta.custodyProfile
            ? {
                custodyModel: meta.custodyModel ?? "unknown",
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
        }, clockSec, reuseScopeRoot);
      } catch (error) {
        return quarantinedSafetyScoreV9ExtensionAsset(admitted, assetId, {
          code: "fact-build-failed",
          path: error instanceof ReviewedRegistryEntryError ? error.path : admissionPath,
          message: toErrorMessage(error),
        });
      }
    }),
  };
}
