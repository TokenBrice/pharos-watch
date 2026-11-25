import { z } from "zod";
import { Sha256Schema } from "./safety-schema-primitives";

export const V9_CONTINUATION_QUEUE_NAME = "pharos-v9-continuation" as const;

/**
 * Bounded heavy Queue wakeup hint for ADR-26 chunked Safety Score V9
 * evaluation. Never execution or publication authority: D1 `v9_eval_runs`,
 * `v9_eval_queue_executions`, and the shared `worker-memory-lane:safety-score-v9`
 * lease remain the sole authority.
 */
export const V9ContinuationMessageSchema = z.object({
  version: z.literal(1),
  runId: z.string().min(1).max(160),
  scheduleKey: z.literal("v9PublicationOffset"),
  slotStartedAt: z.number().int().positive(),
  stage: z.enum(["eval", "commit", "materialize"]),
  chunkIndex: z.number().int().nonnegative().nullable(),
  quarantineEpoch: z.number().int().nonnegative(),
  attemptNo: z.number().int().positive(),
  executionGeneration: z.number().int().positive(),
  sourceInvocationId: z.string().min(1).max(256),
  evaluationBuildDigest: Sha256Schema,
  registryFingerprint: z.string().min(1).max(128),
  policyDigest: Sha256Schema,
}).strict().superRefine((value, ctx) => {
  if (value.stage === "eval" && value.chunkIndex === null) {
    ctx.addIssue({
      code: "custom",
      path: ["chunkIndex"],
      message: "eval stage requires a non-negative chunkIndex",
    });
  }
  if (value.stage !== "eval" && value.chunkIndex !== null) {
    ctx.addIssue({
      code: "custom",
      path: ["chunkIndex"],
      message: "non-eval stage must use chunkIndex = null",
    });
  }
});

export type V9ContinuationMessage = z.output<typeof V9ContinuationMessageSchema>;
