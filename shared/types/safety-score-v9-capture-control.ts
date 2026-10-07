import { z } from "zod";
import { SafetyScoreV9InputIdentitySchema } from "./safety-score-publication";
import { BaseInputGenerationIdSchema, Sha256Schema, UnixSecondsSchema } from "./safety-schema-primitives";

export const SafetyScoreV9CaptureTupleSchema = z.strictObject({
  safetyScoreIdentity: SafetyScoreV9InputIdentitySchema,
  baseInputGenerationId: BaseInputGenerationIdSchema,
  sourceGeneration: z.string().min(1),
  clockSec: UnixSecondsSchema,
  registryFingerprint: Sha256Schema,
  workerVersion: z.string().min(1).max(160).nullable(),
  workerUploadedAtSec: UnixSecondsSchema.nullable(),
});
export type SafetyScoreV9CaptureTuple = z.infer<typeof SafetyScoreV9CaptureTupleSchema>;

export const SafetyScoreV9CaptureControlSchema = z.strictObject({
  schemaVersion: z.literal(1),
  capture: SafetyScoreV9CaptureTupleSchema,
  recaptureRequest: z.strictObject({
    targetWorkerVersion: z.string().min(1).max(160),
    targetWorkerUploadedAtSec: UnixSecondsSchema,
    evaluationBuildDigest: Sha256Schema,
    registryFingerprint: Sha256Schema,
    sourceCaptureTuple: SafetyScoreV9CaptureTupleSchema,
    requestedAtSec: UnixSecondsSchema,
  }).nullable(),
  attribution: z.strictObject({
    status: z.enum(["pending", "settled"]),
    dueSlotStartedAtSec: UnixSecondsSchema,
    pendingUntilSec: UnixSecondsSchema,
    generationId: z.string().min(1).nullable(),
    outcome: z.enum(["ok", "degraded", "error"]).nullable(),
  }),
}).superRefine((control, ctx) => {
  const capture = control.capture;
  if (capture.safetyScoreIdentity.baseInputGenerationId !== capture.baseInputGenerationId ||
    capture.safetyScoreIdentity.publicationGenerationId !== capture.sourceGeneration) {
    ctx.addIssue({ code: "custom", path: ["capture"], message: "Capture identity must match its immutable source tuple" });
  }
  if ((control.attribution.status === "pending") !== (control.attribution.outcome === null)) {
    ctx.addIssue({ code: "custom", path: ["attribution"], message: "Only an unsettled attribution request may be pending" });
  }
});
export type SafetyScoreV9CaptureControl = z.infer<typeof SafetyScoreV9CaptureControlSchema>;
