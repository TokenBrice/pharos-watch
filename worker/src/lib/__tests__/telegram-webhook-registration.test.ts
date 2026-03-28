import { beforeEach, describe, expect, it, vi } from "vitest";
import { mockD1 } from "../../api/__tests__/helpers/mock-d1";
import {
  buildTelegramWebhookUrl,
  reconcileTelegramWebhookRegistration,
} from "../telegram-webhook-registration";

const fetchSpy = vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>();
vi.stubGlobal("fetch", fetchSpy);

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
        rows: [{ value: "{\"url\":\"https://api.pharos.watch/api/telegram-webhook\"}", updated_at: nowSec }],
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

  it("registers the webhook against Telegram and records the reconciliation cache", async () => {
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
    });
    const writes = db.getHistory().filter((entry) =>
      entry.sql.includes("INSERT OR REPLACE INTO cache (key, value, updated_at) VALUES (?, ?, ?)"),
    );
    expect(writes).toHaveLength(1);
    expect(writes[0]?.binds[0]).toBe("telegram:webhook-reconciled");
    expect(writes[0]?.binds[1]).toBe("{\"url\":\"https://api.pharos.watch/api/telegram-webhook\"}");
    expect(typeof writes[0]?.binds[2]).toBe("number");
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
