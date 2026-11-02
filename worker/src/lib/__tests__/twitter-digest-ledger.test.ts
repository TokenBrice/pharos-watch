import type { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createLatestSchemaFixtureTracker } from "@shared/test-utils/latest-schema-sqlite";
import {
  deliverTwitterDigestWithLedger,
  readTwitterDigestDeliveryStatus,
  type TwitterDigestDeliveryRecord,
} from "../twitter-digest-ledger";

const KEY = "daily-digest:twitter-sent:2026-08-22";
const NOW_SEC = 1_787_360_000;
const fixtures = createLatestSchemaFixtureTracker();

function loadRecord(sqlite: DatabaseSync): TwitterDigestDeliveryRecord {
  const row = sqlite.prepare("SELECT value FROM cache WHERE key = ?").get(KEY) as { value: string };
  return JSON.parse(row.value) as TwitterDigestDeliveryRecord;
}

/**
 * D1 can commit a fenced UPDATE and then lose its acknowledgement. The overload
 * retry replays the statement, whose WHERE now compares the pre-write value and
 * matches zero rows.
 */
function makeCommitThenTimeoutDb(db: D1Database): D1Database {
  let ambiguousWrites = 0;
  return {
    prepare: (query: string) => {
      const statement = db.prepare(query);
      return {
        bind: (...values: unknown[]) => {
          const bound = statement.bind(...values);
          return {
            run: async () => {
              const result = await bound.run();
              if (ambiguousWrites === 0 && query.startsWith("UPDATE cache SET value = ?")) {
                ambiguousWrites += 1;
                throw new Error("D1 DB storage operation exceeded timeout");
              }
              return result;
            },
            first: () => bound.first(),
            all: () => bound.all(),
          };
        },
      };
    },
  } as unknown as D1Database;
}

afterEach(() => {
  vi.restoreAllMocks();
  fixtures.closeAll();
});

describe("Twitter digest delivery ledger", () => {
  it("retains execution_unknown after a throw-after-send error and never reposts automatically", async () => {
    const { sqlite, db } = fixtures.open();
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
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
    const executionUnknownLog = errorSpy.mock.calls
      .map(([line]) => JSON.parse(String(line)) as { level?: string; event?: string })
      .find((line) => line.event === "twitter_digest_execution_unknown");
    expect(executionUnknownLog).toMatchObject({ level: "error" });
  });

  it("logs an error when a stale sending claim is reconciled as execution_unknown", async () => {
    const { sqlite, db } = fixtures.open();
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    sqlite
      .prepare("INSERT INTO cache (key, value, updated_at) VALUES (?, ?, ?)")
      .run(
        KEY,
        JSON.stringify({
          schemaVersion: 1,
          state: "sending",
          editionNumber: 17,
          attempts: 1,
          createdAt: NOW_SEC - 200,
          updatedAt: NOW_SEC - 121,
          sendingAt: NOW_SEC - 121,
        }),
        NOW_SEC - 121,
      );

    await expect(deliverTwitterDigestWithLedger(db, KEY, 17, NOW_SEC, vi.fn())).resolves.toEqual({
      status: "skipped",
      reason: "execution-unknown",
    });
    const staleLog = errorSpy.mock.calls
      .map(([line]) => JSON.parse(String(line)) as { level?: string; event?: string; metadata?: Record<string, unknown> })
      .find((line) => line.event === "twitter_digest_execution_unknown");
    expect(staleLog).toMatchObject({
      level: "error",
      metadata: { error: "delivery_owner_lost" },
    });
  });

  it("allows bounded retries after definitive rejection", async () => {
    const { sqlite, db } = fixtures.open();
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
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
    const attemptsExhaustedLog = errorSpy.mock.calls
      .map(([line]) => JSON.parse(String(line)) as { level?: string; event?: string; metadata?: Record<string, unknown> })
      .find((line) => line.event === "twitter_digest_attempts_exhausted");
    expect(attemptsExhaustedLog).toMatchObject({
      level: "error",
      metadata: { attempts: 3, maxAttempts: 3 },
    });
  });

  it("records sent state and the returned tweet id", async () => {
    const { sqlite, db } = fixtures.open();
    const post = vi.fn(async () => ({
      tweetId: "1900000000000000001",
      mediaAttached: true,
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

  it("treats a committed claim whose acknowledgement was lost as claimed, not lost", async () => {
    const { sqlite, db } = fixtures.open();
    const post = vi.fn(async () => ({ tweetId: "1900000000000000002", mediaAttached: false }));

    await expect(deliverTwitterDigestWithLedger(makeCommitThenTimeoutDb(db), KEY, 17, NOW_SEC, post))
      .resolves.toMatchObject({ status: "sent", post: { tweetId: "1900000000000000002" } });
    expect(post).toHaveBeenCalledTimes(1);
    expect(loadRecord(sqlite)).toMatchObject({ state: "sent", attempts: 1 });
  });

  it.each([
    ["a partial repair record", '{"state":"failed","attempts":1}'],
    ["a foreign schema record", '{"schemaVersion":2,"state":"execution_unknown","attempts":1,"createdAt":1,"updatedAt":1}'],
  ])("does not publish %s as already sent", async (_label, value) => {
    const { sqlite, db } = fixtures.open();
    sqlite.prepare("INSERT INTO cache (key, value, updated_at) VALUES (?, ?, ?)").run(KEY, value, NOW_SEC);
    const post = vi.fn();

    await expect(readTwitterDigestDeliveryStatus(db, KEY)).resolves.toBe("skipped: execution-unknown");
    await expect(deliverTwitterDigestWithLedger(db, KEY, 17, NOW_SEC, post)).resolves.toEqual({
      status: "skipped",
      reason: "execution-unknown",
    });
    expect(post).not.toHaveBeenCalled();
  });

  it("keeps the known legacy delivery marker duplicate-safe", async () => {
    const { sqlite, db } = fixtures.open();
    sqlite.prepare("INSERT INTO cache (key, value, updated_at) VALUES (?, ?, ?)")
      .run(KEY, JSON.stringify({ sentAt: 1, editionNumber: 17 }), NOW_SEC);
    const post = vi.fn();

    await expect(readTwitterDigestDeliveryStatus(db, KEY)).resolves.toBe("skipped: already-sent");
    await expect(deliverTwitterDigestWithLedger(db, KEY, 17, NOW_SEC, post))
      .resolves.toEqual({ status: "skipped", reason: "already-sent" });
    expect(post).not.toHaveBeenCalled();
  });
});
