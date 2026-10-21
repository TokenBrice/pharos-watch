import { afterEach, describe, expect, it, vi } from "vitest";
import type { DatabaseSync } from "node:sqlite";
import { createLatestSchemaSqlite } from "@shared/test-utils/latest-schema-sqlite";
import { createSqliteD1 } from "@shared/test-utils/sqlite-d1";
import {
  enqueueTelegramJob,
  type TelegramDeliveryInput,
} from "../jobs";
import { drainTelegramDeliveries, TELEGRAM_DELIVERY_CLAIM_TTL_SEC } from "../job-drain";
import type { SendToChatResult } from "../telegram";
import { fanOutPlanningTelegramJobs, sweepTelegramJobs } from "../../../cron/telegram/jobs/run-jobs";
import { forgetSubscriber } from "../../store/subscriber-lifecycle";

const NOW = 1_800_000_000;
const open: DatabaseSync[] = [];

function setup() {
  const { sqlite } = createLatestSchemaSqlite();
  open.push(sqlite);
  return { sqlite, db: createSqliteD1(sqlite) };
}

afterEach(() => {
  while (open.length > 0) open.pop()!.close();
  vi.restoreAllMocks();
});

function addSubscriber(sqlite: DatabaseSync, chatId: string, extra: Record<string, unknown> = {}) {
  const columns = ["chat_id", "created_at", "last_active_at", ...Object.keys(extra)];
  const values = [chatId, NOW - 1000, NOW - 1000, ...Object.values(extra)];
  sqlite.prepare(`INSERT INTO telegram_subscribers (${columns.join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`)
    .run(...(values as never[]));
}

const ok: SendToChatResult = {
  ok: true, blocked: false, retryable: false, permanentFailure: false, statusCode: 200,
  errorClass: null, delivery: "sent", retryAfterSec: null,
};

function failure(overrides: Partial<SendToChatResult>): SendToChatResult {
  return {
    ok: false, blocked: false, retryable: true, permanentFailure: false, statusCode: 500,
    errorClass: "server_error", delivery: "retryable_failure", retryAfterSec: null, ...overrides,
  };
}

function rows(sqlite: DatabaseSync, jobId?: string) {
  return sqlite.prepare(
    `SELECT chat_id, seq, state, attempts, reason, next_attempt_at, body FROM telegram_deliveries
      ${jobId ? "WHERE job_id = ?" : ""} ORDER BY chat_id, seq`,
  ).all(...(jobId ? [jobId] : [])) as Array<Record<string, unknown>>;
}

function job(jobId: string, deliveries: TelegramDeliveryInput[], createdAt = NOW) {
  return { jobId, kind: "broadcast" as const, payload: {}, createdAt, expiresAt: createdAt + 3600, deliveries };
}

describe("telegram delivery v2 queue", () => {
  it("enqueues idempotently and drains to sent, then closes the job", async () => {
    const { sqlite, db } = setup();
    addSubscriber(sqlite, "1");
    addSubscriber(sqlite, "2");
    const spec = job("broadcast:a", [
      { chatId: "1", body: "hello", audience: "notice" },
      { chatId: "2", body: "hello", audience: "notice" },
    ]);
    expect(await enqueueTelegramJob(db, spec)).toEqual({ created: true });
    expect(await enqueueTelegramJob(db, spec)).toEqual({ created: false });
    expect(rows(sqlite)).toHaveLength(2);

    const sendMessage = vi.fn(async () => ok);
    const result = await drainTelegramDeliveries(db, "token", { nowSec: () => NOW, sendMessage });
    expect(result.sent).toBe(2);
    expect(sendMessage).toHaveBeenCalledTimes(2);
    expect(rows(sqlite).map((row) => [row.state, row.attempts, row.body])).toEqual([
      ["sent", 1, null],
      ["sent", 1, null],
    ]);

    const sweep = await sweepTelegramJobs(db, NOW + 1);
    expect(sweep.jobsDone).toBe(1);
    expect(sqlite.prepare("SELECT state FROM telegram_jobs").get()).toEqual({ state: "done" });
  });

  it("records per-chat delivery diagnostics for attempted sends", async () => {
    const { sqlite, db } = setup();
    addSubscriber(sqlite, "1");
    addSubscriber(sqlite, "2");
    await enqueueTelegramJob(db, job("broadcast:diag", [
      { chatId: "1", body: "hello", audience: "notice" },
      { chatId: "2", body: "hello", audience: "notice" },
    ]));
    const sendMessage = vi.fn(async (chatId: string) =>
      chatId === "1" ? ok : failure({ retryable: false, permanentFailure: true, statusCode: 400, errorClass: "bad_request", delivery: "permanent_failure" }));
    await drainTelegramDeliveries(db, "token", { nowSec: () => NOW, sendMessage });
    expect(sqlite.prepare(
      `SELECT chat_id, last_successful_delivery_at, last_delivery_attempt_at, recent_failure_class
         FROM telegram_chat_delivery_diagnostics ORDER BY chat_id`,
    ).all()).toEqual([
      { chat_id: "1", last_successful_delivery_at: NOW, last_delivery_attempt_at: NOW, recent_failure_class: null },
      { chat_id: "2", last_successful_delivery_at: null, last_delivery_attempt_at: NOW, recent_failure_class: "bad_request" },
    ]);
  });

  it("suppresses an identical body for the same chat within 24 h as suppressed_duplicate", async () => {
    const { sqlite, db } = setup();
    for (const chat of ["1", "2"]) addSubscriber(sqlite, chat);
    await enqueueTelegramJob(db, job("alert:a", [{ chatId: "1", body: "IUSD D -> C", dedupeBody: "IUSD D -> C" }]));
    await drainTelegramDeliveries(db, "token", { nowSec: () => NOW, sendMessage: async () => ok });

    await enqueueTelegramJob(db, job("alert:b", [
      { chatId: "1", body: "IUSD D -> C", dedupeBody: "IUSD D -> C" },
      { chatId: "2", body: "IUSD D -> C", dedupeBody: "IUSD D -> C" },
      { chatId: "1", body: "IUSD C -> D", dedupeBody: "IUSD C -> D", seq: 1 },
    ], NOW + 600));
    expect(rows(sqlite, "alert:b").map((row) => [row.chat_id, row.seq, row.state, row.reason])).toEqual([
      ["1", 0, "suppressed_duplicate", "duplicate_prior_delivery"],
      ["1", 1, "pending", null],
      ["2", 0, "pending", null],
    ]);

    // Outside the window the same body is delivered again.
    await enqueueTelegramJob(db, job("alert:c", [{ chatId: "1", body: "IUSD D -> C", dedupeBody: "IUSD D -> C" }], NOW + 86_401));
    expect(rows(sqlite, "alert:c")[0]?.state).toBe("pending");
  });

  it("never sends a row twice across overlapping drains", async () => {
    const { sqlite, db } = setup();
    const deliveries: TelegramDeliveryInput[] = [];
    for (let chat = 1; chat <= 30; chat += 1) {
      addSubscriber(sqlite, String(chat));
      deliveries.push({ chatId: String(chat), body: "part 0", audience: "notice" });
      deliveries.push({ chatId: String(chat), body: "part 1", seq: 1, audience: "notice" });
    }
    await enqueueTelegramJob(db, job("broadcast:overlap", deliveries));
    const sends = new Map<string, number>();
    const sendMessage = vi.fn(async (chatId: string, text: string) => {
      await new Promise((resolve) => setTimeout(resolve, 1));
      const key = `${chatId}:${text}`;
      sends.set(key, (sends.get(key) ?? 0) + 1);
      return ok;
    });
    const [a, b] = await Promise.all([
      drainTelegramDeliveries(db, "token", { nowSec: () => NOW, sendMessage }),
      drainTelegramDeliveries(db, "token", { nowSec: () => NOW, sendMessage }),
    ]);
    // Chunk 1 can need a second pass because chunk 0 was in flight elsewhere.
    await drainTelegramDeliveries(db, "token", { nowSec: () => NOW, sendMessage });
    expect(a.sent + b.sent).toBeGreaterThan(0);
    expect([...sends.values()].every((count) => count === 1)).toBe(true);
    expect(sends.size).toBe(60);
    expect(rows(sqlite).every((row) => row.state === "sent")).toBe(true);
  });

  it("keeps chunks serial: a retryable head defers the tail, a permanent head cancels it", async () => {
    const { sqlite, db } = setup();
    addSubscriber(sqlite, "1");
    addSubscriber(sqlite, "2");
    await enqueueTelegramJob(db, job("broadcast:chunks", [
      { chatId: "1", body: "c0", audience: "notice" },
      { chatId: "1", body: "c1", seq: 1, audience: "notice" },
      { chatId: "2", body: "d0", audience: "notice" },
      { chatId: "2", body: "d1", seq: 1, audience: "notice" },
    ]));
    const sendMessage = vi.fn(async (chatId: string) => chatId === "1"
      ? failure({})
      : failure({ retryable: false, permanentFailure: true, errorClass: "formatting_error", statusCode: 400, delivery: "permanent_failure" }));
    await drainTelegramDeliveries(db, "token", { nowSec: () => NOW, sendMessage });
    expect(sendMessage).toHaveBeenCalledTimes(2);
    expect(rows(sqlite).map((row) => [row.chat_id, row.seq, row.state, row.attempts])).toEqual([
      ["1", 0, "retry", 1],
      ["1", 1, "retry", 0],
      ["2", 0, "failed", 1],
      ["2", 1, "cancelled", 0],
    ]);
    // The tail is not claimable before its head is due again.
    const second = await drainTelegramDeliveries(db, "token", { nowSec: () => NOW + 1, sendMessage });
    expect(second.claimed).toBe(0);
  });

  it("does not cancel another job's message queued behind a failed head for the same chat", async () => {
    const { sqlite, db } = setup();
    addSubscriber(sqlite, "1");
    await enqueueTelegramJob(db, job("broadcast:bad", [{ chatId: "1", body: "bad", audience: "notice" }]));
    await enqueueTelegramJob(db, job("broadcast:good", [{ chatId: "1", body: "good", audience: "notice" }], NOW + 1));
    const permanent = failure({ retryable: false, permanentFailure: true, errorClass: "formatting_error", statusCode: 400, delivery: "permanent_failure" });
    const sendMessage = vi.fn(async (_chatId: string, text: string) => text === "bad" ? permanent : ok);
    await drainTelegramDeliveries(db, "token", { nowSec: () => NOW + 1, sendMessage });
    expect(sqlite.prepare("SELECT job_id, state FROM telegram_deliveries ORDER BY job_id").all()).toEqual([
      { job_id: "broadcast:bad", state: "failed" },
      { job_id: "broadcast:good", state: "retry" },
    ]);
    await drainTelegramDeliveries(db, "token", { nowSec: () => NOW + 2, sendMessage });
    expect(sqlite.prepare("SELECT state FROM telegram_deliveries WHERE job_id = 'broadcast:good'").get()).toEqual({ state: "sent" });
  });

  it("propagates chat Retry-After even when the 429 exhausts the row's attempts", async () => {
    const { sqlite, db } = setup();
    addSubscriber(sqlite, "1");
    await enqueueTelegramJob(db, job("broadcast:last", [{ chatId: "1", body: "a", audience: "notice" }]));
    await enqueueTelegramJob(db, job("broadcast:next", [{ chatId: "1", body: "b", audience: "notice" }], NOW + 1));
    sqlite.prepare("UPDATE telegram_deliveries SET attempts = 19 WHERE job_id = 'broadcast:last'").run();
    const limited = failure({ errorClass: "rate_limit", statusCode: 429, retryAfterSec: 120, rateLimitScope: "chat" });
    await drainTelegramDeliveries(db, "token", { nowSec: () => NOW + 1, maxRows: 1, sendMessage: async () => limited });
    expect(rows(sqlite).map((row) => [row.state, row.next_attempt_at])).toEqual([
      ["failed", NOW],
      ["pending", NOW + 121],
    ]);
  });

  it("/forget deletes per-chat roll-up jobs and scrubs the chat from broadcast payloads", async () => {
    const { sqlite, db } = setup();
    addSubscriber(sqlite, "42");
    addSubscriber(sqlite, "7");
    await enqueueTelegramJob(db, { ...job("rollup:2026-10-21:42", [{ chatId: "42", body: "r" }]), kind: "rollup" });
    await enqueueTelegramJob(db, { ...job("rollup:2026-10-21:7", [{ chatId: "7", body: "r" }]), kind: "rollup" });
    await enqueueTelegramJob(db, {
      jobId: "broadcast:x", kind: "broadcast", payload: { messageHtml: "m", scope: "all", excludeChatId: "42" },
      createdAt: NOW, expiresAt: NOW + 3600,
    });
    await forgetSubscriber(db, "42");
    expect(sqlite.prepare("SELECT job_id FROM telegram_jobs ORDER BY job_id").all())
      .toEqual([{ job_id: "broadcast:x" }, { job_id: "rollup:2026-10-21:7" }]);
    expect(sqlite.prepare("SELECT payload_json FROM telegram_jobs WHERE job_id = 'broadcast:x'").get())
      .toEqual({ payload_json: JSON.stringify({ messageHtml: "m", scope: "all" }) });
    expect(sqlite.prepare("SELECT chat_id FROM telegram_deliveries").all()).toEqual([{ chat_id: "7" }]);
  });

  it("/forget removes roll-up jobs by delivery ownership and rewinds a fan-out cursor naming the chat", async () => {
    const { sqlite, db } = setup();
    for (const chat of ["40", "42", "44"]) addSubscriber(sqlite, chat);
    // Created before a group migration: the job id still names the old chat id.
    await enqueueTelegramJob(db, { ...job("rollup:2026-10-21:-100old", [{ chatId: "42", body: "r" }]), kind: "rollup" });
    sqlite.prepare(
      `INSERT INTO telegram_jobs (job_id, kind, payload_json, state, cursor, created_at, expires_at)
       VALUES ('broadcast:paging', 'broadcast', '{"messageHtml":"m","scope":"all"}', 'planning', '42', ?, ?)`,
    ).run(NOW, NOW + 3600);
    await forgetSubscriber(db, "42");
    expect(sqlite.prepare("SELECT job_id, cursor FROM telegram_jobs").all())
      .toEqual([{ job_id: "broadcast:paging", cursor: "40" }]);
    // Resume continues after the rewound cursor without skipping chat 44.
    await fanOutPlanningTelegramJobs(db, NOW);
    expect(sqlite.prepare("SELECT chat_id FROM telegram_deliveries WHERE job_id = 'broadcast:paging'").all())
      .toEqual([{ chat_id: "44" }]);
  });

  it("records ambiguous transport failures as unknown and never replays them", async () => {
    const { sqlite, db } = setup();
    addSubscriber(sqlite, "1");
    await enqueueTelegramJob(db, job("broadcast:timeout", [{ chatId: "1", body: "x", audience: "notice" }]));
    const sendMessage = vi.fn(async () => failure({ errorClass: "timeout", statusCode: null }));
    await drainTelegramDeliveries(db, "token", { nowSec: () => NOW, sendMessage });
    await drainTelegramDeliveries(db, "token", { nowSec: () => NOW + 3600, sendMessage });
    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(rows(sqlite)[0]).toMatchObject({ state: "unknown", reason: "ambiguous_send" });
  });

  it("applies the 2-strike block rule", async () => {
    const { sqlite, db } = setup();
    addSubscriber(sqlite, "1", { alert_depeg: 1 });
    const blocked = failure({ blocked: true, retryable: false, permanentFailure: false, errorClass: "blocked", statusCode: 403, delivery: "blocked" });
    await enqueueTelegramJob(db, job("broadcast:b1", [{ chatId: "1", body: "a", audience: "notice" }]));
    await drainTelegramDeliveries(db, "token", { nowSec: () => NOW, sendMessage: async () => blocked });
    expect(sqlite.prepare("SELECT consecutive_block_count AS n, alert_depeg FROM telegram_subscribers").get())
      .toEqual({ n: 1, alert_depeg: 1 });
    await enqueueTelegramJob(db, job("broadcast:b2", [{ chatId: "1", body: "b", audience: "notice" }]));
    const second = await drainTelegramDeliveries(db, "token", { nowSec: () => NOW + 60, sendMessage: async () => blocked });
    expect(second.blockedChatsDisabled).toBe(1);
    expect(rows(sqlite).map((row) => row.state)).toEqual(["blocked", "blocked"]);
    expect(sqlite.prepare("SELECT alert_depeg FROM telegram_subscribers").get()).toEqual({ alert_depeg: 0 });
  });

  it("honours chat Retry-After for the whole chat and infers a global flood from two chats", async () => {
    const { sqlite, db } = setup();
    for (const chat of ["1", "2", "3"]) addSubscriber(sqlite, chat);
    await enqueueTelegramJob(db, job("broadcast:r1", [{ chatId: "1", body: "a", audience: "notice" }]));
    await enqueueTelegramJob(db, job("broadcast:r2", [{ chatId: "1", body: "b", audience: "notice" }], NOW + 1));
    const limited = failure({ errorClass: "rate_limit", statusCode: 429, retryAfterSec: 30, rateLimitScope: "chat" });
    let calls = 0;
    await drainTelegramDeliveries(db, "token", {
      nowSec: () => NOW + 1,
      maxRows: 1,
      sendMessage: async () => {
        calls += 1;
        return limited;
      },
    });
    expect(calls).toBe(1);
    expect(rows(sqlite).map((row) => [row.state, row.next_attempt_at])).toEqual([
      ["retry", NOW + 31],
      ["pending", NOW + 31],
    ]);

    await enqueueTelegramJob(db, job("broadcast:r3", [
      { chatId: "2", body: "c", audience: "notice" },
      { chatId: "3", body: "c", audience: "notice" },
    ], NOW + 2));
    const flood = await drainTelegramDeliveries(db, "token", { nowSec: () => NOW + 2, sendMessage: async () => limited });
    expect(flood.globalBackoffUntil).toBe(NOW + 32);
    const gated = await drainTelegramDeliveries(db, "token", { nowSec: () => NOW + 3, sendMessage: async () => ok });
    expect(gated.stoppedReason).toBe("global-backoff");
  });

  it("gates on chat state: forgotten chats cancel, snoozes defer, coin snoozes cancel, quiet hours send silently", async () => {
    const { sqlite, db } = setup();
    addSubscriber(sqlite, "10", { alert_snooze_until_ts: NOW + 900 });
    addSubscriber(sqlite, "11");
    addSubscriber(sqlite, "12", { quiet_hours_enabled: 1, quiet_hours_start_utc: 0, quiet_hours_end_utc: 23 });
    sqlite.prepare(
      "INSERT INTO telegram_subscriptions (chat_id, stablecoin_id, alert_depeg, alert_snooze_until_ts) VALUES ('11', 'usdc', 1, ?)",
    ).run(NOW + 900);
    await enqueueTelegramJob(db, job("alert:gate", [
      { chatId: "10", body: "a", coinIds: ["usdt"] },
      { chatId: "11", body: "a", coinIds: ["usdc"] },
      { chatId: "12", body: "a", coinIds: ["usdt"] },
      { chatId: "13", body: "a", coinIds: ["usdt"] },
    ]));
    const sendMessage = vi.fn(async () => ok);
    await drainTelegramDeliveries(db, "token", { nowSec: () => NOW, sendMessage });
    expect(rows(sqlite).map((row) => [row.chat_id, row.state, row.reason])).toEqual([
      ["10", "retry", "chat_snoozed"],
      ["11", "cancelled", "coin_snoozed"],
      ["12", "sent", null],
      ["13", "cancelled", "subscriber_missing"],
    ]);
    expect(sendMessage).toHaveBeenCalledWith("12", "a", "token", expect.objectContaining({ disableNotification: true }));
  });

  it("sweeps crashed sends to unknown and expired rows, without resending", async () => {
    const { sqlite, db } = setup();
    addSubscriber(sqlite, "1");
    addSubscriber(sqlite, "2");
    await enqueueTelegramJob(db, job("broadcast:crash", [
      { chatId: "1", body: "a", audience: "notice" },
      { chatId: "2", body: "b", audience: "notice", expiresAt: NOW + 60 },
    ]));
    // Replay of a crash after the claim: the row is `sending` with a claim and no settlement.
    sqlite.prepare(
      `UPDATE telegram_deliveries SET state = 'sending', claim_owner = 'dead', sending_at = ?, claim_expires_at = ?
        WHERE chat_id = '1'`,
    ).run(NOW, NOW + TELEGRAM_DELIVERY_CLAIM_TTL_SEC);
    const sendMessage = vi.fn(async () => ok);
    expect(await sweepTelegramJobs(db, NOW + 61)).toMatchObject({ sendingToUnknown: 0, expired: 1 });
    expect(await sweepTelegramJobs(db, NOW + TELEGRAM_DELIVERY_CLAIM_TTL_SEC)).toMatchObject({ sendingToUnknown: 1, jobsDone: 1 });
    await drainTelegramDeliveries(db, "token", { nowSec: () => NOW + 700, sendMessage });
    expect(sendMessage).not.toHaveBeenCalled();
    expect(rows(sqlite).map((row) => [row.chat_id, row.state])).toEqual([["1", "unknown"], ["2", "expired"]]);
  });
});

describe("telegram job fan-out", () => {
  it("resumes a large fan-out across runs without duplicate rows", async () => {
    const { sqlite, db } = setup();
    for (let index = 0; index < 250; index += 1) {
      addSubscriber(sqlite, String(1000 + index), { global_alert_freeze: 1 });
    }
    sqlite.prepare(
      `INSERT INTO telegram_jobs (job_id, kind, payload_json, state, created_at, expires_at)
       VALUES ('freeze:tape-1', 'freeze', ?, 'planning', ?, ?)`,
    ).run(JSON.stringify({
      stablecoinId: "usdt",
      symbol: "USDT",
      eventType: "destroy",
      chainName: "Ethereum",
      amountUsdAtEvent: 5_000_000,
      tapeEventId: "tape-1",
      sourceEventId: "blacklist:1",
    }), NOW, NOW + 3600);

    const first = await fanOutPlanningTelegramJobs(db, NOW, { maxPages: 1 });
    expect(first).toMatchObject({ pages: 1, deliveriesPlanned: 200, jobsReady: 0 });
    expect(sqlite.prepare("SELECT state, cursor FROM telegram_jobs").get()).toEqual({ state: "planning", cursor: "1199" });
    // A replayed page (same cursor) inserts nothing new.
    sqlite.prepare("UPDATE telegram_jobs SET cursor = NULL").run();
    await fanOutPlanningTelegramJobs(db, NOW, { maxPages: 1 });
    const second = await fanOutPlanningTelegramJobs(db, NOW, { maxPages: 5 });
    expect(second.jobsReady).toBe(1);
    expect(sqlite.prepare("SELECT COUNT(*) AS n, COUNT(DISTINCT chat_id) AS chats FROM telegram_deliveries").get())
      .toEqual({ n: 250, chats: 250 });
    expect(sqlite.prepare("SELECT state, planned_count FROM telegram_jobs").get()).toMatchObject({ state: "ready" });
  });

  it("splits a page over the batch statement limit at chat boundaries", async () => {
    const { sqlite, db } = setup();
    for (let index = 0; index < 200; index += 1) addSubscriber(sqlite, String(5000 + index));
    // Four chunks per chat: 800 rows on one 200-chat page, beyond one 100-statement batch.
    const messageHtml = "<b>Notice</b> " + "maintenance window details ".repeat(560);
    await enqueueTelegramJob(db, {
      jobId: "broadcast:big", kind: "broadcast", payload: { messageHtml, scope: "all" },
      createdAt: NOW, expiresAt: NOW + 3600,
    });
    const result = await fanOutPlanningTelegramJobs(db, NOW);
    expect(result).toMatchObject({ jobsFailedClosed: 0, jobsReady: 1, deliveriesPlanned: 800 });
    expect(sqlite.prepare("SELECT COUNT(*) AS n, COUNT(DISTINCT chat_id) AS chats, MAX(seq) AS maxSeq FROM telegram_deliveries").get())
      .toEqual({ n: 800, chats: 200, maxSeq: 3 });
    expect(sqlite.prepare("SELECT state, cursor, planned_count FROM telegram_jobs").get())
      .toEqual({ state: "ready", cursor: null, planned_count: 800 });
  });

  it("cancels a planning job that outlives its TTL", async () => {
    const { sqlite, db } = setup();
    sqlite.prepare(
      `INSERT INTO telegram_jobs (job_id, kind, payload_json, state, created_at, expires_at)
       VALUES ('alert:old', 'alert', '{}', 'planning', ?, ?)`,
    ).run(NOW - 7200, NOW - 1);
    const result = await fanOutPlanningTelegramJobs(db, NOW);
    expect(result.jobsCancelled).toBe(1);
    expect(sqlite.prepare("SELECT state FROM telegram_jobs").get()).toEqual({ state: "cancelled" });
  });
});

describe("telegram delivery v2 query plans", () => {
  it("serves the drain claim and the 24 h duplicate probe from their partial indexes", async () => {
    const { sqlite, db } = setup();
    addSubscriber(sqlite, "1");
    const statements: string[] = [];
    const prepare = sqlite.prepare.bind(sqlite);
    vi.spyOn(sqlite, "prepare").mockImplementation((sql: string) => {
      statements.push(sql);
      return prepare(sql);
    });
    await enqueueTelegramJob(db, job("alert:a", [{ chatId: "1", body: "same body", dedupeBody: "same body" }]));
    await drainTelegramDeliveries(db, "token", { nowSec: () => NOW, sendMessage: async () => ok });
    const plan = (needle: string) => {
      const sql = statements.find((candidate) => candidate.includes(needle));
      expect(sql, needle).toBeDefined();
      return (prepare(`EXPLAIN QUERY PLAN ${sql}`).all() as Array<{ detail: string }>).map((row) => row.detail);
    };
    const insert = plan("INSERT OR IGNORE INTO telegram_deliveries");
    expect(insert.some((detail) => detail.includes("idx_telegram_deliveries_chat"))).toBe(true);
    const claim = plan("RETURNING id, job_id, kind, chat_id");
    expect(claim).toContain("SCAN d USING INDEX idx_telegram_deliveries_due");
    // A bare SCAN would be a full table scan of telegram_deliveries.
    expect([...insert, ...claim].filter((detail) => /^SCAN (d|prior|prev|telegram_deliveries)$/.test(detail))).toEqual([]);
  });
});
