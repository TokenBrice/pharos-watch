import { describe, it, expect, vi } from "vitest";
import { mockD1 } from "@shared/test-utils/mock-d1";
import { hasValidAdminCredential, requireAdmin } from "../../../lib/auth";
import {
  resetTelegramInvalidSecretLogStateForTests,
} from "../../common/log";
import {
  formatAdministratorMentions,
  getCachedChatAdministrators,
  isGroupAdminActor,
  resolveGroupAdminStatus,
  validateTelegramWebhookSecret,
} from "../telegram-webhook-auth";

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
  it("returns false when no request and not trusted", async () => {
    expect(await hasValidAdminCredential(undefined)).toBe(false);
  });
});

describe("requireAdmin", () => {
  it("returns null when authorized", async () => {
    expect(await requireAdmin(undefined, true)).toBeNull();
  });
});

describe("getCachedChatAdministrators", () => {
  it("keeps oversized administrator evidence unavailable without caching a partial list", async () => {
    const db = mockD1([{ match: "SELECT value, updated_at FROM cache WHERE key = ?", rows: [], first: null }]);
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(new Response("{}", {
      headers: { "Content-Length": String(16 * 1024 * 1024 + 1) },
    }));
    try {
      expect(await getCachedChatAdministrators(db, "bot-token", "-100")).toBeNull();
    } finally {
      fetchMock.mockRestore();
    }
    expect(db.getHistory().some((entry) => entry.sql.includes("INSERT"))).toBe(false);
  });
});

describe("formatAdministratorMentions", () => {
  it("omits anonymous administrators from group-visible hints", () => {
    expect(
      formatAdministratorMentions([
        { status: "creator", userId: "1", username: "alice", firstName: "Alice", isAnonymous: false },
        { status: "administrator", userId: "2", username: "hidden", firstName: "Hidden", isAnonymous: true },
        { status: "administrator", userId: "3", username: null, firstName: "Bob", isAnonymous: false },
      ]),
    ).toBe("@alice, Bob");
  });
});
