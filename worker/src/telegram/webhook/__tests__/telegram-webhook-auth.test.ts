import { describe, it, expect, vi } from "vitest";
import { timingSafeCompare, hasValidAdminCredential, requireAdmin, withAdmin } from "../../../lib/auth";
import {
  resetTelegramInvalidSecretLogStateForTests,
} from "../../common/log";
import { isGroupAdminActor, resolveGroupAdminStatus, validateTelegramWebhookSecret } from "../telegram-webhook-auth";

describe("timingSafeCompare", () => {
  it("denies group authorization on oversized Telegram member evidence", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(new Response("{}", {
      headers: { "Content-Length": String(16 * 1024 * 1024 + 1) },
    }));
    try {
      expect(await isGroupAdminActor("bot-token", "-100", "1")).toBe(false);
      expect(fetchMock).toHaveBeenCalledOnce();
    } finally {
      fetchMock.mockRestore();
    }
  });

  it("returns true for matching strings", async () => {
    expect(await timingSafeCompare("secret123", "secret123")).toBe(true);
  });
  it("returns false for non-matching strings", async () => {
    expect(await timingSafeCompare("secret123", "wrong")).toBe(false);
  });
  it("returns false for empty strings", async () => {
    expect(await timingSafeCompare("", "secret")).toBe(false);
  });
  it("returns false when both empty", async () => {
    expect(await timingSafeCompare("", "")).toBe(false);
  });
});

describe("resolveGroupAdminStatus", () => {
  it.each([
    ["admin", () => Response.json({ ok: true, result: { status: "administrator" } }), "admin"],
    ["creator", () => Response.json({ ok: true, result: { status: "creator" } }), "admin"],
    ["member", () => Response.json({ ok: true, result: { status: "member" } }), "not_admin"],
    ["definitive 400 refusal", () => new Response("{}", { status: 400 }), "not_admin"],
    ["bot-side 401 token rejection", () => new Response("{}", { status: 401 }), "unknown"],
    ["bot-side 403 permission refusal", () => new Response("{}", { status: 403 }), "unknown"],
    ["429 throttle", () => new Response("{}", { status: 429 }), "unknown"],
    ["502 server error", () => new Response("{}", { status: 502 }), "unknown"],
    ["ok:false body", () => Response.json({ ok: false }), "unknown"],
  ] as const)("classifies a %s lookup", async (_label, respond, expected) => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(respond());
    try {
      expect(await resolveGroupAdminStatus("bot-token", "-100", "1")).toBe(expected);
    } finally {
      fetchMock.mockRestore();
    }
  });

  it("treats a network failure as unknown, not as a non-admin", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockRejectedValue(new TypeError("network down"));
    try {
      expect(await resolveGroupAdminStatus("bot-token", "-100", "1")).toBe("unknown");
    } finally {
      fetchMock.mockRestore();
    }
  });
});

describe("validateTelegramWebhookSecret", () => {
  it("accepts current and previous secrets", async () => {
    const current = new Request("https://x/api/telegram-webhook", {
      headers: { "X-Telegram-Bot-Api-Secret-Token": "current" },
    });
    const previous = new Request("https://x/api/telegram-webhook", {
      headers: { "X-Telegram-Bot-Api-Secret-Token": "previous" },
    });

    expect(await validateTelegramWebhookSecret(current, "current", "previous")).toBe("valid");
    expect(await validateTelegramWebhookSecret(previous, "current", "previous")).toBe("valid");
  });

  it("logs missing secrets as a separate spike signal", async () => {
    resetTelegramInvalidSecretLogStateForTests();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const request = new Request("https://x/api/telegram-webhook");

    expect(await validateTelegramWebhookSecret(request, "current")).toBe("missing");
    const record = JSON.parse(String(warn.mock.calls[0]?.[0] ?? "{}")) as {
      action?: string;
      signal?: string;
      missingSecretWindowCount?: number;
    };
    expect(record.action).toBe("auth-missing-secret");
    expect(record.signal).toBe("missing_secret");
    expect(record.missingSecretWindowCount).toBe(1);
    warn.mockRestore();
  });
});

describe("hasValidAdminCredential", () => {
  it("returns true when trustedAdmin is true", async () => {
    expect(await hasValidAdminCredential(undefined, true)).toBe(true);
  });
  it("returns false when no request and not trusted", async () => {
    expect(await hasValidAdminCredential(undefined)).toBe(false);
  });
  it("returns false for non-ops-api request", async () => {
    const req = new Request("https://api.pharos.watch/api/test");
    expect(await hasValidAdminCredential(req)).toBe(false);
  });
  it("rejects ops-api request when no env configured", async () => {
    const req = new Request("https://ops-api.pharos.watch/api/test", {
      headers: { "Cf-Access-Jwt-Assertion": "some-jwt" },
    });
    expect(await hasValidAdminCredential(req, false, {})).toBe(false);
  });
  it("returns false for ops-api request without JWT header", async () => {
    const req = new Request("https://ops-api.pharos.watch/api/test");
    expect(await hasValidAdminCredential(req)).toBe(false);
  });
});

describe("requireAdmin", () => {
  it("returns null when authorized", async () => {
    expect(await requireAdmin(undefined, true)).toBeNull();
  });
  it("returns 401 Response when unauthorized", async () => {
    const result = await requireAdmin(undefined);
    expect(result).toBeInstanceOf(Response);
    expect(result!.status).toBe(401);
  });
});

describe("withAdmin", () => {
  it("executes handler when authorized", async () => {
    const handler = async () => new Response("ok");
    const result = await withAdmin(undefined, handler, true);
    expect(await result.text()).toBe("ok");
  });
  it("returns 401 when unauthorized", async () => {
    const handler = async () => new Response("ok");
    const result = await withAdmin(undefined, handler, false);
    expect(result.status).toBe(401);
  });
});
