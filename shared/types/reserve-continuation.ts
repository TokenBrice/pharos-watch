import { z } from "zod";

/** A wakeup hint, never execution or publication authority. */
export const ReserveContinuationMessageSchema = z.object({
  version: z.literal(1),
  scheduleKey: z.literal("fourHourlyReserveSync"),
  slotStartedAt: z.number().int().positive(),
  attemptNo: z.number().int().positive(),
  executionGeneration: z.number().int().positive(),
  queueHash: z.string().min(1).max(128),
  nextItemKey: z.string().min(1).max(160).nullable(),
  itemsDone: z.number().int().nonnegative(),
  phase: z.enum(["reserve", "tail"]),
  sourceInvocationId: z.string().min(1).max(256),
}).strict();
export type ReserveContinuationMessage = z.output<typeof ReserveContinuationMessageSchema>;

export const ReserveContinuationExecutionStatusSchema = z.object({
  deliveryId: z.string(),
  phase: z.enum(["reserve", "tail"]),
  state: z.enum(["running", "reconciling", "finished"]),
  generation: z.number().int().positive(),
  startedAt: z.number().int(),
  updatedAt: z.number().int(),
  deadlineMs: z.number().int(),
  finishedAt: z.number().int().nullable(),
  resultStatus: z.enum(["ok", "degraded", "error"]).nullable(),
}).strict();
