import mechanismReviewOverlaysAsset from "@shared/data/safety-score-v9/mechanism-review-overlays-v1.json";
import {
  projectV9MechanismProfile,
  type V9MechanismProfileComponentProjection,
} from "@shared/lib/safety-score-v9/mechanism-profiles";
import { V9_CANDIDATE_POLICY_V1 } from "@shared/lib/safety-score-v9/policy";
import { compareText } from "@shared/lib/safety-score-v9/primitives";
import { admitV10ReserveReportScope, resolveV10ScopedAssuranceFragments, shouldApplyV10ReserveReportScope } from "@shared/lib/safety-score-v9/reserve-scope";
import { normalizeDeploymentId } from "@shared/types/deployment-id";
import { parseIsoDateOrUtcInstantSec, reviewAdmissionSec } from "@shared/types/date-primitives";
import type { ProofOfReservesLatestReport, StablecoinMeta } from "@shared/types/core";
import {
  V9MechanismRiskReviewSchema,
  type V9MechanismFactV1,
  type V9MechanismQualityLevel,
  type V9MechanismRiskReview,
} from "@shared/types/safety-score-v9-backing";
import type { V9FactStatusV2 } from "@shared/types/safety-score-v9-facts";
import {
  SafetyScoreV9MechanismReviewOverlayEnvelopeSchema,
  SafetyScoreV9MechanismReviewOverlaySchema,
  type SafetyScoreV9MechanismReviewOverlay,
} from "@shared/types/safety-score-v9-mechanism-overlays";
import { MechanismArchetypeReviewSchema } from "@shared/types/stablecoin-meta-primitives";
import { isoDateStartSec, requiredStatus, notApplicableStatus } from "./extension-shared";
import { V9_MECHANISM_FIELDS, type V9SimpleReview } from "@shared/lib/safety-score-v9/mechanism-fields";
import type { SafetyScoreV9CompilerInput } from "./native-input";
import { canonicalizeReviewedRegistryDigest, createReviewedAssetRegistry, reviewedRegistryEnvelopeDigest } from "@shared/lib/safety-score-v9/reviewed-registry";

type MechanismMeta = Pick<
  StablecoinMeta,
  "id" | "reserves" | "reserveReview" | "custodyProfile" | "proofOfReserves"
  | "mechanismArchetype" | "mechanismArchetypeReview"
  | "contracts"
>;

const MECHANISM_POLICY_RULE_ID = "v9.backing.mechanism-review";

function status(observationState: V9FactStatusV2["observationState"], componentKey: string): V9FactStatusV2 {
  return requiredStatus(
    MECHANISM_POLICY_RULE_ID, observationState, `mechanism:${componentKey}`,
    [`extension-evidence:mechanism:${componentKey}`],
  );
}

function boundedFact(componentKey: string, hasEvidence: boolean): V9MechanismFactV1 {
  return {
    status: status(hasEvidence ? "bounded-unknown" : "missing", componentKey),
    quality: null,
    failureDomains: [],
  };
}

function unsupportedFact(componentKey: string): V9MechanismFactV1 {
  return {
    status: status("unsupported", componentKey),
    quality: null,
    failureDomains: [],
  };
}

function knownFact(componentKey: string, quality: V9MechanismQualityLevel): V9MechanismFactV1 {
  return { status: status("known", componentKey), quality, failureDomains: [] };
}

function notApplicableFact(componentKey: string, rationale: string): V9MechanismFactV1 {
  return {
    status: notApplicableStatus(
      MECHANISM_POLICY_RULE_ID, rationale, [`extension-evidence:mechanism:${componentKey}`],
    ),
    quality: null,
    failureDomains: [],
  };
}

/**
 * Quality of the assurance-and-reconciliation component from the reviewed
 * latest proof-of-reserves report. The tiers restate the report's own
 * assurance method; they do not add judgment beyond the recorded review.
 */
function assuranceQuality(report: ProofOfReservesLatestReport): V9MechanismQualityLevel {
  if (report.confidence === "unknown") return "limited";
  if (report.assuranceMethod === "audit" || report.assuranceMethod === "examination") {
    return report.scope === "assets-and-liabilities" ? "strong" : "adequate";
  }
  if (
    report.assuranceMethod === "attestation" ||
    report.assuranceMethod === "review" ||
    report.assuranceMethod === "agreed-upon-procedures"
  ) {
    return report.scope === "assets-and-liabilities" ? "adequate" : "limited";
  }
  if (report.assuranceMethod === "onchain-proof") return "adequate";
  return "weak";
}

function scoringReportScope(fixedInput: Readonly<SafetyScoreV9CompilerInput>, meta: MechanismMeta) {
  const report = meta.proofOfReserves?.latestReport;
  if (!report?.coverage) return null;
  const partition = fixedInput.safetyScoreV9SupplyAttributionById[meta.id];
  const admission = admitV10ReserveReportScope({
    report, deploymentRefs: (meta.contracts ?? []).map(row => normalizeDeploymentId(`${row.chain}:${row.address}`)),
    clockSec: fixedInput.clockSec, policy: V9_CANDIDATE_POLICY_V1.policy,
    currentPartition: partition?.model === "reviewed-economic-deployment-partition-v1" ? partition : null,
    baseInputGenerationId: fixedInput.baseInputGenerationId,
  });
  return shouldApplyV10ReserveReportScope(report, admission) ? admission : null;
}

function assuranceFact(
  fixedInput: Readonly<SafetyScoreV9CompilerInput>,
  meta: MechanismMeta,
): V9MechanismFactV1 {
  const report = meta.proofOfReserves?.latestReport;
  const admission = scoringReportScope(fixedInput, meta);
  if (report && admission) {
    const quality = V9_CANDIDATE_POLICY_V1.policy.semantic.backing.reserveScope.financialMethodQuality[report.assuranceMethod];
    const fact = boundedFact("assurance-and-reconciliation", true);
    if (!admission || quality == null) return fact;
    const fragments = resolveV10ScopedAssuranceFragments(admission, quality);
    if (fragments.length === 0) return fact;
    return { ...fact, scopedAssessments: fragments.filter(row => row.share > 0).map(row => ({
      scopeId: row.scopeId, share: row.share, quality: row.quality,
      status: status(row.quality === null ? "bounded-unknown" : "known", "assurance-and-reconciliation"),
    })) };
  }
  if (fixedInput.liveReserveProvenanceMap[meta.id]?.reserveObservation != null ||
    meta.reserveReview?.observations?.some(row => row.kind === "onchain-observation")) {
    if (report?.assuranceMethod === "onchain-proof" || !report) return boundedFact("assurance-and-reconciliation", true);
  }
  if (
    !report?.periodEnd ||
    !report.publishedAt ||
    report.assuranceMethod === "unknown" ||
    report.scope === "unknown"
  ) {
    return boundedFact("assurance-and-reconciliation", meta.proofOfReserves !== undefined);
  }
  const reportPeriodEndSec = isoDateStartSec(
    report.periodEnd,
    fixedInput.clockSec,
    `${meta.id}:assurance-report-period-end`,
  );
  if (
    fixedInput.clockSec - reportPeriodEndSec >
    V9_CANDIDATE_POLICY_V1.policy.semantic.evidence.evidenceExpiry.assuranceReportMaxAgeSec
  ) {
    return {
      status: status("stale", "assurance-and-reconciliation"),
      quality: null,
      failureDomains: [],
    };
  }
  return knownFact("assurance-and-reconciliation", assuranceQuality(report));
}

function hasReserveEvidence(fixedInput: Readonly<SafetyScoreV9CompilerInput>, meta: MechanismMeta): boolean {
  return (
    (fixedInput.liveReserveMap[meta.id] ?? []).length > 0 ||
    (meta.reserves?.length ?? 0) > 0 ||
    meta.reserveReview !== undefined
  );
}

function buildSimpleReview(
  fixedInput: Readonly<SafetyScoreV9CompilerInput>,
  meta: MechanismMeta,
  archetype: string,
): V9MechanismRiskReview | null {
  const residualFamily = archetype === "ucits-trs-fund" || archetype === "shared-reserve" || archetype === "protocol-position";
  if (!residualFamily && archetype !== "fiat-cash" && archetype !== "commodity-claim" && archetype !== "tbill") return null;
  const reserves = !residualFamily && hasReserveEvidence(fixedInput, meta);
  const custody = reserves || meta.custodyProfile !== undefined;
  if (!residualFamily && !reserves && !meta.proofOfReserves && (archetype === "tbill" || !custody)) return null;
  const review: Record<string, unknown> & { archetype: string } = { archetype };
  for (const [key, field] of V9_MECHANISM_FIELDS[archetype].components) {
    // These shortcuts restate existing evidence only; no compiler-derived
    // physical delivery terms or assurance for the native residual families.
    if (field === "assuranceAndReconciliation") {
      review[field] = assuranceFact(fixedInput, meta);
      continue;
    }
    if (archetype === "tbill" && field === "lossRecoveryDesign") {
      review[field] = scoringReportScope(fixedInput, meta) !== null ? boundedFact(key, true) : assuranceFact(fixedInput, meta);
      continue;
    }
    const hasEvidence = residualFamily || (field === "physicalRedemption" ? false
      : field === "custodyContinuity" ? custody
      // Any live reserve slice already makes `reserves` true.
      : field === "durationAndLiquidity" ? reserves
      : reserves || meta.proofOfReserves !== undefined);
    review[field] = boundedFact(key, hasEvidence);
  }
  return residualFamily ? V9MechanismRiskReviewSchema.parse(review) : review as V9SimpleReview;
}

export type MechanismReviewOverlay = SafetyScoreV9MechanismReviewOverlay;
export const MechanismReviewOverlaySchema = SafetyScoreV9MechanismReviewOverlaySchema;


function kebabCase(value: string): string {
  return value.replace(/[A-Z]/g, (char) => `-${char.toLowerCase()}`);
}

function profileComponentFact(
  componentKey: string,
  component: V9MechanismProfileComponentProjection,
): V9MechanismFactV1 {
  const aggregate = component.observationState === "known" && component.quality !== null
    ? knownFact(componentKey, component.quality)
    : component.observationState === "unsupported"
      ? unsupportedFact(componentKey)
      : boundedFact(componentKey, component.observationState === "bounded-unknown");
  if (component.unavailableFacts.length === 0) return aggregate;
  return {
    ...aggregate,
    constraints: [
      ...(component.quality === null ? [] : [{
        factKey: component.supportedFactKeys.join("+"),
        quality: component.quality,
        status: status("known", `${componentKey}:supported`),
      }]),
      ...component.unavailableFacts.map(({ factKey, disposition }) => ({
        factKey,
        quality: null,
        status: status(disposition === "issuer-undisclosed" ? "bounded-unknown"
          : disposition === "method-unsupported" ? "unsupported" : "missing", `${componentKey}:${factKey}`),
      })),
    ],
  };
}

export function expandOverlayReview(
  overlay: MechanismReviewOverlay,
  fallbackReview?: V9MechanismRiskReview | null,
  clockSec?: number,
): V9MechanismRiskReview {
  const profileProjection =
    overlay.profileReview === undefined ? null : projectV9MechanismProfile(overlay.profileReview);
  const { components: componentFields, metrics: metricKeys } = V9_MECHANISM_FIELDS[overlay.archetype];
  const projectedComponents = profileProjection?.components ?? null;
  const components = projectedComponents ?? overlay.components;
  const metrics = profileProjection?.metrics ?? overlay.metrics;
  for (const key of Object.keys(components)) {
    if (!componentFields.some(([, field]) => field === key)) {
      throw new Error(`Unknown ${overlay.archetype} mechanism component in overlay ${overlay.assetId}: ${key}`);
    }
  }
  for (const key of metricKeys) {
    if (!(key in metrics)) {
      throw new Error(`Overlay ${overlay.assetId} is missing required ${overlay.archetype} metric: ${key}`);
    }
  }
  for (const key of Object.keys(metrics)) {
    if (!(metricKeys as readonly string[]).includes(key)) {
      throw new Error(`Unknown ${overlay.archetype} mechanism metric in overlay ${overlay.assetId}: ${key}`);
    }
  }
  for (const key of Object.keys(overlay.metricApplicability ?? {})) {
    if (!(metricKeys as readonly string[]).includes(key)) {
      throw new Error(
        `Unknown ${overlay.archetype} mechanism metric applicability in overlay ${overlay.assetId}: ${key}`,
      );
    }
  }
  const fallbackComponents =
    fallbackReview && fallbackReview.archetype === overlay.archetype
      ? (fallbackReview as unknown as Record<string, V9MechanismFactV1>)
      : null;
  const review: Record<string, unknown> = { archetype: overlay.archetype, ...metrics };
  const measurement = overlay.collateralizationMeasurement;
  review.collateralizationMeasurement = measurement
    ? {
        ratio: measurement.ratio,
        measuredAt: overlay.reviewedAt,
        measurementId: measurement.measurementId,
        sourceUrl: measurement.sourceUrl,
        status: {
          ...status("known", "collateralization-ratio"),
          evidenceRefIds: [`extension-evidence:mechanism:collateralization:${measurement.measurementId}`],
        },
      }
    : null;
  const partialMetricArchetypes = ["cdp", "synthetic-delta-neutral", "rwa-credit-fund"] as const;
  if ((partialMetricArchetypes as readonly string[]).includes(overlay.archetype)) {
    const metricApplicability: Record<string, unknown> = {};
    for (const metricKey of metricKeys) {
      const value = metrics[metricKey];
      const applicability = overlay.metricApplicability?.[metricKey] ?? { state: "measured" as const };
      if (applicability.state === "measured" && value == null) {
        throw new Error(`Overlay ${overlay.assetId} has measured ${metricKey} without a numeric value`);
      }
      if (applicability.state !== "measured" && value !== null) {
        throw new Error(`Overlay ${overlay.assetId} has ${applicability.state} ${metricKey} with a numeric value`);
      }
      metricApplicability[metricKey] =
        applicability.state === "measured"
          ? { state: "measured" }
          : {
              state: applicability.state,
              rationale: applicability.rationale,
              evidenceRefIds: [`extension-evidence:mechanism:${kebabCase(metricKey)}`],
            };
    }
    review.metricApplicability = metricApplicability;
  } else if (Object.values(metrics).some((value) => value === null)) {
    throw new Error(`Only CDP, synthetic-delta-neutral, and rwa-credit-fund overlays support null metrics (${overlay.assetId})`);
  }
  if (overlay.archetype === "synthetic-delta-neutral") {
    review.venueShares = overlay.venueShares ?? [];
  }
  for (const [componentKey, componentField] of componentFields) {
    const projected = projectedComponents?.[componentField];
    if (projected !== undefined) {
      review[componentField] = profileComponentFact(componentKey, projected);
      continue;
    }
    const curated = overlay.components[componentField];
    if (curated?.review && clockSec !== undefined && !isMechanismOverlayCurrent(curated.review, clockSec)) {
      const reviewSec = parseIsoDateOrUtcInstantSec(curated.review.reviewedAt);
      review[componentField] = clockSec < reviewSec
        ? boundedFact(componentKey, false)
        : clockSec < reviewAdmissionSec(curated.review.reviewedAt)
          ? unsupportedFact(componentKey)
          : { ...boundedFact(componentKey, true), status: status("stale", componentKey) };
      continue;
    }
    // A component the curated review does not evidence keeps the built
    // review's fact when one exists (e.g. PoR-derived assurance), otherwise
    // stays bounded-unknown; serial mechanism components are never published
    // as missing. A curated `unavailable` stays bounded-unknown and scores
    // exactly like an unreviewed one; its reviewed rationale and source travel
    // separately through
    // `getSafetyScoreV9MechanismReviewedUnavailableComponents` because the
    // required applicability of a bounded fact cannot carry a rationale.
    review[componentField] = curated
      ? !("applicability" in curated) || curated.applicability === "measured"
        ? knownFact(componentKey, curated.quality)
        : curated.applicability === "not-applicable"
          ? notApplicableFact(componentKey, curated.rationale)
          : boundedFact(componentKey, true)
      : (fallbackComponents?.[componentField] ?? boundedFact(componentKey, true));
  }
  return V9MechanismRiskReviewSchema.parse(review);
}

const mechanismEnvelope = SafetyScoreV9MechanismReviewOverlayEnvelopeSchema.parse(mechanismReviewOverlaysAsset);
// Canonicalization is digest-only: do not retain its duplicate registry graph.
export const SAFETY_SCORE_V9_MECHANISM_REVIEW_OVERLAYS_DIGEST = reviewedRegistryEnvelopeDigest(
  "safety-score-v9.mechanism-review-overlays.v1", "overlays",
  canonicalizeReviewedRegistryDigest(mechanismEnvelope, {}, {
    "overlays.*.venueShares.*.failureDomains": [],
  }, [
    "overlays.*.collateralizationMeasurement.measurementId",
    "overlays.*.collateralizationMeasurement.rationale",
  ]),
);

const MECHANISM_REVIEW_OVERLAYS = createReviewedAssetRegistry({
  rows: mechanismEnvelope.overlays, schema: SafetyScoreV9MechanismReviewOverlaySchema, path: "mechanismReviews.overlays",
});

// Reviewed claims expire from their original evidence pin. Date-only reviews
// wait until their UTC day has elapsed; exact UTC instants admit immediately.
// Invalid or expired reviews retain the conservative compiler path (VER2-004).
const MECHANISM_OVERLAY_MAX_AGE_SEC =
  V9_CANDIDATE_POLICY_V1.policy.semantic.evidence.evidenceExpiry.mechanismOverlayMaxAgeSec;
const DAY_SEC = 86_400;

export function isMechanismOverlayCurrent(overlay: Pick<MechanismReviewOverlay, "reviewedAt">, clockSec: number): boolean {
  const reviewedAtSec = parseIsoDateOrUtcInstantSec(overlay.reviewedAt);
  return clockSec >= reviewAdmissionSec(overlay.reviewedAt)
    && reviewedAtSec + MECHANISM_OVERLAY_MAX_AGE_SEC > clockSec;
}

/** A family label, inherited ticker, or reserve total cannot establish a holder claim. */
export function hasAdmittedSafetyScoreV9NativeFamily(
  meta: MechanismMeta,
  archetype: string,
  clockSec: number,
): boolean {
  if (archetype !== "ucits-trs-fund" && archetype !== "shared-reserve" && archetype !== "protocol-position") {
    return true;
  }
  const parsed = MechanismArchetypeReviewSchema.safeParse(meta.mechanismArchetypeReview);
  if (!parsed.success || parsed.data.disposition !== "resolved" || meta.mechanismArchetype !== archetype) {
    return false;
  }
  const reviewedAtSec = Date.parse(`${parsed.data.reviewedAt}T00:00:00.000Z`) / 1_000;
  return reviewedAtSec + DAY_SEC <= clockSec && reviewedAtSec + MECHANISM_OVERLAY_MAX_AGE_SEC > clockSec;
}


function currentMechanismOverlay(assetId: string, archetype: string, clockSec: number): MechanismReviewOverlay | null {
  const overlay = MECHANISM_REVIEW_OVERLAYS.get(assetId);
  return overlay && overlay.archetype === archetype && isMechanismOverlayCurrent(overlay, clockSec) ? overlay : null;
}

export function getSafetyScoreV9MechanismReviewGapDisposition(
  assetId: string,
  archetype: string,
  clockSec: number,
): {
  responsibility: "method-unsupported";
  rationale: string;
  componentKeys: string[];
} | null {
  const overlay = MECHANISM_REVIEW_OVERLAYS.get(assetId);
  if (!overlay || overlay.archetype !== archetype) return null;
  const componentKeys = Object.entries(overlay.components).filter(([, component]) => {
    const reviewedAt = component.review?.reviewedAt ?? overlay.reviewedAt;
    const reviewedAtSec = parseIsoDateOrUtcInstantSec(reviewedAt);
    return reviewedAtSec <= clockSec && clockSec < reviewAdmissionSec(reviewedAt);
  }).map(([key]) => key).sort();
  if (componentKeys.length === 0) return null;
  return {
    responsibility: "method-unsupported",
    rationale: "A mechanism component review exists, but the exact admission policy cannot use a date-only review until its UTC day has elapsed.",
    componentKeys,
  };
}

export interface V9MechanismReviewedUnavailableComponent {
  /** Camel-case review field, matching the emitted `mechanism-review:<key>` gap. */
  componentKey: string;
  rationale: string;
  sourceUrl: string;
  reviewedAt: string;
  searchedSurfaces: string[];
}

/**
 * Dated typed-overlay findings of scoped nondisclosure, with original sources
 * and rationale. These are historical research inputs, not current-cause
 * assertions; the fact compiler resolves each exact component separately.
 * Dated unavailable findings survive research expiry as history. Cause admission
 * independently enforces the captured day and 365-day research window; expired
 * research never refreshes a positive mechanism review or proves current C.
 */
export function getSafetyScoreV9MechanismReviewedUnavailableComponents(
  assetId: string,
  archetype: string,
  clockSec: number,
): V9MechanismReviewedUnavailableComponent[] {
  const overlay = MECHANISM_REVIEW_OVERLAYS.get(assetId);
  if (!overlay || overlay.archetype !== archetype ||
      parseIsoDateOrUtcInstantSec(overlay.reviewedAt) > clockSec) return [];
  // Mirrors `expandOverlayReview`: a projected profile component wins over the
  // curated row, so its adjudication never reaches a fact.
  const projectedComponents =
    overlay.profileReview === undefined ? null : projectV9MechanismProfile(overlay.profileReview).components;
  const rows: V9MechanismReviewedUnavailableComponent[] = [];
  for (const [componentField, curated] of Object.entries(overlay.components)) {
    if (projectedComponents?.[componentField] !== undefined) continue;
    if (!("applicability" in curated) || curated.applicability !== "unavailable") continue;
    const reviewedAt = curated.review?.reviewedAt ?? overlay.reviewedAt;
    if (parseIsoDateOrUtcInstantSec(reviewedAt) > clockSec) continue;
    rows.push({
      componentKey: componentField,
      rationale: curated.rationale,
      sourceUrl: curated.sourceUrl,
      reviewedAt,
      searchedSurfaces: (curated.review?.sources ?? overlay.sources).map((source) => source.url),
    });
  }
  return rows.sort((left, right) => compareText(left.componentKey, right.componentKey));
}

export function getSafetyScoreV9MechanismOverlayEvidence(
  assetId: string,
  archetype: string,
  clockSec: number,
  options: { history?: boolean } = {},
): {
  reviewedAt: string;
  sources: MechanismReviewOverlay["sources"];
  payload: MechanismReviewOverlay;
  maxAgeSec: number;
} | null {
  const historical = options.history ? MECHANISM_REVIEW_OVERLAYS.get(assetId) : null;
  const overlay = options.history
    ? historical && historical.archetype === archetype &&
      reviewAdmissionSec(historical.reviewedAt) <= clockSec ? historical : null
    : currentMechanismOverlay(assetId, archetype, clockSec);
  return overlay
    ? {
        reviewedAt: overlay.reviewedAt,
        sources: overlay.sources,
        payload: overlay,
        maxAgeSec: MECHANISM_OVERLAY_MAX_AGE_SEC,
      }
    : null;
}

/** Bind each independently reviewed component without renewing metrics or siblings. */
export function getSafetyScoreV9MechanismComponentEvidence(
  assetId: string,
  archetype: string,
  clockSec: number,
) {
  const overlay = currentMechanismOverlay(assetId, archetype, clockSec);
  if (!overlay) return [];
  return Object.entries(overlay.components).flatMap(([componentKey, component]) => {
    if (!component.review || reviewAdmissionSec(component.review.reviewedAt) > clockSec) return [];
    return [{
      componentKey,
      reviewedAt: component.review.reviewedAt,
      sources: component.review.sources,
      payload: component,
      maxAgeSec: MECHANISM_OVERLAY_MAX_AGE_SEC,
    }];
  });
}

export interface V9MechanismExitFactProjection {
  factKey: "physical-redemption" | "protocol-redemption";
  disposition: "supported" | "issuer-undisclosed" | "integration-missing" | "method-unsupported";
  quality: V9MechanismQualityLevel | null;
}

/**
 * The `physical-redemption` mechanism-exit fact for a commodity claim, derived
 * from the SAME curated `physicalRedemption` component the backing pillar
 * grades. v9.14 promotes physical redemption to a first-class backing
 * component; the Exit pillar keeps consuming it only to explain a missing
 * runtime route (`no-viable-exit-path` becomes the bounded
 * `missing-runtime-route-evidence`), exactly as it did while the fact lived in
 * the `allocated-commodity-claim` profile's `exitFacts`. Deriving rather than
 * re-declaring is the anti-double-count rule: one curated statement, two
 * readers, no way for a curator to assert a strong backing redemption and a
 * different exit disposition.
 *
 * A `not-applicable` component projects nothing: a structurally absent
 * redemption right is not evidence that an exit route exists, so it must not
 * buy the bounded reason substitution. An uncurated component projects nothing
 * either — the compiler fallback has no redemption evidence to state.
 */
export function deriveCommodityClaimMechanismExitFacts(
  overlay: MechanismReviewOverlay,
): V9MechanismExitFactProjection[] {
  const component = overlay.components.physicalRedemption;
  if (component === undefined) return [];
  if (!("applicability" in component) || component.applicability === "measured") {
    return [{ factKey: "physical-redemption", disposition: "supported", quality: component.quality }];
  }
  if (component.applicability === "unavailable") {
    return [{ factKey: "physical-redemption", disposition: "issuer-undisclosed", quality: null }];
  }
  return [];
}

export function getSafetyScoreV9MechanismExitFacts(
  assetId: string,
  archetype: string,
  clockSec: number,
): V9MechanismExitFactProjection[] {
  const overlay = currentMechanismOverlay(assetId, archetype, clockSec);
  if (overlay === null) return [];
  if (overlay.archetype === "commodity-claim") {
    const component = overlay.components.physicalRedemption;
    if (component?.review && !isMechanismOverlayCurrent(component.review, clockSec)) return [];
    return deriveCommodityClaimMechanismExitFacts(overlay);
  }
  if (overlay.profileReview === undefined) return [];
  const projection = projectV9MechanismProfile(overlay.profileReview);
  // Every mechanism profile projects exactly one exit fact.
  return Object.entries(projection.exitFacts)
    .map(([factKey, fact]) => ({
      factKey: kebabCase(factKey) as "physical-redemption" | "protocol-redemption",
      disposition: fact.disposition,
      quality: fact.disposition === "supported" ? fact.quality : null,
    }));
}

/**
 * Builds the conservative mechanism risk review the exact evidence supports.
 * A curated overlay (schema-validated, source-cited) takes precedence for the
 * archetypes whose review requires measured mechanism ratios (CDP, synthetic,
 * algorithmic, RWA credit); an overlay whose archetype disagrees with the
 * resolved archetype is ignored rather than silently applied. Components with
 * dated reserve/assurance evidence are bounded-unknown at the policy's
 * bounded quality; only the assurance component claims a reviewed quality,
 * restated from the recorded proof-of-reserves report.
 */
export function buildSafetyScoreV9MechanismReview(
  fixedInput: Readonly<SafetyScoreV9CompilerInput>,
  meta: MechanismMeta,
  archetype: string,
): V9MechanismRiskReview | null {
  if (!hasAdmittedSafetyScoreV9NativeFamily(meta, archetype, fixedInput.clockSec)) return null;
  const overlay = currentMechanismOverlay(meta.id, archetype, fixedInput.clockSec);
  if (overlay) {
    const fallbackReview = buildSimpleReview(fixedInput, meta, archetype);
    const expanded = expandOverlayReview(overlay, fallbackReview, fixedInput.clockSec);
    const report = meta.proofOfReserves?.latestReport;
    const technicalObservation = fixedInput.liveReserveProvenanceMap[meta.id]?.reserveObservation?.kind === "onchain-observation" ||
      meta.reserveReview?.observations?.some(row => row.kind === "onchain-observation");
    const appliesReportScope = scoringReportScope(fixedInput, meta) !== null;
    if (appliesReportScope || (technicalObservation && report?.assuranceMethod === "onchain-proof")) {
      if (expanded.archetype === "fiat-cash" || expanded.archetype === "commodity-claim") {
        expanded.assuranceAndReconciliation = assuranceFact(fixedInput, meta);
      }
      if (expanded.archetype === "tbill" && appliesReportScope) {
        expanded.lossRecoveryDesign = boundedFact("loss-recovery-design", true);
      }
    }
    return expanded;
  }
  return buildSimpleReview(fixedInput, meta, archetype);
}
