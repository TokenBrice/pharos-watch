import { afterEach, describe, expect, it } from "vitest";
import type { DatabaseSync } from "node:sqlite";
import { createLatestSchemaSqlite } from "@shared/test-utils/latest-schema-sqlite";
import { createSqliteD1 } from "@shared/test-utils/sqlite-d1";
import { enqueueTelegramJob } from "../../../../telegram/delivery/jobs";
import { drainTelegramDeliveries } from "../../../../telegram/delivery/job-drain";
import type { SendToChatResult } from "../../../../telegram/delivery/telegram";
import type { TelegramBroadcastJobPayload } from "../../../../telegram/delivery/broadcast-targets";
import { fanOutPlanningTelegramJobs, sweepTelegramJobs } from "../run-jobs";

const NOW = 1_900_000_000;
const MESSAGE = "<b>Pharos maintenance</b> tonight at 02:00 UTC";
const open: DatabaseSync[] = [];
afterEach(() => {
  while (open.length > 0) open.pop()!.close();
});

function fixture() {
  const { sqlite } = createLatestSchemaSqlite();
  open.push(sqlite);
  return { sqlite, db: createSqliteD1(sqlite) };
}

const ok: SendToChatResult = {
  ok: true, blocked: false, retryable: false, permanentFailure: false, statusCode: 200,
  errorClass: null, delivery: "sent", retryAfterSec: null,
};

function addSubscribers(sqlite: DatabaseSync, chatIds: readonly string[]) {
  for (const chatId of chatIds) {
    sqlite.prepare("INSERT INTO telegram_subscribers (chat_id, created_at, last_active_at) VALUES (?, ?, ?)")
      .run(chatId, NOW, NOW);
  }
}

function broadcastJob(jobId: string, excludeChatId?: string) {
  return {
    jobId,
    kind: "broadcast" as const,
    payload: { messageHtml: MESSAGE, scope: "all", ...(excludeChatId ? { excludeChatId } : {}) } satisfies TelegramBroadcastJobPayload,
    createdAt: NOW,
    expiresAt: NOW + 2_700,
  };
}

function storedMessageHtml(sqlite: DatabaseSync): unknown[] {
  // A scrub must remove the key, not corrupt the payload: an invalid payload
  // would also read as null, so require valid JSON first.
  const rows = sqlite.prepare(
    "SELECT json_valid(payload_json) AS valid, json_extract(payload_json, '$.messageHtml') AS message_html FROM telegram_jobs",
  ).all() as Array<{ valid: number; message_html: unknown }>;
  for (const row of rows) expect(row.valid).toBe(1);
  return rows.map((row) => row.message_html);
}

describe("broadcast job payload retention", () => {
  it("drops the message text from telegram_jobs once fan-out is complete", async () => {
    const { sqlite, db } = fixture();
    addSubscribers(sqlite, ["100", "200", "300"]);
    await enqueueTelegramJob(db, broadcastJob("broadcast:ready", "100"));
    expect(storedMessageHtml(sqlite)).toEqual([MESSAGE]);

    const fanout = await fanOutPlanningTelegramJobs(db, NOW);
    expect(fanout.jobsReady).toBe(1);
    expect(sqlite.prepare("SELECT state FROM telegram_jobs").get()).toEqual({ state: "ready" });
    // Every row already carries the chunk it will send, so the job text is dead
    // weight from this point on.
    expect(sqlite.prepare("SELECT chat_id, body FROM telegram_deliveries ORDER BY chat_id").all())
      .toEqual([{ chat_id: "200", body: MESSAGE }, { chat_id: "300", body: MESSAGE }]);
    expect(storedMessageHtml(sqlite)).toEqual([null]);
    // The routing fields the job still needs (and /forget scrubs) survive.
    expect(sqlite.prepare("SELECT json_extract(payload_json, '$.scope') AS scope, json_extract(payload_json, '$.excludeChatId') AS exclude FROM telegram_jobs").get())
      .toEqual({ scope: "all", exclude: "100" });
  });

  it("keeps the message text while pages remain and clears it on the last page", async () => {
    const { sqlite, db } = fixture();
    const chatIds = Array.from({ length: 250 }, (_, index) => String(1000 + index));
    addSubscribers(sqlite, chatIds);
    await enqueueTelegramJob(db, broadcastJob("broadcast:paged"));
    // One page of 200 chats leaves the job planning; the remaining 50 finish it.
    await fanOutPlanningTelegramJobs(db, NOW, { maxPages: 1 });
    expect(sqlite.prepare("SELECT state, cursor FROM telegram_jobs").get())
      .toEqual({ state: "planning", cursor: "1199" });
    expect(storedMessageHtml(sqlite)).toEqual([MESSAGE]);

    await fanOutPlanningTelegramJobs(db, NOW, { maxPages: 1 });
    expect(sqlite.prepare("SELECT state FROM telegram_jobs").get()).toEqual({ state: "ready" });
    expect(storedMessageHtml(sqlite)).toEqual([null]);
    expect(sqlite.prepare("SELECT COUNT(*) AS n FROM telegram_deliveries").get()).toEqual({ n: 250 });
  });

  it("leaves no broadcast text in D1 after the job reaches a terminal state", async () => {
    const { sqlite, db } = fixture();
    addSubscribers(sqlite, ["100", "200"]);
    await enqueueTelegramJob(db, broadcastJob("broadcast:done"));
    await fanOutPlanningTelegramJobs(db, NOW);
    await drainTelegramDeliveries(db, "token", { nowSec: () => NOW, sendMessage: async () => ok });
    expect(sqlite.prepare("SELECT state, body FROM telegram_deliveries ORDER BY chat_id").all())
      .toEqual([{ state: "sent", body: null }, { state: "sent", body: null }]);
    expect(await sweepTelegramJobs(db, NOW + 1)).toMatchObject({ jobsDone: 1 });

    expect(sqlite.prepare("SELECT state FROM telegram_jobs").get()).toEqual({ state: "done" });
    expect(storedMessageHtml(sqlite)).toEqual([null]);
    // No table keeps the text: the jobs and deliveries columns are both scrubbed.
    const leaked = sqlite.prepare(
      `SELECT COUNT(*) AS n FROM telegram_jobs
        WHERE instr(payload_json, 'Pharos maintenance') > 0`,
    ).get() as { n: number };
    expect(leaked.n).toBe(0);
    expect(sqlite.prepare("SELECT COUNT(*) AS n FROM telegram_deliveries WHERE body IS NOT NULL").get()).toEqual({ n: 0 });
  });

  it("scrubs a broadcast job cancelled before fan-out", async () => {
    const { sqlite, db } = fixture();
    addSubscribers(sqlite, ["100"]);
    // Expiry while planning terminates the job without ever needing its text.
    await enqueueTelegramJob(db, { ...broadcastJob("broadcast:expired"), expiresAt: NOW - 1 });
    await fanOutPlanningTelegramJobs(db, NOW);
    expect(sqlite.prepare("SELECT state, error FROM telegram_jobs").get())
      .toEqual({ state: "cancelled", error: "expired_while_planning" });
    expect(storedMessageHtml(sqlite)).toEqual([null]);
  });

  it("scrubs a broadcast payload readied before this retention rule on the close sweep", async () => {
    const { sqlite, db } = fixture();
    // A job readied by the previous Worker keeps its payload; the ready -> done
    // close is the self-healing pass that scrubs it without operator action.
    sqlite.prepare(
      `INSERT INTO telegram_jobs (job_id, kind, payload_json, state, planned_count, created_at, expires_at)
       VALUES ('broadcast:legacy', 'broadcast', ?, 'ready', 0, ?, ?)`,
    ).run(JSON.stringify({ messageHtml: MESSAGE, scope: "all" }), NOW, NOW + 2_700);
    expect(storedMessageHtml(sqlite)).toEqual([MESSAGE]);
    expect(await sweepTelegramJobs(db, NOW + 1)).toMatchObject({ jobsDone: 1 });
    expect(sqlite.prepare("SELECT state FROM telegram_jobs").get()).toEqual({ state: "done" });
    expect(storedMessageHtml(sqlite)).toEqual([null]);
    expect(sqlite.prepare("SELECT json_extract(payload_json, '$.scope') AS scope FROM telegram_jobs").get())
      .toEqual({ scope: "all" });
  });
});
