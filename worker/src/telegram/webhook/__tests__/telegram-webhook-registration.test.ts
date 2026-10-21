import { beforeEach, describe, expect, it } from "vitest";
import { mockD1, type MockTableConfig } from "@shared/test-utils/mock-d1";
import { mockFetch } from "@shared/test-utils/mock-fetch";
import { buildTelegramMiniAppUrl, TELEGRAM_MINI_APP_URL } from "../../common/mini-app-url";
import { COMMAND_HANDLERS } from "../../commands";
import { HELP_MESSAGE } from "../telegram-webhook-shared";
import { TELEGRAM_COMMAND_POLICIES } from "../telegram-webhook-ingress-policy";
import {
  buildTelegramWebhookUrl,
  reconcileTelegramCommandRegistration,
  reconcileTelegramMenuButton,
  reconcileTelegramProfileRegistration,
  reconcileTelegramWebhookRegistration,
  TELEGRAM_BOT_COMMANDS,
  TELEGRAM_BOT_GROUP_COMMANDS,
  TELEGRAM_MINI_APP_BUTTON_TEXT,
} from "../webhook-registration";

let fetchSpy = mockFetch([], { requireMatch: true });

const MINI_APP_MVP_ALLOWED_UPDATES = [
  "message",
  "callback_query",
  "my_chat_member",
] as const;
const CACHE_SELECT_MATCH = "SELECT value, updated_at FROM cache WHERE key = ?";
const CACHE_WRITE_MATCH = "INSERT INTO cache (key, value, updated_at) VALUES (?, ?, ?)";
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

describe("retired watchlist commands", () => {
  it("omits command portability from dispatch, policy, registration, and help", () => {
    for (const command of ["import", "export"]) {
      expect(COMMAND_HANDLERS[`/${command}`]).toBeUndefined();
      expect(TELEGRAM_COMMAND_POLICIES[`/${command}`]).toBeUndefined();
      expect(TELEGRAM_BOT_COMMANDS.some((entry) => entry.command === command)).toBe(false);
      expect(TELEGRAM_BOT_GROUP_COMMANDS.some((entry) => entry.command === command)).toBe(false);
      expect(HELP_MESSAGE).not.toContain(`/${command}`);
    }
  });
});

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
    fetchSpy = mockFetch([], { requireMatch: true });
  });
  it("does not retry a registration mutation when its response exceeds the body cap", async () => {
    fetchSpy.mockResolvedValueOnce(new Response("{}", {
      headers: { "Content-Length": String(16 * 1024 * 1024 + 1) },
    }));
    await expect(reconcileTelegramWebhookRegistration(mockD1([
      cacheSelectEntry("telegram:webhook-reconciled"),
      cacheSelectEntry("telegram:reconcile:429:setWebhook"),
    ]), {
      botToken: "bot-token", webhookSecret: "secret-token",
    })).rejects.toMatchObject({ code: "resource-budget-exceeded" });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });


  it("skips the Telegram API call when the reconciliation cache is still fresh", async () => {
    const nowSec = Math.floor(Date.now() / 1000);
    const db = mockD1(
      [
        cacheSelectEntry("telegram:webhook-reconciled", { value: await expectedWebhookCacheValue(), updated_at: nowSec }),
      ],
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
      cacheSelectEntry("telegram:webhook-reconciled"),
      cacheSelectEntry("telegram:reconcile:429:setWebhook"),
      cacheWriteEntry(),
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

  it.each(["retired update types", "rotated secret", "stale"] as const)(
    "re-registers for %s rather than trusting the cached configuration",
    async (scenario) => {
      const nowSec = Math.floor(Date.now() / 1000);
      const cached = JSON.parse(await expectedWebhookCacheValue(
        undefined, scenario === "rotated secret" ? "old-secret-token" : "secret-token",
      ));
      if (scenario === "retired update types") {
        cached.allowed_updates = ["message", "callback_query", "my_chat_member", "inline_query", "chosen_inline_result"];
      }
      const db = mockD1([
        cacheSelectEntry("telegram:webhook-reconciled", {
          value: JSON.stringify(cached),
          updated_at: nowSec - (scenario === "stale" ? 901 : 0),
        }),
        cacheSelectEntry("telegram:reconcile:429:setWebhook"),
        cacheWriteEntry(),
      ]);
      fetchSpy.mockResolvedValueOnce(new Response(JSON.stringify({ ok: true }), { status: 200 }));

      const result = await reconcileTelegramWebhookRegistration(db, {
        botToken: "bot-token",
        webhookSecret: "secret-token",
        selfUrl: "https://api.pharos.watch",
      });

      expect(result).toMatchObject({
        attempted: true, skipped: false, expectedUrl: "https://api.pharos.watch/api/telegram-webhook",
      });
      expect(fetchSpy).toHaveBeenCalledTimes(1);
      expect(JSON.parse(fetchSpy.mock.calls[0]?.[1]?.body as string)).toEqual({
        url: "https://api.pharos.watch/api/telegram-webhook",
        secret_token: "secret-token",
        allowed_updates: ["message", "callback_query", "my_chat_member"],
      });
    },
  );

  it("throws when Telegram rejects the registration", async () => {
    const db = mockD1(
      [
        cacheSelectEntry("telegram:webhook-reconciled"),
        cacheSelectEntry("telegram:reconcile:429:setWebhook"),
      ],
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
    fetchSpy = mockFetch([], { requireMatch: true });
  });

  it("sets the default Web App menu button and records the cache marker", async () => {
    const db = mockD1([
      cacheSelectEntry("telegram:menu-reconciled"),
      cacheSelectEntry("telegram:reconcile:429:setChatMenuButton"),
      cacheWriteEntry(),
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
        (entry) => entry.sql.includes("INSERT INTO cache") && entry.binds[0] === "telegram:menu-reconciled",
      );
    expect(write?.binds[1]).toBe(expectedMenuCacheValue());
  });

  it("skips setChatMenuButton when the current menu button already matches", async () => {
    const db = mockD1([
      cacheSelectEntry("telegram:menu-reconciled"),
      cacheWriteEntry(),
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
    fetchSpy = mockFetch([], { requireMatch: true });
  });

  it("skips the Telegram API call when the command reconciliation cache is still fresh", async () => {
    const nowSec = Math.floor(Date.now() / 1000);
    const db = mockD1(
      [
        cacheSelectEntry("telegram:commands-reconciled", { value: expectedCommandsCacheValue(), updated_at: nowSec }),
      ],
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

  it("passes an already-aborted signal into Telegram command registration fetches", async () => {
    const db = mockD1(
      [
        cacheSelectEntry("telegram:commands-reconciled"),
        cacheSelectEntry("telegram:reconcile:429:setMyCommands:all_private_chats"),
      ],
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
  });

  it("skips the second scope call when Telegram rejects the private-chat registration", async () => {
    const db = mockD1(
      [
        cacheSelectEntry("telegram:commands-reconciled"),
        cacheSelectEntry("telegram:reconcile:429:setMyCommands:all_private_chats"),
      ],
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
        cacheSelectEntry("telegram:commands-reconciled"),
        cacheSelectEntry("telegram:reconcile:429:setMyCommands:all_private_chats"),
        cacheSelectEntry("telegram:reconcile:429:setMyCommands:all_group_chats"),
      ],
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
    fetchSpy = mockFetch([], { requireMatch: true });
  });

  it('treats Telegram "is not modified" 400 as success and still refreshes the cache marker', async () => {
    const db = mockD1(
      [
        cacheSelectEntry("telegram:profile-reconciled"),
        ...profileBackoffSelectEntries(),
        cacheWriteEntry(),
      ],
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
        cacheSelectEntry("telegram:profile-reconciled"),
        ...profileBackoffSelectEntries(),
      ],
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

  it("records a 429 backoff and returns rate-limited without throwing when setMyName is throttled", async () => {
    const db = mockD1(
      [cacheSelectEntry("telegram:profile-reconciled"), ...profileBackoffSelectEntries(), cacheWriteEntry()],
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
          entry.sql.includes("INSERT INTO cache") && entry.binds[0] === "telegram:reconcile:429:setMyName",
      );
    expect(backoffWrite?.binds[1]).toBe("60");
  });
});
