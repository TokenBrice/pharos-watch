import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath, URL as NodeUrl } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createSqliteD1 } from "../../test-helpers/sqlite-d1";

vi.mock("../digest-safety-context", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../digest-safety-context")>();
  return {
    ...actual,
    checkDigestSafetyContextForDelivery: vi.fn(),
  };
});

import {
  TELEGRAM_DIGEST_OUTBOX_CLAIM_TTL_SEC,
  deliverTelegramDigestEdition,
  drainTelegramDigestOutbox,
  enqueueTelegramDigestEdition,
} from "../telegram-digest-outbox";
import { checkDigestSafetyContextForDelivery } from "../digest-safety-context";

interface StoredEdition {
  payload_chunks_json: string;
  success_actions_json: string;
  safety_context_json: string;
  state: string;
  next_chunk_index: number;
  attempts: number;
  next_attempt_at: number | null;
  delivery_owner: string | null;
  delivery_generation: number;
  last_error_class: string | null;
  last_status_code: number | null;
}

// eslint-disable-next-line security/detect-non-literal-fs-filename -- checked-in migration fixture only.
const migrationSql = readFileSync(
  fileURLToPath(new NodeUrl("../../../migrations/0184_telegram_digest_outbox.sql", import.meta.url)),
  "utf8",
);
// eslint-disable-next-line security/detect-non-literal-fs-filename -- checked-in migration fixture only.
const safetyIdentityMigrationSql = readFileSync(
  fileURLToPath(new NodeUrl("../../../migrations/0221_telegram_digest_safety_identity.sql", import.meta.url)),
  "utf8",
);
const creds = { botToken: "bot-token", chatId: "channel-1" };
const safetyContext = {
  status: "unavailable" as const,
  expectedModel: "v9" as const,
  identity: null,
  publishedAt: null,
  reason: "safety-section-omitted",
};
const openDatabases: DatabaseSync[] = [];
let ownerSequence = 0;

function createHarness(): { sqlite: DatabaseSync; db: D1Database } {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(`
    CREATE TABLE cache (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE daily_digest (
      generated_at INTEGER PRIMARY KEY,
      digest_meta TEXT
    );
    ${migrationSql}
    ${safetyIdentityMigrationSql}
  `);
  openDatabases.push(sqlite);
  return { sqlite, db: createSqliteD1(sqlite) };
}

function loadEdition(sqlite: DatabaseSync, editionKey = "daily:2026-07-10"): StoredEdition {
  return sqlite
    .prepare(
      `SELECT payload_chunks_json, success_actions_json, safety_context_json, state, next_chunk_index,
              attempts, next_attempt_at, delivery_owner, delivery_generation,
              last_error_class, last_status_code
         FROM telegram_digest_outbox
        WHERE edition_key = ?`,
    )
    .get(editionKey) as unknown as StoredEdition;
}

async function enqueueDaily(
  db: D1Database,
  overrides: Partial<Parameters<typeof enqueueTelegramDigestEdition>[1]> = {},
) {
  return enqueueTelegramDigestEdition(db, {
    editionKey: "daily:2026-07-10",
    digestKind: "daily",
    digestGeneratedAt: 1_783_660_800,
    targetChatId: creds.chatId,
    title: "Daily Signal",
    extended: "PSI held steady while USDC remained near peg.",
    date: "2026-07-10",
    safetyContext,
    ...overrides,
  });
}

function telegramRequestText(call: unknown[]): string {
  const init = call[1] as RequestInit;
  const body = JSON.parse(String(init.body)) as { text: string };
  return body.text;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-07-10T08:05:00Z"));
  ownerSequence = 0;
  vi.stubGlobal("crypto", {
    randomUUID: () => `00000000-0000-4000-8000-${String(++ownerSequence).padStart(12, "0")}`,
  });
  vi.mocked(checkDigestSafetyContextForDelivery).mockReset().mockResolvedValue({ kind: "ok" });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
  for (const sqlite of openDatabases.splice(0)) sqlite.close();
});

describe("Telegram digest outbox", () => {
  it("persists sending before the Bot API effect and commits success actions with sent", async () => {
    const { sqlite, db } = createHarness();
    const successActions = [{ key: "telegram:appendix-pointer", value: "edition-42" }];
    await enqueueDaily(db, { successActions });
    const statesAtFetch: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async () => {
      statesAtFetch.push(loadEdition(sqlite).state);
      expect(sqlite.prepare("SELECT value FROM cache WHERE key = ?").get(successActions[0]!.key)).toBeUndefined();
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }));

    const result = await deliverTelegramDigestEdition(db, creds, "daily:2026-07-10");

    expect(statesAtFetch).toEqual(["sending"]);
    expect(result).toMatchObject({ outcome: "sent", state: "sent", chunksSent: 1 });
    expect(loadEdition(sqlite)).toMatchObject({
      state: "sent",
      next_chunk_index: 1,
      attempts: 1,
      delivery_generation: 1,
      last_error_class: null,
      last_status_code: 200,
    });
    expect(sqlite.prepare("SELECT value FROM cache WHERE key = ?").get(successActions[0]!.key))
      .toMatchObject({ value: "edition-42" });
  });

  it("honors Telegram retry_after and retries the identical stored payload", async () => {
    const { sqlite, db } = createHarness();
    await enqueueDaily(db);
    const storedPayload = (JSON.parse(loadEdition(sqlite).payload_chunks_json) as string[])[0]!;
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(
        JSON.stringify({ ok: false, description: "flood", parameters: { retry_after: 45 } }),
        { status: 429, headers: { "Retry-After": "45" } },
      ))
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const first = await deliverTelegramDigestEdition(db, creds, "daily:2026-07-10");
    expect(first).toMatchObject({ outcome: "pending", errorClass: "rate_limit", retryAfterSec: 45 });
    expect(loadEdition(sqlite)).toMatchObject({ state: "pending", attempts: 1 });
    const retryAt = loadEdition(sqlite).next_attempt_at!;

    vi.setSystemTime((retryAt - 1) * 1_000);
    const early = await drainTelegramDigestOutbox(db, creds);
    expect(early).toMatchObject({ due: 0, attempted: 0 });
    expect(fetchMock).toHaveBeenCalledTimes(1);

    vi.setSystemTime(retryAt * 1_000);
    const retry = await drainTelegramDigestOutbox(db, creds);
    expect(retry).toMatchObject({ due: 1, attempted: 1, sent: 1 });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(telegramRequestText(fetchMock.mock.calls[0]!)).toBe(storedPayload);
    expect(telegramRequestText(fetchMock.mock.calls[1]!)).toBe(storedPayload);
    expect(loadEdition(sqlite)).toMatchObject({ state: "sent", attempts: 2 });
  });

  it("resumes a split appendix from the first unconfirmed chunk without replaying accepted chunks", async () => {
    const { sqlite, db } = createHarness();
    const successActions = [{ key: "telegram:appendix-pointer", value: "large-edition" }];
    const enqueue = await enqueueDaily(db, {
      appendixHtml: `<b>Tracking Changes</b>\n\n${"long appendix line\n".repeat(500)}`,
      successActions,
    });
    expect(enqueue.chunks.length).toBeGreaterThan(1);
    expect(enqueue.chunks.every((chunk) => chunk.length <= 4000)).toBe(true);
    const storedChunks = [...enqueue.chunks];
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true }), { status: 200 }))
      .mockResolvedValueOnce(new Response(
        JSON.stringify({ ok: false, parameters: { retry_after: 30 } }),
        { status: 429 },
      ));
    vi.stubGlobal("fetch", fetchMock);

    const first = await deliverTelegramDigestEdition(db, creds, "daily:2026-07-10");
    expect(first).toMatchObject({ outcome: "pending", chunksSent: 1, nextChunkIndex: 1 });
    expect(loadEdition(sqlite)).toMatchObject({ state: "pending", next_chunk_index: 1 });
    expect(sqlite.prepare("SELECT value FROM cache WHERE key = ?").get(successActions[0]!.key)).toBeUndefined();

    const retryAt = loadEdition(sqlite).next_attempt_at!;
    vi.setSystemTime(retryAt * 1_000);
    fetchMock.mockImplementation(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }));
    const retry = await drainTelegramDigestOutbox(db, creds);

    expect(retry.sent).toBe(1);
    expect(telegramRequestText(fetchMock.mock.calls[0]!)).toBe(storedChunks[0]);
    expect(telegramRequestText(fetchMock.mock.calls[1]!)).toBe(storedChunks[1]);
    expect(telegramRequestText(fetchMock.mock.calls[2]!)).toBe(storedChunks[1]);
    expect(fetchMock.mock.calls.slice(2).map(telegramRequestText)).toEqual(storedChunks.slice(1));
    expect(loadEdition(sqlite)).toMatchObject({ state: "sent", next_chunk_index: storedChunks.length });
    expect(sqlite.prepare("SELECT value FROM cache WHERE key = ?").get(successActions[0]!.key))
      .toMatchObject({ value: "large-edition" });
  });

  it("fences network ambiguity and never replays it automatically", async () => {
    const { sqlite, db } = createHarness();
    await enqueueDaily(db);
    const fetchMock = vi.fn(async () => {
      throw new DOMException("timed out after request start", "TimeoutError");
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await deliverTelegramDigestEdition(db, creds, "daily:2026-07-10");
    expect(result).toMatchObject({ outcome: "execution_unknown", errorClass: "timeout" });
    expect(loadEdition(sqlite)).toMatchObject({ state: "execution_unknown", next_chunk_index: 0 });

    vi.setSystemTime(Date.now() + 24 * 60 * 60_000);
    const retry = await drainTelegramDigestOutbox(db, creds);
    expect(retry).toMatchObject({ due: 0, attempted: 0, retainedExecutionUnknown: 1 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("turns an expired sending owner into execution_unknown without replay", async () => {
    const { sqlite, db } = createHarness();
    await enqueueDaily(db);
    const nowSec = Math.floor(Date.now() / 1000);
    sqlite.prepare(
      `UPDATE telegram_digest_outbox
          SET state = 'sending', delivery_owner = 'abandoned', delivery_generation = 1,
              delivery_claim_expires_at = ?`,
    ).run(nowSec - 1);
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const summary = await drainTelegramDigestOutbox(db, creds);

    expect(summary).toMatchObject({ due: 0, attempted: 0, staleSendingReconciled: 1 });
    expect(loadEdition(sqlite)).toMatchObject({
      state: "execution_unknown",
      last_error_class: "delivery_owner_lost",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("does not let a stale accepted-chunk writer overwrite a newer owner generation", async () => {
    const { sqlite, db: baseDb } = createHarness();
    await enqueueDaily(baseDb);
    let replacedOwner = false;
    const db = {
      ...baseDb,
      prepare(sql: string) {
        const statement = baseDb.prepare(sql);
        if (!sql.includes("SET next_chunk_index = ?")) return statement;
        return {
          ...statement,
          bind: (...binds: unknown[]) => {
            const bound = statement.bind(...binds);
            return {
              ...bound,
              run: async () => {
                if (!replacedOwner) {
                  replacedOwner = true;
                  sqlite.prepare(
                    `UPDATE telegram_digest_outbox
                        SET delivery_owner = 'new-owner', delivery_generation = delivery_generation + 1
                      WHERE edition_key = 'daily:2026-07-10'`,
                  ).run();
                }
                throw new Error("fault after Telegram acceptance");
              },
            } as unknown as D1PreparedStatement;
          },
        } as D1PreparedStatement;
      },
    } as D1Database;
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 })));

    await expect(deliverTelegramDigestEdition(db, creds, "daily:2026-07-10"))
      .rejects.toThrow("fault after Telegram acceptance");

    expect(loadEdition(sqlite)).toMatchObject({
      state: "sending",
      delivery_owner: "new-owner",
      delivery_generation: 2,
    });
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining("Could not persist ambiguity"),
    );
  });

  it("keeps confirmed permanent rejection distinct from ambiguous execution", async () => {
    const { sqlite, db } = createHarness();
    await enqueueDaily(db);
    const fetchMock = vi.fn(async () => new Response(
      JSON.stringify({ ok: false, description: "Bad Request: can't parse entities" }),
      { status: 400 },
    ));
    vi.stubGlobal("fetch", fetchMock);

    const result = await deliverTelegramDigestEdition(db, creds, "daily:2026-07-10");
    expect(result).toMatchObject({ outcome: "failed_permanent", errorClass: "formatting_error" });
    expect(loadEdition(sqlite)).toMatchObject({
      state: "failed_permanent",
      last_error_class: "formatting_error",
      last_status_code: 400,
    });

    await drainTelegramDigestOutbox(db, creds);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("preserves the first immutable edition and reports a later payload mismatch", async () => {
    const { sqlite, db } = createHarness();
    const first = await enqueueDaily(db);
    const second = await enqueueDaily(db, { extended: "Different regenerated copy." });

    expect(first).toMatchObject({ created: true, payloadMatched: true });
    expect(second).toMatchObject({ created: false, payloadMatched: false });
    expect(JSON.parse(loadEdition(sqlite).payload_chunks_json)).toEqual(first.chunks);
  });

  it("refuses to enqueue safety claims without an identified publication", async () => {
    const { sqlite, db } = createHarness();

    await expect(enqueueDaily(db, {
      title: "USDT Safety Score",
      extended: "USDT retained an A grade.",
    })).rejects.toThrow("without an identified publication");
    expect(
      sqlite.prepare("SELECT COUNT(*) AS count FROM telegram_digest_outbox").get(),
    ).toEqual({ count: 0 });
  });

  it("terminalizes an unbound safety claim restored from persisted chunks before sending", async () => {
    const { sqlite, db } = createHarness();
    await enqueueDaily(db);
    sqlite
      .prepare("UPDATE telegram_digest_outbox SET payload_chunks_json = ? WHERE edition_key = ?")
      .run(
        JSON.stringify(["USDT's Safety Score remains A."]),
        "daily:2026-07-10",
      );
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const result = await deliverTelegramDigestEdition(db, creds, "daily:2026-07-10");

    expect(result).toMatchObject({
      outcome: "failed_permanent",
      errorClass: "unbound_safety_copy:safety-score",
    });
    expect(loadEdition(sqlite)).toMatchObject({
      state: "failed_permanent",
      last_error_class: "unbound_safety_copy:safety-score",
    });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(checkDigestSafetyContextForDelivery).not.toHaveBeenCalled();
  });

  it("terminalizes a queued edition authored under a stale exact safety identity before sending", async () => {
    const { sqlite, db } = createHarness();
    const authoredIdentity = {
      model: "v9" as const,
      schemaVersion: 1 as const,
      methodologyVersion: "9.0",
      policyId: "safety-score-v9",
      policyDigest: "a".repeat(64),
      evaluationBuildDigest: "b".repeat(64),
      baseInputGenerationId: `report-cards-input:v1:${"c".repeat(64)}`,
      publicationGenerationId: "report-cards:v9:old",
    };
    await enqueueDaily(db, {
      safetyContext: {
        status: "available",
        expectedModel: "v9",
        identity: authoredIdentity,
        publishedAt: Math.floor(Date.now() / 1000) - 60,
        reason: null,
      },
    });
    vi.mocked(checkDigestSafetyContextForDelivery).mockResolvedValueOnce({
      kind: "stale",
      reason: "identity-mismatch",
    });
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const result = await deliverTelegramDigestEdition(db, creds, "daily:2026-07-10");

    expect(result).toMatchObject({
      outcome: "failed_permanent",
      errorClass: "stale_safety_identity:identity-mismatch",
    });
    expect(loadEdition(sqlite)).toMatchObject({
      state: "failed_permanent",
      last_error_class: "stale_safety_identity:identity-mismatch",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("updates weekly compatibility metadata only after the exact edition is sent", async () => {
    const { sqlite, db } = createHarness();
    const generatedAt = Math.floor(Date.now() / 1000);
    sqlite.prepare("INSERT INTO daily_digest (generated_at, digest_meta) VALUES (?, ?)").run(
      generatedAt,
      JSON.stringify({ type: "weekly", telegramDelivered: false, telegramDeliveryStatus: "pending" }),
    );
    await enqueueTelegramDigestEdition(db, {
      editionKey: "weekly:2026-07-10",
      digestKind: "weekly",
      digestGeneratedAt: generatedAt,
      targetChatId: creds.chatId,
      title: "Weekly Recap",
      extended: "The exact weekly payload.",
      date: "2026-07-10-weekly",
      safetyContext,
    });
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 })));

    await deliverTelegramDigestEdition(db, creds, "weekly:2026-07-10");

    const row = sqlite.prepare("SELECT digest_meta FROM daily_digest WHERE generated_at = ?").get(generatedAt) as {
      digest_meta: string;
    };
    expect(JSON.parse(row.digest_meta)).toMatchObject({
      telegramDelivered: true,
      telegramDeliveryStatus: "ok",
      telegramDeliveredAt: Math.floor(Date.now() / 1000),
    });
  });

  it("keeps the claim TTL above one Bot API timeout", () => {
    expect(TELEGRAM_DIGEST_OUTBOX_CLAIM_TTL_SEC).toBeGreaterThan(10);
  });
});
