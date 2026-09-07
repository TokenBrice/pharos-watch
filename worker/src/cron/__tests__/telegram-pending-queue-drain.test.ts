import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mockD1 as createMockD1, type MockTableConfig } from "@shared/test-utils/mock-d1";
import { serializePendingAlertScope, serializePendingMarkupPolicy } from "../../lib/telegram/pending-provenance";
import { createLatestSchemaSqlite } from "../../test-helpers/latest-schema-sqlite";
import { createSqliteD1 } from "../../test-helpers/sqlite-d1";
import {
  DEFAULT_TELEGRAM_PENDING_D1_TABLES,
  createClaimContentionD1,
  insertAlertJobFixture,
  insertAlertJobTargetFixture,
  insertPendingSqlite,
  insertRecapDeliveryFixture,
  insertRiskPendingSqlite,
  insertSourceEventSqlite,
  insertSubscriberSqlite,
  makePendingQueryRow,
  makeTelegramBlockedResult,
  makeTelegramDeliveryResult,
  makeTelegramPermanentResult,
  makeTelegramRateLimitedResult,
  makeTelegramRetryableResult,
  makeTelegramSentResult,
  resetTelegramPendingMocks,
  withPendingQueueScenario,
} from "./telegram-pending-queue.test-support";

function mockD1(tables: MockTableConfig[] = []) {
  return createMockD1([...tables, ...DEFAULT_TELEGRAM_PENDING_D1_TABLES]);
}

const mockSendToChat = vi.fn();
const mockMigrateTelegramChatId = vi.fn();
const transportMocks = vi.hoisted(() => ({ claim: vi.fn(), readPause: vi.fn(), record: vi.fn() }));

vi.mock("../../lib/telegram", async (importOriginal) => ({ ...(await importOriginal<typeof import("../../lib/telegram")>()), sendToChat: mockSendToChat }));
vi.mock("../../lib/telegram/transport-control", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../lib/telegram/transport-control")>()),
  claimTelegramTransportPermit: transportMocks.claim,
  readTelegramDeliveryPause: transportMocks.readPause,
  recordTelegramTransportOutcomes: transportMocks.record,
}));
vi.mock("../../lib/telegram/subscriber-lifecycle", () => ({ migrateTelegramChatId: mockMigrateTelegramChatId }));

const {
  drainPendingQueue,
  cleanupExpiredPendingAlerts,
  pendingBackoffSec,
  PENDING_TTL_SEC,
  PENDING_MAX_ATTEMPTS,
  PENDING_BACKOFF_SCHEDULE_SEC,
  BLOCK_STRIKE_WINDOW_SEC,
  TELEGRAM_PENDING_PRIORITY,
  TELEGRAM_GLOBAL_BACKOFF_CACHE_KEY,
  SEND_BATCH_SIZE,
  reconcileStalePendingSending,
} = await import("../telegram-pending");
const { enqueuePendingAlerts, buildDedupeKey } = await import("../../lib/telegram/pending-queue");
await import("../../lib/telegram/alerts");

beforeEach(() => {
  resetTelegramPendingMocks({ sendToChat: mockSendToChat, migrateTelegramChatId: mockMigrateTelegramChatId, transport: transportMocks, sendBatchSize: SEND_BATCH_SIZE });
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-04-23T12:00:00Z"));
});

afterEach(() => vi.useRealTimers());

function row(id: number, overrides: Record<string, unknown> = {}) {
  return makePendingQueryRow(id, overrides);
}

function queueDb(rows: Record<string, unknown>[], extra: MockTableConfig[] = []) {
  return mockD1([{ match: "FROM telegram_pending_alerts p", rows }, ...extra]);
}

function history(db: { getHistory(): Array<{ sql: string; binds: unknown[] }> }, fragment: string) {
  return db.getHistory().filter((entry) => entry.sql.includes(fragment));
}

describe("drainPendingQueue contract cases", () => {
  it("returns the empty result for zero work and for an empty queue", async () => {
    const zero = await drainPendingQueue(queueDb([]), "bot-token", 0);
    expect(zero).toEqual({ attempted: 0, sent: 0, acceptedChats: 0, blocked: 0, blockedCleanedUp: 0, blockedCleanupFailed: 0, retryQueued: 0, executionUnknown: 0, dropped: 0, droppedPermanentFailure: 0, droppedMaxAttemptsFallback: 0, deferred: 0, rateLimited: false, retryAfterSec: null, notBeforeAt: null });
    const empty = await drainPendingQueue(queueDb([]), "bot-token", 10);
    expect(empty).toEqual(zero);
    expect(mockSendToChat).not.toHaveBeenCalled();
  });

  it("sends eligible rows in chunk order and preserves quiet-hour/markup transport options", async () => {
    mockSendToChat.mockResolvedValue(makeTelegramSentResult());
    const now = Math.floor(Date.now() / 1000);
    const db = queueDb([
      row(1, { chat_id: "ordered", message_html: "chunk-1", chunk_index: 1, created_at: now - 10 }),
      row(2, { chat_id: "ordered", message_html: "chunk-2", chunk_index: 2, created_at: now - 10 }),
      row(3, { chat_id: "quiet", message_html: "quiet", chunk_index: null, delivery_state: null, delivery_generation: null, quiet_hours_enabled: 1, quiet_hours_start_utc: 0, quiet_hours_end_utc: 23 }),
    ], [{ match: "DELETE FROM telegram_pending_alerts WHERE id IN", rows: [] }]);
    const markStarted = vi.fn();
    await expect(drainPendingQueue(db, "bot-token", 10, undefined, { markTelegramDeliveryStarted: markStarted })).resolves.toMatchObject({ attempted: 3, sent: 3, acceptedChats: 2 });
    const sentHtml = mockSendToChat.mock.calls.map((call) => call[1]);
    expect(sentHtml).toEqual(expect.arrayContaining(["chunk-1", "chunk-2", "quiet"]));
    expect(sentHtml.indexOf("chunk-1")).toBeLessThan(sentHtml.indexOf("chunk-2"));
    expect(mockSendToChat.mock.calls.find((call) => call[0] === "quiet")?.[3]).toEqual(expect.objectContaining({ disableNotification: true }));
    expect(markStarted).toHaveBeenCalled();
    expect(history(db, "FROM telegram_pending_alerts p").length).toBeGreaterThanOrEqual(2);
    expect(history(db, "SELECT p.id").every((entry) => /p\.chunk_index ASC\s+LIMIT/.test(entry.sql))).toBe(true);
  });

  it("honors selection boundaries, snooze, max-priority filtering, and soft-deadline release", async () => {
    const now = Math.floor(Date.now() / 1000);
    const snoozed = queueDb([row(30, { chat_id: "snoozed", alert_snooze_until_ts: now + 900 })], [{ match: "UPDATE telegram_pending_alerts SET not_before_at", rows: [] }]);
    await expect(drainPendingQueue(snoozed, "bot-token", 10)).resolves.toMatchObject({ attempted: 0, deferred: 1 });
    expect(history(snoozed, "SET not_before_at")[0]?.binds.slice(0, 4)).toEqual([now + 900, "preference_snoozed", now, 30]);

    const filtered = queueDb([]);
    await drainPendingQueue(filtered, "bot-token", 10, undefined, { maxPriority: TELEGRAM_PENDING_PRIORITY.riskAlert });
    const select = history(filtered, "SELECT p.id")[0];
    expect(select?.sql).toContain("COALESCE(p.priority");
    expect(select?.binds).toEqual([PENDING_TTL_SEC, now, now, TELEGRAM_PENDING_PRIORITY.riskAlert, TELEGRAM_PENDING_PRIORITY.legacy, TELEGRAM_PENDING_PRIORITY.riskAlert, now, TELEGRAM_PENDING_PRIORITY.legacy, 10]);

    const deadline = await withPendingQueueScenario({ now, pending: { id: 31, chatId: "deadline", html: "deadline", createdAt: now - 60, expiresAt: now + 600 } }, async ({ sqlite, db }) => {
      const result = await drainPendingQueue(db, "bot-token", 10, undefined, { softDeadlineAtMs: Date.now() - 1 });
      return { result, state: sqlite.prepare("SELECT processing_owner, processing_started_at, processing_expires_at FROM telegram_pending_alerts WHERE id = 31").get() };
    });
    expect(deadline.result).toMatchObject({ attempted: 0, sent: 0 });
    expect(deadline.state).toEqual({ processing_owner: null, processing_started_at: null, processing_expires_at: null });
  });

  it.each([
    { label: "success", result: makeTelegramDeliveryResult(), attempts: 0, expected: { sent: 1, attempted: 1 } },
    { label: "retry below the ceiling", result: makeTelegramRetryableResult({ statusCode: 500, errorClass: "server_error" }), attempts: 0, expected: { retryQueued: 1, dropped: 0 } },
    { label: "max attempts", result: makeTelegramRetryableResult({ statusCode: 500, errorClass: "server_error" }), attempts: PENDING_MAX_ATTEMPTS, expected: { droppedMaxAttemptsFallback: 1, dropped: 1 } },
    { label: "permanent failure", result: makeTelegramPermanentResult(), attempts: 0, expected: { droppedPermanentFailure: 1, dropped: 1 } },
    { label: "execution unknown", result: makeTelegramRetryableResult({ statusCode: null, errorClass: "timeout" }), attempts: 0, expected: { executionUnknown: 1, dropped: 0 } },
  ] as const)("projects $label once and persists its terminal/retry state", async ({ result, attempts, expected }) => {
    mockSendToChat.mockResolvedValue(result);
    const db = queueDb([row(40, { attempts, dedupe_key: null })], [{ match: "UPDATE telegram_pending_alerts SET attempts", rows: [] }, { match: "DELETE FROM telegram_pending_alerts WHERE id IN", rows: [] }]);
    await expect(drainPendingQueue(db, "bot-token", 10)).resolves.toMatchObject(expected);
    expect(mockSendToChat).toHaveBeenCalledTimes(1);
  });

  it("uses every backoff boundary and prefers Retry-After", () => {
    expect(PENDING_BACKOFF_SCHEDULE_SEC).toEqual([60, 120, 240, 480, 600]);
    expect(PENDING_BACKOFF_SCHEDULE_SEC.map((_, attempt) => pendingBackoffSec(attempt, null))).toEqual(PENDING_BACKOFF_SCHEDULE_SEC);
    expect(pendingBackoffSec(5, null)).toBe(600);
    expect(pendingBackoffSec(19, null)).toBe(600);
    expect(pendingBackoffSec(0, 30)).toBe(30);
    expect(pendingBackoffSec(4, 1800)).toBe(1800);
  });

  it("writes local retry backoff and keeps retryable alerts alive past the legacy cap", async () => {
    mockSendToChat.mockResolvedValue(makeTelegramRetryableResult({ statusCode: 500, errorClass: "server_error" }));
    const now = Math.floor(Date.now() / 1000);
    const db = queueDb([row(401, { chat_id: "a", attempts: 0, created_at: now - 60 }), row(402, { chat_id: "b", attempts: 2, created_at: now - 60 })], [{ match: "UPDATE telegram_pending_alerts SET attempts", rows: [] }]);
    await drainPendingQueue(db, "bot-token", 10);
    const updates = history(db, "SET attempts");
    expect(updates).toHaveLength(2);
    expect(updates.find((entry) => entry.binds[4] === 401)?.binds[0]).toBe(now + 60);
    expect(updates.find((entry) => entry.binds[4] === 402)?.binds[0]).toBe(now + 240);

    let attempts = 0;
    for (let elapsed = 0; elapsed <= 30; elapsed += 5) {
      vi.setSystemTime(new Date(Date.now() + (elapsed === 0 ? 0 : 5 * 60_000)));
      mockSendToChat.mockResolvedValueOnce(elapsed >= 25 ? makeTelegramSentResult() : makeTelegramRateLimitedResult({ rateLimitScope: "chat", retryAfterSec: 120 }));
      const result = await drainPendingQueue(queueDb([row(999, { created_at: now, attempts })], [{ match: "UPDATE telegram_pending_alerts SET attempts", rows: [] }, { match: "DELETE FROM telegram_pending_alerts WHERE id IN", rows: [] }]), "bot-token", 10);
      if (result.sent) break;
      attempts++;
      expect(result).toMatchObject({ retryQueued: 1, dropped: 0 });
      expect(attempts).toBeLessThan(PENDING_MAX_ATTEMPTS);
    }
    expect(mockSendToChat).toHaveBeenCalledWith("chat-999", expect.any(String), "bot-token", expect.any(Object));
  });

  it.each([
    { scope: "chat" as const, expectedCalls: 8, expectedSent: 7 },
    { scope: "global" as const, expectedCalls: 4, expectedSent: 3 },
  ])("handles a $scope rate limit at the correct scope", async ({ scope, expectedCalls, expectedSent }) => {
    mockSendToChat.mockImplementation((_, __, ___, ____,) => Promise.resolve(
      makeTelegramRateLimitedResult({ rateLimitScope: scope, retryAfterSec: 30 }),
    ));
    const rows = Array.from({ length: scope === "global" ? 8 : 8 }, (_, i) => row(i + 1, { chat_id: `chat-${i}`, message_html: `msg${i}` }));
    let calls = 0;
    mockSendToChat.mockImplementation(() => {
      calls++;
      return Promise.resolve(calls === (scope === "global" ? 4 : 4) ? makeTelegramRateLimitedResult({ rateLimitScope: scope, retryAfterSec: 30 }) : makeTelegramSentResult());
    });
    const db = queueDb(rows, [{ match: "DELETE FROM telegram_pending_alerts WHERE id IN", rows: [] }, { match: "UPDATE telegram_pending_alerts SET attempts", rows: [] }, ...(scope === "global" ? [{ match: "INSERT OR REPLACE INTO cache", rows: [] }] : [])]);
    const result = await drainPendingQueue(db, "bot-token", 20);
    expect(result).toMatchObject({ attempted: expectedCalls, sent: expectedSent, retryQueued: 1, rateLimited: true, retryAfterSec: 30 });
    if (scope === "global") expect(history(db, "INSERT OR REPLACE INTO cache")[0]?.binds).toEqual([TELEGRAM_GLOBAL_BACKOFF_CACHE_KEY, String(Math.floor(Date.now() / 1000) + 30), Math.floor(Date.now() / 1000)]);
    else expect(history(db, "INSERT OR REPLACE INTO cache")).toHaveLength(0);
  });

  it("defers later same-chat chunks after a chat limit while other chats continue", async () => {
    mockSendToChat.mockResolvedValueOnce(makeTelegramRateLimitedResult({ rateLimitScope: "chat", retryAfterSec: 45 })).mockResolvedValue(makeTelegramSentResult());
    const db = queueDb([
      row(1, { chat_id: "chat-a", message_html: "chunk-0", chunk_index: 0 }),
      row(2, { chat_id: "chat-a", message_html: "chunk-1", chunk_index: 1 }),
      row(3, { chat_id: "chat-a", message_html: "chunk-2", chunk_index: 2 }),
      row(4, { chat_id: "chat-a", message_html: "chunk-3", chunk_index: 3 }),
      row(5, { chat_id: "chat-b", message_html: "other" }),
    ], [{ match: "DELETE FROM telegram_pending_alerts WHERE id IN", rows: [] }, { match: "UPDATE telegram_pending_alerts SET attempts", rows: [] }]);
    const result = await drainPendingQueue(db, "bot-token", 20);
    expect(result).toMatchObject({ attempted: 2, sent: 1, retryQueued: 1, deferred: 3, rateLimited: true, retryAfterSec: 45 });
    expect(mockSendToChat).toHaveBeenCalledTimes(2);
    expect(history(db, "SET attempts")[0]?.binds[0]).toBe(Math.floor(Date.now() / 1000) + 45);
  });

  it.each([
    { priorStrike: false, strikeCount: 1, cleaned: 0 },
    { priorStrike: true, strikeCount: 2, cleaned: 1 },
  ])("handles the $strikeCount chat_not_found strike without double-counting cleanup", async ({ priorStrike, strikeCount, cleaned }) => {
    mockSendToChat.mockResolvedValue(makeTelegramBlockedResult({ errorClass: "chat_not_found", statusCode: 400 }));
    const now = Math.floor(Date.now() / 1000);
    const db = queueDb([row(20 + strikeCount, { chat_id: `blocked-${strikeCount}` })], [
      { match: "SELECT consecutive_block_count", rows: priorStrike ? [{ consecutive_block_count: 1, consecutive_block_first_at: now - 3600 }] : [] },
      { match: "UPDATE telegram_subscribers", rows: [] },
      ...(cleaned ? [{ match: "UPDATE telegram_subscriptions", rows: [] }, { match: "DELETE FROM telegram_preset_subscriptions", rows: [] }] : []),
      { match: "DELETE FROM telegram_pending_alerts WHERE id IN", rows: [] },
    ]);
    const result = await drainPendingQueue(db, "bot-token", 10);
    expect(result).toMatchObject({ blocked: 1, blockedCleanedUp: cleaned, sent: 0 });
    const counter = history(db, "UPDATE telegram_subscribers").find((entry) => entry.sql.includes("consecutive_block_count"));
    expect(counter?.binds[0]).toBe(strikeCount);
    expect(history(db, "UPDATE telegram_subscribers").filter((entry) => entry.sql.includes("alert_dews=0"))).toHaveLength(cleaned ? 1 : 0);
  });

  it("dead-letters all same-chat siblings after disabling a chat and records one cleanup", async () => {
    const { sqlite, db } = createLatestSchemaSqlite();
    try {
      const now = Math.floor(Date.now() / 1000);
      sqlite.prepare(`INSERT INTO telegram_subscribers (chat_id, created_at, last_active_at, consecutive_block_count, consecutive_block_first_at, alert_dews, alert_depeg, alert_safety, alert_launch, alert_reserve, global_alert_dews, global_alert_depeg, global_alert_safety, global_alert_launch, global_alert_reserve) VALUES (?, ?, ?, 1, ?, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1)`).run("siblings", now - 600, now - 600, now - 60);
      insertPendingSqlite(sqlite, { id: 210, chatId: "siblings", html: "attempted", createdAt: now - 120, dedupeKey: "attempted" });
      insertPendingSqlite(sqlite, { id: 211, chatId: "siblings", html: "tail", createdAt: now - 60, notBeforeAt: now + 600, dedupeKey: "tail" });
      mockSendToChat.mockResolvedValue(makeTelegramBlockedResult({ errorClass: "chat_not_found", statusCode: 400 }));
      const result = await drainPendingQueue(db, "bot-token", 1);
      expect(result).toMatchObject({ blocked: 1, blockedCleanedUp: 1, blockedCleanupFailed: 0 });
      expect(sqlite.prepare("SELECT COUNT(*) AS count FROM telegram_pending_alerts").get()).toEqual({ count: 0 });
      expect(sqlite.prepare("SELECT pending_id, reason FROM telegram_alert_dead_letters ORDER BY pending_id").all()).toEqual([{ pending_id: 210, reason: "blocked_disabled" }, { pending_id: 211, reason: "blocked_disabled" }]);
    } finally { sqlite.close(); }
  });

  it("handles permanent predecessor failure and chat migration as terminal cases", async () => {
    mockSendToChat.mockResolvedValue(makeTelegramPermanentResult());
    const rows = Array.from({ length: 4 }, (_, i) => row(1300 + i, { chat_id: "same", message_html: `chunk-${i}`, chunk_index: i, dedupe_key: `same:${i}` }));
    const db = queueDb(rows, [{ match: "INSERT INTO telegram_alert_dead_letters", rows: [] }, { match: "DELETE FROM telegram_pending_alerts WHERE id IN", rows: [] }]);
    await expect(drainPendingQueue(db, "bot-token", rows.length)).resolves.toMatchObject({ attempted: 1, dropped: 4, droppedPermanentFailure: 4 });
    expect(mockSendToChat).toHaveBeenCalledTimes(1);

    mockSendToChat.mockReset().mockResolvedValue(makeTelegramPermanentResult({ errorClass: "chat_migrated", migrateToChatId: "-1001234567890" }));
    const migrated = queueDb([row(1310, { chat_id: "-1234567890", message_html: "migrated", dedupe_key: "old" })], [{ match: "INSERT INTO telegram_alert_dead_letters", rows: [] }, { match: "DELETE FROM telegram_pending_alerts", rows: [] }]);
    await drainPendingQueue(migrated, "bot-token", 1);
    expect(mockMigrateTelegramChatId).toHaveBeenCalledWith(migrated, "-1234567890", "-1001234567890");
  });

  it("projects personalized recap acceptance and pause cancellation with persisted markup", async () => {
    for (const paused of [false, true]) {
      await withPendingQueueScenario({}, async ({ sqlite, db, now }) => {
        const { recapKey } = insertRecapDeliveryFixture(sqlite, now, { paused });
        if (!paused) sqlite.prepare("UPDATE telegram_pending_alerts SET markup_policy_json = ? WHERE id = 8501").run(serializePendingMarkupPolicy({ replyMarkup: { inline_keyboard: [[{ text: "Open", callback_data: "open" }]] }, linkPreviewOptions: { url: "https://pharos.watch", prefer_small_media: true } }));
        if (!paused) mockSendToChat.mockResolvedValue(makeTelegramSentResult());
        const result = await drainPendingQueue(db, "bot-token", 1);
        expect(result).toMatchObject(paused ? { attempted: 0, dropped: 1 } : { attempted: 1, sent: 1 });
        expect(mockSendToChat).toHaveBeenCalledTimes(paused ? 0 : 1);
        expect(sqlite.prepare("SELECT status FROM telegram_recap_targets WHERE recap_key = ?").get(recapKey)).toEqual({ status: paused ? "cancelled" : "sent" });
        if (!paused) expect(mockSendToChat.mock.calls[0]?.[3]).toEqual(expect.objectContaining({ replyMarkup: expect.any(Object), linkPreviewOptions: { url: "https://pharos.watch", prefer_small_media: true } }));
      });
      mockSendToChat.mockClear();
    }
  });

  it("defers incomplete preference data and cancels a changed generation before the Bot API", async () => {
    const now = Math.floor(Date.now() / 1000);
    const scope = serializePendingAlertScope([{ stablecoinId: "usdc-circle", family: "dews" }]);
    const pending = { id: 801, chatId: "preference", html: "cancel", createdAt: now - 60, expiresAt: now + 600, sourceType: "risk_alert", alertType: "dews", dedupeKey: "preference-key", sourceEventId: "source-cancel", alertScopeJson: scope, preferenceGeneration: 1, markupPolicyJson: serializePendingMarkupPolicy({}) };
    const cancel = await withPendingQueueScenario({ now, subscriber: { chatId: "preference", preferenceGeneration: 2, globalAlertDews: 0 }, pending, target: { jobId: "job", targetKey: "target", chatId: "preference", alertType: "dews", pendingDedupeKey: "preference-key" } }, async ({ sqlite, db }) => ({ result: await drainPendingQueue(db, "bot-token", 1), dead: sqlite.prepare("SELECT reason, last_error_class FROM telegram_alert_dead_letters WHERE pending_id = 801").get() }));
    expect(cancel.result).toMatchObject({ attempted: 0, dropped: 1 });
    expect(cancel.dead).toEqual({ reason: "preference_changed", last_error_class: "scope_disabled" });

    const incomplete = await withPendingQueueScenario({ now, pending: { ...pending, id: 802, chatId: "incomplete" } }, async ({ db, sqlite }) => {
      const failing = { ...db, prepare: (sql: string) => sql.includes("SELECT chat_id, preference_generation, alert_snooze_until_ts") ? { bind: () => ({ all: async () => { throw new Error("preference lookup unavailable"); } }) } as unknown as D1PreparedStatement : db.prepare(sql) } as D1Database;
      return { result: await drainPendingQueue(failing, "bot-token", 1), state: sqlite.prepare("SELECT last_error_class FROM telegram_pending_alerts WHERE id = 802").get() };
    });
    expect(incomplete.result).toMatchObject({ attempted: 0, deferred: 1 });
    expect(incomplete.state).toEqual({ last_error_class: "preference_revalidation_failed" });
  });

  it("defers a row when its preference generation changes after revalidation", async () => {
    const now = Math.floor(Date.now() / 1000);
    const { sqlite } = createLatestSchemaSqlite();
    insertRiskPendingSqlite(sqlite, { id: 803, chatId: "generation-race", sourceEventId: "generation-source", dedupeKey: "generation-key" }, now);
    let bumped = false;
    const db = createSqliteD1(sqlite, { onAll: (sql) => {
      if (!bumped && sql.includes("SELECT chat_id, preference_generation")) {
        bumped = true;
        sqlite.prepare("UPDATE telegram_subscribers SET preference_generation = preference_generation + 1 WHERE chat_id = 'generation-race'").run();
      }
    } });
    const result = await drainPendingQueue(db, "bot-token", 1);
    expect(bumped).toBe(true);
    expect(result).toMatchObject({ attempted: 0, deferred: 1 });
    expect(sqlite.prepare("SELECT delivery_state, last_error_class FROM telegram_pending_alerts WHERE id = 803").get()).toEqual({ delivery_state: "pending", last_error_class: "preference_generation_changed" });
    sqlite.close();
  });

  it("releases rows whose optimistic sending claim loses its CAS race", async () => {
    const candidate = row(804, { delivery_state: "pending", delivery_generation: 0 });
    const db = queueDb([candidate], [
      { match: "FROM telegram_pending_alerts p\n        WHERE p.processing_owner = ?", rows: [candidate] },
      { match: "SET delivery_state = 'sending'", rows: [], runMeta: { changes: 0 } },
    ]);
    const result = await drainPendingQueue(db, "bot-token", 1);
    expect(result).toMatchObject({ attempted: 0, deferred: 1 });
    expect(mockSendToChat).not.toHaveBeenCalled();
  });

  it("does not resend accepted delivery, rejects stale ownership, and preserves execution ambiguity", async () => {
    mockSendToChat.mockResolvedValue(makeTelegramSentResult());
    const now = Math.floor(Date.now() / 1000);
    const deleteFailure = await withPendingQueueScenario({ now, pending: { id: 702, chatId: "delete", html: "once", createdAt: now - 60, expiresAt: now + 600, dedupeKey: "delete-key" } }, async ({ sqlite, db }) => {
      const failing = { ...db, prepare: (sql: string) => sql.includes("DELETE FROM telegram_pending_alerts WHERE id IN") ? { bind: () => ({ run: async () => { throw new Error("delete failed"); } }) } as unknown as D1PreparedStatement : db.prepare(sql) } as D1Database;
      const first = await drainPendingQueue(failing, "bot-token", 1);
      const second = await drainPendingQueue(db, "bot-token", 1);
      return { first, second, state: sqlite.prepare("SELECT delivery_state FROM telegram_pending_alerts WHERE id = 702").get() };
    });
    expect(deleteFailure.first.sent).toBe(1);
    expect(deleteFailure.second.attempted).toBe(0);
    expect(deleteFailure.state).toEqual({ delivery_state: "sent" });

    const { sqlite, db } = createLatestSchemaSqlite();
    insertPendingSqlite(sqlite, { id: 704, chatId: "stale", html: "stale", createdAt: 1_000, expiresAt: 10_000, dedupeKey: "stale-key", sourceType: "risk_alert", alertType: "dews", sourceEventId: "stale-source", alertScopeJson: serializePendingAlertScope([{ stablecoinId: "usdc-circle", family: "dews" }]), preferenceGeneration: 1, markupPolicyJson: serializePendingMarkupPolicy({}) });
    insertSourceEventSqlite(sqlite, { sourceEventId: "stale-source", planGeneration: 1 });
    insertAlertJobFixture(sqlite, { jobId: "stale-job", alertType: "dews", sourceEventId: "stale-source", severity: "warning" }, 1_000);
    insertAlertJobTargetFixture(sqlite, { jobId: "stale-job", targetKey: "stale-target", chatId: "stale", alertType: "dews", pendingDedupeKey: "stale-key", sourceEventId: "stale-source", status: "queued", effectState: "complete" }, 1_000);
    sqlite.prepare("UPDATE telegram_pending_alerts SET delivery_state = 'sending', delivery_owner = 'lost', delivery_generation = 3, delivery_started_at = ?, delivery_claim_expires_at = ?, processing_owner = 'lost', processing_expires_at = ? WHERE id = 704").run(1_000, 1_000, 1_000);
    expect(await reconcileStalePendingSending(db, 2_000)).toBe(1);
    expect(await reconcileStalePendingSending(db, 2_000)).toBe(0);
    expect(sqlite.prepare("SELECT delivery_state, last_error_class FROM telegram_pending_alerts WHERE id = 704").get()).toEqual({ delivery_state: "execution_unknown", last_error_class: "pending_effect_owner_lost" });
    sqlite.close();
  });

  it("allows only one racing owner and does not finalize after an ownership change", async () => {
    const now = Math.floor(Date.now() / 1000);
    mockSendToChat.mockResolvedValue(makeTelegramSentResult());
    const { sqlite } = createLatestSchemaSqlite();
    insertSubscriberSqlite(sqlite, { chatId: "race", globalAlertDepeg: 1 });
    const raceNow = Math.floor(Date.now() / 1000);
    insertPendingSqlite(sqlite, { id: 701, chatId: "race", html: "race", createdAt: raceNow - 60, expiresAt: raceNow + 600, dedupeKey: "race-key" });
    const raced = createClaimContentionD1(sqlite);
    const results = await Promise.all([drainPendingQueue(raced, "bot-token", 1), drainPendingQueue(raced, "bot-token", 1)]);
    expect(results.map((result) => result.sent).sort()).toEqual([0, 1]);
    expect(mockSendToChat).toHaveBeenCalledTimes(1);
    expect(new Set(history(raced, "SET processing_owner = ?").map((entry) => entry.binds[0])).size).toBe(2);
    expect(raced.getOwner()).toBeTruthy();
    sqlite.close();

    const ownerLoss = await withPendingQueueScenario({ now, pending: { id: 706, chatId: "owner-loss", html: "owner", createdAt: now - 60, expiresAt: now + 600, dedupeKey: "owner-key" } }, async ({ sqlite, db }) => {
      let changed = false;
      const losing = { ...db, prepare: (sql: string) => { if (!changed && sql.includes("SET delivery_state = 'sent'") && sql.includes("AND delivery_owner = ?")) { changed = true; sqlite.prepare("UPDATE telegram_pending_alerts SET delivery_owner = 'takeover', delivery_generation = delivery_generation + 1 WHERE id = 706").run(); } return db.prepare(sql); } } as D1Database;
      await expect(drainPendingQueue(losing, "bot-token", 1)).rejects.toThrow("sent-state persistence was not confirmed");
      return sqlite.prepare("SELECT delivery_state, delivery_owner, delivery_generation FROM telegram_pending_alerts WHERE id = 706").get();
    });
    expect(ownerLoss).toEqual({ delivery_state: "sending", delivery_owner: "takeover", delivery_generation: 2 });
  });

  it("checkpoints an attempted timeout as execution-unknown and handles abort-after-send", async () => {
    const now = Math.floor(Date.now() / 1000);
    const { sqlite, db } = createLatestSchemaSqlite();
    insertRiskPendingSqlite(sqlite, { id: 707, chatId: "timeout", sourceEventId: "timeout-source", dedupeKey: "timeout-key" });
    insertAlertJobFixture(sqlite, { jobId: "timeout-job", alertType: "dews", sourceEventId: "timeout-source", severity: "warning" }, 1_000);
    insertAlertJobTargetFixture(sqlite, { jobId: "timeout-job", targetKey: "timeout-target", chatId: "timeout", alertType: "dews", pendingDedupeKey: "timeout-key", sourceEventId: "timeout-source", status: "queued", effectState: "complete" }, 1_000);
    mockSendToChat.mockResolvedValue(makeTelegramRetryableResult({ statusCode: null, errorClass: "timeout" }));
    const first = await drainPendingQueue(db, "bot-token", 1);
    expect(first).toMatchObject({ attempted: 1, executionUnknown: 1, retryQueued: 0 });
    expect(sqlite.prepare("SELECT delivery_state, attempts, last_error_class FROM telegram_pending_alerts WHERE id = 707").get()).toEqual({ delivery_state: "execution_unknown", attempts: 0, last_error_class: "timeout" });
    expect((await drainPendingQueue(db, "bot-token", 1)).attempted).toBe(0);
    sqlite.close();

    const controller = new AbortController();
    await withPendingQueueScenario({ now, pending: { id: 708, chatId: "abort", html: "accepted", createdAt: now - 60, expiresAt: now + 600 } }, async ({ db: sqliteDb }) => {
      mockSendToChat.mockImplementation(async () => { controller.abort(); return makeTelegramSentResult(); });
      await expect(drainPendingQueue(sqliteDb, "bot-token", 1, controller.signal)).resolves.toMatchObject({ attempted: 1, sent: 1 });
    });
  });

  it("chunks large deletes, respects the drain budget, and keeps same-chat sends serial", async () => {
    mockSendToChat.mockResolvedValue(makeTelegramSentResult());
    const rows = Array.from({ length: 101 }, (_, i) => row(i + 1, { chat_id: `chat-${i}`, message_html: `msg-${i}`, dedupe_key: `key-${i}` }));
    const db = queueDb(rows, [{ match: "UPDATE telegram_subscribers", rows: [] }, { match: "UPDATE telegram_alert_job_targets", rows: [] }, { match: "DELETE FROM telegram_pending_alerts WHERE id IN", rows: [] }]);
    expect((await drainPendingQueue(db, "bot-token", 101)).sent).toBe(101);
    expect(history(db, "DELETE FROM telegram_pending_alerts WHERE id IN").map((entry) => entry.binds.length)).toEqual([90, 11]);

    const budgetNow = Math.floor(Date.now() / 1000);
    const budget = await withPendingQueueScenario({ now: budgetNow, pending: [1, 2, 3].map((id) => ({ id, chatId: `budget-${id}`, html: `msg-${id}`, createdAt: budgetNow - id, expiresAt: budgetNow + 600 })) }, async ({ sqlite, db: sqliteDb }) => ({ result: await drainPendingQueue(sqliteDb, "bot-token", 2), count: sqlite.prepare("SELECT COUNT(*) AS count FROM telegram_pending_alerts").get() }));
    expect(budget.result).toMatchObject({ attempted: 2, sent: 2 });
    expect(budget.count).toEqual({ count: 1 });

    vi.useRealTimers();
    const started: string[] = [];
    const releases = new Map<string, () => void>();
    mockSendToChat.mockImplementation((chatId: string, html: string) => { const key = `${chatId}:${html}`; started.push(key); return new Promise((resolve) => releases.set(key, () => resolve(makeTelegramSentResult()))); });
    const serialRows = [...Array.from({ length: 4 }, (_, i) => row(1800 + i, { chat_id: "same", message_html: `chunk-${i}`, chunk_index: i })), ...["a", "b", "c"].map((chatId, i) => row(1900 + i, { chat_id: chatId, message_html: "only" }))];
    const serialDb = queueDb(serialRows, [{ match: "DELETE FROM telegram_pending_alerts WHERE id IN", rows: [] }]);
    const promise = drainPendingQueue(serialDb, "bot-token", serialRows.length);
    await vi.waitFor(() => expect(started).toHaveLength(4));
    expect(started).toEqual(["same:chunk-0", "a:only", "b:only", "c:only"]);
    for (const key of ["a:only", "b:only", "c:only", "same:chunk-0"]) releases.get(key)?.();
    for (let i = 1; i < 4; i++) await vi.waitFor(() => expect(started).toContain(`same:chunk-${i}`)).then(() => releases.get(`same:chunk-${i}`)?.());
    await expect(promise).resolves.toMatchObject({ attempted: serialRows.length, sent: serialRows.length });
    expect(started.filter((key) => key.startsWith("same:"))).toEqual(["same:chunk-0", "same:chunk-1", "same:chunk-2", "same:chunk-3"]);
  });

  it("cleans expired rows into the SQL dead-letter protocol", async () => {
    const now = Math.floor(Date.now() / 1000);
    const db = mockD1([
      { match: "SELECT id, chat_id, message_html", rows: [{ id: 123, chat_id: "expired", message_html: "expired", created_at: now - PENDING_TTL_SEC - 60, attempts: 3, last_error_class: "rate_limit", dedupe_key: "expired-key", chunk_index: 0, priority: TELEGRAM_PENDING_PRIORITY.depeg, source_type: "risk_alert", alert_type: "depeg" }] },
      { match: "INSERT INTO telegram_alert_dead_letters", rows: [] },
      { match: "DELETE FROM telegram_pending_alerts WHERE", rows: [], runMeta: { changes: 1 } },
    ]);
    expect(await cleanupExpiredPendingAlerts(db, now)).toBe(1);
    expect(history(db, "INSERT INTO telegram_alert_dead_letters")[0]?.binds).toEqual(["pending:123:delivery:0", 123, "expired", "expired", "risk_alert", "depeg", TELEGRAM_PENDING_PRIORITY.depeg, now - PENDING_TTL_SEC - 60, now, 3, "rate_limit", "ttl_expired", "expired-key", 0, null, null, null, null, "pending", null, 0, null, null, null]);
  });

  it("records the stale-strike boundary and successful reset", async () => {
    const now = Math.floor(Date.now() / 1000);
    mockSendToChat.mockResolvedValue(makeTelegramBlockedResult({ errorClass: "chat_not_found", statusCode: 400 }));
    const stale = queueDb([row(22, { chat_id: "stale-strike" })], [{ match: "SELECT consecutive_block_count", rows: [{ consecutive_block_count: 1, consecutive_block_first_at: now - BLOCK_STRIKE_WINDOW_SEC - 1 }] }, { match: "UPDATE telegram_subscribers", rows: [] }, { match: "DELETE FROM telegram_pending_alerts WHERE id IN", rows: [] }]);
    await drainPendingQueue(stale, "bot-token", 10);
    expect(history(stale, "UPDATE telegram_subscribers").find((entry) => entry.sql.includes("consecutive_block_count = ?"))?.binds.slice(0, 2)).toEqual([1, now]);
    mockSendToChat.mockResolvedValue(makeTelegramSentResult());
    const recovered = queueDb([row(23, { chat_id: "recovered" })], [{ match: "UPDATE telegram_subscribers", rows: [] }, { match: "DELETE FROM telegram_pending_alerts WHERE id IN", rows: [] }]);
    await drainPendingQueue(recovered, "bot-token", 10);
    expect(history(recovered, "consecutive_block_count = 0")[0]?.binds).toEqual(["recovered"]);
  });

  it("reports a blocked-chat cleanup failure without losing the delivery outcome", async () => {
    const controller = new AbortController();
    const now = Math.floor(Date.now() / 1000);
    mockSendToChat.mockImplementation(async () => { controller.abort(); return makeTelegramBlockedResult({ errorClass: "blocked" }); });
    const db = queueDb([row(805, { chat_id: "blocked-cleanup" })], [
      { match: "SELECT consecutive_block_count", rows: [{ consecutive_block_count: 1, consecutive_block_first_at: now - 60 }] },
      { match: "SET alert_dews=0", rows: [], throwError: new Error("D1 cleanup failed") },
      { match: "INSERT INTO telegram_chat_delivery_diagnostics", rows: [] },
      { match: "UPDATE telegram_alert_job_targets", rows: [] },
      { match: "INSERT INTO telegram_alert_dead_letters", rows: [] },
      { match: "DELETE FROM telegram_pending_alerts WHERE id IN", rows: [] },
    ]);
    await expect(drainPendingQueue(db, "bot-token", 1, controller.signal)).resolves.toMatchObject({ attempted: 1, blocked: 1, blockedCleanedUp: 0, blockedCleanupFailed: 1 });
  });

  it("keeps an active sending dedupe row byte-identical", async () => {
    const { sqlite, db } = createLatestSchemaSqlite();
    const now = Math.floor(Date.now() / 1000);
    const dedupeKey = buildDedupeKey({ chatId: "sending-collision", html: "Original", disableNotification: false });
    insertPendingSqlite(sqlite, { id: 705, chatId: "sending-collision", html: "Original", createdAt: now - 4_000, expiresAt: now - 1, attempts: 7, notBeforeAt: now + 300, dedupeKey });
    sqlite.prepare("UPDATE telegram_pending_alerts SET delivery_state = 'sending', delivery_owner = 'active', delivery_generation = 4, delivery_started_at = ?, delivery_claim_expires_at = ?, processing_owner = 'active', processing_started_at = ?, processing_expires_at = ? WHERE id = 705").run(now - 30, now + 300, now - 30, now + 300);
    const before = sqlite.prepare("SELECT * FROM telegram_pending_alerts WHERE id = 705").get();
    await enqueuePendingAlerts(db, [{ chatId: "sending-collision", html: "Original", disableNotification: false }], now, { sourceType: "legacy" });
    expect(sqlite.prepare("SELECT * FROM telegram_pending_alerts WHERE id = 705").get()).toEqual(before);
    sqlite.close();
  });
});
