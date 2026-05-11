import { beforeEach, describe, expect, it, vi } from "vitest";
import { mockD1 } from "../../api/__tests__/helpers/mock-d1";
import {
  buildTelegramWebhookUrl,
  reconcileTelegramCommandRegistration,
  reconcileTelegramProfileRegistration,
  reconcileTelegramWebhookRegistration,
  TELEGRAM_BOT_COMMANDS,
  TELEGRAM_BOT_DESCRIPTION,
  TELEGRAM_BOT_GROUP_COMMANDS,
  TELEGRAM_BOT_NAME,
  TELEGRAM_BOT_SHORT_DESCRIPTION,
} from "../telegram-webhook-registration";

const fetchSpy = vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>();
vi.stubGlobal("fetch", fetchSpy);

async function secretTokenMarker(secret = "secret-token"): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(secret));
  return Array.from(new Uint8Array(digest))
    .slice(0, 16)
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

async function expectedWebhookCacheValue(
  url = "https://api.pharos.watch/api/telegram-webhook",
  secret = "secret-token",
): Promise<string> {
  return JSON.stringify({
    version: 2,
    url,
    allowed_updates: ["message", "callback_query"],
    secret_token: {
      present: true,
      marker: await secretTokenMarker(secret),
    },
  });
}

function expectedCommandsCacheValue(): string {
  return JSON.stringify({
    version: 3,
    scopes: {
      all_private_chats: TELEGRAM_BOT_COMMANDS,
      all_group_chats: TELEGRAM_BOT_GROUP_COMMANDS,
    },
  });
}

function expectedProfileCacheValue(): string {
  return JSON.stringify({
    version: 1,
    name: TELEGRAM_BOT_NAME,
    short_description: TELEGRAM_BOT_SHORT_DESCRIPTION,
    description: TELEGRAM_BOT_DESCRIPTION,
  });
}

describe("buildTelegramWebhookUrl", () => {
  it("uses the configured SELF_URL when valid", () => {
    expect(buildTelegramWebhookUrl("https://ops.example.com/base")).toBe(
      "https://ops.example.com/api/telegram-webhook",
    );
  });

  it("falls back to the production API origin when SELF_URL is invalid", () => {
    expect(buildTelegramWebhookUrl("not a url")).toBe("https://api.pharos.watch/api/telegram-webhook");
  });
});

describe("reconcileTelegramWebhookRegistration", () => {
  beforeEach(() => {
    fetchSpy.mockReset();
  });

  it("skips the Telegram API call when the reconciliation cache is still fresh", async () => {
    const nowSec = Math.floor(Date.now() / 1000);
    const db = mockD1([
      {
        match: "SELECT value, updated_at FROM cache WHERE key = ?",
        matchBinds: ["telegram:webhook-reconciled"],
        rows: [{ value: await expectedWebhookCacheValue(), updated_at: nowSec }],
      },
    ], { requireMatch: true });

    const result = await reconcileTelegramWebhookRegistration(db, {
      botToken: "bot-token",
      webhookSecret: "secret-token",
      selfUrl: "https://api.pharos.watch",
    });

    expect(result).toMatchObject({
      attempted: false,
      skipped: true,
      reason: "fresh-cache",
      expectedUrl: "https://api.pharos.watch/api/telegram-webhook",
    });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("registers the webhook with allowed updates and records the reconciliation cache", async () => {
    const db = mockD1([
      {
        match: "SELECT value, updated_at FROM cache WHERE key = ?",
        matchBinds: ["telegram:webhook-reconciled"],
        rows: [],
        first: null,
      },
      {
        match: "INSERT OR REPLACE INTO cache (key, value, updated_at) VALUES (?, ?, ?)",
        rows: [],
      },
    ]);
    fetchSpy.mockResolvedValueOnce(new Response(JSON.stringify({ ok: true }), { status: 200 }));

    const result = await reconcileTelegramWebhookRegistration(db, {
      botToken: "bot-token",
      webhookSecret: "secret-token",
      selfUrl: "https://api.pharos.watch",
    });

    expect(result).toMatchObject({
      attempted: true,
      skipped: false,
      expectedUrl: "https://api.pharos.watch/api/telegram-webhook",
    });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(fetchSpy.mock.calls[0]?.[0]).toBe("https://api.telegram.org/botbot-token/setWebhook");
    const body = JSON.parse(fetchSpy.mock.calls[0]?.[1]?.body as string);
    expect(body).toEqual({
      url: "https://api.pharos.watch/api/telegram-webhook",
      secret_token: "secret-token",
      allowed_updates: ["message", "callback_query"],
    });
    const writes = db.getHistory().filter((entry) =>
      entry.sql.includes("INSERT OR REPLACE INTO cache (key, value, updated_at) VALUES (?, ?, ?)"),
    );
    expect(writes).toHaveLength(1);
    expect(writes[0]?.binds[0]).toBe("telegram:webhook-reconciled");
    expect(writes[0]?.binds[1]).toBe(await expectedWebhookCacheValue());
    expect(typeof writes[0]?.binds[2]).toBe("number");
  });

  it("re-registers when a fresh cached config does not match the effective webhook config", async () => {
    const nowSec = Math.floor(Date.now() / 1000);
    const db = mockD1([
      {
        match: "SELECT value, updated_at FROM cache WHERE key = ?",
        matchBinds: ["telegram:webhook-reconciled"],
        rows: [{
          value: JSON.stringify({
            version: 2,
            url: "https://api.pharos.watch/api/telegram-webhook",
            allowed_updates: ["message"],
            secret_token: {
              present: true,
              marker: await secretTokenMarker(),
            },
          }),
          updated_at: nowSec,
        }],
      },
      {
        match: "INSERT OR REPLACE INTO cache (key, value, updated_at) VALUES (?, ?, ?)",
        rows: [],
      },
    ], { requireMatch: true });
    fetchSpy.mockResolvedValueOnce(new Response(JSON.stringify({ ok: true }), { status: 200 }));

    const result = await reconcileTelegramWebhookRegistration(db, {
      botToken: "bot-token",
      webhookSecret: "secret-token",
      selfUrl: "https://api.pharos.watch",
    });

    expect(result).toMatchObject({
      attempted: true,
      skipped: false,
      expectedUrl: "https://api.pharos.watch/api/telegram-webhook",
    });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const body = JSON.parse(fetchSpy.mock.calls[0]?.[1]?.body as string);
    expect(body.allowed_updates).toEqual(["message", "callback_query"]);
  });

  it("re-registers when the cached secret marker belongs to a previous secret", async () => {
    const nowSec = Math.floor(Date.now() / 1000);
    const db = mockD1([
      {
        match: "SELECT value, updated_at FROM cache WHERE key = ?",
        matchBinds: ["telegram:webhook-reconciled"],
        rows: [{ value: await expectedWebhookCacheValue(undefined, "old-secret-token"), updated_at: nowSec }],
      },
      {
        match: "INSERT OR REPLACE INTO cache (key, value, updated_at) VALUES (?, ?, ?)",
        rows: [],
      },
    ], { requireMatch: true });
    fetchSpy.mockResolvedValueOnce(new Response(JSON.stringify({ ok: true }), { status: 200 }));

    const result = await reconcileTelegramWebhookRegistration(db, {
      botToken: "bot-token",
      webhookSecret: "secret-token",
      selfUrl: "https://api.pharos.watch",
    });

    expect(result).toMatchObject({
      attempted: true,
      skipped: false,
      expectedUrl: "https://api.pharos.watch/api/telegram-webhook",
    });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("re-registers when the matching cached config is stale", async () => {
    const staleUpdatedAtSec = Math.floor(Date.now() / 1000) - 901;
    const db = mockD1([
      {
        match: "SELECT value, updated_at FROM cache WHERE key = ?",
        matchBinds: ["telegram:webhook-reconciled"],
        rows: [{ value: await expectedWebhookCacheValue(), updated_at: staleUpdatedAtSec }],
      },
      {
        match: "INSERT OR REPLACE INTO cache (key, value, updated_at) VALUES (?, ?, ?)",
        rows: [],
      },
    ], { requireMatch: true });
    fetchSpy.mockResolvedValueOnce(new Response(JSON.stringify({ ok: true }), { status: 200 }));

    const result = await reconcileTelegramWebhookRegistration(db, {
      botToken: "bot-token",
      webhookSecret: "secret-token",
      selfUrl: "https://api.pharos.watch",
    });

    expect(result).toMatchObject({
      attempted: true,
      skipped: false,
      expectedUrl: "https://api.pharos.watch/api/telegram-webhook",
    });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("continues registering only the current secret token", async () => {
    const db = mockD1([
      {
        match: "SELECT value, updated_at FROM cache WHERE key = ?",
        matchBinds: ["telegram:webhook-reconciled"],
        rows: [],
        first: null,
      },
      {
        match: "INSERT OR REPLACE INTO cache (key, value, updated_at) VALUES (?, ?, ?)",
        rows: [],
      },
    ]);
    fetchSpy.mockResolvedValueOnce(new Response(JSON.stringify({ ok: true }), { status: 200 }));

    await reconcileTelegramWebhookRegistration(db, {
      botToken: "bot-token",
      webhookSecret: "current-secret",
      selfUrl: "https://api.pharos.watch",
    });

    const body = JSON.parse(fetchSpy.mock.calls[0]?.[1]?.body as string);
    expect(body.secret_token).toBe("current-secret");
  });

  it("throws when Telegram rejects the registration", async () => {
    const db = mockD1([
      {
        match: "SELECT value, updated_at FROM cache WHERE key = ?",
        matchBinds: ["telegram:webhook-reconciled"],
        rows: [],
        first: null,
      },
    ], { requireMatch: true });
    fetchSpy.mockResolvedValueOnce(
      new Response(JSON.stringify({ ok: false, description: "Bad webhook: failed to resolve host" }), { status: 200 }),
    );

    await expect(
      reconcileTelegramWebhookRegistration(db, {
        botToken: "bot-token",
        webhookSecret: "secret-token",
        selfUrl: "https://api.pharos.watch",
      }),
    ).rejects.toThrow("Telegram setWebhook rejected registration");
  });
});

describe("reconcileTelegramCommandRegistration", () => {
  beforeEach(() => {
    fetchSpy.mockReset();
  });

  it("skips the Telegram API call when the command reconciliation cache is still fresh", async () => {
    const nowSec = Math.floor(Date.now() / 1000);
    const db = mockD1([
      {
        match: "SELECT value, updated_at FROM cache WHERE key = ?",
        matchBinds: ["telegram:commands-reconciled"],
        rows: [{ value: expectedCommandsCacheValue(), updated_at: nowSec }],
      },
    ], { requireMatch: true });

    const result = await reconcileTelegramCommandRegistration(db, {
      botToken: "bot-token",
    });

    expect(result).toEqual({
      attempted: false,
      skipped: true,
      reason: "fresh-cache",
    });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("registers scoped slash-command suggestions for private and group chats and records the reconciliation cache", async () => {
    const db = mockD1([
      {
        match: "SELECT value, updated_at FROM cache WHERE key = ?",
        matchBinds: ["telegram:commands-reconciled"],
        rows: [],
        first: null,
      },
      {
        match: "INSERT OR REPLACE INTO cache (key, value, updated_at) VALUES (?, ?, ?)",
        rows: [],
      },
    ], { requireMatch: true });
    fetchSpy.mockResolvedValueOnce(new Response(JSON.stringify({ ok: true }), { status: 200 }));
    fetchSpy.mockResolvedValueOnce(new Response(JSON.stringify({ ok: true }), { status: 200 }));

    const result = await reconcileTelegramCommandRegistration(db, {
      botToken: "bot-token",
    });

    expect(result).toEqual({
      attempted: true,
      skipped: false,
    });
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(fetchSpy.mock.calls[0]?.[0]).toBe("https://api.telegram.org/botbot-token/setMyCommands");
    expect(fetchSpy.mock.calls[1]?.[0]).toBe("https://api.telegram.org/botbot-token/setMyCommands");

    const privateBody = JSON.parse(fetchSpy.mock.calls[0]?.[1]?.body as string);
    expect(privateBody).toEqual({
      commands: TELEGRAM_BOT_COMMANDS,
      scope: { type: "all_private_chats" },
    });
    expect(privateBody.commands.map((entry: { command: string }) => entry.command)).toEqual([
      "start",
      "help",
      "status",
      "brief",
      "top",
      "why",
      "coverage",
      "list",
      "subscribe",
      "unsubscribe",
      "presets",
      "set",
      "settings",
      "mute",
      "unsnooze",
      "unmutehours",
      "cancel",
    ]);

    const groupBody = JSON.parse(fetchSpy.mock.calls[1]?.[1]?.body as string);
    expect(groupBody).toEqual({
      commands: TELEGRAM_BOT_GROUP_COMMANDS,
      scope: { type: "all_group_chats" },
    });
    expect(groupBody.commands.map((entry: { command: string }) => entry.command)).toEqual([
      "subscribe",
      "unsubscribe",
      "list",
      "status",
      "mute",
      "help",
    ]);

    const writes = db.getHistory().filter((entry) =>
      entry.sql.includes("INSERT OR REPLACE INTO cache (key, value, updated_at) VALUES (?, ?, ?)"),
    );
    expect(writes).toHaveLength(1);
    expect(writes[0]?.binds[0]).toBe("telegram:commands-reconciled");
    expect(writes[0]?.binds[1]).toBe(expectedCommandsCacheValue());
    expect(typeof writes[0]?.binds[2]).toBe("number");
  });

  it("skips the second scope call when Telegram rejects the private-chat registration", async () => {
    const db = mockD1([
      {
        match: "SELECT value, updated_at FROM cache WHERE key = ?",
        matchBinds: ["telegram:commands-reconciled"],
        rows: [],
        first: null,
      },
    ], { requireMatch: true });
    fetchSpy.mockResolvedValueOnce(
      new Response(JSON.stringify({ ok: false, description: "Bad Request: command is invalid" }), { status: 200 }),
    );

    await expect(
      reconcileTelegramCommandRegistration(db, {
        botToken: "bot-token",
      }),
    ).rejects.toThrow("Telegram setMyCommands rejected registration (scope=all_private_chats)");
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("throws when Telegram rejects the group-chat registration after a successful private-chat call", async () => {
    const db = mockD1([
      {
        match: "SELECT value, updated_at FROM cache WHERE key = ?",
        matchBinds: ["telegram:commands-reconciled"],
        rows: [],
        first: null,
      },
    ], { requireMatch: true });
    fetchSpy.mockResolvedValueOnce(new Response(JSON.stringify({ ok: true }), { status: 200 }));
    fetchSpy.mockResolvedValueOnce(
      new Response(JSON.stringify({ ok: false, description: "Bad Request: command is invalid" }), { status: 200 }),
    );

    await expect(
      reconcileTelegramCommandRegistration(db, {
        botToken: "bot-token",
      }),
    ).rejects.toThrow("Telegram setMyCommands rejected registration (scope=all_group_chats)");
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });
});

describe("reconcileTelegramProfileRegistration", () => {
  beforeEach(() => {
    fetchSpy.mockReset();
  });

  it("skips the Telegram API call when the profile reconciliation cache is still fresh", async () => {
    const nowSec = Math.floor(Date.now() / 1000);
    const db = mockD1([
      {
        match: "SELECT value, updated_at FROM cache WHERE key = ?",
        matchBinds: ["telegram:profile-reconciled"],
        rows: [{ value: expectedProfileCacheValue(), updated_at: nowSec }],
      },
    ], { requireMatch: true });

    const result = await reconcileTelegramProfileRegistration(db, {
      botToken: "bot-token",
    });

    expect(result).toEqual({
      attempted: false,
      skipped: true,
      reason: "fresh-cache",
    });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("registers name, short description, and description and records the cache marker", async () => {
    const db = mockD1([
      {
        match: "SELECT value, updated_at FROM cache WHERE key = ?",
        matchBinds: ["telegram:profile-reconciled"],
        rows: [],
        first: null,
      },
      {
        match: "INSERT OR REPLACE INTO cache (key, value, updated_at) VALUES (?, ?, ?)",
        rows: [],
      },
    ], { requireMatch: true });
    fetchSpy.mockImplementation(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }));

    const result = await reconcileTelegramProfileRegistration(db, {
      botToken: "bot-token",
    });

    expect(result).toEqual({ attempted: true, skipped: false });
    expect(fetchSpy).toHaveBeenCalledTimes(3);
    expect(fetchSpy.mock.calls[0]?.[0]).toBe("https://api.telegram.org/botbot-token/setMyName");
    expect(JSON.parse(fetchSpy.mock.calls[0]?.[1]?.body as string)).toEqual({ name: TELEGRAM_BOT_NAME });
    expect(fetchSpy.mock.calls[1]?.[0]).toBe("https://api.telegram.org/botbot-token/setMyShortDescription");
    expect(JSON.parse(fetchSpy.mock.calls[1]?.[1]?.body as string)).toEqual({
      short_description: TELEGRAM_BOT_SHORT_DESCRIPTION,
    });
    expect(fetchSpy.mock.calls[2]?.[0]).toBe("https://api.telegram.org/botbot-token/setMyDescription");
    expect(JSON.parse(fetchSpy.mock.calls[2]?.[1]?.body as string)).toEqual({
      description: TELEGRAM_BOT_DESCRIPTION,
    });

    const writes = db.getHistory().filter((entry) =>
      entry.sql.includes("INSERT OR REPLACE INTO cache (key, value, updated_at) VALUES (?, ?, ?)"),
    );
    expect(writes).toHaveLength(1);
    expect(writes[0]?.binds[0]).toBe("telegram:profile-reconciled");
    expect(writes[0]?.binds[1]).toBe(expectedProfileCacheValue());
  });

  it('treats Telegram "is not modified" 400 as success and still refreshes the cache marker', async () => {
    const db = mockD1([
      {
        match: "SELECT value, updated_at FROM cache WHERE key = ?",
        matchBinds: ["telegram:profile-reconciled"],
        rows: [],
        first: null,
      },
      {
        match: "INSERT OR REPLACE INTO cache (key, value, updated_at) VALUES (?, ?, ?)",
        rows: [],
      },
    ], { requireMatch: true });
    fetchSpy.mockImplementation(async () =>
      new Response(
        JSON.stringify({ ok: false, description: "Bad Request: bot description is not modified" }),
        { status: 400 },
      ),
    );

    const result = await reconcileTelegramProfileRegistration(db, {
      botToken: "bot-token",
    });

    expect(result).toEqual({ attempted: true, skipped: false });
    expect(fetchSpy).toHaveBeenCalledTimes(3);
    const writes = db.getHistory().filter((entry) =>
      entry.sql.includes("INSERT OR REPLACE INTO cache (key, value, updated_at) VALUES (?, ?, ?)"),
    );
    expect(writes).toHaveLength(1);
  });

  it("throws when Telegram rejects with a non-idempotent error", async () => {
    const db = mockD1([
      {
        match: "SELECT value, updated_at FROM cache WHERE key = ?",
        matchBinds: ["telegram:profile-reconciled"],
        rows: [],
        first: null,
      },
    ], { requireMatch: true });
    fetchSpy.mockResolvedValueOnce(
      new Response(JSON.stringify({ ok: false, description: "Bad Request: NAME_TOO_LONG" }), { status: 400 }),
    );

    await expect(
      reconcileTelegramProfileRegistration(db, {
        botToken: "bot-token",
      }),
    ).rejects.toThrow("Telegram setMyName");
  });

  it("returns missing-bot-token when no token is configured", async () => {
    const db = mockD1([], { requireMatch: true });
    const result = await reconcileTelegramProfileRegistration(db, { botToken: "" });
    expect(result).toEqual({ attempted: false, skipped: true, reason: "missing-bot-token" });
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
