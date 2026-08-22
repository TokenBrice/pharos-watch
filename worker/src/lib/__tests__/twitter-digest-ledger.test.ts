import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createLatestSchemaSqlite } from "../../test-helpers/latest-schema-sqlite";
import {
  deliverTwitterDigestWithLedger,
  type TwitterDigestDeliveryRecord,
} from "../twitter-digest-ledger";

const KEY = "daily-digest:twitter-sent:2026-08-22";
const NOW_SEC = 1_787_360_000;
const openDatabases: DatabaseSync[] = [];

function createHarness(): { sqlite: DatabaseSync; db: D1Database } {
  const { sqlite, db } = createLatestSchemaSqlite();
  openDatabases.push(sqlite);
  return { sqlite, db };
}

function loadRecord(sqlite: DatabaseSync): TwitterDigestDeliveryRecord {
  const row = sqlite.prepare("SELECT value FROM cache WHERE key = ?").get(KEY) as { value: string };
  return JSON.parse(row.value) as TwitterDigestDeliveryRecord;
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const sqlite of openDatabases.splice(0)) sqlite.close();
});

describe("Twitter digest delivery ledger", () => {
  it("retains execution_unknown after a throw-after-send error and never reposts automatically", async () => {
    const { sqlite, db } = createHarness();
    const post = vi.fn(async () => {
      throw new Error("connection closed after request transmission");
    });

    await expect(deliverTwitterDigestWithLedger(db, KEY, 17, NOW_SEC, post)).rejects.toThrow(
      "connection closed after request transmission",
    );
    expect(loadRecord(sqlite)).toMatchObject({ state: "execution_unknown", attempts: 1 });

    await expect(deliverTwitterDigestWithLedger(db, KEY, 17, NOW_SEC + 300, post)).resolves.toEqual({
      status: "skipped",
      reason: "execution-unknown",
    });
    expect(post).toHaveBeenCalledTimes(1);
  });

  it("allows bounded retries after definitive rejection", async () => {
    const { sqlite, db } = createHarness();
    const rejection = Object.assign(new Error("Twitter API 403: denied"), {
      twitterDeliveryFailureKind: "definitive_failure",
    });
    const post = vi.fn(async () => {
      throw rejection;
    });

    for (let attempt = 0; attempt < 3; attempt++) {
      await expect(deliverTwitterDigestWithLedger(db, KEY, 17, NOW_SEC + attempt, post)).rejects.toThrow("denied");
    }
    expect(loadRecord(sqlite)).toMatchObject({ state: "failed", attempts: 3 });

    await expect(deliverTwitterDigestWithLedger(db, KEY, 17, NOW_SEC + 3, post)).resolves.toEqual({
      status: "skipped",
      reason: "attempt-limit",
    });
    expect(post).toHaveBeenCalledTimes(3);
  });

  it("records sent state and the returned tweet id", async () => {
    const { sqlite, db } = createHarness();
    const post = vi.fn(async () => ({
      tweetId: "1900000000000000001",
      mediaAttached: true,
      mediaError: null,
    }));

    await expect(deliverTwitterDigestWithLedger(db, KEY, 17, NOW_SEC, post)).resolves.toMatchObject({
      status: "sent",
      post: { tweetId: "1900000000000000001" },
    });
    expect(loadRecord(sqlite)).toMatchObject({
      state: "sent",
      attempts: 1,
      tweetId: "1900000000000000001",
    });
  });
});
