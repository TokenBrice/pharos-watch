import { createV9EvidenceReference, createV9FactStatus, requiredV9Applicability } from "@shared/lib/safety-score-v9/evidence";
import { deriveLenderBookObservationIdentity, lenderBookAdmissionReason, lenderMarketKey } from "@shared/lib/safety-score-v9/lender-book-registry";
import { getLenderCollateralClassesRegistry } from "@shared/lib/safety-score-v9/lender-collateral-classes";
import { unknownQuality, V9_CANDIDATE_POLICY_V1 } from "@shared/lib/safety-score-v9/policy";
import { compareText, domainDigest, uniqueSorted } from "@shared/lib/safety-score-v9/primitives";
import { createV9FactGapV3 } from "@shared/lib/safety-score-v9/reasons";
import type { V9EvidenceCauseScope } from "@shared/types/safety-score-v9-causes";
import type { V1019LenderBookFact } from "@shared/types/safety-score-v9-facts";
import type { LenderBookObservation, LenderBookReason, LenderCollateralBacking, LenderCollateralResolution } from "@shared/types/safety-score-v9-lender-book";
import { SAFETY_SCORE_V9_CONSUMER_MAX_AGE_SEC } from "./consumer-freshness";
import { addEvidence, addGap, createRuntimeGapVerdict, type AssetBuildContext } from "./fact-set-context";

const RULE = "v10.19.backing.lender-collateral-book";

function scope(componentKey: string, requiredDatum = componentKey): V9EvidenceCauseScope {
  return { pillar: "backing", componentKey, factorKey: null, routeKey: null, exposureId: null, requiredDatum };
}

/** A source failure is diagnostic: it does not replace the denomination reserve status. */
function diagnosticGap(context: AssetBuildContext, args: {
  componentKey: string;
  reason: LenderBookReason;
  sourceGenerationId: string;
  contentSha256: string | null;
  observedAtSec: number;
  failedDeploymentKey?: string | null;
  attempted: boolean;
  evidenceRefIds?: readonly string[];
}): string {
  const causeScope = scope(args.componentKey);
  const runtime = args.attempted ? createRuntimeGapVerdict({
    assetId: context.asset.assetId, scope: causeScope, sourceId: "morpho-lender-book",
    sourceGenerationId: args.sourceGenerationId,
    // A future observation cannot be evidence admitted at the fixed clock. The
    // rejection occurs at this clock; original source clocks remain in the book.
    observedAtSec: args.observedAtSec > context.fixedInput.clockSec ? context.fixedInput.clockSec : args.observedAtSec,
    asOfSec: context.fixedInput.clockSec,
    producerState: args.reason === "stale" || args.reason === "accepted-source-stale" ? "stale-producer"
      : args.reason.startsWith("unsupported-") ? "unsupported-reader"
        : args.reason === "identity-mismatch" ? "config-mismatch" : "producer-failed",
    rejectionCode: args.reason, reason: args.reason, contentSha256: args.contentSha256,
  }) : undefined;
  if (runtime) addEvidence(context, runtime.evidence);
  // A stale producer verdict alone is not last-known data. Keep it missing
  // unless the retained source evidence independently exceeded its own budget.
  const stale = (args.reason === "stale" || args.reason === "accepted-source-stale") &&
    (args.evidenceRefIds ?? []).some((id) => context.evidence.get(id)?.freshness.state === "stale");
  return addGap(context, createV9FactGapV3({
    gapId: `${context.asset.assetId}:gap:${args.componentKey}`,
    reasonCode: "partial-reserve-review", ownerDomain: "backing", policyRuleId: RULE,
    observationState: stale ? "stale" : "missing",
    responsibility: runtime ? "producer-failed" : "unresearched",
    ...(runtime ? { causeProof: runtime.verdict.proof } : {}),
    causeScope, path: { kind: "local-component", componentKey: args.componentKey },
    message: `Lender-book requiredDatum=${causeScope.requiredDatum}; reason=${args.reason}; source=${args.sourceGenerationId}${args.failedDeploymentKey ? `; deployment=${args.failedDeploymentKey}` : ""}. ${args.componentKey === "lender-book-latest-attempt" ? "The latest attempt failed; any retained book keeps its original clocks and must independently pass admission." : "Existing inherited-parent behavior is retained when the book is unavailable."}`,
    evidenceRefIds: uniqueSorted([...(args.evidenceRefIds ?? []), ...(runtime ? [runtime.evidence.evidenceId] : [])]),
  }));
}

function acceptedSourceReason(bundle: LenderCollateralBacking | undefined, clockSec: number): LenderBookReason | null {
  if (!bundle) return "accepted-source-unavailable";
  if (bundle.status === "unavailable") return bundle.reason ?? "accepted-source-unavailable";
  if (bundle.publishedAtSec === null || bundle.publicationGenerationId === null ||
      bundle.policyDigest === null || bundle.evaluationBuildDigest === null ||
      bundle.maxAgeSec !== SAFETY_SCORE_V9_CONSUMER_MAX_AGE_SEC) return "accepted-source-unavailable";
  if (bundle.publishedAtSec > clockSec) return "future-dated";
  if (clockSec - bundle.publishedAtSec > SAFETY_SCORE_V9_CONSUMER_MAX_AGE_SEC) return "accepted-source-stale";
  return null;
}

/** Compile only frozen, admitted bytes. No live registry, publication or evaluator lookup. */
export function buildLenderBookFact(context: AssetBuildContext): V1019LenderBookFact | undefined {
  const policy = V9_CANDIDATE_POLICY_V1.policy.semantic.backing.lenderCollateralBook;
  const provenance = context.fixedInput.liveReserveProvenanceMap[context.asset.assetId];
  const observation: LenderBookObservation | undefined = provenance?.lenderBookObservation;
  const failure = provenance?.lenderBookObservationFailure;
  if (observation === undefined && failure === undefined && provenance?.lenderBookLatestAttemptFailure === undefined) return undefined;
  const bundle = context.fixedInput.lenderCollateralBacking;
  if (bundle && bundle.registryFingerprint !== context.fixedInput.registryFingerprint) {
    throw new Error(`Lender collateral registry fingerprint mismatch for ${context.asset.assetId}`);
  }
  const evidenceRefIds: string[] = [];
  const attemptedObservation = observation !== undefined && !(observation.status === "unavailable" &&
    (observation.reason === "missing-observation" || observation.reason === "legacy-unobserved"));
  if (attemptedObservation && observation) {
    const observedAtSec = observation.status === "ok"
      ? Math.min(observation.acquiredAtSec, ...observation.deployments.map((deployment) => deployment.pin.timestampSec))
      : observation.acquiredAtSec;
    if (observedAtSec <= context.fixedInput.clockSec) evidenceRefIds.push(addEvidence(context, createV9EvidenceReference({
      evidenceId: `${context.asset.assetId}:lender-book:${observation.contentSha256}`,
      sourceId: "morpho-lender-book", sourceGenerationId: observation.sourceGenerationId,
      disposition: "observed", observedAtSec, contentSha256: observation.contentSha256,
      maxAgeSec: policy.observationMaxAgeSec,
    }, context.fixedInput.clockSec)));
  }
  const latestAttemptFailure = provenance?.lenderBookLatestAttemptFailure;
  let latestAttemptStatus: V1019LenderBookFact["latestAttemptStatus"];
  if (latestAttemptFailure) {
    const identity = deriveLenderBookObservationIdentity(latestAttemptFailure);
    if (latestAttemptFailure.assetId !== context.asset.assetId ||
        latestAttemptFailure.contentSha256 !== identity.contentSha256 ||
        latestAttemptFailure.sourceGenerationId !== identity.sourceGenerationId ||
        latestAttemptFailure.maxAgeSec !== policy.observationMaxAgeSec ||
        latestAttemptFailure.acquiredAtSec > context.fixedInput.clockSec ||
        observation?.status !== "ok" || latestAttemptFailure.acquiredAtSec < observation.acquiredAtSec) {
      throw new Error(`Invalid retained lender-book attempt for ${context.asset.assetId}`);
    }
    const gapId = diagnosticGap(context, {
      componentKey: "lender-book-latest-attempt", reason: latestAttemptFailure.reason,
      sourceGenerationId: latestAttemptFailure.sourceGenerationId,
      contentSha256: latestAttemptFailure.contentSha256,
      observedAtSec: latestAttemptFailure.acquiredAtSec,
      failedDeploymentKey: latestAttemptFailure.failedDeploymentKey, attempted: true,
    });
    latestAttemptStatus = createV9FactStatus({
      applicability: requiredV9Applicability(RULE), observationState: "missing",
      gapIds: [gapId], evidenceRefIds: context.gaps.get(gapId)!.evidenceRefIds,
    });
  }
  const reason = failure ? "malformed" : observation
    ? lenderBookAdmissionReason(observation, context.asset.assetId, context.fixedInput.clockSec, policy)
    : bundle === undefined ? "legacy-unobserved" : "missing-observation";
  if (reason !== null) {
    // Typed unavailability is local and preserves the producer outcome. Invalid
    // admitted identities/digests instead enter the existing asset quarantine.
    if (observation?.status === "ok" && (reason === "malformed" || reason === "identity-mismatch")) {
      throw new Error(`Invalid lender book for ${context.asset.assetId}: ${reason}`);
    }
    const gapId = diagnosticGap(context, {
      componentKey: "lender-book", reason,
      sourceGenerationId: observation?.sourceGenerationId ?? (failure ? `rejected-lender-book:${failure.sourceSha256}` : context.fixedInput.sourceGeneration),
      contentSha256: observation?.contentSha256 ?? failure?.sourceSha256 ?? null,
      observedAtSec: observation?.acquiredAtSec ?? provenance?.fetchedAt ?? context.fixedInput.clockSec,
      failedDeploymentKey: observation?.status === "unavailable" ? observation.failedDeploymentKey : null,
      attempted: attemptedObservation || failure !== undefined, evidenceRefIds,
    });
    const gap = context.gaps.get(gapId)!;
    return {
      status: createV9FactStatus({ applicability: requiredV9Applicability(RULE),
        observationState: gap.observationState,
        evidenceRefIds: gap.evidenceRefIds, gapIds: [gapId] }),
      observation: observation ?? null, collaterals: [],
      ...(latestAttemptStatus ? { latestAttemptStatus, latestAttemptFailure } : {}),
    };
  }
  if (!observation || observation.status !== "ok") throw new Error("Admitted lender book must have successful deployments");
  const classRegistry = getLenderCollateralClassesRegistry();
  const sourceReason = acceptedSourceReason(bundle, context.fixedInput.clockSec);
  const collaterals: LenderCollateralResolution[] = [];
  const gapIds: string[] = [];
  let acceptedSourceStatus: V1019LenderBookFact["acceptedSourceStatus"];
  for (const deployment of observation.deployments) {
    for (const market of deployment.markets) {
      const marketKey = lenderMarketKey(deployment.chain, market.morpho, market.marketId, market.account);
      const tokenKey = `${deployment.chain}:${market.collateralToken}`;
      const classReview = market.collateralMode === "unsecured" ? undefined
        : classRegistry.get(tokenKey);
      if (classReview && Date.parse(classReview.reviewedAt) / 1000 > context.fixedInput.clockSec) {
        throw new Error(`Future lender collateral class review for ${tokenKey}`);
      }
      const collateralClass = market.collateralMode === "unsecured" ? "structured-credit" : classReview?.class ?? "other-unknown";
      let trackedAssetId = market.collateralMode === "unsecured" ? null : bundle?.tokenToAssetId[tokenKey] ?? null;
      let fallbackReason: LenderBookReason | null = market.collateralMode === "unsecured" ? null
        : trackedAssetId === context.asset.assetId ? "self-collateral"
          : trackedAssetId === null ? "unmapped-collateral" : sourceReason;
      if (trackedAssetId === context.asset.assetId) trackedAssetId = null;
      const accepted = trackedAssetId !== null && fallbackReason === null ? bundle?.byAssetId[trackedAssetId] : undefined;
      if (trackedAssetId !== null && fallbackReason === null && !accepted) fallbackReason = "accepted-card-ineligible";
      if (accepted && accepted.assetId !== trackedAssetId) throw new Error(`Accepted lender collateral row key mismatch for ${marketKey}`);
      const marketEvidenceId = addEvidence(context, createV9EvidenceReference({
        evidenceId: `${context.asset.assetId}:lender-market:${marketKey}`,
        sourceId: "morpho-lender-book", sourceGenerationId: observation.sourceGenerationId,
        disposition: "observed", observedAtSec: Math.min(observation.acquiredAtSec, deployment.pin.timestampSec),
        contentSha256: observation.contentSha256, maxAgeSec: policy.observationMaxAgeSec,
      }, context.fixedInput.clockSec));
      evidenceRefIds.push(marketEvidenceId);
      if (classReview) evidenceRefIds.push(addEvidence(context, createV9EvidenceReference({
        evidenceId: `${context.asset.assetId}:lender-collateral:${marketKey}:class:${collateralClass}`,
        sourceId: classRegistry.registry.registryId, sourceGenerationId: classRegistry.digest,
        disposition: "published", observedAtSec: Date.parse(classReview.reviewedAt) / 1000,
        publishedAtSec: Date.parse(classReview.reviewedAt) / 1000, url: classReview.sources[0]!.url,
        contentSha256: domainDigest("safety-score-v10.19.lender-collateral-class.v1", classReview),
      }, context.fixedInput.clockSec)));
      if (accepted && bundle) {
        evidenceRefIds.push(addEvidence(context, createV9EvidenceReference({
          evidenceId: `${context.asset.assetId}:lender-collateral:${marketKey}:accepted:${accepted.cardSha256}`,
          sourceId: `previous-accepted-backing:${accepted.assetId}`,
          sourceGenerationId: bundle.publicationGenerationId!, disposition: "published",
          observedAtSec: bundle.publishedAtSec!, publishedAtSec: bundle.publishedAtSec!,
          contentSha256: domainDigest("safety-score-v10.19.accepted-collateral-proxy.v1", {
            row: accepted, publicationGenerationId: bundle.publicationGenerationId, publishedAtSec: bundle.publishedAtSec,
            policyDigest: bundle.policyDigest, evaluationBuildDigest: bundle.evaluationBuildDigest,
            registryFingerprint: bundle.registryFingerprint, tokenKey,
          }), maxAgeSec: SAFETY_SCORE_V9_CONSUMER_MAX_AGE_SEC,
        }, context.fixedInput.clockSec)));
      }
      if (acceptedSourceStatus === undefined && sourceReason !== null && trackedAssetId !== null) {
        const sourceContentSha256 = bundle ? domainDigest("safety-score-v10.19.accepted-collateral-source.v1", bundle) : null;
        const sourceEvidenceRefIds: string[] = [];
        if (sourceReason === "accepted-source-stale" && bundle &&
            bundle.publishedAtSec !== null && bundle.publicationGenerationId !== null &&
            context.fixedInput.clockSec - bundle.publishedAtSec > SAFETY_SCORE_V9_CONSUMER_MAX_AGE_SEC) {
          sourceEvidenceRefIds.push(addEvidence(context, createV9EvidenceReference({
            evidenceId: `${context.asset.assetId}:lender-collateral-accepted-source:${sourceContentSha256}`,
            sourceId: "previous-accepted-backing", sourceGenerationId: bundle.publicationGenerationId,
            disposition: "published", observedAtSec: bundle.publishedAtSec, publishedAtSec: bundle.publishedAtSec,
            contentSha256: sourceContentSha256, maxAgeSec: SAFETY_SCORE_V9_CONSUMER_MAX_AGE_SEC,
          }, context.fixedInput.clockSec)));
        }
        const gapId = diagnosticGap(context, { componentKey: "lender-collateral-accepted-source", reason: sourceReason,
          sourceGenerationId: bundle?.publicationGenerationId ?? context.fixedInput.sourceGeneration,
          contentSha256: sourceContentSha256,
          observedAtSec: bundle?.publishedAtSec ?? context.fixedInput.clockSec,
          attempted: bundle !== undefined, evidenceRefIds: sourceEvidenceRefIds });
        const gap = context.gaps.get(gapId)!;
        acceptedSourceStatus = createV9FactStatus({
          applicability: requiredV9Applicability(RULE),
          observationState: gap.observationState,
          gapIds: [gapId], evidenceRefIds: gap.evidenceRefIds,
        });
      }
      const unknown = !accepted && collateralClass === "other-unknown";
      const localGapIds: string[] = [];
      if (unknown) {
        const gapId = addGap(context, createV9FactGapV3({
          gapId: `${context.asset.assetId}:gap:lender-collateral:${marketKey}`,
          reasonCode: "partial-reserve-review", ownerDomain: "backing", policyRuleId: RULE,
          observationState: "bounded-unknown", responsibility: "unresearched",
          causeScope: scope(`lender-collateral:${marketKey}`, "collateral-quality"),
          path: { kind: "local-component", componentKey: `lender-collateral:${marketKey}` },
          message: `Measured lender claim has unmapped collateral ${tokenKey}; reason=${fallbackReason ?? "unmapped-collateral"}; authored bounded-unknown class quality applies.`,
          evidenceRefIds: [marketEvidenceId],
        }));
        gapIds.push(gapId); localGapIds.push(gapId);
      }
      collaterals.push({ marketKey, collateralClass, trackedAssetId,
        quality: accepted?.backingScore ?? (collateralClass === "other-unknown" ? unknownQuality("backing", "U") : policy.classQuality[collateralClass]),
        qualitySource: accepted ? "previous-accepted-backing" : unknown ? "bounded-unknown" : "authored-class",
        fallbackReason: accepted ? null : fallbackReason,
        acceptedPublicationGenerationId: accepted ? bundle!.publicationGenerationId : null,
        sourceCause: accepted?.sourceCause ?? (unknown ? "U" : null),
        sourceGapIds: accepted ? [...accepted.sourceGapIds] : localGapIds,
      });
    }
  }
  return {
    status: createV9FactStatus({ applicability: requiredV9Applicability(RULE),
      observationState: gapIds.length ? "bounded-unknown" : "known",
      evidenceRefIds: uniqueSorted(evidenceRefIds), gapIds: uniqueSorted(gapIds) }),
    ...(acceptedSourceStatus ? { acceptedSourceStatus } : {}),
    ...(latestAttemptStatus ? { latestAttemptStatus, latestAttemptFailure } : {}),
    observation, collaterals: collaterals.sort((a, b) => compareText(a.marketKey, b.marketKey)),
  };
}
