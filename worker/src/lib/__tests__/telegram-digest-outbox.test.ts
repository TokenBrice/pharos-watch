import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createLatestSchemaSqlite } from "../../test-helpers/latest-schema-sqlite";
import { mockFetch } from "@shared/test-utils/mock-fetch";

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
  map_image_url: string | null;
  map_date: string | null;
  media_state: string;
  state: string;
  next_chunk_index: number;
  attempts: number;
  next_attempt_at: number | null;
  delivery_owner: string | null;
  delivery_generation: number;
  last_error_class: string | null;
  last_status_code: number | null;
}

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
  const { sqlite, db } = createLatestSchemaSqlite();
  openDatabases.push(sqlite);
  return { sqlite, db };
}

function loadEdition(sqlite: DatabaseSync, editionKey = "daily:2026-07-10"): StoredEdition {
  return sqlite
    .prepare(
      `SELECT payload_chunks_json, success_actions_json, safety_context_json,
              map_image_url, map_date, media_state, state, next_chunk_index,
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
  it("sends the dated map as a durable photo before the text chunks", async () => {
    const { sqlite, db } = createHarness();
    const mapImageUrl = "https://pharos.watch/safety-scores/map.png?date=2026-07-10";
    const mapAppendixHtml = [
      "<b>Today’s map</b>",
      "Mapped supply: $100B across 318 coins",
      "A tier: 13 coins · 81.8%",
      "C/D/F tiers: 264 coins · 11.2%",
    ].join("\n");
    const enqueued = await enqueueDaily(db, {
      mapImageUrl,
      mapDate: "2026-07-10",
      mapAppendixHtml,
    });
    expect(enqueued.chunks.join("\n")).toContain(mapAppendixHtml);
    expect(enqueued.chunks.join("\n")).not.toContain(mapImageUrl);
    expect(loadEdition(sqlite)).toMatchObject({
      map_image_url: mapImageUrl,
      map_date: "2026-07-10",
      media_state: "pending",
      next_chunk_index: 0,
    });
    const mediaStatesAtFetch: string[] = [];
    const fetchSpy = mockFetch([], { requireMatch: true });
    fetchSpy.mockImplementation(async (input) => {
      mediaStatesAtFetch.push(loadEdition(sqlite).media_state);
      if (String(input).endsWith("/sendMessage")) {
        expect(loadEdition(sqlite)).toMatchObject({ media_state: "sent", next_chunk_index: 0 });
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    });

    const result = await deliverTelegramDigestEdition(db, creds, "daily:2026-07-10");

    expect(result).toMatchObject({ outcome: "sent", chunksSent: 1 });
    expect(fetchSpy.mock.calls.map((call) => String(call[0]).split("/").pop())).toEqual([
      "sendPhoto",
      "sendMessage",
    ]);
    const photoBody = JSON.parse(String(fetchSpy.mock.calls[0]![1]?.body));
    expect(photoBody).toMatchObject({
      photo: mapImageUrl,
      caption: "<b>Safety Score map · 2026-07-10</b>",
      parse_mode: "HTML",
    });
    const textBody = JSON.parse(String(fetchSpy.mock.calls[1]![1]?.body));
    expect(textBody.text).toContain(mapAppendixHtml);
    expect(textBody.text).not.toContain(mapImageUrl);
    expect(textBody.link_preview_options).toBeUndefined();
    expect(mediaStatesAtFetch).toEqual(["pending", "sent"]);
    expect(loadEdition(sqlite)).toMatchObject({ media_state: "sent", state: "sent", next_chunk_index: 1 });
  });

  it("keeps failed photo delivery retryable without advancing the text cursor", async () => {
    const { sqlite, db } = createHarness();
    const mapImageUrl = "https://pharos.watch/safety-scores/map.png?date=2026-07-09";
    await enqueueDaily(db, { mapImageUrl, mapDate: "2026-07-09" });
    const fetchMock = mockFetch([{
      match: () => true,
      outcomes: [
        { body: { ok: false, description: "server unavailable" }, status: 503 },
        { body: { ok: true } },
        { body: { ok: true } },
      ],
    }]);

    const first = await deliverTelegramDigestEdition(db, creds, "daily:2026-07-10");

    expect(first).toMatchObject({
      outcome: "pending",
      chunksSent: 0,
      nextChunkIndex: 0,
      errorClass: "server_error",
    });
    expect(loadEdition(sqlite)).toMatchObject({
      state: "pending",
      media_state: "pending",
      next_chunk_index: 0,
      attempts: 1,
    });

    vi.setSystemTime(loadEdition(sqlite).next_attempt_at! * 1_000);
    const retry = await drainTelegramDigestOutbox(db, creds);

    expect(retry).toMatchObject({ due: 1, attempted: 1, sent: 1 });
    expect(fetchMock.mock.calls.map((call) => String(call[0]).split("/").pop())).toEqual([
      "sendPhoto",
      "sendPhoto",
      "sendMessage",
    ]);
    expect(loadEdition(sqlite)).toMatchObject({
      state: "sent",
      media_state: "sent",
      next_chunk_index: 1,
      attempts: 2,
    });
  });

  it("does not resend a durably accepted photo when text delivery retries", async () => {
    const { sqlite, db } = createHarness();
    await enqueueDaily(db, {
      mapImageUrl: "https://pharos.watch/safety-scores/map.png?date=2026-07-10",
      mapDate: "2026-07-10",
    });
    const fetchMock = mockFetch([{
      match: () => true,
      outcomes: [
        { body: { ok: true } },
        { body: { ok: false, description: "server unavailable" }, status: 503 },
        { body: { ok: true } },
      ],
    }]);

    const first = await deliverTelegramDigestEdition(db, creds, "daily:2026-07-10");

    expect(first).toMatchObject({ outcome: "pending", chunksSent: 0, nextChunkIndex: 0 });
    expect(loadEdition(sqlite)).toMatchObject({
      state: "pending",
      media_state: "sent",
      next_chunk_index: 0,
    });

    vi.setSystemTime(loadEdition(sqlite).next_attempt_at! * 1_000);
    const retry = await drainTelegramDigestOutbox(db, creds);

    expect(retry).toMatchObject({ due: 1, attempted: 1, sent: 1 });
    expect(fetchMock.mock.calls.map((call) => String(call[0]).split("/").pop())).toEqual([
      "sendPhoto",
      "sendMessage",
      "sendMessage",
    ]);
    expect(loadEdition(sqlite)).toMatchObject({ state: "sent", media_state: "sent", next_chunk_index: 1 });
  });

  it("sends a text-only edition with media_state none", async () => {
    const { sqlite, db } = createHarness();
    await enqueueDaily(db);
    const fetchMock = mockFetch([{ match: () => true, body: { ok: true } }]);

    const result = await deliverTelegramDigestEdition(db, creds, "daily:2026-07-10");

    expect(result).toMatchObject({ outcome: "sent", chunksSent: 1 });
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain("/sendMessage");
    expect(loadEdition(sqlite)).toMatchObject({
      media_state: "none",
      map_image_url: null,
      map_date: null,
      state: "sent",
    });
  });

  it("persists sending before the Bot API effect and commits success actions with sent", async () => {
    const { sqlite, db } = createHarness();
    const successActions = [{ key: "telegram:appendix-pointer", value: "edition-42" }];
    await enqueueDaily(db, { successActions });
    const statesAtFetch: string[] = [];
    mockFetch([{
      match: () => true,
      respond: () => {
        statesAtFetch.push(loadEdition(sqlite).state);
        expect(sqlite.prepare("SELECT value FROM cache WHERE key = ?").get(successActions[0]!.key)).toBeUndefined();
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      },
    }]);

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

  it("persists the rollout-gated recap CTA inside the immutable text payload", async () => {
    const { sqlite, db } = createHarness();
    const enqueued = await enqueueDaily(db, {
      recapRollout: { mode: "public", allowedChatIds: new Set() },
    });
    expect(enqueued.chunks.join("\n")).toContain("private /recap");

    const fetchMock = mockFetch([{ match: () => true, body: { ok: true } }]);
    const result = await deliverTelegramDigestEdition(db, creds, "daily:2026-07-10");

    expect(result).toMatchObject({ outcome: "sent", chunksSent: 1 });
    expect(fetchMock.mock.calls).toHaveLength(1);
    const payload = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)) as Record<string, unknown>;
    expect(payload.reply_markup).toBeUndefined();
    expect(loadEdition(sqlite)).toMatchObject({ state: "sent", next_chunk_index: 1 });
    expect(JSON.parse(loadEdition(sqlite).payload_chunks_json)[0]).toContain("private /recap");
  });

  it("honors Telegram retry_after and retries the identical stored payload", async () => {
    const { sqlite, db } = createHarness();
    await enqueueDaily(db);
    const storedPayload = (JSON.parse(loadEdition(sqlite).payload_chunks_json) as string[])[0]!;
    const fetchMock = mockFetch([{
      match: () => true,
      outcomes: [
        { body: { ok: false, description: "flood", parameters: { retry_after: 45 } }, status: 429, headers: { "Retry-After": "45" } },
        { body: { ok: true } },
      ],
    }]);

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

  it("keeps a due retry queued when the authoritative fresh-delivery permit is paused", async () => {
    const { sqlite, db } = createHarness();
    await enqueueDaily(db);
    const nowSec = Math.floor(Date.now() / 1000);
    sqlite.prepare(
      `INSERT INTO telegram_delivery_pauses
         (mode, generation, expires_at, reason, actor, created_at, updated_at)
       VALUES ('fresh', 1, ?, 'operator maintenance', 'test', ?, ?)`,
    ).run(nowSec + 300, nowSec, nowSec);
    const fetchMock = mockFetch([], { requireMatch: true });

    const summary = await drainTelegramDigestOutbox(db, creds);

    expect(summary).toMatchObject({ due: 1, attempted: 0, sent: 0, skipped: 1 });
    expect(loadEdition(sqlite)).toMatchObject({ state: "pending", attempts: 0 });
    expect(fetchMock).not.toHaveBeenCalled();
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
    const fetchMock = mockFetch([{
      match: () => true,
      outcomes: [
        { body: { ok: true } },
        { body: { ok: false, parameters: { retry_after: 30 } }, status: 429 },
      ],
    }]);

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
    const fetchMock = mockFetch([{ match: () => true, outcomes: [new DOMException("timed out after request start", "TimeoutError")] }]);

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
    const fetchMock = mockFetch([], { requireMatch: true });

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
    mockFetch([{ match: () => true, body: { ok: true } }]);

    await expect(deliverTelegramDigestEdition(db, creds, "daily:2026-07-10"))
      .rejects.toThrow("fault after Telegram acceptance");

    expect(loadEdition(sqlite)).toMatchObject({
      state: "sending",
      delivery_owner: "new-owner",
      delivery_generation: 2,
    });
    expect(JSON.parse(String(errorSpy.mock.calls[0]?.[0]))).toMatchObject({
      event: "telegram_digest_ambiguity_persistence_lost",
      metadata: { editionKey: "daily:2026-07-10" },
    });
  });

  it("keeps confirmed permanent rejection distinct from ambiguous execution", async () => {
    const { sqlite, db } = createHarness();
    await enqueueDaily(db);
    const fetchMock = mockFetch([{
      match: () => true,
      body: { ok: false, description: "Bad Request: can't parse entities" },
      status: 400,
    }]);

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

  it("includes the typed map identity in immutable edition equality", async () => {
    const { sqlite, db } = createHarness();
    const first = await enqueueDaily(db, {
      mapImageUrl: "https://pharos.watch/safety-scores/map.png?date=2026-07-10",
      mapDate: "2026-07-10",
    });
    const second = await enqueueDaily(db, {
      mapImageUrl: "https://pharos.watch/safety-scores/map.png?date=2026-07-09",
      mapDate: "2026-07-09",
    });

    expect(first).toMatchObject({ created: true, payloadMatched: true });
    expect(second).toMatchObject({ created: false, payloadMatched: false });
    expect(loadEdition(sqlite)).toMatchObject({
      map_image_url: "https://pharos.watch/safety-scores/map.png?date=2026-07-10",
      map_date: "2026-07-10",
      media_state: "pending",
    });
  });

  it("keeps the migration compatible with the previous Worker's insert shape", () => {
    const { sqlite } = createHarness();
    const nowSec = Math.floor(Date.now() / 1000);
    sqlite.prepare(
      `INSERT INTO telegram_digest_outbox (
         edition_key, digest_kind, digest_generated_at, target_chat_id,
         payload_chunks_json, success_actions_json, safety_context_json, state, next_attempt_at,
         created_at, updated_at
       ) VALUES (?, 'daily', ?, ?, ?, '[]', ?, 'pending', ?, ?, ?)`,
    ).run(
      "daily:legacy-worker",
      nowSec,
      creds.chatId,
      JSON.stringify(["Legacy Worker payload"]),
      JSON.stringify(safetyContext),
      nowSec,
      nowSec,
      nowSec,
    );

    expect(loadEdition(sqlite, "daily:legacy-worker")).toMatchObject({
      map_image_url: null,
      map_date: null,
      media_state: "none",
      state: "pending",
      next_chunk_index: 0,
    });
    expect(() => sqlite.prepare(
      "UPDATE telegram_digest_outbox SET media_state = 'invalid' WHERE edition_key = ?",
    ).run("daily:legacy-worker")).toThrow();
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
    const fetchMock = mockFetch([], { requireMatch: true });

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
    const fetchMock = mockFetch([], { requireMatch: true });

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
    sqlite.prepare(
      "INSERT INTO daily_digest (generated_at, digest_text, input_data, digest_meta) VALUES (?, '', '{}', ?)",
    ).run(
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
    mockFetch([{ match: () => true, body: { ok: true } }]);

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
