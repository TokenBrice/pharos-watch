import { DatabaseSync } from "node:sqlite";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  classifyDigestChannelStatus,
  didDigestChannelDeliver,
  insertDigestRecord,
  markDigestMetaBlocked,
  runDigestChannelDelivery,
} from "../platform";
import { createLatestSchemaSqlite } from "../../../test-helpers/latest-schema-sqlite";
import {
  buildTelegramCreds,
  buildTwitterCreds,
  missingTelegramCredentialNames,
  missingTwitterCredentialNames,
} from "../../../lib/runtime-credentials";

vi.mock("../../../lib/circuit-breaker", () => ({
  shouldAttemptFetch: vi.fn(async () => true),
  recordOutcomeSafe: vi.fn(async () => null),
}));

import { recordOutcomeSafe, shouldAttemptFetch } from "../../../lib/circuit-breaker";

describe("insertDigestRecord", () => {
  function makeOptions(db: D1Database, signal?: AbortSignal) {
    return {
      db,
      generatedAt: 1_710_000_000,
      digestText: "Digest body",
      digestTitle: "Digest title",
      inputData: { ok: true },
      digestExtended: "Extended body",
      digestMeta: JSON.stringify({ type: "daily" }),
      signal,
    };
  }

  function setupDigestSqlite(): DatabaseSync {
    const sqlite = createLatestSchemaSqlite().sqlite;
    return sqlite;
  }

  function sqliteD1(
    sqlite: DatabaseSync,
    throwAfterRun?: (runCount: number) => Error | null,
  ): D1Database & { getRunCount: () => number; getHistory: () => Array<{ sql: string; binds: unknown[] }> } {
    let runCount = 0;
    const history: Array<{ sql: string; binds: unknown[] }> = [];

    return {
      prepare: (sql: string) => ({
        bind: (...binds: unknown[]) => ({
          run: async () => {
            runCount++;
            history.push({ sql, binds: [...binds] });
            const result = sqlite.prepare(sql).run(...(binds as never[]));
            const error = throwAfterRun?.(runCount);
            if (error) throw error;
            return { success: true, meta: { changes: Number(result.changes) } };
          },
        }),
      }),
      getRunCount: () => runCount,
      getHistory: () => history.map((entry) => ({ sql: entry.sql, binds: [...entry.binds] })),
    } as D1Database & {
      getRunCount: () => number;
      getHistory: () => Array<{ sql: string; binds: unknown[] }>;
    };
  }

  it("retries transient D1 overloads", async () => {
    let attempts = 0;
    const db = {
      prepare: () => ({
        bind: () => ({
          run: async () => {
            attempts++;
            if (attempts === 1) throw new Error("D1 DB is overloaded");
            return { success: true, meta: { changes: 1 } };
          },
        }),
      }),
    } as unknown as D1Database;

    await insertDigestRecord(makeOptions(db));

    expect(attempts).toBe(2);
  });

  it("does not duplicate the digest row when a retried D1 write already committed", async () => {
    const sqlite = setupDigestSqlite();
    const db = sqliteD1(sqlite, (runCount) =>
      runCount === 1 ? new Error("D1 DB storage operation exceeded timeout") : null,
    );

    try {
      await insertDigestRecord(makeOptions(db));

      const rows = sqlite
        .prepare("SELECT generated_at, digest_text, digest_title, input_data, digest_extended, digest_meta FROM daily_digest")
        .all();
      const history = db.getHistory();

      expect(db.getRunCount()).toBe(2);
      expect(rows).toHaveLength(1);
      expect(history[0]?.sql).toContain("WHERE NOT EXISTS");
      expect(history[0]?.binds.slice(0, 6)).toEqual(history[0]?.binds.slice(6));
    } finally {
      sqlite.close();
    }
  });

  it("honors an already-aborted signal before preparing the insert", async () => {
    const controller = new AbortController();
    controller.abort(new Error("stop-digest"));
    const prepare = vi.fn();
    const db = {
      prepare,
    } as unknown as D1Database;

    await expect(insertDigestRecord(makeOptions(db, controller.signal))).rejects.toThrow("stop-digest");
    expect(prepare).not.toHaveBeenCalled();
  });

  it("honors an abort that fires while the D1 insert is in flight", async () => {
    const controller = new AbortController();
    const prepare = vi.fn(() => ({
      bind: () => ({
        run: async () => {
          controller.abort(new Error("stop-after-insert"));
          return { success: true, meta: { changes: 1 } };
        },
      }),
    }));
    const db = {
      prepare,
    } as unknown as D1Database;

    await expect(insertDigestRecord(makeOptions(db, controller.signal))).rejects.toThrow("stop-after-insert");
    expect(prepare).toHaveBeenCalledTimes(1);
  });
});

describe("markDigestMetaBlocked", () => {
  it("preserves existing meta fields and adds the blocked flag", () => {
    const marked = JSON.parse(
      markDigestMetaBlocked(JSON.stringify({ type: "weekly", leadSignalId: "depeg:x:active" })),
    ) as Record<string, unknown>;
    expect(marked.qualityGate).toBe("blocked");
    expect(marked.type).toBe("weekly");
    expect(marked.leadSignalId).toBe("depeg:x:active");
  });

  it("wraps null and unparseable meta in a valid blocked payload", () => {
    expect(JSON.parse(markDigestMetaBlocked(null))).toEqual({ qualityGate: "blocked" });
    expect(JSON.parse(markDigestMetaBlocked("not-json{"))).toEqual({ qualityGate: "blocked" });
  });
});

describe("digest channel status", () => {
  it.each([
    ["ok", "delivered"],
    ["ok+appendix(cemetery=1)", "delivered"],
    ["skipped: already-sent", "delivered"],
    ["failed: Twitter API 503", "retryable"],
    ["skipped: circuit-open", "retryable"],
    ["skipped: in-flight", "retryable"],
    ["skipped: stale-safety-identity", "retryable"],
    ["skipped: safety-identity-unavailable", "retryable"],
    ["queued: pending", "retryable"],
    ["queued: sending", "retryable"],
    ["queued: transport-outage_open", "retryable"],
    ["outbox-pending", "retryable"],
    ["outbox-sending", "retryable"],
    ["skipped: execution-unknown", "terminal-unsent"],
    ["skipped: attempt-limit", "terminal-unsent"],
    ["skipped: quality-gate", "terminal-unsent"],
    ["queued: execution_unknown", "terminal-unsent"],
    ["queued: failed_permanent", "terminal-unsent"],
    ["outbox-execution_unknown", "terminal-unsent"],
    ["outbox-failed_permanent", "terminal-unsent"],
    ["outbox-sent", "delivered"],
    ["skipped: no-creds", "not-configured"],
    ["no-creds", "not-configured"],
  ] as const)("classifies %s as %s", (status, disposition) => {
    expect(classifyDigestChannelStatus(status)).toBe(disposition);
  });

  it("defaults unknown statuses to terminal-unsent", () => {
    expect(classifyDigestChannelStatus("queued: a-new-state")).toBe("terminal-unsent");
    expect(classifyDigestChannelStatus("something-unrecognized")).toBe("terminal-unsent");
  });

  it("treats already-sent as delivered for lifecycle metadata", () => {
    expect(didDigestChannelDeliver("skipped: already-sent")).toBe(true);
    expect(didDigestChannelDeliver("skipped: execution-unknown")).toBe(false);
  });
});

describe("runDigestChannelDelivery", () => {
  const db = {} as D1Database;

  beforeEach(() => {
    vi.mocked(shouldAttemptFetch).mockReset().mockResolvedValue(true);
    vi.mocked(recordOutcomeSafe).mockReset().mockResolvedValue(null);
  });

  function options(deliver: (creds: string) => Promise<string | void>, creds: string | null = "creds") {
    return {
      db,
      circuitSource: "twitter-api",
      creds,
      logPrefix: "test-digest",
      channelLabel: "Twitter",
      deliver,
    };
  }

  it("uses the shared skipped grammar when credentials are absent", async () => {
    const deliver = vi.fn(async () => "ok");

    await expect(runDigestChannelDelivery(options(deliver, null))).resolves.toBe("skipped: no-creds");
    expect(deliver).not.toHaveBeenCalled();
    expect(shouldAttemptFetch).not.toHaveBeenCalled();
    expect(recordOutcomeSafe).not.toHaveBeenCalled();
  });

  it.each(["skipped: already-sent", "skipped: in-flight", "skipped: safety-identity-unavailable"])(
    "does not heal the circuit for a non-throwing %s skip",
    async (status) => {
      const deliver = vi.fn(async () => status);

      await expect(runDigestChannelDelivery(options(deliver))).resolves.toBe(status);
      expect(recordOutcomeSafe).not.toHaveBeenCalled();
    },
  );

  it("records circuit success only for an explicit delivered status", async () => {
    const deliver = vi.fn(async () => "ok+appendix(cemetery=1)");

    await expect(runDigestChannelDelivery(options(deliver))).resolves.toBe("ok+appendix(cemetery=1)");
    expect(recordOutcomeSafe).toHaveBeenCalledWith(db, "twitter-api", true);
  });
});

describe("runtime digest credentials", () => {
  const twitter = {
    TWITTER_API_KEY: " key ",
    TWITTER_API_SECRET: " secret ",
    TWITTER_ACCESS_TOKEN: " token ",
    TWITTER_ACCESS_TOKEN_SECRET: " token-secret ",
  };

  it("trims credential values and treats whitespace-only values as absent", () => {
    expect(buildTwitterCreds(twitter as Parameters<typeof buildTwitterCreds>[0])).toEqual({
      apiKey: "key",
      apiSecret: "secret",
      accessToken: "token",
      accessTokenSecret: "token-secret",
    });
    expect(
      buildTwitterCreds({ ...twitter, TWITTER_API_SECRET: "   " } as Parameters<typeof buildTwitterCreds>[0]),
    ).toBeNull();
    expect(
      buildTelegramCreds({ TELEGRAM_BOT_TOKEN: " bot ", TELEGRAM_CHAT_ID: "  " } as Parameters<typeof buildTelegramCreds>[0]),
    ).toBeNull();
  });

  it("returns only missing Twitter and Telegram environment variable names", () => {
    expect(missingTwitterCredentialNames({ ...twitter, TWITTER_ACCESS_TOKEN: "" })).toEqual([
      "TWITTER_ACCESS_TOKEN",
    ]);
    expect(missingTelegramCredentialNames({ TELEGRAM_BOT_TOKEN: "  ", TELEGRAM_CHAT_ID: " chat " })).toEqual([
      "TELEGRAM_BOT_TOKEN",
    ]);
    expect(missingTelegramCredentialNames({ TELEGRAM_BOT_TOKEN: "bot", TELEGRAM_CHAT_ID: "chat" })).toEqual([]);
  });
});
