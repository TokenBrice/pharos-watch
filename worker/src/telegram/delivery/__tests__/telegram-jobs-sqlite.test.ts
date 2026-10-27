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

/** Fault injection over the SQLite D1: fail matching statements or numbered batches once. */
function faulty(db: D1Database, faults: { prepare?: RegExp; batchCalls?: readonly number[] }) {
  let prepareArmed = faults.prepare != null;
  let batchCall = 0;
  return new Proxy(db, {
    get(target, property, receiver) {
      if (property === "prepare") {
        return (sql: string) => {
          if (prepareArmed && faults.prepare!.test(sql)) {
            prepareArmed = false;
            throw new Error("D1 read unavailable");
          }
          return target.prepare(sql);
        };
      }
      if (property === "batch") {
        return async (statements: D1PreparedStatement[]) => {
          batchCall += 1;
          if (faults.batchCalls?.includes(batchCall)) throw new Error("D1 batch unavailable");
          return target.batch(statements);
        };
      }
      const value = Reflect.get(target, property, receiver) as unknown;
      return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(target) : value;
    },
  });
}

function claims(sqlite: DatabaseSync) {
  return sqlite.prepare(
    "SELECT chat_id, seq, state, attempts, reason, claim_owner, body IS NOT NULL AS has_body FROM telegram_deliveries ORDER BY chat_id, seq",
  ).all() as Array<Record<string, unknown>>;
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

describe("telegram drain pre-send failures", () => {
  it.each([
    ["subscriber gate read", { prepare: /FROM telegram_subscribers WHERE chat_id IN/ }],
    ["coin snooze read", { prepare: /alert_snooze_until_ts > \?/ }],
  ] as const)("releases unsent claims when the %s fails, then sends once on a later drain", async (_label, fault) => {
    const { sqlite, db } = setup();
    addSubscriber(sqlite, "1");
    await enqueueTelegramJob(db, job("alert:gate-fail", [{ chatId: "1", body: "a", coinIds: ["usdt"] }]));
    const sendMessage = vi.fn(async () => ok);
    await expect(drainTelegramDeliveries(faulty(db, fault), "token", { nowSec: () => NOW, sendMessage }))
      .rejects.toThrow("D1 read unavailable");
    expect(sendMessage).not.toHaveBeenCalled();
    expect(claims(sqlite)).toEqual([
      { chat_id: "1", seq: 0, state: "retry", attempts: 0, reason: "drain_aborted", claim_owner: null, has_body: 1 },
    ]);
    // Past the claim window the sweep finds nothing stranded to mark unknown.
    expect(await sweepTelegramJobs(db, NOW + TELEGRAM_DELIVERY_CLAIM_TTL_SEC + 1)).toMatchObject({ sendingToUnknown: 0 });
    await drainTelegramDeliveries(db, "token", { nowSec: () => NOW + 1, sendMessage });
    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(rows(sqlite).map((row) => [row.state, row.attempts])).toEqual([["sent", 1]]);
  });

  it("releases sendable claims when pre-settlement fails", async () => {
    const { sqlite, db } = setup();
    addSubscriber(sqlite, "1");
    // Chat 2 is unknown, so its row is pre-settled as cancelled in the failing batch.
    await enqueueTelegramJob(db, job("alert:pre", [
      { chatId: "1", body: "a", coinIds: ["usdt"] },
      { chatId: "2", body: "a", coinIds: ["usdt"] },
    ]));
    const sendMessage = vi.fn(async () => ok);
    await expect(drainTelegramDeliveries(faulty(db, { batchCalls: [1] }), "token", { nowSec: () => NOW, sendMessage }))
      .rejects.toThrow("D1 batch unavailable");
    expect(sendMessage).not.toHaveBeenCalled();
    expect(claims(sqlite).map((row) => [row.chat_id, row.state, row.attempts, row.reason])).toEqual([
      ["1", "retry", 0, "drain_aborted"],
      ["2", "retry", 0, "drain_aborted"],
    ]);
    await drainTelegramDeliveries(db, "token", { nowSec: () => NOW + 1, sendMessage });
    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(rows(sqlite).map((row) => [row.chat_id, row.state, row.reason])).toEqual([
      ["1", "sent", null],
      ["2", "cancelled", "subscriber_missing"],
    ]);
  });

  it("keeps successful pre-settlements and another owner's claim when the start callback throws", async () => {
    const { sqlite, db } = setup();
    addSubscriber(sqlite, "1");
    addSubscriber(sqlite, "3");
    await enqueueTelegramJob(db, job("alert:start", [
      { chatId: "1", body: "a", coinIds: ["usdt"] },
      { chatId: "2", body: "a", coinIds: ["usdt"] },
      { chatId: "3", body: "a", coinIds: ["usdt"] },
    ]));
    const sendMessage = vi.fn(async () => ok);
    await expect(drainTelegramDeliveries(db, "token", {
      nowSec: () => NOW,
      sendMessage,
      onDeliveryStarted: () => {
        // A concurrent owner took chat 3's row; it must not be released by this invocation.
        sqlite.prepare("UPDATE telegram_deliveries SET claim_owner = 'other' WHERE chat_id = '3'").run();
        throw new Error("start hook failed");
      },
    })).rejects.toThrow("start hook failed");
    expect(sendMessage).not.toHaveBeenCalled();
    expect(claims(sqlite).map((row) => [row.chat_id, row.state, row.attempts, row.reason, row.claim_owner])).toEqual([
      ["1", "retry", 0, "drain_aborted", null],
      ["2", "cancelled", 0, "subscriber_missing", null],
      ["3", "sending", 0, null, "other"],
    ]);
  });

  it("releases a skipped tail when tail settlement fails, keeping the attempted head", async () => {
    const { sqlite, db } = setup();
    addSubscriber(sqlite, "1");
    await enqueueTelegramJob(db, job("broadcast:tail", [
      { chatId: "1", body: "c0", audience: "notice" },
      { chatId: "1", body: "c1", seq: 1, audience: "notice" },
    ]));
    const sendMessage = vi.fn(async () => failure({}));
    // Batch 1 settles the attempted head; batch 2 (tail settlement) fails.
    await expect(drainTelegramDeliveries(faulty(db, { batchCalls: [2] }), "token", { nowSec: () => NOW, sendMessage }))
      .rejects.toThrow("D1 batch unavailable");
    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(claims(sqlite).map((row) => [row.seq, row.state, row.attempts, row.reason, row.has_body])).toEqual([
      [0, "retry", 1, "server_error", 1],
      [1, "retry", 0, "drain_aborted", 1],
    ]);
  });

  it("leaves a transport call whose settlement failed sending, then unknown, never resent", async () => {
    const { sqlite, db } = setup();
    addSubscriber(sqlite, "1");
    await enqueueTelegramJob(db, job("broadcast:ambiguous", [{ chatId: "1", body: "x", audience: "notice" }]));
    const sendMessage = vi.fn(async () => ok);
    await expect(drainTelegramDeliveries(faulty(db, { batchCalls: [1] }), "token", { nowSec: () => NOW, sendMessage }))
      .rejects.toThrow("D1 batch unavailable");
    // attempts is still 0, yet the send happened: only the invocation's attempt marker proves no-send.
    expect(claims(sqlite)[0]).toMatchObject({ state: "sending", attempts: 0 });
    await sweepTelegramJobs(db, NOW + TELEGRAM_DELIVERY_CLAIM_TTL_SEC);
    await drainTelegramDeliveries(db, "token", { nowSec: () => NOW + TELEGRAM_DELIVERY_CLAIM_TTL_SEC + 1, sendMessage });
    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(rows(sqlite)[0]).toMatchObject({ state: "unknown", reason: "claim_expired", attempts: 0 });
  });
});

describe("telegram drain freeze claim revalidation", () => {
  function freezeJob(
    jobId: string,
    kind: "freeze_batch" | "rollup" | "freeze",
    deliveries: Array<Partial<TelegramDeliveryInput> & { chatId: string }>,
  ) {
    return {
      jobId, kind, payload: {}, createdAt: NOW, expiresAt: NOW + 3600,
      deliveries: deliveries.map((delivery) => ({
        body: "freeze message", families: ["freeze"], ...delivery,
      })) as TelegramDeliveryInput[],
    };
  }
  const states = (sqlite: DatabaseSync) => sqlite.prepare(
    "SELECT job_id, chat_id, seq, state, attempts, reason, next_attempt_at FROM telegram_deliveries ORDER BY job_id, chat_id, seq",
  ).all() as Array<Record<string, unknown>>;

  it("cancels a retracted batch claim before transport while unrelated chats and kinds still send", async () => {
    const { sqlite, db } = setup();
    for (const chat of ["1", "2", "3"]) addSubscriber(sqlite, chat);
    await enqueueTelegramJob(db, freezeJob("freeze_batch:0-2", "freeze_batch", [
      { chatId: "1", freezeSourceKeys: ["freeze:gone", "freeze:kept"] },
      { chatId: "2", freezeSourceKeys: ["freeze:kept"] },
    ]));
    await enqueueTelegramJob(db, job("broadcast:other", [{ chatId: "3", body: "notice", audience: "notice" }]));
    const validateFreezeClaims = vi.fn(async () => new Set(["freeze:gone"]));
    const sendMessage = vi.fn(async (_chatId: string) => ok);
    const result = await drainTelegramDeliveries(db, "token", { nowSec: () => NOW, sendMessage, validateFreezeClaims });

    expect(validateFreezeClaims).toHaveBeenCalledWith(expect.arrayContaining(["freeze:gone", "freeze:kept"]));
    expect(sendMessage.mock.calls.map((call) => call[0]).sort()).toEqual(["2", "3"]);
    expect(result).toMatchObject({ attempted: 2, sent: 2, cancelled: 1 });
    expect(states(sqlite).map((row) => [row.chat_id, row.state, row.attempts, row.reason])).toEqual([
      ["3", "sent", 1, null],
      ["1", "cancelled", 0, "freeze-claim-retracted"],
      ["2", "sent", 1, null],
    ]);
  });

  it("revalidates every wave: a retraction between chunks cancels the rest of that message", async () => {
    const { sqlite, db } = setup();
    addSubscriber(sqlite, "1");
    await enqueueTelegramJob(db, freezeJob("freeze_batch:0-1", "freeze_batch", [
      { chatId: "1", seq: 0, body: "c0", freezeSourceKeys: ["freeze:a"] },
      { chatId: "1", seq: 1, body: "c1", freezeSourceKeys: ["freeze:a"] },
      { chatId: "1", seq: 2, body: "c2", freezeSourceKeys: ["freeze:a"] },
    ]));
    let retracted = false;
    const validateFreezeClaims = vi.fn(async () => {
      const set = new Set(retracted ? ["freeze:a"] : []);
      retracted = true;
      return set;
    });
    const sendMessage = vi.fn(async (_chatId: string) => ok);
    // Only chunks 0 and 1 are claimed; chunk 2 is an unclaimed sibling.
    await drainTelegramDeliveries(db, "token", { nowSec: () => NOW, sendMessage, validateFreezeClaims, maxRows: 2 });

    expect(validateFreezeClaims).toHaveBeenCalledTimes(2);
    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(states(sqlite).map((row) => [row.seq, row.state, row.attempts, row.reason])).toEqual([
      [0, "sent", 1, null],
      [1, "cancelled", 0, "freeze-claim-retracted"],
      [2, "cancelled", 0, "freeze-claim-retracted"],
    ]);
  });

  it.each([
    ["the read fails", async () => null],
    ["no validator is supplied", undefined],
  ] as const)("defers freeze-bearing rows with backoff when %s, then sends after recovery", async (_label, validator) => {
    const { sqlite, db } = setup();
    addSubscriber(sqlite, "1");
    await enqueueTelegramJob(db, freezeJob("freeze:tape-1", "freeze", [{ chatId: "1" }]));
    const sendMessage = vi.fn(async (_chatId: string) => ok);
    const result = await drainTelegramDeliveries(db, "token", {
      nowSec: () => NOW, sendMessage, ...(validator ? { validateFreezeClaims: validator } : {}),
    });
    expect(sendMessage).not.toHaveBeenCalled();
    expect(result.attempted).toBe(0);
    expect(states(sqlite)[0]).toMatchObject({
      state: "retry", attempts: 0, reason: "freeze-retraction-read-failed", next_attempt_at: NOW + 60,
    });
    const validateFreezeClaims = vi.fn(async (keys: readonly string[]) => {
      expect(keys).toEqual(["freeze:tape-1"]);
      return new Set<string>();
    });
    await drainTelegramDeliveries(db, "token", { nowSec: () => NOW + 60, sendMessage, validateFreezeClaims });
    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(states(sqlite)[0]).toMatchObject({ state: "sent", attempts: 1 });
  });

  it("cancels freeze-bearing messages whose manifest is missing or malformed, sparing non-freeze roll-ups", async () => {
    const { sqlite, db } = setup();
    for (const chat of ["1", "2", "3", "4"]) addSubscriber(sqlite, chat);
    await enqueueTelegramJob(db, freezeJob("freeze_batch:legacy", "freeze_batch", [{ chatId: "1" }]));
    await enqueueTelegramJob(db, freezeJob("rollup:2026-10-27:2", "rollup", [{ chatId: "2", families: ["safety", "freeze"] }]));
    await enqueueTelegramJob(db, freezeJob("rollup:2026-10-27:3", "rollup", [{ chatId: "3", families: ["safety"] }]));
    await enqueueTelegramJob(db, freezeJob("freeze_batch:bad", "freeze_batch", [{ chatId: "4" }]));
    sqlite.prepare("UPDATE telegram_deliveries SET options_json = ? WHERE chat_id = '4'")
      .run(JSON.stringify({ freezeSourceKeys: ["freeze:", "tape-x"] }));
    const validateFreezeClaims = vi.fn(async () => new Set<string>());
    const sendMessage = vi.fn(async (_chatId: string) => ok);
    await drainTelegramDeliveries(db, "token", { nowSec: () => NOW, sendMessage, validateFreezeClaims });

    expect(sendMessage.mock.calls.map((call) => call[0])).toEqual(["3"]);
    expect(states(sqlite).map((row) => [row.chat_id, row.state, row.reason])).toEqual([
      ["4", "cancelled", "freeze-claim-manifest-missing"],
      ["1", "cancelled", "freeze-claim-manifest-missing"],
      ["2", "cancelled", "freeze-claim-manifest-missing"],
      ["3", "sent", null],
    ]);
  });

  it.each([
    ["abort", (controller: AbortController) => controller.abort(), "aborted"],
    ["deadline", () => vi.setSystemTime(Date.now() + 10_000), "soft_deadline"],
  ] as const)("grants no fresh send time when validation outlasts the %s", async (_label, expire, reason) => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      const { sqlite, db } = setup();
      addSubscriber(sqlite, "1");
      await enqueueTelegramJob(db, freezeJob("freeze_batch:slow", "freeze_batch", [{ chatId: "1", freezeSourceKeys: ["freeze:a"] }]));
      const controller = new AbortController();
      const sendMessage = vi.fn(async (_chatId: string) => ok);
      await drainTelegramDeliveries(db, "token", {
        nowSec: () => NOW,
        sendMessage,
        signal: controller.signal,
        softDeadlineAtMs: Date.now() + 5_000,
        validateFreezeClaims: async () => {
          expire(controller);
          return new Set<string>();
        },
      });
      expect(sendMessage).not.toHaveBeenCalled();
      expect(states(sqlite)[0]).toMatchObject({ state: "retry", attempts: 0, reason });
    } finally {
      vi.useRealTimers();
    }
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

  describe("bounded planning selection", () => {
    const isPlanningSelect = (sql: string) =>
      sql.trimStart().startsWith("SELECT job_id, kind, payload_json") && sql.includes("'planning'");
    function planningJob(sqlite: DatabaseSync, jobId: string, createdAt: number, payload = '{"messageHtml":"hi","scope":"all"}') {
      sqlite.prepare(
        `INSERT INTO telegram_jobs (job_id, kind, payload_json, state, created_at, expires_at)
         VALUES (?, 'broadcast', ?, 'planning', ?, ?)`,
      ).run(jobId, payload, createdAt, NOW + 3600);
    }
    function recordSelections(sqlite: DatabaseSync) {
      const selections: number[] = [];
      const prepare = sqlite.prepare.bind(sqlite);
      vi.spyOn(sqlite, "prepare").mockImplementation((sql: string) => {
        const statement = prepare(sql);
        if (!isPlanningSelect(sql)) return statement;
        return new Proxy(statement, {
          get(target, property) {
            if (property === "get") return (...args: never[]) => {
              const row = target.get(...args);
              selections.push(row ? 1 : 0);
              return row;
            };
            if (property === "all") return (...args: never[]) => {
              const rows = target.all(...args);
              selections.push(rows.length);
              return rows;
            };
            const value = Reflect.get(target, property) as unknown;
            return typeof value === "function" ? (value as (...a: unknown[]) => unknown).bind(target) : value;
          },
        });
      });
      return selections;
    }

    it("holds one job resident at a time and stops selecting when the page budget is spent", async () => {
      const { sqlite, db } = setup();
      addSubscriber(sqlite, "1");
      for (let index = 0; index < 100; index += 1) planningJob(sqlite, `broadcast:${String(index).padStart(3, "0")}`, NOW);
      const selections = recordSelections(sqlite);
      const result = await fanOutPlanningTelegramJobs(db, NOW, { maxPages: 1 });
      expect(result).toMatchObject({ pages: 1, jobsReady: 1 });
      expect(selections).toEqual([1]);
      // FIFO ties break on job id.
      expect(sqlite.prepare("SELECT job_id FROM telegram_jobs WHERE state = 'ready'").all()).toEqual([{ job_id: "broadcast:000" }]);
    });

    it("selects nothing with a zero budget, an aborted signal or a spent deadline", async () => {
      const { sqlite, db } = setup();
      planningJob(sqlite, "broadcast:a", NOW);
      const selections = recordSelections(sqlite);
      await fanOutPlanningTelegramJobs(db, NOW, { maxPages: 0 });
      const controller = new AbortController();
      controller.abort();
      await fanOutPlanningTelegramJobs(db, NOW, { signal: controller.signal });
      await fanOutPlanningTelegramJobs(db, NOW, { softDeadlineAtMs: Date.now() - 1 });
      expect(selections).toEqual([]);
      expect(sqlite.prepare("SELECT state FROM telegram_jobs").get()).toEqual({ state: "planning" });
    });

    it("passes a failed job once per run so later healthy jobs still plan, and retries it next run", async () => {
      const { sqlite, db } = setup();
      addSubscriber(sqlite, "1");
      planningJob(sqlite, "freeze_batch:bad", NOW - 10, "null");
      sqlite.prepare("UPDATE telegram_jobs SET kind = 'freeze_batch' WHERE job_id = 'freeze_batch:bad'").run();
      planningJob(sqlite, "broadcast:later", NOW);
      const selections = recordSelections(sqlite);
      const first = await fanOutPlanningTelegramJobs(db, NOW);
      expect(first).toMatchObject({ jobsFailedClosed: 1, jobsReady: 1, deliveriesPlanned: 1 });
      // bad, later, then the empty end of the queue.
      expect(selections).toEqual([1, 1, 0]);
      const second = await fanOutPlanningTelegramJobs(db, NOW + 300);
      expect(second).toMatchObject({ jobsFailedClosed: 1, deliveriesPlanned: 0 });
      expect(sqlite.prepare("SELECT job_id, state, cursor FROM telegram_jobs ORDER BY job_id").all()).toEqual([
        { job_id: "broadcast:later", state: "ready", cursor: null },
        { job_id: "freeze_batch:bad", state: "planning", cursor: null },
      ]);
    });

    it("serves the planning selection from the open-jobs partial index", async () => {
      const { sqlite, db } = setup();
      planningJob(sqlite, "broadcast:a", NOW);
      planningJob(sqlite, "broadcast:b", NOW);
      const statements: string[] = [];
      const prepare = sqlite.prepare.bind(sqlite);
      vi.spyOn(sqlite, "prepare").mockImplementation((sql: string) => {
        statements.push(sql);
        return prepare(sql);
      });
      await fanOutPlanningTelegramJobs(db, NOW);
      const selects = statements.filter(isPlanningSelect);
      expect(selects.some((sql) => sql.includes("(created_at, job_id) >"))).toBe(true);
      for (const sql of selects) {
        const plan = (prepare(`EXPLAIN QUERY PLAN ${sql}`).all() as Array<{ detail: string }>).map((row) => row.detail);
        expect(plan.join("\n")).toContain("idx_telegram_jobs_open");
      }
    });
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
