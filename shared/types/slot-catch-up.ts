import { z } from "zod";

export const SLOT_CATCH_UP_MESSAGE_KIND = "slot-catch-up";

export const SlotCatchUpTriggerSchema = z.enum(["never-delivered", "abandoned"]);
export type SlotCatchUpTrigger = z.output<typeof SlotCatchUpTriggerSchema>;

/** A one-shot wakeup hint; the missed slot's own execution fence stays the authority. */
export const SlotCatchUpMessageSchema = z.object({
  version: z.literal(1),
  kind: z.literal(SLOT_CATCH_UP_MESSAGE_KIND),
  scheduleKey: z.string().min(1).max(64),
  slotStartedAt: z.number().int().positive(),
  trigger: SlotCatchUpTriggerSchema,
  armedAt: z.number().int().positive(),
  armedByInvocationId: z.string().min(1).max(256),
}).strict();
export type SlotCatchUpMessage = z.output<typeof SlotCatchUpMessageSchema>;
