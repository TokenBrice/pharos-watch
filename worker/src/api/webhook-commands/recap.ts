import { nextIanaLocalHourDueAt } from "@shared/lib/iana-local-time";
import { TELEGRAM_RECAP_DEFAULT_DELIVERY_HOUR_LOCAL } from "@shared/lib/telegram-recap-policy";
import {
  TELEGRAM_RECAP_PUBLIC_ROLLOUT_POLICY,
  isTelegramRecapAvailableToChat,
} from "@shared/lib/telegram-recap-rollout";
import { escapeHtml } from "../../lib/telegram";
import { recordTelegramUsageEvent } from "../../lib/telegram-usage-analytics";
import {
  getTelegramRecapPreference,
  setTelegramRecapPreference,
} from "../../lib/telegram-recap-store";
import { loadSubscriberByChat, unixNow } from "../telegram-webhook-store";
import {
  confirmCommandMutation,
  prepareCommandMutation,
  type WebhookCommandHandler,
} from "./context";

type RecapMarkup = { inline_keyboard: Array<Array<{ text: string; callback_data: string }>> };

function recapMarkup(enabled: boolean, hour: number): RecapMarkup {
  return {
    inline_keyboard: [
      enabled
        ? [{ text: "Turn recap off", callback_data: "recap:off" }]
        : [{ text: "Turn recap on", callback_data: "recap:on" }],
      [8, 9, 10].map((candidate) => ({
        text: `${candidate.toString().padStart(2, "0")}:00${candidate === hour ? " *" : ""}`,
        callback_data: `recap:h:${candidate}`,
      })),
    ],
  };
}

function formatRecapStatus(input: {
  enabled: boolean;
  hour: number;
  timezone: string | null;
  nextDueAt: number | null;
  lastLocalDate: string | null;
  lastOutcome: string | null;
}): string {
  const state = input.enabled ? "On" : "Off";
  const timezone = input.timezone == null ? "Not set" : escapeHtml(input.timezone);
  const next = input.nextDueAt == null
    ? "Not scheduled"
    : `<code>${new Date(input.nextDueAt * 1000).toISOString()}</code>`;
  return [
    "<b>Daily watchlist recap</b>",
    `Status: ${state}`,
    `Delivery: <code>${String(input.hour).padStart(2, "0")}:00</code> (${timezone})`,
    `Next: ${next}`,
    `Last local date: ${input.lastLocalDate ?? "Not delivered yet"}`,
    `Last outcome: ${input.lastOutcome ?? "Not recorded yet"}`,
    "",
    "Sent only when watched assets materially changed. Immediate alert toggles are separate.",
  ].join("\n");
}

function parseRecapArgs(args: string): { kind: "status" } | { kind: "set"; enabled: boolean } | { kind: "time"; hour: number } | null {
  const parts = args.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return { kind: "status" };
  if (parts.length === 1 && parts[0] === "on") return { kind: "set", enabled: true };
  if (parts.length === 1 && parts[0] === "off") return { kind: "set", enabled: false };
  if (parts.length === 2 && parts[0] === "time" && /^(?:[0-9]|1[0-9]|2[0-3])$/.test(parts[1] ?? "")) {
    return { kind: "time", hour: Number(parts[1]) };
  }
  return null;
}

async function loadLastRecapOutcome(db: D1Database, chatId: string): Promise<string | null> {
  const row = await db.prepare(`
    SELECT status FROM telegram_recap_targets
     WHERE chat_id = ?
     ORDER BY created_at DESC, recap_key DESC
     LIMIT 1
  `).bind(chatId).first<{ status: string | null }>();
  return row?.status ?? null;
}

export const handleRecap: WebhookCommandHandler = async (ctx, args) => {
  if (!isTelegramRecapAvailableToChat(ctx.recapRollout ?? TELEGRAM_RECAP_PUBLIC_ROLLOUT_POLICY, ctx.chatId)) {
    await ctx.replyToChat("Daily watchlist recaps are not available for this chat.");
    return;
  }
  if (ctx.chatType !== "private") {
    await ctx.replyToChat("Daily watchlist recaps are available in a private chat with the bot.");
    return;
  }
  const parsed = parseRecapArgs(args);
  if (!parsed) {
    await ctx.replyToChat("Usage: <code>/recap</code>, <code>/recap on</code>, <code>/recap off</code>, or <code>/recap time 0-23</code>.");
    return;
  }

  const [subscriber, preference, lastOutcome] = await Promise.all([
    loadSubscriberByChat(ctx.db, ctx.chatId),
    getTelegramRecapPreference(ctx.db, ctx.chatId),
    loadLastRecapOutcome(ctx.db, ctx.chatId),
  ]);
  const deliveryHourLocal = parsed.kind === "time"
    ? parsed.hour
    : preference?.deliveryHourLocal ?? TELEGRAM_RECAP_DEFAULT_DELIVERY_HOUR_LOCAL;
  const enabled = parsed.kind === "set" ? parsed.enabled : preference?.enabled ?? false;

  if (parsed.kind === "status") {
    await ctx.replyToChatWithMarkup(formatRecapStatus({
      enabled,
      hour: deliveryHourLocal,
      timezone: subscriber?.timezone ?? null,
      nextDueAt: preference?.nextDueAt ?? null,
      lastLocalDate: preference?.lastDeliveredLocalDate ?? null,
      lastOutcome,
    }), { replyMarkup: recapMarkup(enabled, deliveryHourLocal) });
    return;
  }

  if (subscriber == null) {
    await ctx.replyToChat("Start the bot or add a watchlist first, then configure <code>/recap</code>.");
    return;
  }

  // Derive the local schedule and generation fence from the same subscriber
  // snapshot. A timezone or watchlist mutation after this point must make the
  // recap write fail instead of committing a stale schedule.
  const timezone = subscriber.timezone ?? null;
  const expectedPreferenceGeneration = Number(subscriber.preference_generation ?? 0);
  if (enabled && timezone == null) {
    await ctx.replyToChat("Set a timezone first with <code>/timezone Europe/Paris</code>, then enable <code>/recap on</code>.");
    return;
  }
  const nowSec = ctx.operationNowSec ?? unixNow();
  const nextDueMs = enabled && timezone != null
    ? nextIanaLocalHourDueAt(nowSec * 1000, timezone, deliveryHourLocal)
    : null;
  if (enabled && nextDueMs == null) {
    await ctx.replyToChat("That timezone cannot schedule a daily recap right now. Set it again with <code>/timezone</code>.");
    return;
  }

  const operation = await prepareCommandMutation(ctx, "recap", {
    enabled,
    deliveryHourLocal,
    timezone,
    nextDueAt: nextDueMs == null ? null : Math.floor(nextDueMs / 1000),
  });
  if (!ctx.wasMutationApplied) {
    const applied = await setTelegramRecapPreference(ctx.db, {
      chatId: ctx.chatId,
      enabled,
      deliveryHourLocal,
      nextDueAt: nextDueMs == null ? null : Math.floor(nextDueMs / 1000),
      nowSec,
      expectedPreferenceGeneration,
    }, operation);
    if (!applied) {
      await ctx.replyToChat("Could not update the daily recap. Please try again.");
      return;
    }
    confirmCommandMutation(ctx, operation);
  }
  await recordTelegramUsageEvent(ctx.db, {
    eventType: "recap_change",
    actionDetail: parsed.kind === "time" ? "hour" : enabled ? "enabled" : "disabled",
    outcome: parsed.kind === "time" ? "set" : enabled ? "on" : "off",
  });
  const [updated, updatedLastOutcome] = await Promise.all([
    getTelegramRecapPreference(ctx.db, ctx.chatId),
    loadLastRecapOutcome(ctx.db, ctx.chatId),
  ]);
  await ctx.replyToChatWithMarkup(formatRecapStatus({
    enabled: updated?.enabled ?? enabled,
    hour: updated?.deliveryHourLocal ?? deliveryHourLocal,
    timezone,
    nextDueAt: updated?.nextDueAt ?? null,
    lastLocalDate: updated?.lastDeliveredLocalDate ?? null,
    lastOutcome: updatedLastOutcome,
  }), { replyMarkup: recapMarkup(updated?.enabled ?? enabled, updated?.deliveryHourLocal ?? deliveryHourLocal) });
};
