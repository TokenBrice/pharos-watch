import { z } from "zod";
import { V9MechanismQualitySchema } from "./safety-score-v9-fact-input-primitives";
import {
  V9MechanismProfileReviewSchema,
  safetyScoreV9MechanismProfileArchetype,
} from "./safety-score-v9-mechanism-profile";

const SafetyScoreV9MechanismArchetypeSchema = z.enum([
  "cdp",
  "synthetic-delta-neutral",
  "algorithmic",
  "rwa-credit-fund",
  "fiat-cash",
  "tbill",
  "commodity-claim",
]);

const SafetyScoreV9MechanismOverlayComponentSchema = z.union([
  z.object({ quality: V9MechanismQualitySchema }).strict(),
  z.object({ applicability: z.literal("measured"), quality: V9MechanismQualitySchema }).strict(),
  z
    .object({
      applicability: z.literal("not-applicable"),
      rationale: z.string().trim().min(1),
      sourceUrl: z.string().url(),
    })
    .strict(),
  z
    .object({
      applicability: z.literal("unavailable"),
      rationale: z.string().trim().min(1),
      sourceUrl: z.string().url(),
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
    reviewedAt: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    sources: z.array(SafetyScoreV9MechanismOverlaySourceSchema).min(1),
    notes: z.string().min(1),
    metrics: z.record(z.string(), z.number().finite().nullable()),
    profileReview: V9MechanismProfileReviewSchema.optional(),
    metricApplicability: z.record(z.string(), SafetyScoreV9MechanismMetricApplicabilitySchema).optional(),
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
    components: z.record(z.string(), SafetyScoreV9MechanismOverlayComponentSchema),
  })
  .strict()
  .superRefine((overlay, ctx) => {
    if (overlay.profileReview !== undefined) {
      const expectedArchetype = safetyScoreV9MechanismProfileArchetype(overlay.profileReview.profile);
      if (expectedArchetype !== overlay.archetype) {
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
        component.applicability !== "measured" &&
        !sourceUrls.has(component.sourceUrl)
      ) {
        ctx.addIssue({
          code: "custom",
          path: ["components", componentKey, "sourceUrl"],
          message: "Non-measured component sourceUrl must match an overlay source",
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

export const SafetyScoreV9MechanismReviewOverlayFileSchema = z
  .object({
    schemaVersion: z.literal(1),
    note: z.string(),
    overlays: z.array(SafetyScoreV9MechanismReviewOverlaySchema),
  })
  .strict()
  .superRefine((file, ctx) => {
    const ids = file.overlays.map((overlay) => overlay.assetId);
    if (new Set(ids).size !== ids.length) {
      ctx.addIssue({ code: "custom", path: ["overlays"], message: "Duplicate overlay assetId" });
    }
  });

export type SafetyScoreV9MechanismReviewOverlay = z.infer<
  typeof SafetyScoreV9MechanismReviewOverlaySchema
>;
