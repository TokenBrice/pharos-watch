import { z } from "zod";
import { CronRunStatusSchema } from "./status/cron";

export const PLACED_EXECUTOR_URL = "https://heavy.internal/project-tape";
export const PLACED_EXECUTOR_MAX_BODY_BYTES = 64 * 1024;

/** The public driver remains the only slot, lease and terminal-accounting owner. */
export const PlacedProjectTapeRequestSchema = z.object({
  job: z.literal("project-tape"),
  scheduleKey: z.literal("dewsPsiOffset"),
  slotStartedAt: z.number().int().nonnegative(),
  eventEntryMs: z.number().int().nonnegative(),
  deadlineMs: z.number().int().nonnegative(),
  workDeadlineMs: z.number().int().nonnegative(),
  invocationId: z.string().min(1),
  owner: z.string().min(1),
  generation: z.number().int().positive(),
}).strict().refine((value) => value.eventEntryMs < value.deadlineMs && value.workDeadlineMs <= value.deadlineMs);
export type PlacedProjectTapeRequest = z.output<typeof PlacedProjectTapeRequestSchema>;

/** The real projector result, including its D1-cost and executor evidence. */
export const PlacedProjectTapeResultSchema = z.object({
  status: CronRunStatusSchema.extract(["ok", "degraded", "error"]),
  itemCount: z.number().int().nonnegative().optional(),
  metadata: z.string(),
  error: z.string().optional(),
  productivity: z.object({ productive: z.boolean(), reason: z.string().optional() }).strict().optional(),
}).strict();
