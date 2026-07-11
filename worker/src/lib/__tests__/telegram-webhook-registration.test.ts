import { beforeEach, describe, expect, it, vi } from "vitest";
import { mockD1, type MockTableConfig } from "../../test-helpers/__shared/mock-d1";
import {
  buildTelegramMiniAppUrl,
  buildTelegramWebhookUrl,
  reconcileTelegramCommandRegistration,
  reconcileTelegramMenuButton,
  reconcileTelegramProfileRegistration,
  reconcileTelegramWebhookRegistration,
  TELEGRAM_ALLOWED_UPDATES,
  TELEGRAM_BOT_COMMANDS,
  TELEGRAM_BOT_DESCRIPTION,
  TELEGRAM_BOT_GROUP_COMMANDS,
  TELEGRAM_BOT_NAME,
  TELEGRAM_BOT_SHORT_DESCRIPTION,
  TELEGRAM_MINI_APP_BUTTON_TEXT,
  TELEGRAM_MINI_APP_URL,
} from "../telegram-webhook-registration";

const fetchSpy = vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>();
vi.stubGlobal("fetch", fetchSpy);

const MINI_APP_MVP_ALLOWED_UPDATES = ["message", "callback_query", "my_chat_member"] as const;
const CACHE_SELECT_MATCH = "SELECT value, updated_at FROM cache WHERE key = ?";
const CACHE_WRITE_MATCH = "INSERT OR REPLACE INTO cache (key, value, updated_at) VALUES (?, ?, ?)";
const PROFILE_BACKOFF_METHODS = ["setMyName", "setMyShortDescription", "setMyDescription"] as const;

type CacheRow = { value: string; updated_at: number };

function cacheSelectEntry(key: string, row: CacheRow | null = null): MockTableConfig {
  return {
    match: CACHE_SELECT_MATCH,
    matchBinds: [key],
    rows: row ? [row] : [],
    first: row,
  };
}

function cacheWriteEntry(): MockTableConfig {
  return {
    match: CACHE_WRITE_MATCH,
    rows: [],
  };
}

function profileBackoffSelectEntries(rows: Partial<Record<(typeof PROFILE_BACKOFF_METHODS)[number], CacheRow>> = {}) {
  return PROFILE_BACKOFF_METHODS.map((method) =>
    cacheSelectEntry(`telegram:reconcile:429:${method}`, rows[method] ?? null),
  );
}

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
    allowed_updates: ["message", "callback_query", "my_chat_member"],
    secret_token: {
      present: true,
      marker: await secretTokenMarker(secret),
    },
  });
}

function expectedCommandsCacheValue(): string {
  return JSON.stringify({
    version: 8,
    scopes: {
      all_private_chats: TELEGRAM_BOT_COMMANDS,
      all_group_chats: TELEGRAM_BOT_GROUP_COMMANDS,
    },
  });
}

function expectedProfileCacheValue(): string {
  return JSON.stringify({
    version: 3,
    name: TELEGRAM_BOT_NAME,
    short_description: TELEGRAM_BOT_SHORT_DESCRIPTION,
    description: TELEGRAM_BOT_DESCRIPTION,
  });
}

function expectedMenuCacheValue(url = TELEGRAM_MINI_APP_URL): string {
  return JSON.stringify({
    version: 1,
    menu_button: {
      type: "web_app",
      text: TELEGRAM_MINI_APP_BUTTON_TEXT,
      web_app: { url },
    },
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

describe("buildTelegramMiniAppUrl", () => {
  it("adds sanitized startapp context to the Mini App URL", () => {
    expect(buildTelegramMiniAppUrl(" coin_usdc-circle ")).toBe(
      "https://pharos.watch/pharoswatchbot/app/?startapp=coin_usdc-circle",
    );
    expect(buildTelegramMiniAppUrl()).toBe(TELEGRAM_MINI_APP_URL);
  });
});

describe("reconcileTelegramWebhookRegistration", () => {
  beforeEach(() => {
    fetchSpy.mockReset();
  });

  it("keeps Mini App MVP webhook updates limited to handled update types", () => {
    expect([...TELEGRAM_ALLOWED_UPDATES]).toEqual([...MINI_APP_MVP_ALLOWED_UPDATES]);
    expect(TELEGRAM_ALLOWED_UPDATES).not.toContain("web_app_data");
  });

  it("skips the Telegram API call when the reconciliation cache is still fresh", async () => {
    const nowSec = Math.floor(Date.now() / 1000);
    const db = mockD1(
      [
        {
          match: CACHE_SELECT_MATCH,
          matchBinds: ["telegram:webhook-reconciled"],
          rows: [{ value: await expectedWebhookCacheValue(), updated_at: nowSec }],
        },
      ],
      { requireMatch: true },
    );

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
        match: CACHE_SELECT_MATCH,
        matchBinds: ["telegram:webhook-reconciled"],
        rows: [],
        first: null,
      },
      {
        match: CACHE_SELECT_MATCH,
        rows: [],
        first: null,
      },
      {
        match: CACHE_WRITE_MATCH,
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
      allowed_updates: ["message", "callback_query", "my_chat_member"],
    });
    expect(body.allowed_updates).toHaveLength(MINI_APP_MVP_ALLOWED_UPDATES.length);
    expect(body.allowed_updates).not.toContain("web_app_data");
    const writes = db.getHistory().filter((entry) => entry.sql.includes(CACHE_WRITE_MATCH));
    expect(writes).toHaveLength(1);
    expect(writes[0]?.binds[0]).toBe("telegram:webhook-reconciled");
    expect(writes[0]?.binds[1]).toBe(await expectedWebhookCacheValue());
    expect(typeof writes[0]?.binds[2]).toBe("number");
  });

  it("re-registers when a fresh cached config does not match the effective webhook config", async () => {
    const nowSec = Math.floor(Date.now() / 1000);
    const db = mockD1(
      [
        {
          match: CACHE_SELECT_MATCH,
          matchBinds: ["telegram:webhook-reconciled"],
          rows: [
            {
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
            },
          ],
        },
        {
          match: CACHE_SELECT_MATCH,
          rows: [],
          first: null,
        },
        {
          match: CACHE_WRITE_MATCH,
          rows: [],
        },
      ],
      { requireMatch: true },
    );
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
    expect(body.allowed_updates).toEqual(["message", "callback_query", "my_chat_member"]);
  });

  it("re-registers when the cached secret marker belongs to a previous secret", async () => {
    const nowSec = Math.floor(Date.now() / 1000);
    const db = mockD1(
      [
        {
          match: CACHE_SELECT_MATCH,
          matchBinds: ["telegram:webhook-reconciled"],
          rows: [{ value: await expectedWebhookCacheValue(undefined, "old-secret-token"), updated_at: nowSec }],
        },
        {
          match: CACHE_SELECT_MATCH,
          rows: [],
          first: null,
        },
        {
          match: CACHE_WRITE_MATCH,
          rows: [],
        },
      ],
      { requireMatch: true },
    );
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
    const db = mockD1(
      [
        {
          match: CACHE_SELECT_MATCH,
          matchBinds: ["telegram:webhook-reconciled"],
          rows: [{ value: await expectedWebhookCacheValue(), updated_at: staleUpdatedAtSec }],
        },
        {
          match: CACHE_SELECT_MATCH,
          rows: [],
          first: null,
        },
        {
          match: CACHE_WRITE_MATCH,
          rows: [],
        },
      ],
      { requireMatch: true },
    );
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
        match: CACHE_SELECT_MATCH,
        matchBinds: ["telegram:webhook-reconciled"],
        rows: [],
        first: null,
      },
      {
        match: CACHE_SELECT_MATCH,
        rows: [],
        first: null,
      },
      {
        match: CACHE_WRITE_MATCH,
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
    const db = mockD1(
      [
        {
          match: CACHE_SELECT_MATCH,
          matchBinds: ["telegram:webhook-reconciled"],
          rows: [],
          first: null,
        },
        {
          match: CACHE_SELECT_MATCH,
          rows: [],
          first: null,
        },
      ],
      { requireMatch: true },
    );
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

describe("reconcileTelegramMenuButton", () => {
  beforeEach(() => {
    fetchSpy.mockReset();
  });

  it("sets the default Web App menu button and records the cache marker", async () => {
    const db = mockD1([
      {
        match: CACHE_SELECT_MATCH,
        matchBinds: ["telegram:menu-reconciled"],
        rows: [],
        first: null,
      },
      {
        match: CACHE_SELECT_MATCH,
        rows: [],
        first: null,
      },
      {
        match: CACHE_WRITE_MATCH,
        rows: [],
      },
    ]);
    fetchSpy
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true, result: { type: "default" } }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true, result: true }), { status: 200 }));

    const result = await reconcileTelegramMenuButton(db, { botToken: "bot-token" });

    expect(result).toEqual({ attempted: true, skipped: false, miniAppUrl: TELEGRAM_MINI_APP_URL });
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(fetchSpy.mock.calls[0]?.[0]).toBe("https://api.telegram.org/botbot-token/getChatMenuButton");
    expect(fetchSpy.mock.calls[1]?.[0]).toBe("https://api.telegram.org/botbot-token/setChatMenuButton");
    expect(JSON.parse(fetchSpy.mock.calls[1]?.[1]?.body as string)).toEqual({
      menu_button: {
        type: "web_app",
        text: "Manage Alerts",
        web_app: { url: TELEGRAM_MINI_APP_URL },
      },
    });
    const write = db
      .getHistory()
      .find(
        (entry) => entry.sql.includes("INSERT OR REPLACE INTO cache") && entry.binds[0] === "telegram:menu-reconciled",
      );
    expect(write?.binds[1]).toBe(expectedMenuCacheValue());
  });

  it("skips setChatMenuButton when the current menu button already matches", async () => {
    const db = mockD1([
      {
        match: CACHE_SELECT_MATCH,
        matchBinds: ["telegram:menu-reconciled"],
        rows: [],
        first: null,
      },
      {
        match: CACHE_WRITE_MATCH,
        rows: [],
      },
    ]);
    fetchSpy.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          ok: true,
          result: {
            type: "web_app",
            text: "Manage Alerts",
            web_app: { url: TELEGRAM_MINI_APP_URL },
          },
        }),
        { status: 200 },
      ),
    );

    const result = await reconcileTelegramMenuButton(db, { botToken: "bot-token" });

    expect(result).toEqual({
      attempted: true,
      skipped: false,
      reason: "already-current",
      miniAppUrl: TELEGRAM_MINI_APP_URL,
    });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });
});

describe("reconcileTelegramCommandRegistration", () => {
  beforeEach(() => {
    fetchSpy.mockReset();
  });

  it("skips the Telegram API call when the command reconciliation cache is still fresh", async () => {
    const nowSec = Math.floor(Date.now() / 1000);
    const db = mockD1(
      [
        {
          match: CACHE_SELECT_MATCH,
          matchBinds: ["telegram:commands-reconciled"],
          rows: [{ value: expectedCommandsCacheValue(), updated_at: nowSec }],
        },
      ],
      { requireMatch: true },
    );

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
    const db = mockD1(
      [
        {
          match: CACHE_SELECT_MATCH,
          matchBinds: ["telegram:commands-reconciled"],
          rows: [],
          first: null,
        },
        {
          match: CACHE_SELECT_MATCH,
          rows: [],
          first: null,
        },
        {
          match: CACHE_WRITE_MATCH,
          rows: [],
        },
      ],
      { requireMatch: true },
    );
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
      "sample",
      "status",
      "brief",
      "top",
      "why",
      "coverage",
      "health",
      "list",
      "subscribe",
      "unsubscribe",
      "presets",
      "set",
      "settings",
      "mute",
      "pause",
      "timezone",
      "unsnooze",
      "unmutehours",
      "cancel",
      "export",
      "import",
      "forget",
    ]);

    const groupBody = JSON.parse(fetchSpy.mock.calls[1]?.[1]?.body as string);
    expect(groupBody).toEqual({
      commands: TELEGRAM_BOT_GROUP_COMMANDS,
      scope: { type: "all_group_chats" },
    });
    expect(groupBody.commands.map((entry: { command: string }) => entry.command)).toEqual([
      "help",
      "sample",
      "status",
      "brief",
      "top",
      "why",
      "coverage",
      "health",
      "list",
      "subscribe",
      "unsubscribe",
      "presets",
      "set",
      "settings",
      "mute",
      "pause",
      "timezone",
      "unsnooze",
      "unmutehours",
      "cancel",
      "export",
      "import",
    ]);

    const writes = db.getHistory().filter((entry) => entry.sql.includes(CACHE_WRITE_MATCH));
    expect(writes).toHaveLength(1);
    expect(writes[0]?.binds[0]).toBe("telegram:commands-reconciled");
    expect(writes[0]?.binds[1]).toBe(expectedCommandsCacheValue());
    expect(typeof writes[0]?.binds[2]).toBe("number");
  });

  it("passes an already-aborted signal into Telegram command registration fetches", async () => {
    const db = mockD1(
      [
        {
          match: CACHE_SELECT_MATCH,
          matchBinds: ["telegram:commands-reconciled"],
          rows: [],
          first: null,
        },
        {
          match: CACHE_SELECT_MATCH,
          rows: [],
          first: null,
        },
      ],
      { requireMatch: true },
    );
    const controller = new AbortController();
    controller.abort(new Error("registration aborted"));
    fetchSpy.mockImplementationOnce(async (_input, init) => {
      const signal = init?.signal as AbortSignal | undefined;
      expect(signal?.aborted).toBe(true);
      throw signal?.reason;
    });

    await expect(
      reconcileTelegramCommandRegistration(db, {
        botToken: "bot-token",
        signal: controller.signal,
      }),
    ).rejects.toThrow("registration aborted");
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("keeps group commands to group-safe commands only", () => {
    const groupCommands = TELEGRAM_BOT_GROUP_COMMANDS.map((entry) => entry.command);
    for (const command of groupCommands) {
      expect(TELEGRAM_BOT_COMMANDS.some((entry) => entry.command === command)).toBe(true);
    }
    expect(groupCommands).not.toContain("start");
    expect(groupCommands).not.toContain("forget");
    expect(groupCommands).toEqual([
      "help",
      "sample",
      "status",
      "brief",
      "top",
      "why",
      "coverage",
      "health",
      "list",
      "subscribe",
      "unsubscribe",
      "presets",
      "set",
      "settings",
      "mute",
      "pause",
      "timezone",
      "unsnooze",
      "unmutehours",
      "cancel",
      "export",
      "import",
    ]);
  });

  it("skips the second scope call when Telegram rejects the private-chat registration", async () => {
    const db = mockD1(
      [
        {
          match: CACHE_SELECT_MATCH,
          matchBinds: ["telegram:commands-reconciled"],
          rows: [],
          first: null,
        },
        {
          match: CACHE_SELECT_MATCH,
          rows: [],
          first: null,
        },
      ],
      { requireMatch: true },
    );
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
    const db = mockD1(
      [
        {
          match: CACHE_SELECT_MATCH,
          matchBinds: ["telegram:commands-reconciled"],
          rows: [],
          first: null,
        },
        {
          match: CACHE_SELECT_MATCH,
          rows: [],
          first: null,
        },
      ],
      { requireMatch: true },
    );
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
    const db = mockD1(
      [
        {
          match: CACHE_SELECT_MATCH,
          matchBinds: ["telegram:profile-reconciled"],
          rows: [{ value: expectedProfileCacheValue(), updated_at: nowSec }],
        },
      ],
      { requireMatch: true },
    );

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
    const db = mockD1(
      [
        {
          match: CACHE_SELECT_MATCH,
          matchBinds: ["telegram:profile-reconciled"],
          rows: [],
          first: null,
        },
        {
          match: CACHE_SELECT_MATCH,
          rows: [],
          first: null,
        },
        {
          match: CACHE_WRITE_MATCH,
          rows: [],
        },
      ],
      { requireMatch: true },
    );
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

    const writes = db.getHistory().filter((entry) => entry.sql.includes(CACHE_WRITE_MATCH));
    expect(writes).toHaveLength(1);
    expect(writes[0]?.binds[0]).toBe("telegram:profile-reconciled");
    expect(writes[0]?.binds[1]).toBe(expectedProfileCacheValue());
  });

  it('treats Telegram "is not modified" 400 as success and still refreshes the cache marker', async () => {
    const db = mockD1(
      [
        {
          match: CACHE_SELECT_MATCH,
          matchBinds: ["telegram:profile-reconciled"],
          rows: [],
          first: null,
        },
        {
          match: CACHE_SELECT_MATCH,
          rows: [],
          first: null,
        },
        {
          match: CACHE_WRITE_MATCH,
          rows: [],
        },
      ],
      { requireMatch: true },
    );
    fetchSpy.mockImplementation(
      async () =>
        new Response(JSON.stringify({ ok: false, description: "Bad Request: bot description is not modified" }), {
          status: 400,
        }),
    );

    const result = await reconcileTelegramProfileRegistration(db, {
      botToken: "bot-token",
    });

    expect(result).toEqual({ attempted: true, skipped: false });
    expect(fetchSpy).toHaveBeenCalledTimes(3);
    const writes = db.getHistory().filter((entry) => entry.sql.includes(CACHE_WRITE_MATCH));
    expect(writes).toHaveLength(1);
  });

  it("throws when Telegram rejects with a non-idempotent error", async () => {
    const db = mockD1(
      [
        {
          match: CACHE_SELECT_MATCH,
          matchBinds: ["telegram:profile-reconciled"],
          rows: [],
          first: null,
        },
        {
          match: CACHE_SELECT_MATCH,
          rows: [],
          first: null,
        },
      ],
      { requireMatch: true },
    );
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

  it("records a 429 backoff and returns rate-limited without throwing when setMyName is throttled", async () => {
    const db = mockD1(
      [cacheSelectEntry("telegram:profile-reconciled"), ...profileBackoffSelectEntries(), cacheWriteEntry()],
      { requireMatch: true },
    );
    fetchSpy
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            ok: false,
            error_code: 429,
            description: "Too Many Requests",
            parameters: { retry_after: 120 },
          }),
          { status: 429 },
        ),
      )
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true }), { status: 200 }));

    const result = await reconcileTelegramProfileRegistration(db, { botToken: "bot-token" });

    expect(result).toEqual({ attempted: false, skipped: true, reason: "rate-limited" });
    expect(fetchSpy).toHaveBeenCalledTimes(3);

    const writes = db.getHistory().filter((entry) => entry.sql.includes(CACHE_WRITE_MATCH));
    // The success marker is NOT written; only the 429 backoff row for setMyName is.
    expect(writes.some((w) => w.binds[0] === "telegram:profile-reconciled")).toBe(false);
    const backoffWrite = writes.find((w) => w.binds[0] === "telegram:reconcile:429:setMyName");
    expect(backoffWrite).toBeDefined();
    expect(backoffWrite?.binds[1]).toBe("120");
  });

  it("skips the throttled endpoint silently while the backoff window is active", async () => {
    const nowSec = Math.floor(Date.now() / 1000);
    const db = mockD1(
      [
        cacheSelectEntry("telegram:profile-reconciled"),
        ...profileBackoffSelectEntries({
          setMyName: { value: "120", updated_at: nowSec - 10 },
        }),
        cacheWriteEntry(),
      ],
      { requireMatch: true },
    );
    fetchSpy
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true }), { status: 200 }));

    const result = await reconcileTelegramProfileRegistration(db, { botToken: "bot-token" });

    expect(result).toEqual({ attempted: false, skipped: true, reason: "rate-limited" });
    // setMyName is skipped — only setMyShortDescription + setMyDescription fetch.
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(fetchSpy.mock.calls[0]?.[0]).toBe("https://api.telegram.org/botbot-token/setMyShortDescription");
    expect(fetchSpy.mock.calls[1]?.[0]).toBe("https://api.telegram.org/botbot-token/setMyDescription");
  });

  it("retries the throttled endpoint after the backoff window elapses", async () => {
    const nowSec = Math.floor(Date.now() / 1000);
    const db = mockD1(
      [
        cacheSelectEntry("telegram:profile-reconciled"),
        ...profileBackoffSelectEntries({
          setMyName: { value: "30", updated_at: nowSec - 60 },
        }),
        cacheWriteEntry(),
      ],
      { requireMatch: true },
    );
    fetchSpy.mockImplementation(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }));

    const result = await reconcileTelegramProfileRegistration(db, { botToken: "bot-token" });

    expect(result).toEqual({ attempted: true, skipped: false });
    expect(fetchSpy).toHaveBeenCalledTimes(3);
    expect(fetchSpy.mock.calls[0]?.[0]).toBe("https://api.telegram.org/botbot-token/setMyName");
  });

  it("defaults retry_after to 60s when Telegram omits the parameters field", async () => {
    const db = mockD1(
      [cacheSelectEntry("telegram:profile-reconciled"), ...profileBackoffSelectEntries(), cacheWriteEntry()],
      { requireMatch: true },
    );
    fetchSpy
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ ok: false, error_code: 429, description: "Too Many Requests" }), {
          status: 429,
        }),
      )
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true }), { status: 200 }));

    const result = await reconcileTelegramProfileRegistration(db, { botToken: "bot-token" });

    expect(result).toEqual({ attempted: false, skipped: true, reason: "rate-limited" });
    const backoffWrite = db
      .getHistory()
      .find(
        (entry) =>
          entry.sql.includes("INSERT OR REPLACE INTO cache") && entry.binds[0] === "telegram:reconcile:429:setMyName",
      );
    expect(backoffWrite?.binds[1]).toBe("60");
  });
});
