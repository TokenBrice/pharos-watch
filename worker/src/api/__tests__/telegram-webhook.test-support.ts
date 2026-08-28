import { expect } from "vitest";
import {
  type MockD1Database,
  type MockTableConfig,
} from "@shared/test-utils/mock-d1";
import {
  createTelegramFetchSpy,
  lastSendMessageBody,
  makeTelegramUpdateRequest,
  mockTelegramD1,
  telegramApiCallBody,
  telegramCallBody,
  type MockTelegramD1Options,
} from "../../test-helpers/__shared/telegram";

const { fetchSpy, reset: resetTelegramFetchSpy } = createTelegramFetchSpy();

const { handleTelegramWebhook, TELEGRAM_GROUP_ADMIN_GATING } = await import("../telegram-webhook");
const { resolveTicker } = await import("../../lib/telegram-alerts");
const { FROZEN_STABLECOINS } = await import("@shared/lib/stablecoins/registry");
const { resetTelegramInvalidSecretLogStateForTests } = await import("../../lib/telegram-log");
function encodeWatchlistToken(state: { coinIds: string[]; alertTypes: string[]; presetIds: string[] }): string {
  const json = JSON.stringify({ v: 1, c: state.coinIds, t: state.alertTypes, p: state.presetIds });
  return btoa(json).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function makeWebhookRequest(
  chatId: number,
  text: string,
  secret = "test-secret",
  options: {
    chatType?: string;
    fromId?: number;
    fromUsername?: string;
    includeFrom?: boolean;
    updateId?: number;
  } = {},
): Request {
  const message: Record<string, unknown> = {
    chat: { id: chatId, username: "testuser", type: options.chatType ?? "private" },
    text,
  };
  if (options.includeFrom !== false) {
    message.from = { id: options.fromId ?? 999, username: options.fromUsername ?? "requester" };
  }
  return makeTelegramUpdateRequest({ message }, { secret, updateId: options.updateId });
}

function makeMyChatMemberRequest(
  options: {
    chatId?: number;
    chatType?: string;
    oldStatus?: string;
    newStatus?: string;
    from?: { id?: number; username?: string; first_name?: string };
    secret?: string;
    updateId?: number;
  } = {},
): Request {
  return makeTelegramUpdateRequest(
    {
      my_chat_member: {
        chat: {
          id: options.chatId ?? -123,
          type: options.chatType ?? "supergroup",
          title: "Stablecoin desk",
        },
        from: options.from ?? { id: 999, username: "requester" },
        old_chat_member: { status: options.oldStatus ?? "left" },
        new_chat_member: { status: options.newStatus ?? "member" },
      },
    },
    { secret: options.secret, updateId: options.updateId },
  );
}

function makeChatMigrationRequest(options: {
  chatId: number;
  migrateToChatId?: number;
  migrateFromChatId?: number;
  updateId?: number;
  secret?: string;
}): Request {
  return makeTelegramUpdateRequest(
    {
      message: {
        chat: { id: options.chatId, type: "supergroup" },
        ...(options.migrateToChatId != null ? { migrate_to_chat_id: options.migrateToChatId } : {}),
        ...(options.migrateFromChatId != null ? { migrate_from_chat_id: options.migrateFromChatId } : {}),
      },
    },
    { secret: options.secret, updateId: options.updateId },
  );
}

function makeCallbackRequest(
  data: string,
  options: {
    chatId?: number;
    chatType?: string;
    fromId?: number;
    fromUsername?: string;
    messageId?: number;
    updateId?: number;
    secret?: string;
  } = {},
): Request {
  return makeTelegramUpdateRequest(
    {
      callback_query: {
        id: "cb1",
        data,
        from: { id: options.fromId ?? 999, username: options.fromUsername ?? "requester" },
        message: {
          chat: { id: options.chatId ?? 123, type: options.chatType ?? "private" },
          message_id: options.messageId ?? 1,
        },
      },
    },
    { secret: options.secret, updateId: options.updateId },
  );
}

function sentMessageBody(callIndex = 0): { text: string; reply_markup?: unknown } {
  const call = fetchSpy.mock.calls[callIndex];
  if (!call?.[1]?.body || typeof call[1].body !== "string") {
    throw new Error("Expected sendToChat to call fetch with a string JSON body");
  }
  return telegramCallBody<{ text: string; reply_markup?: unknown }>(call);
}

function latestSendMessageBody(): { text: string; reply_markup?: unknown } {
  return lastSendMessageBody(fetchSpy);
}

type InlineButton = {
  text?: string;
  callback_data?: string;
  url?: string;
  web_app?: { url?: string };
};

function inlineButtons(body: { reply_markup?: unknown }): InlineButton[] {
  const markup = body.reply_markup as { inline_keyboard?: InlineButton[][] } | undefined;
  return (markup?.inline_keyboard ?? []).flat();
}

function expectMiniAppButton(body: { reply_markup?: unknown }, text: string, startapp: string): void {
  expect(
    inlineButtons(body).some((button) => button.text === text && button.web_app?.url?.includes(`startapp=${startapp}`)),
  ).toBe(true);
}

function makeSetupPendingRow(
  actionPayload: Record<string, unknown>,
  options: { expiresAt?: number; initiatorUserId?: string | null } = {},
): Record<string, unknown> {
  return {
    action_type: "setup-step",
    action_payload: JSON.stringify(actionPayload),
    alert_types: JSON.stringify([]),
    resolved_ids: JSON.stringify([]),
    ambiguous_ticker: "",
    candidates: JSON.stringify([]),
    remaining_tickers: JSON.stringify([]),
    expires_at: options.expiresAt ?? Math.floor(Date.now() / 1000) + 60,
    initiator_user_id: options.initiatorUserId ?? null,
  };
}

function makeStablecoinsCacheValue(overrides: Record<string, number>): string {
  return JSON.stringify({
    peggedAssets: [
      { id: "usdt-tether", symbol: "USDT", circulating: { usd: overrides["usdt-tether"] ?? 0 } },
      { id: "usdc-circle", symbol: "USDC", circulating: { usd: overrides["usdc-circle"] ?? 0 } },
      { id: "dai-makerdao", symbol: "DAI", circulating: { usd: overrides["dai-makerdao"] ?? 0 } },
      { id: "pyusd-paypal", symbol: "PYUSD", circulating: { usd: overrides["pyusd-paypal"] ?? 0 } },
      { id: "eurc-circle", symbol: "EURC", circulating: { usd: overrides["eurc-circle"] ?? 0 } },
      { id: "xaut-tether", symbol: "XAUT", circulating: { usd: overrides["xaut-tether"] ?? 0 } },
      { id: "paxg-paxos", symbol: "PAXG", circulating: { usd: overrides["paxg-paxos"] ?? 0 } },
    ],
  });
}
function resetTelegramWebhookTest() {
  resetTelegramFetchSpy();
  resetTelegramInvalidSecretLogStateForTests();
}

const fixtureMockD1 = mockTelegramD1;
const fixtureLastSendMessageBody = lastSendMessageBody;
const fixtureTelegramApiCallBody = telegramApiCallBody;

const COMMAND_DB_EXTRA_TABLES: MockTableConfig[] = [
  { match: "RETURNING value", rows: [{ value: "1" }] },
];

const LIFECYCLE_DB_EXTRA_TABLES: MockTableConfig[] = [
  { match: "SELECT status, received_at, effect_state, claim_owner, claim_generation", rows: [], first: null },
];

export function makeTelegramWebhookDb(
  tables: MockTableConfig[] = [],
  options: MockTelegramD1Options = {},
  profile: "command" | "lifecycle" = "command",
): MockD1Database {
  const defaults = profile === "lifecycle" ? LIFECYCLE_DB_EXTRA_TABLES : COMMAND_DB_EXTRA_TABLES;
  return mockTelegramD1(tables, { ...options, fallbackTables: defaults });
}

export {
  fetchSpy,
  handleTelegramWebhook,
  TELEGRAM_GROUP_ADMIN_GATING,
  resolveTicker,
  FROZEN_STABLECOINS,
  resetTelegramInvalidSecretLogStateForTests,
  encodeWatchlistToken,
  makeWebhookRequest,
  makeMyChatMemberRequest,
  makeChatMigrationRequest,
  makeCallbackRequest,
  sentMessageBody,
  latestSendMessageBody,
  inlineButtons,
  expectMiniAppButton,
  makeSetupPendingRow,
  makeStablecoinsCacheValue,
  resetTelegramWebhookTest,
  type InlineButton,
  fixtureMockD1,
  fixtureLastSendMessageBody,
  fixtureTelegramApiCallBody,
};
