import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { createSqliteD1 } from "@shared/test-utils/sqlite-d1";
import { pruneTelegramMiniAppMutationBurstCache } from "../../../cron/telegram/maintenance/telegram-retention-cleanup";
import { prepareDeleteTelegramChatCacheStatements } from "../../store/telegram-webhook-store";
import {
  acquireTelegramMiniAppMutationBurst,
  TELEGRAM_MINI_APP_MUTATION_BURST_LIMIT,
  TELEGRAM_MINI_APP_MUTATION_BURST_WINDOW_SEC,
} from "../telegram-mini-app-rate-limit";
import { createCacheSqlite as openDb } from "../../webhook/__tests__/telegram-sqlite.test-support.ts";

const botToken = "123456:mutation-quota-test";

describe("acquireTelegramMiniAppMutationBurst", () => {
  let sqlite: DatabaseSync | null = null;

  afterEach(() => {
    sqlite?.close();
    sqlite = null;
  });

  it("admits a normal six-write settings session in one burst", async () => {
    const opened = openDb();
    sqlite = opened.sqlite;

    for (let index = 0; index < 6; index += 1) {
      await expect(acquireTelegramMiniAppMutationBurst(opened.db, {
        userId: "42",
        botToken,
        nowSec: 1_000,
      })).resolves.toEqual({ allowed: true, retryAfterSec: 0 });
    }

    expect(sqlite.prepare("SELECT value FROM cache").get()).toEqual({ value: "6" });
  });

  it("caps one user atomically and returns the exact remaining window", async () => {
    const opened = openDb();
    sqlite = opened.sqlite;

    const attempts = await Promise.all(Array.from(
      { length: TELEGRAM_MINI_APP_MUTATION_BURST_LIMIT + 8 },
      () => acquireTelegramMiniAppMutationBurst(opened.db, { userId: "42", botToken, nowSec: 2_000 }),
    ));

    expect(attempts.filter((attempt) => attempt.allowed)).toHaveLength(TELEGRAM_MINI_APP_MUTATION_BURST_LIMIT);
    expect(attempts.filter((attempt) => !attempt.allowed)).toHaveLength(8);
    expect(sqlite.prepare("SELECT value, updated_at FROM cache").get()).toEqual({
      value: String(TELEGRAM_MINI_APP_MUTATION_BURST_LIMIT),
      updated_at: 2_000,
    });

    await expect(acquireTelegramMiniAppMutationBurst(opened.db, {
      userId: "42",
      botToken,
      nowSec: 2_017,
    })).resolves.toEqual({ allowed: false, retryAfterSec: 13 });
    expect(sqlite.prepare("SELECT value FROM cache").get()).toEqual({
      value: String(TELEGRAM_MINI_APP_MUTATION_BURST_LIMIT),
    });
  });

  it("starts a fresh window exactly when the prior window expires", async () => {
    const opened = openDb();
    sqlite = opened.sqlite;

    for (let index = 0; index < TELEGRAM_MINI_APP_MUTATION_BURST_LIMIT; index += 1) {
      await acquireTelegramMiniAppMutationBurst(opened.db, { userId: "42", botToken, nowSec: 3_000 });
    }

    await expect(acquireTelegramMiniAppMutationBurst(opened.db, {
      userId: "42",
      botToken,
      nowSec: 3_000 + TELEGRAM_MINI_APP_MUTATION_BURST_WINDOW_SEC,
    })).resolves.toEqual({ allowed: true, retryAfterSec: 0 });
    expect(sqlite.prepare("SELECT value, updated_at FROM cache ORDER BY updated_at DESC LIMIT 1").get()).toEqual({
      value: "1",
      updated_at: 3_030,
    });
    const rows = sqlite.prepare("SELECT key FROM cache").all() as { key: string }[];
    expect(rows).toHaveLength(2);
    expect(new Set(rows.map((row) => row.key)).size).toBe(2);
    for (const row of rows) expect(row.key).toMatch(/^telegram:mini-app-mutation-burst:anon:[a-f0-9]{64}$/);
  });

  it("fails closed when the D1 rate-limit boundary is unavailable", async () => {
    const brokenSqlite = new DatabaseSync(":memory:");
    sqlite = brokenSqlite;

    await expect(acquireTelegramMiniAppMutationBurst(createSqliteD1(brokenSqlite), {
      userId: "42",
      botToken,
      nowSec: 4_000,
    })).rejects.toThrow(/no such table: cache/i);
  });
});

describe("Mini App mutation burst privacy lifecycle", () => {
  it("erases legacy raw-chat burst keys during subscriber cache wipes", async () => {
    const { sqlite, db } = openDb();
    try {
      sqlite.exec(`
        INSERT INTO cache (key, value, updated_at) VALUES
          ('telegram:mini-app-mutation-burst:42', '6', 1000),
          ('telegram:command-cooldown:42:/status', '1', 1000),
          ('telegram:mini-app-mutation-burst:43', '4', 1000),
          ('telegram:mini-app-mutation-burst:420', '5', 1000);
      `);

      await db.batch(prepareDeleteTelegramChatCacheStatements(db, "42"));

      expect(sqlite.prepare("SELECT key FROM cache ORDER BY key").all()).toEqual([
        { key: "telegram:mini-app-mutation-burst:420" },
        { key: "telegram:mini-app-mutation-burst:43" },
      ]);
    } finally {
      sqlite.close();
    }
  });

  it("keeps only the original anchored budget across repeated forget cache wipes and epoch rollover", async () => {
    const { sqlite, db } = openDb();
    try {
      // The first admission is 17 seconds into an epoch, not on its boundary.
      for (let index = 0; index < 20; index += 1) {
        const nowSec = index < 6 ? 3_017 : 3_030;
        await expect(acquireTelegramMiniAppMutationBurst(db, { userId: "42", botToken, nowSec }))
          .resolves.toEqual(index < 12
            ? { allowed: true, retryAfterSec: 0 }
            : { allowed: false, retryAfterSec: 17 });
        await db.batch(prepareDeleteTelegramChatCacheStatements(db, "42"));
      }
      expect(sqlite.prepare("SELECT value, updated_at FROM cache").all())
        .toEqual([{ value: "12", updated_at: 3_017 }]);
      await expect(acquireTelegramMiniAppMutationBurst(db, { userId: "42", botToken, nowSec: 3_046 }))
        .resolves.toEqual({ allowed: false, retryAfterSec: 1 });
      await expect(acquireTelegramMiniAppMutationBurst(db, { userId: "43", botToken, nowSec: 3_046 }))
        .resolves.toEqual({ allowed: true, retryAfterSec: 0 });
      await expect(acquireTelegramMiniAppMutationBurst(db, { userId: "42", botToken, nowSec: 3_047 }))
        .resolves.toEqual({ allowed: true, retryAfterSec: 0 });
      expect(sqlite.prepare("SELECT value, updated_at FROM cache ORDER BY updated_at DESC LIMIT 1").get())
        .toEqual({ value: "1", updated_at: 3_047 });
    } finally {
      sqlite.close();
    }
  });

  it("prunes stale burst counters by prefix without touching fresh counters", async () => {
    const { sqlite, db } = openDb();
    try {
      sqlite.exec(`
        INSERT INTO cache (key, value, updated_at) VALUES
          ('telegram:mini-app-mutation-burst:42', '12', 99),
          ('telegram:mini-app-mutation-burst:43', '4', 100),
          ('stablecoins', '{}', 1);
      `);

      await expect(pruneTelegramMiniAppMutationBurstCache(db, 100)).resolves.toEqual({
        pruned: 1,
        cappedAtLimit: false,
      });
      expect(sqlite.prepare("SELECT key FROM cache ORDER BY key").all()).toEqual([
        { key: "stablecoins" },
        { key: "telegram:mini-app-mutation-burst:43" },
      ]);
    } finally {
      sqlite.close();
    }
  });
});
