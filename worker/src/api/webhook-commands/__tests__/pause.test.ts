import { beforeEach, describe, expect, it, vi } from "vitest";
import { mockD1 as baseMockD1 } from "@shared/test-utils/mock-d1";
import { PAUSE_SENTINEL_TS } from "../../../lib/telegram/constants";
import type { WebhookCommandContext } from "../context";
import { handlePause } from "../pause";

type InlineButton = { text?: string; web_app?: { url?: string } };

function mockD1(
  tables: Parameters<typeof baseMockD1>[0] = [],
  options: Parameters<typeof baseMockD1>[1] = {},
) {
  return baseMockD1([
    ...tables,
    { match: "INSERT INTO telegram_subscribers", rows: [] },
  ], options);
}

function makeContext(overrides: Partial<WebhookCommandContext> = {}): WebhookCommandContext {
  return {
    db: mockD1(),
    chatId: "42",
    chatType: "private",
    username: "alice",
    actorUserId: "99",
    botToken: "bot-token",
    replyToChat: vi.fn().mockResolvedValue(undefined),
    replyToChatWithMarkup: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

function buttonsFromMarkup(markup: unknown): InlineButton[] {
  const typed = markup as { inline_keyboard?: InlineButton[][] } | undefined;
  return (typed?.inline_keyboard ?? []).flat();
}

describe("/pause command", () => {
  beforeEach(() => {
    vi.useRealTimers();
  });

  it("writes the durable Paused sentinel with no arg", async () => {
    const db = mockD1();
    const replyToChatWithMarkup = vi.fn().mockResolvedValue(undefined);
    const ctx = makeContext({ db, replyToChatWithMarkup });

    await handlePause(ctx, "");

    expect(
      db.getHistory().some((entry) =>
        entry.sql.includes("alert_snooze_until_ts = excluded.alert_snooze_until_ts") &&
        entry.binds.includes(PAUSE_SENTINEL_TS),
      ),
    ).toBe(true);
    const buttons = buttonsFromMarkup(replyToChatWithMarkup.mock.calls[0]?.[1]?.replyMarkup);
    expect(buttons.some((b) => b.text === "Open in app" && b.web_app?.url?.includes("startapp=snooze"))).toBe(true);
  });

  it("clears the snooze on /pause off", async () => {
    const db = mockD1();
    const ctx = makeContext({ db });

    await handlePause(ctx, "off");

    expect(db.getHistory().some((entry) => entry.sql.includes("alert_snooze_until_ts = NULL"))).toBe(true);
    expect(db.getHistory().some((entry) => entry.binds.includes(PAUSE_SENTINEL_TS))).toBe(false);
  });

  it("clears the snooze on /pause resume", async () => {
    const db = mockD1();
    const ctx = makeContext({ db });

    await handlePause(ctx, "resume");

    expect(db.getHistory().some((entry) => entry.sql.includes("alert_snooze_until_ts = NULL"))).toBe(true);
  });

  it("writes a timed snooze (not the sentinel) for /pause 4h", async () => {
    const nowMs = 1_700_000_000_000;
    vi.useFakeTimers();
    vi.setSystemTime(nowMs);
    const db = mockD1();
    const ctx = makeContext({ db });

    await handlePause(ctx, "4h");

    const expected = Math.floor(nowMs / 1000) + 4 * 60 * 60;
    expect(
      db.getHistory().some((entry) =>
        entry.sql.includes("alert_snooze_until_ts = excluded.alert_snooze_until_ts") &&
        entry.binds.includes(expected),
      ),
    ).toBe(true);
    expect(db.getHistory().some((entry) => entry.binds.includes(PAUSE_SENTINEL_TS))).toBe(false);
    vi.useRealTimers();
  });

  it("replies with usage help for an unknown arg without writing state", async () => {
    const db = mockD1();
    const replyToChat = vi.fn().mockResolvedValue(undefined);
    const ctx = makeContext({ db, replyToChat });

    await handlePause(ctx, "forever");

    expect(replyToChat.mock.calls[0]?.[0]).toContain("Usage: /pause");
    expect(
      db.getHistory().some((entry) => entry.sql.includes("INSERT INTO telegram_subscribers")),
    ).toBe(false);
  });
});
