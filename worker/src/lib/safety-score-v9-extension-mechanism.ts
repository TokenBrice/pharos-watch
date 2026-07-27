import { z } from "zod";
import mechanismReviewOverlaysAsset from "@shared/data/safety-score-v9/mechanism-review-overlays-v1.json";
import {
  V9MechanismProfileReviewSchema,
  projectV9MechanismProfile,
  type V9MechanismProfileComponentProjection,
} from "@shared/lib/safety-score-v9/mechanism-profiles";
import { sha256Hex } from "@shared/lib/sha256";
import { stableJsonStringifyV1 } from "@shared/lib/stable-json";
import type { ProofOfReservesLatestReport, StablecoinMeta } from "@shared/types/core";
import {
  V9MechanismRiskReviewSchema,
  type V9FiatCashMechanismRiskReview,
  type V9MechanismFactV1,
  type V9MechanismQualityLevel,
  type V9MechanismRiskReview,
  type V9TbillMechanismRiskReview,
} from "@shared/types/safety-score-v9-backing";
import type { V9FactStatusV2 } from "@shared/types/safety-score-v9-facts";
import type { ReportCardsFixedInput } from "./report-cards-fixed-input";

type MechanismMeta = Pick<StablecoinMeta, "id" | "reserves" | "reserveReview" | "custodyProfile" | "proofOfReserves">;

const MECHANISM_POLICY_RULE_ID = "v9.backing.mechanism-review";

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function status(observationState: V9FactStatusV2["observationState"], componentKey: string): V9FactStatusV2 {
  // The fact-set compiler rebinds these statuses to the research-overlay
  // evidence reference; the extension-level ids only carry the fact state.
  const requiresEvidence =
    observationState === "known" || observationState === "stale" || observationState === "bounded-unknown";
  return {
    applicability: { state: "required", policyRuleId: MECHANISM_POLICY_RULE_ID, rationale: null, gapId: null },
    observationState,
    evidenceRefIds: requiresEvidence ? [`extension-evidence:mechanism:${componentKey}`] : [],
    gapIds: observationState === "known" ? [] : [`extension-gap:mechanism:${componentKey}`],
  };
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
    status: {
      applicability: {
        state: "not-applicable",
        policyRuleId: MECHANISM_POLICY_RULE_ID,
        rationale,
        gapId: null,
      },
      observationState: "known",
      evidenceRefIds: [`extension-evidence:mechanism:${componentKey}`],
      gapIds: [],
    },
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

function assuranceFact(meta: MechanismMeta): V9MechanismFactV1 {
  const report = meta.proofOfReserves?.latestReport;
  if (report) return knownFact("assurance-and-reconciliation", assuranceQuality(report));
  return boundedFact("assurance-and-reconciliation", meta.proofOfReserves !== undefined);
}

function hasReserveEvidence(fixedInput: Readonly<ReportCardsFixedInput>, meta: MechanismMeta): boolean {
  return (
    (fixedInput.liveReserveMap[meta.id] ?? []).length > 0 ||
    (meta.reserves?.length ?? 0) > 0 ||
    meta.reserveReview !== undefined
  );
}

function buildFiatCashReview(
  fixedInput: Readonly<ReportCardsFixedInput>,
  meta: MechanismMeta,
): V9FiatCashMechanismRiskReview | null {
  const reserves = hasReserveEvidence(fixedInput, meta);
  const custody = reserves || meta.custodyProfile !== undefined;
  if (!reserves && !custody && !meta.proofOfReserves) return null;
  return {
    archetype: "fiat-cash",
    claimAndSegregation: boundedFact("claim-and-segregation", reserves || meta.proofOfReserves !== undefined),
    custodyContinuity: boundedFact("custody-continuity", custody),
    assuranceAndReconciliation: assuranceFact(meta),
  };
}

function buildTbillReview(
  fixedInput: Readonly<ReportCardsFixedInput>,
  meta: MechanismMeta,
): V9TbillMechanismRiskReview | null {
  const reserves = hasReserveEvidence(fixedInput, meta);
  if (!reserves && !meta.proofOfReserves) return null;
  const maturityEvidence = (fixedInput.liveReserveMap[meta.id] ?? []).some(
    (slice) => slice.maturityDaysMax != null || slice.liquidityHorizon != null,
  );
  return {
    archetype: "tbill",
    fundClaimAndSeniority: boundedFact("fund-claim-and-seniority", reserves || meta.proofOfReserves !== undefined),
    navValuation: boundedFact("nav-valuation", reserves || meta.proofOfReserves !== undefined),
    durationAndLiquidity: boundedFact("duration-and-liquidity", maturityEvidence || reserves),
    lossRecoveryDesign: assuranceFact(meta),
  };
}

const OverlayMeasuredComponentSchema = z
  .object({
    quality: z.enum(["strong", "adequate", "limited", "weak", "failed"]),
  })
  .strict();

const OverlayComponentSchema = z.union([
  // Legacy rows predate explicit applicability; a numeric quality always
  // meant that the component was measured/reviewed.
  OverlayMeasuredComponentSchema,
  z
    .object({
      applicability: z.literal("measured"),
      quality: z.enum(["strong", "adequate", "limited", "weak", "failed"]),
    })
    .strict(),
  z
    .object({
      applicability: z.literal("not-applicable"),
      rationale: z.string().trim().min(1),
      sourceUrl: z.string().url(),
    })
    .strict(),
]);

const OverlayMetricApplicabilitySchema = z.discriminatedUnion("state", [
  z.object({ state: z.literal("measured") }).strict(),
  z
    .object({
      state: z.literal("not-applicable"),
      rationale: z.string().trim().min(1),
      sourceUrl: z.string().url(),
    })
    .strict(),
  // Owner ruling 2026-07-27 (wave-7 D2): the metric structurally applies but
  // the issuer publishes no measurable value. Admitted for the sdn/rwa
  // archetypes only; the linked structural penalty signal keeps firing.
  z
    .object({
      state: z.literal("unavailable"),
      rationale: z.string().trim().min(1),
      sourceUrl: z.string().url(),
    })
    .strict(),
]);

const OverlaySourceSchema = z.object({ label: z.string().min(1), url: z.string().url() }).strict();

export const MechanismReviewOverlaySchema = z
  .object({
    assetId: z.string().min(1),
    archetype: z.enum(["cdp", "synthetic-delta-neutral", "algorithmic", "rwa-credit-fund", "fiat-cash", "tbill"]),
    reviewedAt: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    sources: z.array(OverlaySourceSchema).min(1),
    notes: z.string().min(1),
    metrics: z.record(z.string(), z.number().finite().nullable()),
    profileReview: V9MechanismProfileReviewSchema.optional(),
    metricApplicability: z.record(z.string(), OverlayMetricApplicabilitySchema).optional(),
    analogousMetrics: z.record(z.string(), z.number().finite()).optional(),
    venueShares: z
      .array(
        z
          .object({
            venueKey: z.string().min(1),
            share: z.number().min(0).max(1),
            failureDomains: z.array(z.object({ kind: z.string().min(1), key: z.string().min(1) }).strict()).default([]),
          })
          .strict(),
      )
      .optional(),
    components: z.record(z.string(), OverlayComponentSchema),
  })
  .strict()
  .superRefine((overlay, ctx) => {
    if (overlay.profileReview !== undefined) {
      const projection = projectV9MechanismProfile(overlay.profileReview);
      if (projection.archetype !== overlay.archetype) {
        ctx.addIssue({
          code: "custom",
          path: ["profileReview", "profile"],
          message: `Profile ${overlay.profileReview.profile} is incompatible with ${overlay.archetype}`,
        });
      }
      if (Object.keys(overlay.metrics).length > 0 || Object.keys(overlay.components).length > 0) {
        ctx.addIssue({
          code: "custom",
          path: ["profileReview"],
          message: "Profile-driven overlays cannot duplicate projected metrics or components",
        });
      }
    }
    const sourceUrls = new Set(overlay.sources.map((source) => source.url));
    for (const [componentKey, component] of Object.entries(overlay.components)) {
      if (
        "applicability" in component &&
        component.applicability === "not-applicable" &&
        !sourceUrls.has(component.sourceUrl)
      ) {
        ctx.addIssue({
          code: "custom",
          path: ["components", componentKey, "sourceUrl"],
          message: "Not-applicable component sourceUrl must match an overlay source",
        });
      }
    }
    for (const [metricKey, applicability] of Object.entries(overlay.metricApplicability ?? {})) {
      if (applicability.state !== "measured" && !sourceUrls.has(applicability.sourceUrl)) {
        ctx.addIssue({
          code: "custom",
          path: ["metricApplicability", metricKey, "sourceUrl"],
          message: "Not-applicable metric sourceUrl must match an overlay source",
        });
      }
    }
  });

const MechanismReviewOverlayFileSchema = z
  .object({
    schemaVersion: z.literal(1),
    note: z.string(),
    overlays: z.array(MechanismReviewOverlaySchema),
  })
  .strict()
  .superRefine((file, ctx) => {
    const ids = file.overlays.map((overlay) => overlay.assetId);
    if (new Set(ids).size !== ids.length) {
      ctx.addIssue({ code: "custom", path: ["overlays"], message: "Duplicate overlay assetId" });
    }
    file.overlays.forEach((overlay, overlayIndex) => {
      const sourceUrls = new Set(overlay.sources.map((source) => source.url));
      for (const [componentKey, component] of Object.entries(overlay.components)) {
        if (
          "applicability" in component &&
          component.applicability === "not-applicable" &&
          !sourceUrls.has(component.sourceUrl)
        ) {
          ctx.addIssue({
            code: "custom",
            path: ["overlays", overlayIndex, "components", componentKey, "sourceUrl"],
            message: "Not-applicable component sourceUrl must match an overlay source",
          });
        }
      }
      for (const [metricKey, applicability] of Object.entries(overlay.metricApplicability ?? {})) {
        if (applicability.state !== "measured" && !sourceUrls.has(applicability.sourceUrl)) {
          ctx.addIssue({
            code: "custom",
            path: ["overlays", overlayIndex, "metricApplicability", metricKey, "sourceUrl"],
            message: "Not-applicable metric sourceUrl must match an overlay source",
          });
        }
      }
    });
  });

export type MechanismReviewOverlay = z.infer<typeof MechanismReviewOverlaySchema>;

// Component fields (camelCase) per archetype; numeric metric fields separate.
const OVERLAY_ARCHETYPE_COMPONENTS: Record<MechanismReviewOverlay["archetype"], readonly string[]> = {
  cdp: [
    "collateralizationParameters",
    "liquidationMechanics",
    "backstop",
    "branchIsolation",
    "shutdownAndBadDebt",
    "structuralRedemption",
  ],
  "synthetic-delta-neutral": [
    "venueAndCustody",
    "hedgeReconciliation",
    "fundingBasisStress",
    "marginAndLiquidation",
    "unwindCapacity",
    "lossAbsorption",
  ],
  algorithmic: [
    "contractionCapacity",
    "confidenceAndIncentives",
    "oracleAndControlAssumptions",
    "emergencyRecovery",
    "lossRecovery",
  ],
  "rwa-credit-fund": [
    "creditQuality",
    "seniority",
    "legalEnforceability",
    "valuationCadence",
    "maturityAndLiquidity",
    "custody",
    "recovery",
  ],
  // Fiat-cash and tbill components are compiler-bounded by design; a curated
  // overlay may claim them only under the owner-approved evidence standard
  // (see the FORGE owner decision packet). Until such overlays exist this
  // path is inert and the built bounded review stands.
  "fiat-cash": ["claimAndSegregation", "custodyContinuity", "assuranceAndReconciliation"],
  tbill: ["fundClaimAndSeniority", "navValuation", "durationAndLiquidity", "lossRecoveryDesign"],
};

const OVERLAY_ARCHETYPE_METRICS: Record<MechanismReviewOverlay["archetype"], readonly string[]> = {
  cdp: ["collateralizationRatio", "liquidationCapacityRatio"],
  "synthetic-delta-neutral": ["hedgeCoverageRatio", "marginBufferPct", "lossAbsorptionShare"],
  algorithmic: ["exogenousBackingShare", "reflexiveBackingShare", "contractionCapacityRatio"],
  "rwa-credit-fund": ["weightedAverageMaturityDays", "valuationCadenceDays"],
  "fiat-cash": [],
  tbill: [],
};

function kebabCase(value: string): string {
  return value.replace(/[A-Z]/g, (char) => `-${char.toLowerCase()}`);
}

function profileComponentFact(
  componentField: string,
  component: V9MechanismProfileComponentProjection,
): V9MechanismFactV1 {
  const componentKey = kebabCase(componentField);
  if (component.observationState === "known" && component.quality !== null) {
    return knownFact(componentKey, component.quality);
  }
  if (component.observationState === "unsupported") return unsupportedFact(componentKey);
  return boundedFact(componentKey, component.observationState === "bounded-unknown");
}

export function expandOverlayReview(
  overlay: MechanismReviewOverlay,
  fallbackReview?: V9MechanismRiskReview | null,
): V9MechanismRiskReview {
  const profileProjection =
    overlay.profileReview === undefined ? null : projectV9MechanismProfile(overlay.profileReview);
  const componentKeys = OVERLAY_ARCHETYPE_COMPONENTS[overlay.archetype];
  const metricKeys = OVERLAY_ARCHETYPE_METRICS[overlay.archetype];
  const projectedComponents = profileProjection?.components ?? null;
  const components = projectedComponents ?? overlay.components;
  const metrics = profileProjection?.metrics ?? overlay.metrics;
  for (const key of Object.keys(components)) {
    if (!componentKeys.includes(key)) {
      throw new Error(`Unknown ${overlay.archetype} mechanism component in overlay ${overlay.assetId}: ${key}`);
    }
  }
  for (const key of metricKeys) {
    if (!(key in metrics)) {
      throw new Error(`Overlay ${overlay.assetId} is missing required ${overlay.archetype} metric: ${key}`);
    }
  }
  for (const key of Object.keys(metrics)) {
    if (!metricKeys.includes(key)) {
      throw new Error(`Unknown ${overlay.archetype} mechanism metric in overlay ${overlay.assetId}: ${key}`);
    }
  }
  for (const key of Object.keys(overlay.metricApplicability ?? {})) {
    if (!metricKeys.includes(key)) {
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
  const partialMetricArchetypes = ["cdp", "synthetic-delta-neutral", "rwa-credit-fund"] as const;
  if ((partialMetricArchetypes as readonly string[]).includes(overlay.archetype)) {
    const metricApplicability: Record<string, unknown> = {};
    for (const metricKey of metricKeys) {
      const value = metrics[metricKey];
      const applicability = overlay.metricApplicability?.[metricKey] ?? { state: "measured" as const };
      if (applicability.state === "unavailable" && overlay.archetype === "cdp") {
        // CDP collateralization banding needs a numeric ratio, so an
        // unavailable CDP metric has no defined severity; use not-applicable
        // for structural absence or leave the overlay out.
        throw new Error(`Overlay ${overlay.assetId} marks ${metricKey} unavailable; CDP admits only measured or not-applicable metrics`);
      }
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
  for (const componentField of componentKeys) {
    const projected = projectedComponents?.[componentField];
    if (projected !== undefined) {
      review[componentField] = profileComponentFact(componentField, projected);
      continue;
    }
    const curated = overlay.components[componentField];
    // A component the curated review does not evidence keeps the built
    // review's fact when one exists (e.g. PoR-derived assurance), otherwise
    // stays bounded-unknown; serial mechanism components are never published
    // as missing.
    review[componentField] = curated
      ? !("applicability" in curated) || curated.applicability === "measured"
        ? knownFact(kebabCase(componentField), curated.quality)
        : notApplicableFact(kebabCase(componentField), curated.rationale)
      : (fallbackComponents?.[componentField] ?? boundedFact(kebabCase(componentField), true));
  }
  return V9MechanismRiskReviewSchema.parse(review);
}

const MECHANISM_REVIEW_OVERLAY_FILE = MechanismReviewOverlayFileSchema.parse(mechanismReviewOverlaysAsset);

export const SAFETY_SCORE_V9_MECHANISM_REVIEW_OVERLAYS_DIGEST = sha256Hex(
  stableJsonStringifyV1({
    domain: "safety-score-v9.mechanism-review-overlays.v1",
    overlays: MECHANISM_REVIEW_OVERLAY_FILE,
  }),
);

const MECHANISM_REVIEW_OVERLAYS: ReadonlyMap<string, MechanismReviewOverlay> = new Map(
  MECHANISM_REVIEW_OVERLAY_FILE.overlays.map((overlay) => [overlay.assetId, overlay]),
);

// The approved D1 fiat/tbill overlay standard re-bounds curated claims after
// twelve months. Date-only reviews become score-bearing after their UTC day has
// elapsed, preventing evidence published later that day from entering an earlier
// point-in-time capture. Invalid or expired reviews fall back to the conservative
// bounded-unknown evidence path (VER2-004).
const MECHANISM_OVERLAY_MAX_AGE_SEC = 31_536_000;
const DAY_SEC = 86_400;

function isMechanismOverlayCurrent(overlay: MechanismReviewOverlay, clockSec: number): boolean {
  const reviewedAtSec = Date.parse(`${overlay.reviewedAt}T00:00:00.000Z`) / 1_000;
  if (!Number.isFinite(reviewedAtSec)) return false;
  return reviewedAtSec + DAY_SEC <= clockSec && reviewedAtSec + MECHANISM_OVERLAY_MAX_AGE_SEC > clockSec;
}

function currentMechanismOverlay(assetId: string, archetype: string, clockSec: number): MechanismReviewOverlay | null {
  const overlay = MECHANISM_REVIEW_OVERLAYS.get(assetId);
  return overlay && overlay.archetype === archetype && isMechanismOverlayCurrent(overlay, clockSec) ? overlay : null;
}

export function getSafetyScoreV9MechanismOverlayEvidence(
  assetId: string,
  archetype: string,
  clockSec: number,
): {
  reviewedAt: string;
  sources: MechanismReviewOverlay["sources"];
  payload: MechanismReviewOverlay;
  maxAgeSec: number;
} | null {
  const overlay = currentMechanismOverlay(assetId, archetype, clockSec);
  return overlay
    ? {
        reviewedAt: overlay.reviewedAt,
        sources: overlay.sources,
        payload: overlay,
        maxAgeSec: MECHANISM_OVERLAY_MAX_AGE_SEC,
      }
    : null;
}

export function getSafetyScoreV9MechanismExitFacts(
  assetId: string,
  archetype: string,
  clockSec: number,
): Array<{
  factKey: "physical-redemption" | "protocol-redemption";
  disposition: "supported" | "issuer-undisclosed" | "integration-missing" | "method-unsupported";
  quality: V9MechanismQualityLevel | null;
}> {
  const overlay = currentMechanismOverlay(assetId, archetype, clockSec);
  if (overlay?.profileReview === undefined) return [];
  const projection = projectV9MechanismProfile(overlay.profileReview);
  return Object.entries(projection.exitFacts)
    .map(([factKey, fact]) => ({
      factKey: kebabCase(factKey) as "physical-redemption" | "protocol-redemption",
      disposition: fact.disposition,
      quality: fact.disposition === "supported" ? fact.quality : null,
    }))
    .sort((left, right) => compareText(left.factKey, right.factKey));
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
  fixedInput: Readonly<ReportCardsFixedInput>,
  meta: MechanismMeta,
  archetype: string,
): V9MechanismRiskReview | null {
  const overlay = currentMechanismOverlay(meta.id, archetype, fixedInput.clockSec);
  if (overlay) {
    const fallbackReview =
      archetype === "fiat-cash"
        ? buildFiatCashReview(fixedInput, meta)
        : archetype === "tbill"
          ? buildTbillReview(fixedInput, meta)
          : null;
    return expandOverlayReview(overlay, fallbackReview);
  }
  if (archetype === "fiat-cash") return buildFiatCashReview(fixedInput, meta);
  if (archetype === "tbill") return buildTbillReview(fixedInput, meta);
  return null;
}
