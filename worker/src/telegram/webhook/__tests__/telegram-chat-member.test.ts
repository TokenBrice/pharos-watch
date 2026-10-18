import { beforeEach, describe, expect, it } from "vitest";
import { mockD1 } from "@shared/test-utils/mock-d1";
import { mockFetch } from "@shared/test-utils/mock-fetch";

let fetchSpy = mockFetch([], { requireMatch: true });

const { getCachedChatAdministrators, formatAdministratorMentions } = await import("../chat-member");

describe("getCachedChatAdministrators", () => {
  beforeEach(() => {
    fetchSpy = mockFetch([], { requireMatch: true });
  });

  it("keeps oversized administrator evidence unavailable without caching a partial list", async () => {
    const db = mockD1([{ match: "SELECT value, updated_at FROM cache WHERE key = ?", rows: [], first: null }]);
    fetchSpy.mockResolvedValueOnce(new Response("{}", {
      headers: { "Content-Length": String(16 * 1024 * 1024 + 1) },
    }));
    expect(await getCachedChatAdministrators(db, "bot-token", "-100")).toBeNull();
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
