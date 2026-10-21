import { describe, expect, it } from "vitest";
import { createLatestSchemaSqlite } from "@shared/test-utils/latest-schema-sqlite";
import { TELEGRAM_ALERT_POLICY } from "@shared/lib/telegram-delivery-policy";
import { enqueueTelegramJob } from "../../../../telegram/delivery/jobs";
import { freezeAlertsToChangeLogEntries, recordTelegramChangeLog, type TelegramChangeLogEntry } from "../change-log";
import { applyTelegramChatCap } from "../chat-cap";
import {
  buildFreezeBatchJobPage,
  runDailyRollup,
  runFreezeBatch,
  runTelegramRollupStep,
  type FreezeBatchJobPayload,
} from "../rollup-step";
import type { TelegramDeliveryInput, TelegramJobRow } from "../../../../telegram/delivery/jobs";

const at = (iso: string) => Date.parse(iso) / 1000;
const DAY1_0905Z = at("2026-10-21T09:05:00Z");

function fixture() {
  const { sqlite, db } = createLatestSchemaSqlite();
  const subscriber = sqlite.prepare(
    `INSERT INTO telegram_subscribers (
       chat_id, created_at, last_active_at, timezone, quiet_hours_enabled, quiet_hours_start_utc, quiet_hours_end_utc,
       global_alert_safety, global_alert_freeze
     ) VALUES (?, 1, 1, ?, ?, ?, ?, ?, ?)`,
  );
  const follow = sqlite.prepare(
    "INSERT INTO telegram_subscriptions (chat_id, stablecoin_id, alert_safety, alert_freeze) VALUES (?, ?, ?, ?)",
  );
  const deliveries = () => sqlite.prepare(
    `SELECT d.job_id, d.chat_id, d.body, d.families FROM telegram_deliveries d ORDER BY d.job_id, d.chat_id, d.seq`,
  ).all() as Array<{ job_id: string; chat_id: string; body: string; families: string }>;
  const state = (chatId: string) => sqlite.prepare("SELECT * FROM telegram_rollup_state WHERE chat_id = ?").get(chatId);
  return { sqlite, db, subscriber, follow, deliveries, state };
}

function safety(coin: string, from: string, to: string, observedAt: number): TelegramChangeLogEntry {
  return {
    kind: "safety", stablecoinId: coin, sourceKey: `safety:${coin}:${from}>${to}:${observedAt}`, observedAt,
    payload: { symbol: coin.toUpperCase(), from, to, fromScore: null, toScore: null },
  };
}

function freeze(coin: string, id: string, amount: number | null, observedAt: number): TelegramChangeLogEntry {
  return freezeAlertsToChangeLogEntries([{
    stablecoinId: coin, symbol: coin.toUpperCase(), eventType: "blacklist", chainName: "Ethereum",
    amountUsdAtEvent: amount, tapeEventId: id, sourceEventId: `blacklist-${id}`,
  }], observedAt)[0]!;
}

describe("daily roll-up", () => {
  it("sends net changes per chat at 09:00 local, skips empty days and quiet hours, and never repeats a date", async () => {
    const { sqlite, db, subscriber, follow, deliveries, state } = fixture();
    try {
      subscriber.run("1", null, 0, null, null, 0, 0); // UTC, direct follow of usdx
      subscriber.run("2", "America/New_York", 0, null, null, 1, 0); // global safety, digest-only
      subscriber.run("3", null, 1, 6, 12, 1, 0); // quiet 06:00-12:00 UTC
      subscriber.run("4", null, 0, null, null, 0, 0); // follows nothing
      follow.run("1", "usdx", 1, 0);
      await recordTelegramChangeLog(db, [
        // A flap on usdx cancels out; usdy moves for real.
        safety("usdx", "B", "C", DAY1_0905Z - 3_600),
        safety("usdx", "C", "B", DAY1_0905Z - 1_800),
        safety("usdy", "A", "B-", DAY1_0905Z - 600),
        // Global-only coverage: a grade flip on a 1-point score move is not material.
        {
          kind: "safety", stablecoinId: "usdw", sourceKey: "safety:usdw", observedAt: DAY1_0905Z - 600,
          payload: { symbol: "USDW", from: "B", to: "B-", fromScore: 70, toScore: 69 },
        },
      ]);

      const first = await runDailyRollup(db, DAY1_0905Z);
      expect(first).toMatchObject({ dueChats: 2, sentChats: 0, emptyChats: 2 });
      expect(deliveries()).toEqual([]);
      expect(state("1")).toEqual({ chat_id: "1", last_rollup_local_date: "2026-10-21", last_rollup_at: DAY1_0905Z });
      expect(state("2")).toBeUndefined();
      expect(state("3")).toBeUndefined();

      // 09:05 New York (EDT) is 13:05 UTC; chat 3 left quiet hours at 12:00 UTC.
      const nyMorning = at("2026-10-21T13:05:00Z");
      const second = await runDailyRollup(db, nyMorning);
      expect(second).toMatchObject({ dueChats: 2, sentChats: 2, emptyChats: 0 });
      const sent = deliveries();
      expect(sent.map(({ job_id, chat_id, families }) => ({ job_id, chat_id, families }))).toEqual([
        { job_id: "rollup:2026-10-21:2", chat_id: "2", families: "safety" },
        { job_id: "rollup:2026-10-21:3", chat_id: "3", families: "safety" },
      ]);
      expect(sent[0]!.body.split("\n")[0]).toBe("<b>Daily changes</b>: 1 change on your coins, led by USDY Safety grade downgraded A → B-");
      expect(sent[0]!.body).not.toContain("USDX");
      expect(sent[0]!.body).not.toContain("USDW");

      expect(await runDailyRollup(db, nyMorning + 900)).toMatchObject({ dueChats: 0, sentChats: 0 });
      expect(deliveries()).toHaveLength(2);
    } finally {
      sqlite.close();
    }
  });

  it("reports cap overflow in the next roll-up and covers only the time since the previous one", async () => {
    const { sqlite, db, subscriber, follow, deliveries } = fixture();
    try {
      subscriber.run("1", null, 0, null, null, 0, 0);
      follow.run("1", "usdx", 1, 0);
      sqlite.prepare("INSERT INTO telegram_rollup_state VALUES ('1', '2026-10-20', ?)").run(DAY1_0905Z - 86_400);
      await recordTelegramChangeLog(db, [
        safety("usdx", "A", "B", DAY1_0905Z - 90_000), // before the previous roll-up
        { kind: "overflow", chatId: "1", sourceKey: "overflow:job-1:1", observedAt: DAY1_0905Z - 60, payload: { families: ["dews"], coinIds: ["usdx"] } },
      ]);
      expect(await runDailyRollup(db, DAY1_0905Z)).toMatchObject({ sentChats: 1 });
      const [rollup] = deliveries();
      expect(rollup!.body.split("\n")[0]).toBe("<b>Daily changes</b>: 1 alert held back");
      expect(rollup!.body).not.toContain("A → B");
    } finally {
      sqlite.close();
    }
  });

  it("skips paused chats and gates the scan to one per 15-minute bucket", async () => {
    const { sqlite, db, subscriber } = fixture();
    try {
      subscriber.run("1", null, 0, null, null, 1, 0);
      sqlite.prepare("UPDATE telegram_subscribers SET alert_snooze_until_ts = ? WHERE chat_id = '1'").run(DAY1_0905Z + 3_600);
      expect((await runTelegramRollupStep(db, DAY1_0905Z)).rollup).toMatchObject({ state: "done", dueChats: 0 });
      expect((await runTelegramRollupStep(db, DAY1_0905Z + 60)).rollup.state).toBe("not-due");
      expect((await runTelegramRollupStep(db, DAY1_0905Z + 15 * 60)).rollup.state).toBe("done");
    } finally {
      sqlite.close();
    }
  });
});

describe("roll-up after live alerts", () => {
  it("does not repeat what the chat was told live, but reports later moves", async () => {
    const { sqlite, db, subscriber, follow, deliveries } = fixture();
    try {
      subscriber.run("1", null, 0, null, null, 0, 0);
      subscriber.run("2", null, 0, null, null, 0, 0);
      follow.run("1", "usdx", 1, 0);
      follow.run("1", "usdz", 1, 0);
      follow.run("2", "usdx", 1, 0);
      const t = DAY1_0905Z - 20_000;
      await recordTelegramChangeLog(db, [
        safety("usdx", "B", "C", t),
        safety("usdx", "C", "D", t + 1_000),
        safety("usdz", "A", "B", t + 1_000),
      ]);
      // The severe downgrade went live to chat 1 only, in a job that also alerted usdy elsewhere.
      await enqueueTelegramJob(db, {
        jobId: "alert:live", kind: "alert", createdAt: t + 7_000, expiresAt: t + 14_000,
        payload: { events: { safetyChanges: [{ stablecoinId: "usdx" }, { stablecoinId: "usdy" }], dewsChanges: [] } },
        deliveries: [{ chatId: "1", body: "USDX downgraded to D", families: ["safety"], coinIds: ["usdx"] }],
      });
      await runDailyRollup(db, DAY1_0905Z);
      const body = (chatId: string) => deliveries().find((row) => row.chat_id === chatId && row.job_id.startsWith("rollup:"))?.body;
      expect(body("1")).not.toContain("USDX");
      expect(body("1")).toContain("<b>USDZ</b> Safety grade downgraded A → B");
      expect(body("2")).toContain("<b>USDX</b> Safety grade downgraded B → D");

      // It moves again after the live alert: the next roll-up reports that move only.
      await recordTelegramChangeLog(db, [safety("usdx", "D", "C", DAY1_0905Z + 3_600)]);
      await runDailyRollup(db, DAY1_0905Z + 86_400);
      const next = deliveries().find((row) => row.job_id === "rollup:2026-10-22:1")?.body;
      expect(next).toContain("<b>USDX</b> Safety grade raised D → C");
    } finally {
      sqlite.close();
    }
  });
});

async function freezeBatchJobs(sqlite: ReturnType<typeof fixture>["sqlite"]) {
  return sqlite.prepare("SELECT job_id, state, payload_json FROM telegram_jobs WHERE kind = 'freeze_batch' ORDER BY created_at")
    .all() as Array<{ job_id: string; state: string; payload_json: string }>;
}

/** Drive a planning freeze_batch job through every fan-out page. */
async function fanOutFreezeBatch(db: D1Database, payloadJson: string, limit = 200) {
  const deliveries: TelegramDeliveryInput[] = [];
  let cursor: string | null = null;
  let pages = 0;
  do {
    const page = await buildFreezeBatchJobPage({
      db, job: {} as TelegramJobRow, payload: JSON.parse(payloadJson) as FreezeBatchJobPayload, cursor, nowSec: 0, limit,
    });
    deliveries.push(...page.deliveries);
    cursor = page.nextCursor;
    pages++;
  } while (cursor != null);
  return { deliveries, pages };
}

describe("roll-up after a mixed live alert", () => {
  it("suppresses only the family and coin this chat was actually sent", async () => {
    const { sqlite, db, subscriber, deliveries } = fixture();
    try {
      // Follows USDC DEWS directly and safety only through the global opt-in.
      subscriber.run("1", null, 0, null, null, 1, 0);
      sqlite.prepare("INSERT INTO telegram_subscriptions (chat_id, stablecoin_id, alert_dews) VALUES ('1', 'usdc', 1)").run();
      const t = DAY1_0905Z - 20_000;
      await recordTelegramChangeLog(db, [
        safety("usdc", "B", "D", t),
        { kind: "dews", stablecoinId: "usdc", sourceKey: "dews:usdc", observedAt: t, payload: { symbol: "USDC", from: "ALERT", to: "WARNING", score: 60 } },
      ]);
      // One job alerted USDC DEWS (to this chat) and USDC safety (to direct safety followers only).
      await enqueueTelegramJob(db, {
        jobId: "alert:mixed", kind: "alert", createdAt: t + 100, expiresAt: t + 7_200,
        payload: { events: { safetyChanges: [{ stablecoinId: "usdc" }], dewsChanges: [{ stablecoinId: "usdc" }] } },
        deliveries: [{ chatId: "1", body: "USDC stress rose to WARNING", families: ["dews"], coinIds: ["usdc"] }],
      });
      await runDailyRollup(db, DAY1_0905Z);
      const body = deliveries().find((row) => row.job_id.startsWith("rollup:"))?.body;
      expect(body).toContain("<b>USDC</b> Safety grade downgraded B → D");
      expect(body).not.toContain("stress");
    } finally {
      sqlite.close();
    }
  });
});

describe("roll-up after an ambiguous live alert", () => {
  it("does not invent a pair from a multi-coin, multi-family delivery", async () => {
    const { sqlite, db, subscriber, deliveries } = fixture();
    try {
      subscriber.run("1", null, 0, null, null, 0, 0);
      sqlite.prepare(
        `INSERT INTO telegram_subscriptions (chat_id, stablecoin_id, alert_dews, alert_reserve)
         VALUES ('1', 'usdt', 1, 0), ('1', 'usdc', 1, 1)`,
      ).run();
      const t = DAY1_0905Z - 20_000;
      await recordTelegramChangeLog(db, [
        { kind: "dews", stablecoinId: "usdc", sourceKey: "dews:usdc", observedAt: t, payload: { symbol: "USDC", from: "ALERT", to: "WATCH", score: 30 } },
      ]);
      // The chat got USDT DEWS and USDC reserve in one message; the job also alerted USDC DEWS elsewhere.
      await enqueueTelegramJob(db, {
        jobId: "alert:multi", kind: "alert", createdAt: t + 100, expiresAt: t + 7_200,
        payload: { events: { dewsChanges: [{ stablecoinId: "usdt" }, { stablecoinId: "usdc" }], reservePromoted: [{ stablecoinId: "usdc" }] } },
        deliveries: [{ chatId: "1", body: "two alerts", families: ["dews", "reserve"], coinIds: ["usdt", "usdc"] }],
      });
      await runDailyRollup(db, DAY1_0905Z);
      expect(deliveries().find((row) => row.job_id.startsWith("rollup:"))?.body).toContain("<b>USDC</b> stress eased to WATCH");
    } finally {
      sqlite.close();
    }
  });
});

describe("hourly freeze batch", () => {
  it("keeps freezes logged before the first batch, then batches once per interval for direct followers only", async () => {
    const { sqlite, db, subscriber, follow, deliveries } = fixture();
    try {
      subscriber.run("1", null, 0, null, null, 0, 0); // direct USDC freeze follower
      subscriber.run("2", null, 0, null, null, 0, 1); // global freeze: roll-up only
      follow.run("1", "usdc", 0, 1);
      const t0 = DAY1_0905Z;
      // Detection logs these in the same run that first initializes the batch cursor.
      await recordTelegramChangeLog(db, [freeze("usdc", "t1", 5_000, t0), freeze("usdc", "t2", null, t0), freeze("usdt", "t3", 10, t0)]);
      expect(await runFreezeBatch(db, t0)).toEqual({ state: "queued", changes: 3 });
      const [job] = await freezeBatchJobs(sqlite);
      expect(job).toMatchObject({ job_id: "freeze_batch:0-3", state: "planning" });
      const { deliveries: rows } = await fanOutFreezeBatch(db, job!.payload_json);
      expect(rows.map((row) => [row.chatId, row.families])).toEqual([["1", ["freeze"]]]);
      expect(rows[0]!.body).toContain("issuer froze an address on Ethereum holding $5,000");
      expect(rows[0]!.body).not.toContain("USDT");

      await recordTelegramChangeLog(db, [freeze("usdc", "t4", 7, t0 + 60)]);
      expect(await runFreezeBatch(db, t0 + 600)).toMatchObject({ state: "not-due" });
      const interval = TELEGRAM_ALERT_POLICY.freeze.batchIntervalSec;
      expect(await runFreezeBatch(db, t0 + interval)).toEqual({ state: "queued", changes: 1 });
      expect(await runFreezeBatch(db, t0 + 2 * interval)).toEqual({ state: "empty", changes: 0 });
      expect((await freezeBatchJobs(sqlite)).map((row) => row.job_id)).toEqual(["freeze_batch:0-3", "freeze_batch:3-4"]);

      // The global-only freeze opt-in sees them in its roll-up instead.
      await runDailyRollup(db, at("2026-10-22T09:00:00Z"));
      const rollup = deliveries().find((row) => row.chat_id === "2");
      expect(rollup?.body).toContain("<b>USDC</b> 3 freeze events, $5,007 known, 1 without a USD amount");
      expect(deliveries().some((row) => row.chat_id === "1" && row.job_id.startsWith("rollup:"))).toBe(false);
    } finally {
      sqlite.close();
    }
  });

  it("replays at most one interval when the cursor is lost", async () => {
    const { sqlite, db } = fixture();
    try {
      const t0 = DAY1_0905Z;
      await recordTelegramChangeLog(db, [freeze("usdc", "old", 1, t0 - 2 * 86_400), freeze("usdc", "recent", 1, t0 - 60)]);
      expect(await runFreezeBatch(db, t0)).toEqual({ state: "queued", changes: 1 });
      expect((await freezeBatchJobs(sqlite)).map((row) => row.job_id)).toEqual(["freeze_batch:1-2"]);
    } finally {
      sqlite.close();
    }
  });

  it("resumes from the latest freeze_batch job when the cache cursor is lost", async () => {
    const { sqlite, db } = fixture();
    try {
      const t0 = DAY1_0905Z;
      await recordTelegramChangeLog(db, [freeze("usdc", "e1", 1, t0)]);
      expect(await runFreezeBatch(db, t0)).toEqual({ state: "queued", changes: 1 });
      sqlite.prepare("DELETE FROM cache WHERE key = 'telegram:freeze-batch:state'").run();
      await recordTelegramChangeLog(db, [freeze("usdc", "e2", 1, t0 + 60)]);
      expect(await runFreezeBatch(db, t0 + 120)).toEqual({ state: "queued", changes: 1 });
      expect((await freezeBatchJobs(sqlite)).map((row) => row.job_id)).toEqual(["freeze_batch:0-1", "freeze_batch:1-2"]);
    } finally {
      sqlite.close();
    }
  });

  it("never batches a retracted freeze, nor lists it in a roll-up", async () => {
    const { sqlite, db, subscriber, follow, deliveries } = fixture();
    try {
      subscriber.run("1", null, 0, null, null, 0, 0);
      subscriber.run("2", null, 0, null, null, 0, 1);
      follow.run("1", "usdc", 0, 1);
      sqlite.prepare(
        `INSERT INTO tape_events (event_id, type, severity, ts, title, summary, payload_json, source_table, source_row_id, transition, created_at, suppressed_at)
         VALUES ('gone', 'freeze.blocked', 'warning', 1, 'x', 'x', '{}', 'blacklist_events', 'b-gone', 'opened', 1, 1)`,
      ).run();
      await recordTelegramChangeLog(db, [freeze("usdc", "gone", 5_000, DAY1_0905Z), freeze("usdc", "kept", 7, DAY1_0905Z)]);
      await runFreezeBatch(db, DAY1_0905Z);
      const [job] = await freezeBatchJobs(sqlite);
      const { deliveries: rows } = await fanOutFreezeBatch(db, job!.payload_json);
      expect(rows).toHaveLength(1);
      expect(rows[0]!.body).toContain("holding $7");
      expect(rows[0]!.body).not.toContain("$5,000");
      await runDailyRollup(db, DAY1_0905Z + 60);
      expect(deliveries().find((row) => row.chat_id === "2")?.body).toContain("<b>USDC</b> 1 freeze event, $7 known");
    } finally {
      sqlite.close();
    }
  });

  it("fans out any number of followers in pages instead of one atomic batch", async () => {
    const { sqlite, db, subscriber, follow } = fixture();
    try {
      for (let index = 0; index < 700; index++) {
        const chatId = String(1_000 + index);
        subscriber.run(chatId, null, 0, null, null, 0, 0);
        follow.run(chatId, "usdc", 0, 1);
      }
      await recordTelegramChangeLog(db, [freeze("usdc", "t1", 5_000, DAY1_0905Z)]);
      expect(await runFreezeBatch(db, DAY1_0905Z)).toEqual({ state: "queued", changes: 1 });
      const [job] = await freezeBatchJobs(sqlite);
      const { deliveries: rows, pages } = await fanOutFreezeBatch(db, job!.payload_json, 200);
      expect(pages).toBe(4);
      expect(new Set(rows.map((row) => row.chatId)).size).toBe(700);
    } finally {
      sqlite.close();
    }
  });

  it("does not let a failing freeze batch block the roll-up", async () => {
    const { sqlite, db, subscriber, follow } = fixture();
    try {
      subscriber.run("1", null, 0, null, null, 0, 0);
      follow.run("1", "usdx", 1, 0);
      await recordTelegramChangeLog(db, [safety("usdx", "B", "C", DAY1_0905Z - 60)]);
      const failingFreezeDb = new Proxy(db, {
        get(target, key) {
          if (key === "prepare") {
            return (sql: string) => {
              if (sql.includes("kind = 'freeze'")) throw new Error("freeze read failed");
              return target.prepare(sql);
            };
          }
          const value = Reflect.get(target, key);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
      const result = await runTelegramRollupStep(failingFreezeDb, DAY1_0905Z);
      expect(result.freezeBatch.state).toBe("failed");
      expect(result.rollup).toMatchObject({ state: "done", sentChats: 1 });
    } finally {
      sqlite.close();
    }
  });
});

describe("per-chat cap", () => {
  it("admits up to the cap, exempts depeg, and turns the excess into roll-up overflow", async () => {
    const { sqlite, db } = fixture();
    try {
      const now = DAY1_0905Z;
      for (let index = 0; index < TELEGRAM_ALERT_POLICY.chatCap.maxRealtimeMessages; index++) {
        await enqueueTelegramJob(db, {
          jobId: `alert:${index}`, kind: "alert", payload: null, createdAt: now - 3_600, expiresAt: now + 3_600,
          deliveries: [{ chatId: "1", body: `alert ${index}`, families: ["safety"] }],
        });
      }
      // An old message outside the window and a depeg message do not count.
      await enqueueTelegramJob(db, {
        jobId: "alert:old", kind: "alert", payload: null, createdAt: now - 2 * 86_400, expiresAt: now,
        deliveries: [{ chatId: "2", body: "old", families: ["dews"] }],
      });
      await enqueueTelegramJob(db, {
        jobId: "alert:depeg", kind: "alert", payload: null, createdAt: now - 60, expiresAt: now + 3_600,
        deliveries: [{ chatId: "2", body: "depeg", families: ["depeg", "dews"] }],
      });

      const capped = await applyTelegramChatCap(db, {
        jobId: "alert:new",
        nowSec: now,
        deliveries: [
          { chatId: "1", seq: 0, body: "new 1/2", families: ["dews"], coinIds: ["usdx"] },
          { chatId: "1", seq: 1, body: "new 2/2", families: ["dews"], coinIds: ["usdx"] },
          { chatId: "1", body: "depeg", families: ["depeg"] },
          { chatId: "2", body: "dews", families: ["dews"] },
        ],
      });
      expect(capped.admitted.map((row) => `${row.chatId}:${row.body}`)).toEqual(["1:depeg", "2:dews"]);
      expect(capped.overflow).toEqual([{
        kind: "overflow", chatId: "1", sourceKey: "overflow:alert:new:1", observedAt: now, payload: { families: ["dews"], coinIds: ["usdx"] },
      }]);
      for (const statement of capped.overflowStatements) await statement.run();
      expect(sqlite.prepare("SELECT kind, chat_id FROM telegram_change_log").all()).toEqual([{ kind: "overflow", chat_id: "1" }]);
    } finally {
      sqlite.close();
    }
  });
});
