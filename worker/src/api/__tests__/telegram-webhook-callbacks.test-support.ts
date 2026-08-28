import { vi } from "vitest";
import { mockD1 as baseMockD1 } from "@shared/test-utils/mock-d1";
import {
  createTelegramFetchSpy,
  telegramApiCallBody,
} from "../../test-helpers/__shared/telegram";

// Keep the callback suites focused on action-specific fixtures and assertions.
vi.mock("../telegram-webhook-insights", async (importOriginal) => {
  const original = (await importOriginal()) as Record<string, unknown>;
  return {
    ...original,
    buildWhyMessage: vi.fn(
      async (_db: unknown, stablecoinId: string) => `<b>${stablecoinId} Safety Score</b>\nOverall: A`,
    ),
  };
});

vi.mock("../telegram-webhook-replies", async (importOriginal) => {
  const original = (await importOriginal()) as Record<string, unknown>;
  return {
    ...original,
    sendAuditedTelegramReply: vi.fn(original.sendAuditedTelegramReply as (...args: unknown[]) => Promise<void>),
  };
});

const { handleCallbackQuery } = await import("../telegram-webhook-callbacks");
const { sendAuditedTelegramReply } = await import("../telegram-webhook-replies");
const { resolveTicker } = await import("../../lib/telegram-alerts");

const { fetchSpy, reset: resetTelegramFetchSpy } = createTelegramFetchSpy();

type InlineButton = {
  text?: string;
  callback_data?: string;
  url?: string;
  web_app?: { url?: string };
};

export type TelegramSentMessageBody = {
  text: string;
  reply_markup?: { inline_keyboard?: InlineButton[][] };
};

export function firstSentMessageBody(): TelegramSentMessageBody {
  return telegramApiCallBody(fetchSpy, "sendMessage", { last: false });
}

export function lastSentMessageBody(): TelegramSentMessageBody {
  return telegramApiCallBody(fetchSpy, "sendMessage");
}

export function firstAckBody(): { text?: string } {
  return telegramApiCallBody(fetchSpy, "answerCallbackQuery", { last: false });
}

export function lastAckBody(): { text?: string } {
  return telegramApiCallBody(fetchSpy, "answerCallbackQuery");
}

export function lastEditedMessageBody(): { text: string; reply_markup?: unknown } {
  return telegramApiCallBody(fetchSpy, "editMessageText");
}

function mockD1(
  tables: Parameters<typeof baseMockD1>[0] = [],
  options: Parameters<typeof baseMockD1>[1] = {},
) {
  return baseMockD1([
    ...tables,
    { match: "FROM telegram_subscribers", rows: [], first: null },
    { match: "FROM telegram_subscriptions", rows: [] },
    { match: "FROM telegram_preset_subscriptions", rows: [] },
    { match: "FROM telegram_pending_disambiguation", rows: [], first: null },
    { match: "FROM telegram_pending_alerts", rows: [], first: null },
    { match: "FROM telegram_recap_preferences", rows: [], first: null },
    { match: "FROM cache", rows: [], first: null },
    { match: "FROM price_cache", rows: [], first: null },
    { match: "FROM dex_liquidity", rows: [], first: null },
    { match: "FROM yield_data", rows: [], first: null },
    { match: "FROM stress_signals", rows: [], first: null },
    { match: "FROM stress_signal_publication_rows", rows: [], first: null },
    { match: "FROM safety_grade_history", rows: [], first: null },
    { match: "FROM depeg_events", rows: [], first: null },
    { match: "INSERT INTO telegram_subscribers", rows: [] },
    { match: "UPDATE telegram_subscribers", rows: [] },
    { match: "INSERT INTO telegram_subscriptions", rows: [] },
    { match: "UPDATE telegram_subscriptions", rows: [] },
    { match: "DELETE FROM telegram_subscriptions", rows: [] },
    { match: "INSERT INTO telegram_preset_subscriptions", rows: [] },
    { match: "DELETE FROM telegram_preset_subscriptions", rows: [] },
    { match: "INSERT INTO telegram_pending_disambiguation", rows: [] },
    { match: "DELETE FROM telegram_pending_disambiguation", rows: [] },
    { match: "DELETE FROM telegram_recap_targets", rows: [] },
    { match: "UPDATE telegram_recap_preferences", rows: [] },
    { match: "UPDATE telegram_recap_targets", rows: [] },
    { match: "DELETE FROM telegram_pending_alerts", rows: [] },
    { match: "DELETE FROM telegram_freeze_alert_targets", rows: [] },
    { match: "DELETE FROM telegram_alert_source_resolution_targets", rows: [] },
    { match: "DELETE FROM telegram_alert_target_plan_items", rows: [] },
    { match: "DELETE FROM telegram_alert_job_targets", rows: [] },
    { match: "DELETE FROM telegram_alert_job_target_items", rows: [] },
    { match: "DELETE FROM telegram_alert_target_plans", rows: [] },
    { match: "DELETE FROM telegram_alert_planning_subscribers", rows: [] },
    { match: "DELETE FROM telegram_transport_failure_observations", rows: [] },
    { match: "DELETE FROM telegram_alert_dead_letters", rows: [] },
    { match: "DELETE FROM telegram_chat_delivery_diagnostics", rows: [] },
    { match: "INSERT INTO telegram_usage_daily", rows: [] },
  ], options);
}

function resetCallbackTest(): void {
  resetTelegramFetchSpy();
  vi.mocked(sendAuditedTelegramReply).mockClear();
}

export {
  fetchSpy,
  handleCallbackQuery,
  sendAuditedTelegramReply,
  resolveTicker,
  mockD1,
  resetCallbackTest,
};
