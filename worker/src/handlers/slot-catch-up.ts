import { SCHEDULED_SLOT_PLANS } from "@shared/lib/scheduled-runner-registry";
import { SLOT_CATCH_UP_MESSAGE_KIND, SlotCatchUpMessageSchema } from "@shared/types/slot-catch-up";
import type { Env } from "../lib/env";
import {
  getSlotCatchUpPolicy,
  isSlotCatchUpWithinWindow,
  resolveSlotCatchUpDeadlineMs,
  type SlotCatchUpScheduleKey,
} from "@shared/lib/scheduled-slot-catch-up-policy";
import { logWorkerEvent } from "../lib/structured-log";

export function isSlotCatchUpBatch(batch: MessageBatch<unknown>): boolean {
  const body = batch.messages[0]?.body;
  return typeof body === "object" && body !== null
    && (body as { kind?: unknown }).kind === SLOT_CATCH_UP_MESSAGE_KIND;
}

/**
 * Run one armed missed slot under its own scheduled-slot fence. Acknowledged
 * before work: a catch-up is one-shot, and the next natural slot remains the
 * fallback for any failure, so the Queue never redelivers it.
 */
export async function handleSlotCatchUpBatch(
  batch: MessageBatch<unknown>, env: Env, ctx: ExecutionContext, eventEntryMs: number,
): Promise<void> {
  batch.ackAll();
  const delivery = batch.messages[0];
  const parsed = SlotCatchUpMessageSchema.safeParse(delivery?.body);
  if (batch.messages.length !== 1 || !parsed.success || env.WORKER_SLOT_CATCH_UP_MODE !== "on") return;
  const message = parsed.data;
  const nowSec = Math.floor(eventEntryMs / 1000);
  const metadata = {
    scheduleKey: message.scheduleKey, slotStartedAt: message.slotStartedAt, trigger: message.trigger,
    armedAt: message.armedAt, deliveryLatencyMs: Math.max(0, eventEntryMs - message.armedAt * 1000),
  };
  if (!getSlotCatchUpPolicy(message.scheduleKey) || !isSlotCatchUpWithinWindow(message.scheduleKey, message.slotStartedAt, nowSec)) {
    logWorkerEvent({ scope: "handler", level: "info", event: "scheduled-slot-catch-up", status: "skipped_neutral",
      message: "Slot catch-up hint arrived outside its admission window",
      metadata: { ...metadata, reason: "slot-catch-up-window-closed" } });
    return;
  }
  const scheduleKey = message.scheduleKey as SlotCatchUpScheduleKey;
  const [{ handleScheduledEvent }, { PUBLIC_SLOT_RUNNER_LOADERS }] = await Promise.all([
    import("./scheduled"),
    import("./scheduled/public-runners"),
  ]);
  const event = {
    cron: SCHEDULED_SLOT_PLANS[scheduleKey].triggerSchedules[0]!,
    scheduledTime: message.slotStartedAt * 1000,
  } as ScheduledEvent;
  try {
    await handleScheduledEvent(event, env, ctx, "public", PUBLIC_SLOT_RUNNER_LOADERS, eventEntryMs, {
      trigger: message.trigger, armedAt: message.armedAt, armedByInvocationId: message.armedByInvocationId,
    }, resolveSlotCatchUpDeadlineMs(scheduleKey, message.slotStartedAt, eventEntryMs));
  } catch (error) {
    // Child and slot terminals are already durable; nothing is retried here.
    logWorkerEvent({ scope: "handler", level: "warn", event: "scheduled-slot-catch-up", status: "error",
      message: "Slot catch-up completed with errors", metadata: { ...metadata, reason: "slot-catch-up-failed" }, error });
  }
}
