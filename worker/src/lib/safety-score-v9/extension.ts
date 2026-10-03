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
import { compileReviewedControlScope, partialControlScopeSemantics, weightedReviewIsCurrent, type V9ReviewedControlProjection } from "@shared/lib/safety-score-v9/control-scope";
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
} from "./fact-set";
import { quarantinedSafetyScoreV9ExtensionAsset } from "./fact-set-schema";
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
  getSafetyScoreV9ReviewedIncidents,
  routeSafetyScoreV9ControlIncidents,
  routeSafetyScoreV9OperationalIncidents,
  SAFETY_SCORE_V9_INCIDENT_REVIEWS_DIGEST,
} from "./extension-incidents";
import { getSafetyScoreV9WrapperAllocationReview, SAFETY_SCORE_V9_WRAPPER_ALLOCATION_REVIEWS_DIGEST } from "./extension-wrapper-allocation";
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
  if (!reviewComplete) incompleteReasons.add("review-incomplete");
  if (hasFreshScopedQuestion) incompleteReasons.add("scoped-question-open");
  if (profile.mintIncidents?.some((incident) => incident.status === "active")) incompleteReasons.add("active-incident");
  const governedReviewSec = Date.parse(`${governed.reviewedAt}T00:00:00Z`) / 1000;
  if (governedReviewSec > clockSec || clockSec - governedReviewSec > V9_REVIEW_EVIDENCE_MAX_AGE_SEC) {
    incompleteReasons.add("governed-review-expired");
  }
  const governorIndexes = authoredControls.flatMap((control, index) =>
    control.chain != null && control.address != null &&
    `${control.chain}:${control.address.toLowerCase()}` === governed.governorControlRef ? [index] : []);
  const governorIndex = governorIndexes.length === 1 ? governorIndexes[0]! : -1;
  const governor = governorIndex >= 0 ? authoredControls[governorIndex] : undefined;
  if (!governor) {
    incompleteReasons.add("governor-control-missing");
  } else if (canonicalAuthorityType(assetId, governor)?.model !== "governance" ||
      ((governed.votingPower === "lock-escrowed" || governed.votingPower === "past-block-checkpoint") &&
        (governor.weightedQuorum != null || governor.threshold != null || governor.signerCount != null))) {
    incompleteReasons.add("governor-not-governance");
  }
  if (governor && projections[governorIndex]!.complete &&
      !governor.executionScope!.paths.some((path) => path.activation !== "disabled-final" &&
        path.capabilities.some((capability) => capability === "mint" || capability === "upgrade" || capability === "bridge-mint"))) {
    incompleteReasons.add("governor-without-issuance-path");
  }
  const authoredContractAuthorityKeys = new Set(authoredControls.flatMap((control) =>
    control.authorityType === "contract" && control.chain != null && control.address != null
      ? [`${control.chain}:${control.address.toLowerCase()}`] : []));
  let minUnavoidableDelaySec: number | null = null;
  let hasNullDelay = false;
  const nonGovernorUnboundedPathKeys = new Set<string>();
  for (const [index, control] of authoredControls.entries()) {
    const projection = projections[index]!;
    if (!projection.complete) {
      incompleteReasons.add(`control-scope-incomplete:${control.label}`);
      continue;
    }
    let governorRooted = index === governorIndex;
    if (!governorRooted && governor != null && control.authorityType === "contract" && control.chain != null) {
      const identity = control.executionScope!.pin.signerIdentity.toLowerCase();
      if (!/\b\d+\s*(?:of|out\s+of|\/|-of-)\s*\d+\b|\b(?:safes?|multisigs?|multisignature|thresholds?|signers?|owners?|quorum)\b/.test(identity)) {
        const addresses: readonly string[] = identity.match(/(?<![0-9a-f])0x[0-9a-f]{40}(?![0-9a-f])/g) ?? [];
        const authorityKeys = addresses.map((address) => `${control.chain}:${address}`);
        governorRooted = authorityKeys.includes(governed.governorControlRef) &&
          authorityKeys.every((key) => key === governed.governorControlRef || authoredContractAuthorityKeys.has(key));
      }
    }
    for (const path of projection.paths) {
      if (!(path.capSemantics.kind === "unbounded" || path.capSemantics.kind === "unknown" ||
            path.claimImpairment === "unbounded" || path.claimImpairment === "unknown")) continue;
      if (path.unavoidableDelaySec === null) {
        hasNullDelay = true;
      } else {
        minUnavoidableDelaySec = minUnavoidableDelaySec === null
          ? path.unavoidableDelaySec
          : Math.min(minUnavoidableDelaySec, path.unavoidableDelaySec);
      }
      if (!governorRooted) nonGovernorUnboundedPathKeys.add(`${control.label}:${path.id}`);
    }
  }
  return {
    coverage: incompleteReasons.size === 0 ? "complete" : "incomplete",
    incompleteReasons: [...incompleteReasons].sort(compareText),
    governorAuthorityKey: governed.governorControlRef,
    minUnavoidableDelaySec: hasNullDelay ? null : minUnavoidableDelaySec,
    votingPower: governed.votingPower,
    enumerable: governed.enumerability.authorizationEvents.length > 0 && governed.enumerability.capacityReads.length > 0,
    nonGovernorUnboundedPathKeys: [...nonGovernorUnboundedPathKeys].sort(compareText),
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
  issuanceGovernance: ControlOverlay["issuanceGovernance"],
): ControlOverlay[] {
  const controlKind = mintControlKind(control);
  const coarseCapabilities = mintCapabilities(control, upgradeCapable);
  const capabilities = control.executionScope && projection.complete
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
    (scopedQuestionFresh || (capSemantics.kind !== "unbounded" && claimImpairment !== "unbounded")) &&
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
    keyCustody: control.keyCustodyAttestation?.kind ?? "unknown",
    modulesOrGuards: control.modulesOrGuardsStatus ?? "unknown",
    ...(control.executionScope ? {
      executionScope: control.executionScope,
      executionScopeComplete: projection.complete,
      scopeDiagnostics: projection.diagnostics.sort(compareText),
      moduleImpact: projection.moduleImpact,
    } : {}),
    ...(issuanceGovernance ? { issuanceGovernance } : {}),
    incidentState,
    failureDomains: controlFailureDomains(assetId, control, controlKind),
    ...(control.weightedQuorum && !weightedReviewIsCurrent(control.weightedQuorum, clockSec, V9_REVIEW_EVIDENCE_MAX_AGE_SEC)
      ? { authority: { ...canonicalAuthorityType(assetId, control)!, weightedQuorum: { ...control.weightedQuorum, status: "unknown" as const } } }
      : {}),
  };
  if (control.executionScope && projection.complete) {
    if (projection.paths.length === 0) return [{ ...globalControl, capabilities: [], capSemantics: { kind: "not-applicable", bound: null }, claimImpairment: "none", economicLossScope: "access-only" }];
    return projection.paths.flatMap((path) => {
      const localScopes = path.reach === "deployment" && path.economicLossScope === "deployment"
        ? resolveMintControlDeploymentScopes({ ...control, deploymentRefs: path.affectedDeployments }, supplyReview, true, path.capabilities.includes("mint"))
        : null;
      const row: ControlOverlay = {
        ...globalControl,
        controlKey: `${controlKey}:path:${path.id}`,
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
  const reviewComplete =
    !reviewStale &&
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
          clockSec - parseBoundedDateSec(question.reviewedAt, clockSec, `${meta.id}:scoped-question`) <=
          V9_SCOPED_QUESTION_MAX_AGE_SEC,
      )
      .map((question) => question.controlRef.toLowerCase()),
  );
  const authoredControls = profile.controls ?? [];
  const controlProjections = authoredControls.map((control) =>
    compileReviewedControlScope(control.executionScope, `${control.chain ?? "chain-unresolved"}:${control.address ?? ""}`, meta.id, clockSec, V9_REVIEW_EVIDENCE_MAX_AGE_SEC));
  const issuanceGovernance = compileMintIssuanceGovernance(
    meta.id, profile, controlProjections, reviewComplete, freshScopedQuestionRefs.size > 0, clockSec,
  );
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
      issuanceGovernance,
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
        admissionPath = "wrapperAllocationReview";
        const wrapperAllocationReview = getSafetyScoreV9WrapperAllocationReview(assetId, clockSec);
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
        const mint = adaptMintReview(meta, prepared.dependency, supplyReview, reviewEvidence, clockSec);
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
        const controls = [...incidentControlRoute.controls, ...bridge.controls].sort((left, right) =>
          compareText(left.controlKey, right.controlKey),
        );
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
        return {
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
        };
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
