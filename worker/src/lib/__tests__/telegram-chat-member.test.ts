import { beforeEach, describe, expect, it } from "vitest";
import { mockD1 } from "@shared/test-utils/mock-d1";
import { jsonResponse, mockFetch } from "@shared/test-utils/mock-fetch";

let fetchSpy = mockFetch([], { requireMatch: true });

const { getCachedChatAdministrators, formatAdministratorMentions } = await import("../telegram-chat-member");

const NOW_SEC = Math.floor(Date.now() / 1000);

describe("getCachedChatAdministrators", () => {
  beforeEach(() => {
    fetchSpy = mockFetch([], { requireMatch: true });
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
      { status: "creator", userId: "1", username: "alice", firstName: "Alice", isAnonymous: false },
      { status: "administrator", userId: "2", username: null, firstName: "Bob", isAnonymous: false },
    ]);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("returns the cached value without calling Telegram when fresh", async () => {
    const cached = JSON.stringify([
      { status: "creator", userId: "1", username: "alice", firstName: "Alice", isAnonymous: false },
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
      { status: "creator", userId: "1", username: "alice", firstName: "Alice", isAnonymous: false },
    ]);
    expect(fetchSpy).not.toHaveBeenCalled();
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
