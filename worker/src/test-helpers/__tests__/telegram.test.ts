import type * as Vitest from "vitest";
import { afterEach, describe, expect, it, vi } from "vitest";

const cleanup = vi.hoisted(() => ({ callbacks: [] as Array<() => void> }));
vi.mock("vitest", async (importOriginal) => ({
  ...await importOriginal<typeof Vitest>(),
  onTestFinished: (callback: () => void) => cleanup.callbacks.push(callback),
}));

import { createTelegramFetchSpy, mockTelegramD1 } from "../__shared/telegram";

afterEach(() => {
  cleanup.callbacks.length = 0;
  vi.unstubAllGlobals();
});

describe("Telegram fixture accounting", () => {
  it("rejects a shadowed explicit table at automatic cleanup", async () => {
    const db = mockTelegramD1([
      { match: "SELECT value", rows: [{ value: 1 }] },
      { match: "SELECT value", rows: [{ value: 2 }] },
    ]);
    expect(await db.prepare("SELECT value").first()).toEqual({ value: 1 });
    expect(() => cleanup.callbacks[0]()).toThrow(/unused/i);
  });

  it("rejects an explicit subscriber fixture shadowed by a table", async () => {
    const db = mockTelegramD1([
      { match: "FROM telegram_subscribers", rows: [{ chat_id: "override" }] },
    ], { subscriber: { chat_id: "required" } });
    expect(await db.prepare("SELECT * FROM telegram_subscribers").first()).toEqual({ chat_id: "override" });
    expect(() => db.assertAllMatchesUsed()).toThrow(/unused/i);
  });

  it("exempts opted-out matches, implicit reads, fallback tables and default writes", () => {
    const db = mockTelegramD1([{ match: "unused", rows: [], allowUnused: true }], {
      fallbackTables: [{ match: "fallback", rows: [] }],
    });
    expect(() => db.assertAllMatchesUsed()).not.toThrow();
    expect(() => cleanup.callbacks[0]()).not.toThrow();
  });

  it("accounts for normalized strict SQL hits", async () => {
    const db = mockTelegramD1([{ match: "SELECT  value", rows: [{ value: 3 }] }], { strictSql: true });
    expect(await db.prepare("SELECT\nvalue").first()).toEqual({ value: 3 });
    expect(() => db.assertAllMatchesUsed()).not.toThrow();
  });
});

it("returns a fresh consumable Telegram response after every call and reset", async () => {
  const { fetchSpy, reset } = createTelegramFetchSpy();
  reset();
  expect(await (await fetchSpy("https://api.telegram.org/one")).json()).toEqual({ ok: true });
  expect(await (await fetchSpy("https://api.telegram.org/two")).json()).toEqual({ ok: true });
  reset();
  expect(await (await fetchSpy("https://api.telegram.org/three")).json()).toEqual({ ok: true });
});
