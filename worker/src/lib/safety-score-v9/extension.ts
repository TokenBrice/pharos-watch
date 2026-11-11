import { buildSafetyScoreV9ReserveBoundFacts, SAFETY_SCORE_V9_RESERVE_BOUND_FACTS_DIGEST } from "./extension-reserve-bounds";
import { buildSafetyScoreV10ScopedReserveAdmissions, addScopedReserveEvidence } from "./extension-reserves";
import { resolveMechanismArchetype } from "@shared/lib/classification/resolve-mechanism-archetype";
import { resolveEffectiveImplementationLaunchDate } from "@shared/lib/classification/resolve-implementation-launch-date";
import { normalizeDeploymentId } from "@shared/types/deployment-id";
import { diagnoseDependencyGraph } from "@shared/lib/dependency-graph";
import { V9_EVIDENCE_PRODUCER_INTERVAL_SEC } from "@shared/lib/cron-cadences";
import { computeReportCardsRegistryFingerprint } from "@shared/lib/report-cards-fixed-input-identity";
import type { V9AccessClaimGraphReview } from "@shared/types/safety-score-v9-access-lookthrough";
import { buildSafetyScoreV9AccessClaimGraph, computeSafetyScoreV9AccessClaimGraphReviewsDigest } from "./extension-access-lookthrough";
import { V9_CANDIDATE_POLICY_V1 } from "@shared/lib/safety-score-v9/policy";
import type { V9LaneEmitterDescriptor } from "@shared/types/safety-score-v9-incidents";
import { compareText, domainDigest } from "@shared/lib/safety-score-v9/primitives";
import { ACTIVE_META_BY_ID } from "@shared/lib/stablecoins/registry";
import type { V9LaneIncidentClosureFailure } from "@shared/types/safety-score-v9-facts";
import { createV9ControlExecutionScopeRootReuse } from "@shared/types/safety-score-v9-control-scope";
import { type SafetyScoreV9FactSetExtensionV2 } from "./fact-set";
import { admitSafetyScoreV9ExtensionAsset, quarantinedSafetyScoreV9ExtensionAsset } from "./fact-set-schema";
import { toErrorMessage } from "@shared/lib/error-utils";
import { createReviewedAssetRegistry, ReviewedRegistryEntryError } from "@shared/lib/safety-score-v9/reviewed-registry";
import { SafetyScoreV9ReviewedTransferFactSchema } from "@shared/types/safety-score-v9-transfer-overlays";
import { controlCanCarryKnownStatus } from "./fact-set-control";
import { hydrateSafetyScoreV9ShockCoverageAsset, validateSafetyScoreV9ShockRegistryAsset } from "./extension-shock";
import { buildSafetyScoreV9MechanismReview, getSafetyScoreV9MechanismExitFacts, getSafetyScoreV9MechanismComponentEvidence, getSafetyScoreV9MechanismOverlayEvidence, getSafetyScoreV9MechanismReviewGapDisposition, getSafetyScoreV9MechanismReviewedUnavailableComponents, hasAdmittedSafetyScoreV9NativeFamily, SAFETY_SCORE_V9_MECHANISM_REVIEW_OVERLAYS_DIGEST } from "./extension-mechanism";
import { addSafetyScoreV9IncidentEvidence, addSafetyScoreV9NegativeIncidentEvidence, getSafetyScoreV9NegativeIncidentReviews, laneContributorProviderKeys, routeSafetyScoreV9NegativeIncidentReviews, getSafetyScoreV9ReviewedIncidents, routeSafetyScoreV9ControlIncidents, SAFETY_SCORE_V9_INCIDENT_REVIEWS_DIGEST, type LaneIncidentCertificateView, type LaneRouteAuthority } from "./extension-incidents";
import { getSafetyScoreV9WrapperAllocationReview, getSafetyScoreV9WrapperLocalReviews, SAFETY_SCORE_V9_WRAPPER_ALLOCATION_REVIEWS_DIGEST, SAFETY_SCORE_V9_WRAPPER_LOCAL_REVIEWS_DIGEST } from "./extension-wrapper-reviews";
import { computeSafetyScoreV9ReviewedTransferFactsDigest, getSafetyScoreV9ReviewedTransferFact, type SafetyScoreV9ReviewedTransferFact } from "./extension-transfer";
import { SAME_NOTIONAL_EXIT_OBSERVATION_FRESHNESS_POLICY } from "@shared/lib/redemption-backstop-scoring";
import { type SafetyScoreV9TransferMaterialityGeneration } from "./transfer-materiality";
import { buildSafetyScoreV9RetainedRoutes, buildSafetyScoreV9RouteReviews } from "./extension-routes";
import { buildSafetyScoreV9SupplyAdmission, type ReviewedProviderRowExclusionRow } from "./extension-supply";
import { normalizeSafetyScoreV9CompilerInput, type SafetyScoreV9CompilerInput } from "./native-input";
import { safetyScoreV9ChainRows, safetyScoreV9ChainSupplySourceGenerationId } from "./supply-attribution";
import { adaptBridgeReview } from "./extension-bridge";
import { adaptOracleReview } from "./extension-oracle";
import { addReserveClassificationEvidence, addReviewedStaticReserveEvidence, buildReviewedReserveClassifications, buildSafetyScoreV9ReviewedAuditedFallbackReserveRows, buildSafetyScoreV9ReviewedCuratedFallbackReserveRows, buildSafetyScoreV9ReviewedStandaloneReserveRows, buildSafetyScoreV9ReviewedStaticReserveRows, resolveReviewedReserveAdmission } from "./extension-reserves";
import { ReviewEvidenceBuilder } from "@shared/lib/safety-score-v9/review-evidence";
import { sha256HexFromUtf8Chunks } from "../hash";
import { boundedObservedAt, confidenceForResearch, maximumObservedAt, type ExtensionAsset, type V9ExtensionRegistryMeta } from "./extension-shared";
import { resolveSafetyScoreV9AssetIssuerKey, assertMintBridgeOwnership, adaptMintReview } from "./extension-mint";
import { prepareDependency, addDependencyEvidence, type PreparedDependency } from "./extension-dependencies";
import { addWrapperCustodyEvidence, addWrapperAllocationEvidence, buildAllocationScopeIdentityReview } from "./extension-wrapper-reviews";
import { transferMaterialScope, adaptAccessReview } from "./extension-access-lookthrough";
import { buildPegReference } from "./extension-peg-reference";

// The registry-meta projection now lives beside the adapters that read it.
export type { V9ExtensionRegistryMeta } from "./extension-shared";
export {
  buildReviewedReserveClassifications,
  buildSafetyScoreV9ReviewedAuditedFallbackReserveRows,
  buildSafetyScoreV9ReviewedCuratedFallbackReserveRows,
  buildSafetyScoreV9ReviewedStandaloneReserveRows,
  buildSafetyScoreV9ReviewedStaticReserveRows,
};


export interface BuildSafetyScoreV9BaselineExtensionOptions {
  metaById?: ReadonlyMap<string, V9ExtensionRegistryMeta>;
  registryFingerprint?: string;
  reviewedTransferFacts?: ReadonlyMap<string, SafetyScoreV9ReviewedTransferFact>;
  accessClaimGraphReviews?: ReadonlyMap<string, V9AccessClaimGraphReview>;
  transferMaterialityGeneration?: SafetyScoreV9TransferMaterialityGeneration | null;
  /** Injected reviewed provider-row exclusions; omitted reads the shared curated registry. */
  providerRowExclusionReviews?: readonly ReviewedProviderRowExclusionRow[];
  /**
   * Evaluation inputs of the v10.39 lane closure, loaded by the publication
   * runner: the admitted certificate chain per lane (only `current` reads are
   * accepted) and the reviewed lane descriptors. Omitted means no closure, which
   * is the fail-closed default (an unread certificate cannot grant `none`).
   */
  laneIncidentCertificates?: ReadonlyMap<string, LaneIncidentCertificateView>;
  laneEmitterDescriptors?: readonly V9LaneEmitterDescriptor[];
  /**
   * Replay-only projection: build these assets while retaining the full input's
   * active set, dependency diagnostics, source generations and identity.
   * Omit for the complete production extension.
   */
  assetIds?: ReadonlySet<string>;
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
  const source = createSafetyScoreV9BaselineExtensionSource(fixedInput, options);
  return { ...source.extension, assets: [...source.assets()] };
}

export interface SafetyScoreV9BaselineExtensionSource {
  extension: SafetyScoreV9FactSetExtensionV2;
  assets(): IterableIterator<ExtensionAsset>;
}

/** Rebuild asset-local overlays per traversal; retain only the shared dependency graph. */
export function createSafetyScoreV9BaselineExtensionSource(
  fixedInput: Readonly<SafetyScoreV9CompilerInput>,
  options: BuildSafetyScoreV9BaselineExtensionOptions = {},
): SafetyScoreV9BaselineExtensionSource {
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
  const asOfDate = new Date(clockSec * 1_000).toISOString().slice(0, 10);
  const activeIds = new Set(fixedInput.activeAssetIds);
  const preparedById = new Map<string, PreparedDependency>();
  const dependencyAdmissionErrors = new Map<string, unknown>();
  for (const assetId of fixedInput.activeAssetIds) {
    const meta = metaById.get(assetId);
    if (!meta) throw new Error(`Safety Score v9 baseline extension has no registry metadata for ${assetId}`);
    try {
      preparedById.set(assetId, prepareDependency(meta, fixedInput.liveReserveMap[assetId], activeIds, clockSec, fixedInput));
    } catch (error) {
      dependencyAdmissionErrors.set(assetId, error);
    }
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
      ...Object.values(fixedInput.exitOutputPriceById ?? {}).map((price) => price.observedAtSec),
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
    ...(fixedInput.exitOutputPriceById ? { exitOutputPriceById: fixedInput.exitOutputPriceById } : {}),
    activeDepegPeakBpsById: fixedInput.activeDepegPeakBpsById,
    ...(fixedInput.safetyScoreV9DirectionalPeg
      ? { safetyScoreV9DirectionalPeg: fixedInput.safetyScoreV9DirectionalPeg }
      : {}),
  });
  const researchOverlaysGenerationDigest = domainDigest("safety-score-v9.research-overlays.v3", {
    registryRevision: fixedInput.registryRevision,
    incidentReviewsDigest: SAFETY_SCORE_V9_INCIDENT_REVIEWS_DIGEST,
    mechanismReviewOverlaysDigest: SAFETY_SCORE_V9_MECHANISM_REVIEW_OVERLAYS_DIGEST,
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

  const extension: SafetyScoreV9FactSetExtensionV2 = {
    schemaVersion: 3,
    registryFingerprint,
    compiledAtSec: clockSec,
    sources,
    routeFreshness: {
      dexMaxAgeSec: V9_EVIDENCE_PRODUCER_INTERVAL_SEC["sync-dex-liquidity"] * 2,
      redemptionMaxAgeSec: V9_EVIDENCE_PRODUCER_INTERVAL_SEC["sync-redemption-backstops"] * 2,
      documentedTermsMaxAgeSec: SAME_NOTIONAL_EXIT_OBSERVATION_FRESHNESS_POLICY.documentedTermsMaxAgeSec,
    },
    assets: [],
  };
  const assetIds = options.assetIds === undefined
      ? fixedInput.activeAssetIds
      : fixedInput.activeAssetIds.filter((assetId) => options.assetIds!.has(assetId));
  return { extension, *assets() {
    for (const assetId of assetIds) {
      const reuseScopeRoot = createV9ControlExecutionScopeRootReuse();
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
        if (dependencyAdmissionErrors.has(assetId)) throw dependencyAdmissionErrors.get(assetId);
        // Materialize lazy reviewed fields once for this asset's helper chain.
        // Do not retain this view in metaById: decoded profiles must be released
        // after asset admission rather than accumulating across the cohort.
        const meta = { ...metaById.get(assetId)! };
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
        // The captured live-to-fallback census is operational telemetry, not
        // authority over independently dated, reviewed registry evidence.
        // Live rows still win; curated rows retain every source/scope/age gate.
        admissionPath = "reviewedStaticReserveRows";
        const reviewedReserveAdmission = resolveReviewedReserveAdmission({
          meta,
          clockSec,
          fixedInput,
          liveReserveRows: liveReserves,
        });
        const reviewedStaticReserveRows = reviewedReserveAdmission.projected;
        const reserveRows = reviewedStaticReserveRows?.rows ?? liveReserves;
        admissionPath = "reserveBoundFacts";
        const reserveBoundFacts = buildSafetyScoreV9ReserveBoundFacts(assetId, reserveRows, { clockSec, liveProvenance: fixedInput.liveReserveProvenanceMap[assetId], liveMaxAgeSec: sources.liveReserves.maxAgeSec });
        const reviewEvidence = new ReviewEvidenceBuilder(assetId, clockSec, sha256HexFromUtf8Chunks);
        admissionPath = "reserveScopeAdmissions";
        const scopedReserveAdmission = buildSafetyScoreV10ScopedReserveAdmissions(meta, fixedInput);
        const reserveScopeAdmissions = scopedReserveAdmission.admissions;
        addScopedReserveEvidence(scopedReserveAdmission, reviewEvidence);
        admissionPath = "reviewedIncidents";
        const reviewedIncidents = getSafetyScoreV9ReviewedIncidents(assetId, clockSec);
        addSafetyScoreV9IncidentEvidence(reviewEvidence, reviewedIncidents);
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
        const mechanismComponentEvidence = mechanismRiskReview && mechanismOverlayEvidence
          ? getSafetyScoreV9MechanismComponentEvidence(assetId, archetype, clockSec)
          : null;
        if (mechanismRiskReview && mechanismOverlayEvidence && mechanismComponentEvidence) {
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
          for (const component of mechanismComponentEvidence) {
            reviewEvidence.add({
              componentKeys: [`mechanism-risk-review:${component.componentKey}`],
              sourceId: `safety-score-v9.mechanism-review-overlay:${component.componentKey}`,
              reviewedAt: component.reviewedAt,
              publishedBy: "unknown",
              confidence: "manual-review",
              sources: component.sources,
              payload: component.payload,
              maxAgeSec: component.maxAgeSec,
            });
          }
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
        const assuranceFact = mechanismRiskReview?.archetype === "tbill"
          ? mechanismRiskReview.lossRecoveryDesign
          : mechanismRiskReview?.archetype === "fiat-cash" || mechanismRiskReview?.archetype === "commodity-claim"
            ? mechanismRiskReview.assuranceAndReconciliation
            : null;
        const hasGoverningComponentReview = assuranceFact?.status.observationState === "known"
          && mechanismComponentEvidence?.some((component) => component.componentKey === assuranceComponent);
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
            // An admitted explicit component governs its own quality and clock.
            // Retain the separate report diagnostically, not as a second current source.
            componentKeys: [hasGoverningComponentReview
              ? "mechanism-risk-review-history"
              : `mechanism-risk-review:${assuranceComponent}`],
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
        addReviewedStaticReserveEvidence(reviewedReserveAdmission, reviewEvidence);
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
        const supplyAdmission = buildSafetyScoreV9SupplyAdmission(
          fixedInput,
          assetId,
          meta.bridgeRouteRisk,
          {
            meta,
            transferMaterialityGeneration: options.transferMaterialityGeneration ?? null,
            ...(options.providerRowExclusionReviews === undefined ? {} : { providerRowExclusionReviews: options.providerRowExclusionReviews }),
          },
        );
        const supplyReview = supplyAdmission.review;
        const chainRows = safetyScoreV9ChainRows(fixedInput, assetId);
        const deployedChainCount = Object.keys(chainRows).length;
        admissionPath = "economicControlReview.mint";
        const mint = adaptMintReview(meta, metaById, prepared.dependency, supplyReview, reviewEvidence, clockSec);
        admissionPath = "economicControlReview.oracle";
        const oracle = adaptOracleReview(
          meta, archetype, reviewEvidence, clockSec,
          fixedInput.liveReserveProvenanceMap[assetId]?.lenderBookObservation,
        );
        admissionPath = "economicControlReview.bridge";
        const bridge = adaptBridgeReview(
          meta,
          supplyReview,
          deployedChainCount,
          reviewEvidence,
          clockSec,
          chainRows,
          supplyAdmission.censusDiagnostics,
        );
        admissionPath = "controlReview";
        const incidentControlRoute = routeSafetyScoreV9ControlIncidents(
          [...mint.controls, ...bridge.controls],
          mint.review,
          reviewedIncidents,
        );
        const laneRoutes = new Map<string, LaneRouteAuthority>();
        for (const route of meta.bridgeRouteRisk?.routes ?? []) {
          const deploymentKey = normalizeDeploymentId(route.id);
          if (deploymentKey.length === 0) continue;
          laneRoutes.set(deploymentKey, {
            rail: route.rail ?? null,
            routeClass: route.routeClass,
            providerKeys: [...(route.providerKeys ?? [])],
          });
        }
        const contributorControls = meta.bridgeRouteRisk?.controls ?? [];
        admissionPath = "reviewedIncidents";
        const negativeIncidentRead = getSafetyScoreV9NegativeIncidentReviews(assetId, clockSec,
          bridge.controls.flatMap((control) => control.scope === "global" && laneRoutes.get(control.deploymentKey)?.rail === "issuer-operated"
            ? laneContributorProviderKeys(control, contributorControls) ?? [] : []));
        const negativeIncidentReviews = negativeIncidentRead.reviews;
        admissionPath = "controlReview";
        const incidentClosureFailures: V9LaneIncidentClosureFailure[] = [];
        const controls = routeSafetyScoreV9NegativeIncidentReviews(
          incidentControlRoute.controls,
          assetId,
          clockSec,
          negativeIncidentReviews,
          reviewedIncidents,
          {
            descriptors: options.laneEmitterDescriptors ?? [],
            certificates: options.laneIncidentCertificates ?? new Map(),
            routes: laneRoutes,
            contributorControls,
            incidentClosureFailures,
            unreadableProviders: negativeIncidentRead.unreadableProviders,
          },
        ).sort((left, right) => compareText(left.controlKey, right.controlKey));
        addSafetyScoreV9NegativeIncidentEvidence(reviewEvidence, negativeIncidentReviews, controls);
        if (negativeIncidentRead.unreadableProviders.size > 0) {
          for (const [deploymentRouteKey, route] of laneRoutes) {
            const laneControls = controls.filter((control) => control.deploymentKey === deploymentRouteKey &&
              control.controlKind === "bridge" && control.incidentState === "unknown" &&
              (control.scope === "deployment" || control.scope === "global") &&
              (control.scope !== "global" || route.routeClass === "native" || route.rail === "issuer-operated"));
            if (laneControls.length === 0) continue;
            const providerKeys = route.rail === "issuer-operated"
              ? laneControls.filter((control) => control.scope === "global")
                .flatMap((control) => laneContributorProviderKeys(control, contributorControls) ?? []) : route.providerKeys;
            for (const providerKey of new Set(providerKeys)) {
              if (laneControls.every((control) => control.scope === "deployment") &&
                  !negativeIncidentReviews.some((review) => review.assetId === assetId &&
                    review.scope.kind === "provider" && review.scope.providerKey === providerKey)) continue;
              const foreignAssetIds = negativeIncidentRead.unreadableProviders.get(providerKey);
              if (foreignAssetIds !== undefined) incidentClosureFailures.push({
                deploymentRouteKey, providerKey, foreignAssetIds: [...foreignAssetIds],
                code: "provider-incident-disclosures-unreadable",
              });
            }
          }
        }
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
            supplyReview,
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
        const implementationLaunch = resolveEffectiveImplementationLaunchDate(meta, metaById, asOfDate);
        // Track-record months use UTC calendar dates, not intraday duration.
        const launchedAtSec = implementationLaunch.date === null
          ? null
          : Date.parse(`${implementationLaunch.date}T00:00:00.000Z`) / 1_000;
        admissionPath = "mechanismExitFacts";
        const mechanismExitFacts = getSafetyScoreV9MechanismExitFacts(assetId, archetype, clockSec);
        admissionPath = "routeReviews";
        const routeReviews = buildSafetyScoreV9RouteReviews(fixedInput, assetId);
        admissionPath = "retainedRoutes";
        const retainedRoutes = buildSafetyScoreV9RetainedRoutes(fixedInput, assetId);
        yield admitSafetyScoreV9ExtensionAsset({
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
                  bridge: incidentClosureFailures.length === 0 ? bridge.review : { ...bridge.review,
                    diagnostics: { ...bridge.review.diagnostics!, incidentClosureFailures } },
                }
              : null,
          accessReview,
          pegReference,
          supplyReview,
          wrapperAllocationReview,
          wrapperLocalReviews,
          allocationScopeIdentityReview: buildAllocationScopeIdentityReview(meta, clockSec),
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
        }, clockSec, reuseScopeRoot, (asset) => hydrateSafetyScoreV9ShockCoverageAsset(asset, clockSec));
      } catch (error) {
        yield quarantinedSafetyScoreV9ExtensionAsset(admitted, assetId, {
          code: "fact-build-failed",
          path: error instanceof ReviewedRegistryEntryError ? error.path : admissionPath,
          message: toErrorMessage(error),
        });
      }
    }
  } };
}
