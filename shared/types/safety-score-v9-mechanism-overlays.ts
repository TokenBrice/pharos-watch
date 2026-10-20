import { z } from "zod";
import { V9MechanismQualitySchema } from "./safety-score-v9-fact-input-primitives";
import {
  V9MechanismProfileReviewSchema,
  safetyScoreV9MechanismProfileArchetype,
} from "./safety-score-v9-mechanism-profile";
import { MECHANISM_ARCHETYPE_VALUES } from "./stablecoin-taxonomy";
import { issue, StrictIsoDateOrUtcInstantSchema, uniqueKeyedCollectionSchema, reviewedAssetCollectionEnvelopeSchema } from "./safety-schema-primitives";

const SafetyScoreV9MechanismArchetypeSchema = z.enum(MECHANISM_ARCHETYPE_VALUES);

const SafetyScoreV9MechanismComponentReviewSchema = z.object({
  reviewedAt: StrictIsoDateOrUtcInstantSchema,
  reviewer: z.string().trim().min(1),
  rationale: z.string().trim().min(1),
  sources: z.array(z.object({ label: z.string().min(1), url: z.string().url() }).strict()).min(1),
}).strict();

const SafetyScoreV9MechanismOverlayComponentSchema = z.union([
  z.object({ quality: V9MechanismQualitySchema, review: SafetyScoreV9MechanismComponentReviewSchema.optional() }).strict(),
  z.object({ applicability: z.literal("measured"), quality: V9MechanismQualitySchema, review: SafetyScoreV9MechanismComponentReviewSchema.optional() }).strict(),
  z
    .object({
      applicability: z.literal("not-applicable"),
      rationale: z.string().trim().min(1),
      sourceUrl: z.string().url(),
      review: SafetyScoreV9MechanismComponentReviewSchema.optional(),
    })
    .strict(),
  z
    .object({
      applicability: z.literal("unavailable"),
      rationale: z.string().trim().min(1),
      sourceUrl: z.string().url(),
      review: SafetyScoreV9MechanismComponentReviewSchema.optional(),
    })
    .strict(),
]);

const SafetyScoreV9MechanismMetricApplicabilitySchema = z.discriminatedUnion("state", [
  z.object({ state: z.literal("measured") }).strict(),
  z
    .object({
      state: z.literal("not-applicable"),
      rationale: z.string().trim().min(1),
      sourceUrl: z.string().url(),
    })
    .strict(),
  z
    .object({
      state: z.literal("unavailable"),
      rationale: z.string().trim().min(1),
      sourceUrl: z.string().url(),
    })
    .strict(),
]);

const SafetyScoreV9MechanismOverlaySourceSchema = z
  .object({ label: z.string().min(1), url: z.string().url() })
  .strict();

export const SafetyScoreV9MechanismReviewOverlaySchema = z
  .object({
    assetId: z.string().min(1),
    archetype: SafetyScoreV9MechanismArchetypeSchema,
    reviewedAt: StrictIsoDateOrUtcInstantSchema,
    sources: z.array(SafetyScoreV9MechanismOverlaySourceSchema).min(1),
    notes: z.string().min(1),
    metrics: z.record(z.string(), z.number().finite().nullable()),
    profileReview: V9MechanismProfileReviewSchema.optional(),
    metricApplicability: z.record(z.string(), SafetyScoreV9MechanismMetricApplicabilitySchema).optional(),
    analogousMetrics: z.record(z.string(), z.number().finite()).optional(),
    collateralizationMeasurement: z
      .object({
        /** Identity of the measured subject and immutable pin, shared unchanged by wrappers. */
        measurementId: z.string().trim().min(1),
        ratio: z.number().finite().nonnegative(),
        rationale: z.string().trim().min(1),
        sourceUrl: z.string().url(),
      })
      .strict()
      .nullable()
      .optional(),
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
    components: z.record(z.string(), SafetyScoreV9MechanismOverlayComponentSchema),
  })
  .strict()
  .superRefine((overlay, ctx) => {
    if (
      overlay.archetype === "ucits-trs-fund" ||
      overlay.archetype === "shared-reserve" ||
      overlay.archetype === "protocol-position"
    ) {
      if (
        Object.keys(overlay.metrics).length > 0 ||
        Object.keys(overlay.metricApplicability ?? {}).length > 0 ||
        Object.keys(overlay.analogousMetrics ?? {}).length > 0 ||
        overlay.venueShares !== undefined
      ) {
        ctx.addIssue({ code: "custom", path: ["metrics"], message: "Native families do not admit position metrics" });
      }
      for (const [key, component] of Object.entries(overlay.components)) {
        if ("applicability" in component && component.applicability === "not-applicable") {
          issue(ctx, ["components", key], "Native family components remain applicable; unavailable facts must be bounded");
        }
      }
    }
    if (overlay.profileReview !== undefined) {
      const expectedArchetype = safetyScoreV9MechanismProfileArchetype(overlay.profileReview.profile);
      if (expectedArchetype !== overlay.archetype) {
        issue(ctx, ["profileReview", "profile"], `Profile ${overlay.profileReview.profile} is incompatible with ${overlay.archetype}`);
      }
      if (Object.keys(overlay.metrics).length > 0 || Object.keys(overlay.components).length > 0) {
        issue(ctx, ["profileReview"], "Profile-driven overlays cannot duplicate projected metrics or components");
      }
    }
    const sourceUrls = new Set(overlay.sources.map((source) => source.url));
    if (overlay.collateralizationMeasurement && !sourceUrls.has(overlay.collateralizationMeasurement.sourceUrl)) {
      issue(ctx, ["collateralizationMeasurement", "sourceUrl"], "Collateralization measurement sourceUrl must match an overlay source");
    }
    for (const [componentKey, component] of Object.entries(overlay.components)) {
      if (component.review !== undefined) {
        const componentUrls = new Set(component.review.sources.map(source => source.url));
        for (const [index, source] of component.review.sources.entries()) {
          if (!sourceUrls.has(source.url)) issue(ctx, ["components", componentKey, "review", "sources", index, "url"], "Component review source must match an overlay source");
        }
        if ("sourceUrl" in component && !componentUrls.has(component.sourceUrl)) issue(ctx, ["components", componentKey, "sourceUrl"], "Component sourceUrl must match its own review source");
      }
      if (
        "applicability" in component &&
        component.applicability !== "measured" &&
        !sourceUrls.has(component.sourceUrl)
      ) {
        issue(ctx, ["components", componentKey, "sourceUrl"], "Non-measured component sourceUrl must match an overlay source");
      }
    }
    for (const [metricKey, applicability] of Object.entries(overlay.metricApplicability ?? {})) {
      if (applicability.state !== "measured" && !sourceUrls.has(applicability.sourceUrl)) {
        issue(ctx, ["metricApplicability", metricKey, "sourceUrl"], "Not-applicable metric sourceUrl must match an overlay source");
      }
    }
  });

export const SafetyScoreV9MechanismReviewOverlayFileSchema = uniqueKeyedCollectionSchema({
  itemSchema: SafetyScoreV9MechanismReviewOverlaySchema,
  collectionKey: "overlays",
  duplicateMessage: "Duplicate overlay assetId",
  noteSchema: z.string(),
});
export const SafetyScoreV9MechanismReviewOverlayEnvelopeSchema = reviewedAssetCollectionEnvelopeSchema("overlays", z.string());

export type SafetyScoreV9MechanismReviewOverlay = z.infer<
  typeof SafetyScoreV9MechanismReviewOverlaySchema
>;
