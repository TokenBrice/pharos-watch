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
