import { vi } from "vitest";
import {
  createTelegramFetchSpy,
  telegramApiCallBody,
} from "../../../test-helpers/__shared/telegram";
import {
  mockTelegramD1 as baseMockTelegramD1,
  type MockTelegramD1Options,
} from "../../../test-helpers/__shared/telegram";
import type { MockTableConfig } from "@shared/test-utils/mock-d1";
import type { TelegramCallbackQuery } from "../../callbacks";

export function mockTelegramD1(tables: MockTableConfig[] = [], options: MockTelegramD1Options = {}) {
  return baseMockTelegramD1(tables, {
    ...options,
    fallbackTables: [
      ...(options.fallbackTables ?? []),
      // Store enable batches include the idempotent first-follow claim.
      { match: "INSERT OR IGNORE INTO telegram_subscribers", rows: [] },
      { match: "INSERT INTO telegram_adoption_daily", rows: [] },
    ],
  });
}

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

const { handleCallbackQuery } = await import("../telegram-webhook-update-dispatch");
const { sendAuditedTelegramReply } = await import("../telegram-webhook-replies");
const { resolveTicker } = await import("../../common/alerts-parser");

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

export function makeCallbackQuery(
  data: string,
  options: Omit<Partial<TelegramCallbackQuery>, "message"> & {
    message?: NonNullable<TelegramCallbackQuery["message"]> & Record<string, unknown>;
  } = {},
): TelegramCallbackQuery {
  return {
    id: "cb1",
    data,
    from: { id: 1, username: "alice" },
    message: { chat: { id: 42, type: "private" }, message_id: 999 },
    ...options,
  };
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
  resetCallbackTest,
};
