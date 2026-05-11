import { beforeEach, describe, expect, it, vi } from "vitest";
import { mockD1 } from "../../api/__tests__/helpers/mock-d1";

const fetchSpy = vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>();
vi.stubGlobal("fetch", fetchSpy);

const { getCachedChatMember, getCachedChatAdministrators } = await import("../telegram-chat-member");

const NOW_SEC = Math.floor(Date.now() / 1000);

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("getCachedChatMember", () => {
  beforeEach(() => {
    fetchSpy.mockReset();
  });

  it("returns the cached membership when the cache row is fresh", async () => {
    const cached = JSON.stringify({
      status: "administrator",
      userId: "42",
      username: "alice",
      firstName: "Alice",
    });
    const db = mockD1([
      {
        match: "SELECT value, updated_at FROM cache WHERE key = ?",
        matchBinds: ["telegram:chat-member:-100:42"],
        rows: [],
        first: { value: cached, updated_at: NOW_SEC },
      },
    ]);

    const result = await getCachedChatMember(db, "bot-token", "-100", "42");

    expect(result).toEqual({
      status: "administrator",
      userId: "42",
      username: "alice",
      firstName: "Alice",
    });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("fetches from Telegram and writes the cache on a miss", async () => {
    const db = mockD1([
      {
        match: "SELECT value, updated_at FROM cache WHERE key = ?",
        matchBinds: ["telegram:chat-member:-100:42"],
        rows: [],
        first: null,
      },
      {
        match: "INSERT OR REPLACE INTO cache (key, value, updated_at) VALUES (?, ?, ?)",
        rows: [],
      },
    ]);
    fetchSpy.mockResolvedValueOnce(
      jsonResponse({
        ok: true,
        result: {
          status: "member",
          user: { id: 42, username: "bob", first_name: "Bob" },
        },
      }),
    );

    const result = await getCachedChatMember(db, "bot-token", "-100", "42");

    expect(result).toEqual({
      status: "member",
      userId: "42",
      username: "bob",
      firstName: "Bob",
    });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0];
    expect(String(url)).toBe("https://api.telegram.org/botbot-token/getChatMember");
    const body = JSON.parse(init?.body as string) as { chat_id: string; user_id: number };
    expect(body).toEqual({ chat_id: "-100", user_id: 42 });

    const insert = db.getHistory().find((entry) => entry.sql.includes("INSERT OR REPLACE INTO cache"));
    expect(insert?.binds?.[0]).toBe("telegram:chat-member:-100:42");
    expect(typeof insert?.binds?.[1]).toBe("string");
  });

  it("returns null when the Telegram API returns an error", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const db = mockD1([
      {
        match: "SELECT value, updated_at FROM cache WHERE key = ?",
        matchBinds: ["telegram:chat-member:-100:42"],
        rows: [],
        first: null,
      },
    ]);
    fetchSpy.mockResolvedValueOnce(new Response("Bad Request", { status: 400 }));

    const result = await getCachedChatMember(db, "bot-token", "-100", "42");

    expect(result).toBeNull();
    expect(db.getHistory().some((entry) => entry.sql.includes("INSERT OR REPLACE INTO cache"))).toBe(false);
    warn.mockRestore();
  });
});

describe("getCachedChatAdministrators", () => {
  beforeEach(() => {
    fetchSpy.mockReset();
  });

  it("fetches and caches the administrator list", async () => {
    const db = mockD1([
      {
        match: "SELECT value, updated_at FROM cache WHERE key = ?",
        matchBinds: ["telegram:chat-admins:-100"],
        rows: [],
        first: null,
      },
      {
        match: "INSERT OR REPLACE INTO cache (key, value, updated_at) VALUES (?, ?, ?)",
        rows: [],
      },
    ]);
    fetchSpy.mockResolvedValueOnce(
      jsonResponse({
        ok: true,
        result: [
          { status: "creator", user: { id: 1, username: "alice", first_name: "Alice" } },
          { status: "administrator", user: { id: 2, first_name: "Bob" } },
        ],
      }),
    );

    const result = await getCachedChatAdministrators(db, "bot-token", "-100");

    expect(result).toEqual([
      { status: "creator", userId: "1", username: "alice", firstName: "Alice" },
      { status: "administrator", userId: "2", username: null, firstName: "Bob" },
    ]);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("returns the cached value without calling Telegram when fresh", async () => {
    const cached = JSON.stringify([
      { status: "creator", userId: "1", username: "alice", firstName: "Alice" },
    ]);
    const db = mockD1([
      {
        match: "SELECT value, updated_at FROM cache WHERE key = ?",
        matchBinds: ["telegram:chat-admins:-100"],
        rows: [],
        first: { value: cached, updated_at: NOW_SEC },
      },
    ]);

    const result = await getCachedChatAdministrators(db, "bot-token", "-100");

    expect(result).toEqual([
      { status: "creator", userId: "1", username: "alice", firstName: "Alice" },
    ]);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
