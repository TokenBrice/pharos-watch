import { z } from "zod";
import mechanismReviewOverlaysAsset from "@shared/data/safety-score-v9/mechanism-review-overlays-v1.json";
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
      if (applicability.state === "not-applicable" && !sourceUrls.has(applicability.sourceUrl)) {
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
        if (applicability.state === "not-applicable" && !sourceUrls.has(applicability.sourceUrl)) {
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

export function expandOverlayReview(
  overlay: MechanismReviewOverlay,
  fallbackReview?: V9MechanismRiskReview | null,
): V9MechanismRiskReview {
  const componentKeys = OVERLAY_ARCHETYPE_COMPONENTS[overlay.archetype];
  const metricKeys = OVERLAY_ARCHETYPE_METRICS[overlay.archetype];
  for (const key of Object.keys(overlay.components)) {
    if (!componentKeys.includes(key)) {
      throw new Error(`Unknown ${overlay.archetype} mechanism component in overlay ${overlay.assetId}: ${key}`);
    }
  }
  for (const key of metricKeys) {
    if (!(key in overlay.metrics)) {
      throw new Error(`Overlay ${overlay.assetId} is missing required ${overlay.archetype} metric: ${key}`);
    }
  }
  for (const key of Object.keys(overlay.metrics)) {
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
  const review: Record<string, unknown> = { archetype: overlay.archetype, ...overlay.metrics };
  if (overlay.archetype === "cdp") {
    const metricApplicability: Record<string, unknown> = {};
    for (const metricKey of metricKeys) {
      const value = overlay.metrics[metricKey];
      const applicability = overlay.metricApplicability?.[metricKey] ?? { state: "measured" as const };
      if (applicability.state === "measured" && value == null) {
        throw new Error(`Overlay ${overlay.assetId} has measured ${metricKey} without a numeric value`);
      }
      if (applicability.state === "not-applicable" && value !== null) {
        throw new Error(`Overlay ${overlay.assetId} has not-applicable ${metricKey} with a numeric value`);
      }
      metricApplicability[metricKey] =
        applicability.state === "measured"
          ? { state: "measured" }
          : {
              state: "not-applicable",
              rationale: applicability.rationale,
              evidenceRefIds: [`extension-evidence:mechanism:${kebabCase(metricKey)}`],
            };
    }
    review.metricApplicability = metricApplicability;
  } else if (Object.values(overlay.metrics).some((value) => value === null)) {
    throw new Error(`Only CDP overlays support structurally not-applicable metrics (${overlay.assetId})`);
  }
  if (overlay.archetype === "synthetic-delta-neutral") {
    review.venueShares = overlay.venueShares ?? [];
  }
  for (const componentField of componentKeys) {
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

const MECHANISM_REVIEW_OVERLAYS: ReadonlyMap<string, MechanismReviewOverlay> = new Map(
  MechanismReviewOverlayFileSchema.parse(mechanismReviewOverlaysAsset).overlays.map((overlay) => [
    overlay.assetId,
    overlay,
  ]),
);

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
  const overlay = MECHANISM_REVIEW_OVERLAYS.get(meta.id);
  if (overlay && overlay.archetype === archetype) {
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
