import { beforeEach, describe, expect, it, vi } from "vitest";

const { sendToChatMock } = vi.hoisted(() => ({
  sendToChatMock: vi.fn(async (..._args: unknown[]) => ({ ok: true })),
}));

vi.mock("../../lib/telegram", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../lib/telegram")>()),
  sendToChat: sendToChatMock,
}));

import {
  DIGEST_PUBLICATION_ALERT_COOLDOWN_SEC,
  runDigestPublicationWatchdog,
} from "../digest-publication-watchdog";

const DATE = "2026-08-31";

function at(iso: string): number {
  return Math.floor(Date.parse(iso) / 1_000);
}

interface FixtureOptions {
  dailyRow?: boolean;
  weeklyRow?: boolean;
  dailyTelegram?: string;
  weeklyTelegram?: string;
  twitterState?: string;
  /** Defaults to `twitterState` so a healthy fixture stays healthy on Mondays. */
  weeklyTwitterState?: string;
}

function fakeDb(options: FixtureOptions = {}): D1Database & {
  cache: Map<string, { value: string; updated_at: number }>;
  set: (next: FixtureOptions) => void;
} {
  const cache = new Map<string, { value: string; updated_at: number }>();
  if (options.twitterState) {
    for (const date of [DATE, "2026-09-01"]) {
      cache.set(`daily-digest:twitter-sent:${date}`, {
        value: options.twitterState,
        updated_at: 1,
      });
    }
  }
  const weeklyTwitterState = options.weeklyTwitterState ?? options.twitterState;
  if (weeklyTwitterState) {
    for (const date of [DATE, "2026-09-01"]) {
      cache.set(`weekly-recap:twitter-sent:${date}`, {
        value: weeklyTwitterState,
        updated_at: 1,
      });
    }
  }
  const fixture = {
    dailyRow: options.dailyRow ?? true,
    weeklyRow: options.weeklyRow ?? true,
    dailyTelegram: options.dailyTelegram ?? "sent",
    weeklyTelegram: options.weeklyTelegram ?? "sent",
  };

  const db = {
    cache,
    prepare(sql: string) {
      return {
        bind(...args: unknown[]) {
          return {
            async first<T>() {
              if (sql.includes("FROM daily_digest")) {
                const isWeekly = sql.includes("json_extract(digest_meta, '$.type') = 'weekly'");
                if ((isWeekly ? fixture.weeklyRow : fixture.dailyRow) && sql.includes("SELECT 1 AS present")) {
                  return { present: 1 } as T;
                }
                return null;
              }
              if (sql.includes("FROM telegram_digest_outbox")) {
                const editionKey = String(args[0]);
                const state = editionKey.startsWith("weekly:") ? fixture.weeklyTelegram : fixture.dailyTelegram;
                return state ? ({ state } as T) : null;
              }
              if (sql.startsWith("SELECT value, updated_at FROM cache WHERE key = ?")) {
                return (cache.get(String(args[0])) ?? null) as T | null;
              }
              return null;
            },
            async run() {
              if (sql.startsWith("INSERT OR REPLACE INTO cache")) {
                cache.set(String(args[0]), {
                  value: String(args[1]),
                  updated_at: Number(args[2]),
                });
              }
              return { meta: { changes: 1 } };
            },
          };
        },
      };
    },
    set(next: FixtureOptions) {
      if (next.dailyRow != null) fixture.dailyRow = next.dailyRow;
      if (next.weeklyRow != null) fixture.weeklyRow = next.weeklyRow;
      if (next.dailyTelegram != null) fixture.dailyTelegram = next.dailyTelegram;
      if (next.weeklyTelegram != null) fixture.weeklyTelegram = next.weeklyTelegram;
    },
  };
  return db as unknown as D1Database & {
    cache: Map<string, { value: string; updated_at: number }>;
    set: (next: FixtureOptions) => void;
  };
}

function healthyDigestDb(): ReturnType<typeof fakeDb> {
  return fakeDb({
    dailyRow: true,
    weeklyRow: true,
    dailyTelegram: "sent",
    weeklyTelegram: "sent",
    twitterState: JSON.stringify({ state: "sent" }),
  });
}

function mockCurrentMap(date = DATE): void {
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ date }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  })));
}

describe("digest publication watchdog", () => {
  beforeEach(() => {
    sendToChatMock.mockClear();
    sendToChatMock.mockResolvedValue({ ok: true });
    mockCurrentMap();
  });

  it("stays healthy before the daily and weekly cutoffs", async () => {
    const result = await runDigestPublicationWatchdog(
      healthyDigestDb(),
      at("2026-08-31T08:10:00Z"),
      { operatorTelegramCreds: { botToken: "bot", chatId: "ops" } },
    );
    expect(result.status).toBe("ok");
    expect(result.itemCount).toBe(0);
    expect(sendToChatMock).not.toHaveBeenCalled();
  });

  it("alerts when the daily row is missing after 08:30 UTC", async () => {
    const result = await runDigestPublicationWatchdog(
      fakeDb({ dailyRow: false, twitterState: JSON.stringify({ state: "sent" }) }),
      at("2026-08-31T08:31:00Z"),
      { operatorTelegramCreds: { botToken: "bot", chatId: "ops" } },
    );
    expect(result.status).toBe("degraded");
    expect(JSON.parse(result.metadata ?? "{}").conditions["daily-row"].state).toBe("stale");
    expect(sendToChatMock).toHaveBeenCalledTimes(1);
  });

  it("does not consume cooldown when transition delivery fails", async () => {
    sendToChatMock.mockResolvedValueOnce({ ok: false });
    const db = fakeDb({ dailyRow: false, twitterState: JSON.stringify({ state: "sent" }) });
    const result = await runDigestPublicationWatchdog(
      db,
      at("2026-08-31T08:31:00Z"),
      { operatorTelegramCreds: { botToken: "bot", chatId: "ops" } },
    );
    expect(JSON.parse(result.metadata ?? "{}").alertTransitions).toMatchObject({
      stale: ["daily-row"],
      sent: false,
      cooldown: false,
    });
    expect(db.cache.has("digest-publication-watchdog:alert:v1")).toBe(false);
  });

  it("alerts when the Telegram edition is not sent", async () => {
    const result = await runDigestPublicationWatchdog(
      fakeDb({ dailyTelegram: "pending", twitterState: JSON.stringify({ state: "sent" }) }),
      at("2026-08-31T08:31:00Z"),
      { operatorTelegramCreds: { botToken: "bot", chatId: "ops" } },
    );
    expect(result.status).toBe("degraded");
    expect(JSON.parse(result.metadata ?? "{}").conditions["daily-telegram"].state).toBe("stale");
    expect(sendToChatMock.mock.calls[0]?.[1]).toContain("daily Telegram edition");
  });

  it("alerts when the Twitter ledger is not delivered", async () => {
    const result = await runDigestPublicationWatchdog(
      fakeDb({ twitterState: JSON.stringify({ state: "execution_unknown" }) }),
      at("2026-08-31T08:31:00Z"),
      { operatorTelegramCreds: { botToken: "bot", chatId: "ops" } },
    );
    expect(result.status).toBe("degraded");
    expect(JSON.parse(result.metadata ?? "{}").conditions["daily-twitter"].state).toBe("stale");
  });

  it("emits a producer-lag advisory for a late map without degrading publication health", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ date: "2026-08-30" }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    })));
    const result = await runDigestPublicationWatchdog(
      healthyDigestDb(),
      at("2026-08-31T08:00:00Z"),
      { operatorTelegramCreds: { botToken: "bot", chatId: "ops" } },
    );
    expect(result.status).toBe("ok");
    expect(JSON.parse(result.metadata ?? "{}").conditions["map-producer-lag"].advisory).toBe(true);
    expect(sendToChatMock.mock.calls[0]?.[1]).toContain("Producer-lag notice");
  });

  it("does not let the advisory cooldown hide a later blocking daily failure", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ date: "2026-08-30" }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    })));
    const db = healthyDigestDb();
    await runDigestPublicationWatchdog(db, at("2026-08-31T08:00:00Z"), {
      operatorTelegramCreds: { botToken: "bot", chatId: "ops" },
    });
    db.set({ dailyRow: false });
    await runDigestPublicationWatchdog(db, at("2026-08-31T08:31:00Z"), {
      operatorTelegramCreds: { botToken: "bot", chatId: "ops" },
    });
    expect(sendToChatMock).toHaveBeenCalledTimes(2);
    expect(sendToChatMock.mock.calls[1]?.[1]).toContain("Late digest conditions");
  });

  it("checks the weekly row and Telegram edition only on Monday", async () => {
    const monday = await runDigestPublicationWatchdog(
      fakeDb({ weeklyRow: false, weeklyTelegram: "pending", twitterState: JSON.stringify({ state: "sent" }) }),
      at("2026-08-31T08:36:00Z"),
      { operatorTelegramCreds: { botToken: "bot", chatId: "ops" } },
    );
    expect(monday.status).toBe("degraded");
    const metadata = JSON.parse(monday.metadata ?? "{}");
    expect(metadata.conditions["weekly-row"].state).toBe("stale");
    expect(metadata.conditions["weekly-telegram"].state).toBe("stale");

    sendToChatMock.mockClear();
    mockCurrentMap("2026-09-01");
    const tuesday = await runDigestPublicationWatchdog(
      fakeDb({ dailyRow: true, weeklyRow: false, weeklyTelegram: "pending", twitterState: JSON.stringify({ state: "sent" }) }),
      at("2026-09-01T08:36:00Z"),
      { operatorTelegramCreds: { botToken: "bot", chatId: "ops" } },
    );
    expect(tuesday.status).toBe("ok");
    expect(JSON.parse(tuesday.metadata ?? "{}").conditions["weekly-row"]).toBeUndefined();
    expect(JSON.parse(tuesday.metadata ?? "{}").conditions["weekly-twitter"]).toBeUndefined();
    expect(sendToChatMock).not.toHaveBeenCalled();
  });

  it("alerts when the weekly recap never reached X", async () => {
    // Weekly-on-X is a distinct ledger key from the daily's, so a delivered
    // daily tweet must not mask an undelivered weekly one.
    const result = await runDigestPublicationWatchdog(
      fakeDb({
        twitterState: JSON.stringify({ state: "sent" }),
        weeklyTwitterState: JSON.stringify({ state: "execution_unknown" }),
      }),
      at("2026-08-31T08:36:00Z"),
      { operatorTelegramCreds: { botToken: "bot", chatId: "ops" } },
    );
    expect(result.status).toBe("degraded");
    const conditions = JSON.parse(result.metadata ?? "{}").conditions;
    expect(conditions["daily-twitter"].state).toBe("ok");
    expect(conditions["weekly-twitter"].state).toBe("stale");
    expect(sendToChatMock).toHaveBeenCalledTimes(1);
    expect(String(sendToChatMock.mock.calls[0]?.[1])).toContain("weekly Twitter edition");
  });

  it("deduplicates a persistent condition within a UTC day", async () => {
    const db = fakeDb({ dailyRow: false, twitterState: JSON.stringify({ state: "sent" }) });
    await runDigestPublicationWatchdog(db, at("2026-08-31T08:31:00Z"), {
      operatorTelegramCreds: { botToken: "bot", chatId: "ops" },
    });
    await runDigestPublicationWatchdog(db, at("2026-08-31T08:46:00Z"), {
      operatorTelegramCreds: { botToken: "bot", chatId: "ops" },
    });
    expect(sendToChatMock).toHaveBeenCalledTimes(1);
    expect(DIGEST_PUBLICATION_ALERT_COOLDOWN_SEC).toBe(1_800);
  });

  it("sends a recovery notice when the publication condition clears", async () => {
    const db = fakeDb({ dailyRow: false, twitterState: JSON.stringify({ state: "sent" }) });
    await runDigestPublicationWatchdog(db, at("2026-08-31T08:31:00Z"), {
      operatorTelegramCreds: { botToken: "bot", chatId: "ops" },
    });
    // Move beyond the alert cooldown before the successful publication.
    db.set({ dailyRow: true });
    await runDigestPublicationWatchdog(db, at("2026-08-31T09:10:00Z"), {
      operatorTelegramCreds: { botToken: "bot", chatId: "ops" },
    });
    expect(sendToChatMock).toHaveBeenCalledTimes(2);
    expect(sendToChatMock.mock.calls[1]?.[1]).toContain("Recovered conditions");
  });

  it("suppresses Telegram completely when operator credentials are null while advancing state", async () => {
    const db = fakeDb({ dailyRow: false, twitterState: JSON.stringify({ state: "sent" }) });
    const result = await runDigestPublicationWatchdog(db, at("2026-08-31T08:31:00Z"), {
      operatorTelegramCreds: null,
    });
    expect(sendToChatMock).not.toHaveBeenCalled();
    const state = JSON.parse(db.cache.get("digest-publication-watchdog:state:v1")?.value ?? "{}");
    expect(state.statuses["daily-row"]).toBe("stale");
    expect(result.status).toBe("degraded");
  });
});
