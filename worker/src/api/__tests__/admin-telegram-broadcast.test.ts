import { describe, expect, it } from "vitest";
import { handleAdminTelegramBroadcast } from "../admin-telegram-broadcast";
import { mockD1 } from "../../test-helpers/__shared/mock-d1";
import { createSqliteD1 } from "../../test-helpers/sqlite-d1";

function adminRequest(body: unknown, opts: { admin?: boolean } = {}): Request {
  const headers = new Headers();
  if (opts.admin !== false) headers.set("X-Pharos-Admin", "1");
  headers.set("Content-Type", "application/json");
  return new Request("https://ops-api.pharos.watch/api/admin-telegram-broadcast", {
    method: "POST",
    headers,
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

function allSubscriberRows(chatIds: string[]) {
  return {
    match: "FROM telegram_subscribers ORDER BY chat_id",
    rows: chatIds.map((chat_id) => ({ chat_id })),
  };
}

function globalSubscriberRows(chatIds: string[]) {
  return {
    match: "global_alert_dews = 1",
    rows: chatIds.map((chat_id) => ({ chat_id })),
  };
}

function deliverableWatcherRows(chatIds: string[]) {
  return {
    match: "FROM telegram_preset_subscriptions ps",
    rows: chatIds.map((chat_id) => ({ chat_id })),
  };
}

function pendingInsertRow() {
  return { match: "INSERT INTO telegram_pending_alerts", rows: [], runMeta: { changes: 1 } };
}

function auditRow() {
  return { match: "INSERT INTO admin_action_audit", rows: [], runMeta: { changes: 1 } };
}

function pendingCapacityRow(active: number) {
  return {
    match: "SUM(CASE WHEN delivery_state = 'pending' THEN 1 ELSE 0 END) AS total",
    first: {
      total: active,
      expired: 0,
      due: active,
      deferred: 0,
      near_ttl: 0,
      oldest_pending_created_at: active > 0 ? Math.floor(Date.now() / 1000) - 60 : null,
      oldest_due_created_at: active > 0 ? Math.floor(Date.now() / 1000) - 60 : null,
    },
    rows: [],
  };
}

describe("handleAdminTelegramBroadcast", () => {
  it("rejects requests without admin auth", async () => {
    const db = mockD1();
    const res = await handleAdminTelegramBroadcast({
      db,
      request: adminRequest({ messageHtml: "<b>x</b>", scope: "all", dryRun: true }),
      trustedAdmin: false,
    });
    expect(res.status).toBe(401);
  });

  it("rejects invalid JSON bodies with 400", async () => {
    const db = mockD1();
    const res = await handleAdminTelegramBroadcast({
      db,
      request: adminRequest("not-json"),
      trustedAdmin: true,
    });
    expect(res.status).toBe(400);
  });

  it("rejects empty messageHtml with 400", async () => {
    const db = mockD1();
    const res = await handleAdminTelegramBroadcast({
      db,
      request: adminRequest({ messageHtml: "  ", scope: "all", dryRun: true }),
      trustedAdmin: true,
    });
    expect(res.status).toBe(400);
  });

  it("rejects messageHtml over the admin broadcast cap with 400", async () => {
    const db = mockD1();
    const res = await handleAdminTelegramBroadcast({
      db,
      request: adminRequest({ messageHtml: "x".repeat(16_001), scope: "all", dryRun: true }),
      trustedAdmin: true,
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "messageHtml must be 16,000 characters or fewer" });
  });

  it("rejects unknown scope with 400", async () => {
    const db = mockD1();
    const res = await handleAdminTelegramBroadcast({
      db,
      request: adminRequest({ messageHtml: "<b>x</b>", scope: "everyone", dryRun: true }),
      trustedAdmin: true,
    });
    expect(res.status).toBe(400);
  });

  it("rejects unsupported Telegram HTML before dry-run targeting", async () => {
    const db = mockD1([auditRow()]);
    const res = await handleAdminTelegramBroadcast({
      db,
      request: adminRequest({ messageHtml: "<div>bad</div>", scope: "all", dryRun: true }),
      trustedAdmin: true,
    });
    expect(res.status).toBe(422);
    expect(await res.json()).toEqual({
      error: "Unsupported Telegram HTML tag <div>",
      position: 0,
    });
    expect(db.getHistory().some((entry) => entry.sql.includes("FROM telegram_subscribers"))).toBe(false);
    const audit = db.getHistory().find((entry) => entry.sql.includes("INSERT INTO admin_action_audit"));
    expect(audit?.binds).toContain("error");
    expect(audit?.binds).toContain(422);
  });

  it("rejects unbalanced Telegram HTML entities", async () => {
    const db = mockD1([auditRow()]);
    const res = await handleAdminTelegramBroadcast({
      db,
      request: adminRequest({ messageHtml: "<b>bad &copy;</b>", scope: "all", dryRun: true }),
      trustedAdmin: true,
    });
    expect(res.status).toBe(422);
    expect(await res.json()).toMatchObject({
      error: "Malformed or unsupported HTML entity",
      position: 7,
    });
  });

  it("rejects non-boolean dryRun with 400", async () => {
    const db = mockD1();
    const res = await handleAdminTelegramBroadcast({
      db,
      request: adminRequest({ messageHtml: "<b>x</b>", scope: "all", dryRun: "yes" }),
      trustedAdmin: true,
    });
    expect(res.status).toBe(400);
  });

  it("rejects non-boolean acknowledgeBacklogRisk with 400", async () => {
    const db = mockD1();
    const res = await handleAdminTelegramBroadcast({
      db,
      request: adminRequest({
        messageHtml: "<b>x</b>",
        scope: "all",
        dryRun: false,
        acknowledgeBacklogRisk: "yes",
      }),
      trustedAdmin: true,
    });
    expect(res.status).toBe(400);
  });

  it("dry-run returns target count and a sample without enqueuing and audits the preview", async () => {
    const chatIds = ["1", "2", "3", "4", "5", "6", "7"];
    const db = mockD1([allSubscriberRows(chatIds), pendingCapacityRow(0), auditRow()]);
    const res = await handleAdminTelegramBroadcast({
      db,
      request: adminRequest({ messageHtml: "<b>x</b>", scope: "all", dryRun: true }),
      trustedAdmin: true,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      targetChatCount: number;
      chunkCount: number;
      targetMessageCount: number;
      deliveryEstimate: { projectedPendingMessages: number; estimatedDrainTimeSec: number; fitsWithinMinutes: Record<string, boolean> };
      sample: string[];
    };
    expect(body.targetChatCount).toBe(7);
    expect(body.chunkCount).toBe(1);
    expect(body.targetMessageCount).toBe(7);
    expect(body.deliveryEstimate.projectedPendingMessages).toBe(7);
    expect(body.deliveryEstimate.estimatedDrainTimeSec).toBe(300);
    expect(body.deliveryEstimate.fitsWithinMinutes["15"]).toBe(true);
    expect(body.sample).toEqual(["1", "2", "3", "4", "5"]);

    const history = db.getHistory();
    expect(history.some((entry) => entry.sql.includes("INSERT INTO telegram_pending_alerts"))).toBe(false);
    const audit = history.find((entry) => entry.sql.includes("INSERT INTO admin_action_audit"));
    expect(audit).toBeDefined();
    expect(audit?.binds).toContain("admin-telegram-broadcast");
    expect(audit?.binds).toContain("all");
    expect(audit?.binds).toContain("ok");
    expect(audit?.binds).toContain(200);
    const details = JSON.parse(String(audit?.binds[6] ?? "{}")) as { dryRun?: boolean; targetChatCount?: number };
    expect(details.dryRun).toBe(true);
    expect(details.targetChatCount).toBe(7);
  });

  it("dry-run with global-subscribers scope filters by global_alert_* flags", async () => {
    const db = mockD1([globalSubscriberRows(["100", "200"])]);
    const res = await handleAdminTelegramBroadcast({
      db,
      request: adminRequest({ messageHtml: "<b>x</b>", scope: "global-subscribers", dryRun: true }),
      trustedAdmin: true,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { targetChatCount: number; sample: string[] };
    expect(body.targetChatCount).toBe(2);
    expect(body.sample).toEqual(["100", "200"]);

    const history = db.getHistory();
    const select = history.find((entry) => entry.sql.includes("FROM telegram_subscribers"));
    expect(select?.sql).toContain("global_alert_dews = 1");
  });

  it("dry-run with deliverable-watchers scope includes active direct, preset, and global follows", async () => {
    const db = mockD1([deliverableWatcherRows(["100", "200"])]);
    const res = await handleAdminTelegramBroadcast({
      db,
      request: adminRequest({ messageHtml: "<b>x</b>", scope: "deliverable-watchers", dryRun: true }),
      trustedAdmin: true,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { targetChatCount: number; sample: string[] };
    expect(body.targetChatCount).toBe(2);
    expect(body.sample).toEqual(["100", "200"]);

    const select = db.getHistory().find((entry) => entry.sql.includes("FROM telegram_subscribers"));
    expect(select?.sql).toContain("FROM telegram_subscriptions ts");
    expect(select?.sql).toContain("FROM telegram_preset_subscriptions ps");
  });

  it("deliverable-watchers scope query runs against the real telegram_preset_subscriptions schema", async () => {
    const { DatabaseSync } = await import("node:sqlite");
    const sqlite = new DatabaseSync(":memory:");
    try {
      // Mirrors migrations 0000_baseline.sql (telegram_subscribers + telegram_subscriptions),
      // 0072_telegram_launch_alerts.sql (adds alert_launch / global_alert_launch to those two
      // tables only), and 0114_telegram_dynamic_presets.sql (telegram_preset_subscriptions has
      // NO alert_launch column — that is the bug guarded here).
      sqlite.exec(`
        CREATE TABLE telegram_subscribers (
          chat_id TEXT PRIMARY KEY,
          alert_dews INTEGER NOT NULL DEFAULT 0,
          alert_depeg INTEGER NOT NULL DEFAULT 0,
          alert_safety INTEGER NOT NULL DEFAULT 0,
          alert_launch INTEGER NOT NULL DEFAULT 0,
          alert_reserve INTEGER NOT NULL DEFAULT 0,
          global_alert_dews INTEGER NOT NULL DEFAULT 0,
          global_alert_depeg INTEGER NOT NULL DEFAULT 0,
          global_alert_safety INTEGER NOT NULL DEFAULT 0,
          global_alert_launch INTEGER NOT NULL DEFAULT 0,
          global_alert_reserve INTEGER NOT NULL DEFAULT 0
        );
        CREATE TABLE telegram_subscriptions (
          chat_id TEXT NOT NULL,
          stablecoin_id TEXT NOT NULL,
          alert_dews INTEGER NOT NULL DEFAULT 0,
          alert_depeg INTEGER NOT NULL DEFAULT 0,
          alert_safety INTEGER NOT NULL DEFAULT 0,
          alert_launch INTEGER NOT NULL DEFAULT 0,
          alert_reserve INTEGER NOT NULL DEFAULT 0,
          PRIMARY KEY (chat_id, stablecoin_id)
        );
        CREATE TABLE telegram_preset_subscriptions (
          chat_id TEXT NOT NULL,
          preset_id TEXT NOT NULL,
          alert_dews INTEGER NOT NULL DEFAULT 0,
          alert_depeg INTEGER NOT NULL DEFAULT 0,
          alert_safety INTEGER NOT NULL DEFAULT 0,
          PRIMARY KEY (chat_id, preset_id)
        );
        CREATE TABLE telegram_pending_alerts (
          chat_id TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          expires_at INTEGER,
          not_before_at INTEGER
        );
      `);
      sqlite.prepare(
        `INSERT INTO telegram_subscribers (chat_id, global_alert_dews) VALUES (?, 1)`,
      ).run("global-1");
      sqlite.prepare(
        `INSERT INTO telegram_subscribers (chat_id) VALUES (?)`,
      ).run("preset-only-1");
      sqlite.prepare(
        `INSERT INTO telegram_preset_subscriptions (chat_id, preset_id, alert_dews) VALUES (?, ?, 1)`,
      ).run("preset-only-1", "usd-top25");

      const res = await handleAdminTelegramBroadcast({
        db: createSqliteD1(sqlite),
        request: adminRequest({ messageHtml: "<b>x</b>", scope: "deliverable-watchers", dryRun: true }),
        trustedAdmin: true,
      });

      // Without the fix this returns 500 because the preset-subscription EXISTS clause
      // references `ps.alert_launch`, which does not exist on telegram_preset_subscriptions.
      expect(res.status).toBe(200);
      const body = (await res.json()) as { targetChatCount: number; sample: string[] };
      expect(body.targetChatCount).toBe(2);
      expect(body.sample).toEqual(["global-1", "preset-only-1"]);
    } finally {
      sqlite.close();
    }
  });

  it("live mode enqueues one pending row per chat and audits the action", async () => {
    const chatIds = ["10", "20", "30"];
    const db = mockD1([allSubscriberRows(chatIds), pendingCapacityRow(0), pendingInsertRow(), auditRow()]);
    const res = await handleAdminTelegramBroadcast({
      db,
      request: adminRequest({
        messageHtml: "<b>Pharos maintenance</b>\nOffline 10:00-10:15 UTC.",
        scope: "all",
        dryRun: false,
      }),
      trustedAdmin: true,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { enqueued: number };
    expect(body.enqueued).toBe(3);

    const history = db.getHistory();
    const inserts = history.filter((entry) => entry.sql.includes("INSERT INTO telegram_pending_alerts"));
    expect(inserts).toHaveLength(3);
    expect(inserts.map((entry) => entry.binds[0])).toEqual(["10", "20", "30"]);
    expect(inserts.every((entry) => entry.binds.includes("admin_broadcast"))).toBe(true);

    const audit = history.find((entry) => entry.sql.includes("INSERT INTO admin_action_audit"));
    expect(audit).toBeDefined();
    expect(audit?.binds).toContain("admin-telegram-broadcast");
    expect(audit?.binds).toContain("all");
  });

  it("blocks live broadcasts projected to outlive the admin broadcast TTL without acknowledgement", async () => {
    const db = mockD1([allSubscriberRows(["10"]), pendingCapacityRow(6_000), auditRow()]);
    const res = await handleAdminTelegramBroadcast({
      db,
      request: adminRequest({
        messageHtml: "<b>Pharos maintenance</b>",
        scope: "all",
        dryRun: false,
      }),
      trustedAdmin: true,
    });
    expect(res.status).toBe(409);
    const body = (await res.json()) as {
      deliveryEstimate: { requiresAcknowledgement: boolean; adminBroadcastTtlSec: number };
    };
    expect(body.deliveryEstimate.requiresAcknowledgement).toBe(true);
    expect(body.deliveryEstimate.adminBroadcastTtlSec).toBe(30 * 60);

    const history = db.getHistory();
    expect(history.some((entry) => entry.sql.includes("INSERT INTO telegram_pending_alerts"))).toBe(false);
    const audit = history.find((entry) => entry.sql.includes("INSERT INTO admin_action_audit"));
    expect(audit).toBeDefined();
    expect(audit?.binds).toContain("error");
    expect(audit?.binds).toContain(409);
    const details = JSON.parse(String(audit?.binds[6] ?? "{}")) as { rejectedReason?: string };
    expect(details.rejectedReason).toBe("backlog-risk");
  });

  it("allows acknowledged live broadcasts with backlog risk and records short admin TTL", async () => {
    const db = mockD1([allSubscriberRows(["10"]), pendingCapacityRow(6_000), pendingInsertRow(), auditRow()]);
    const res = await handleAdminTelegramBroadcast({
      db,
      request: adminRequest({
        messageHtml: "<b>Pharos maintenance</b>",
        scope: "all",
        dryRun: false,
        acknowledgeBacklogRisk: true,
      }),
      trustedAdmin: true,
    });
    expect(res.status).toBe(200);

    const insert = db.getHistory().find((entry) => entry.sql.includes("INSERT INTO telegram_pending_alerts"));
    expect(insert?.binds).toContain("admin_broadcast");
    expect(insert?.binds).toContain(90);
    expect(Number(insert?.binds[13]) - Number(insert?.binds[3])).toBe(30 * 60);
  });

  it("live mode with global-subscribers scope only enqueues filtered chats", async () => {
    const db = mockD1([globalSubscriberRows(["77"]), pendingCapacityRow(0), pendingInsertRow(), auditRow()]);
    const res = await handleAdminTelegramBroadcast({
      db,
      request: adminRequest({
        messageHtml: "<b>maint</b>",
        scope: "global-subscribers",
        dryRun: false,
      }),
      trustedAdmin: true,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { enqueued: number };
    expect(body.enqueued).toBe(1);

    const history = db.getHistory();
    const inserts = history.filter((entry) => entry.sql.includes("INSERT INTO telegram_pending_alerts"));
    expect(inserts).toHaveLength(1);
    expect(inserts[0]?.binds[0]).toBe("77");

    const audit = history.find((entry) => entry.sql.includes("INSERT INTO admin_action_audit"));
    expect(audit?.binds).toContain("global-subscribers");
  });

  it("live mode with no target chats returns enqueued: 0 and still audits", async () => {
    const db = mockD1([allSubscriberRows([]), pendingCapacityRow(0), auditRow()]);
    const res = await handleAdminTelegramBroadcast({
      db,
      request: adminRequest({ messageHtml: "<b>x</b>", scope: "all", dryRun: false }),
      trustedAdmin: true,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { enqueued: number };
    expect(body.enqueued).toBe(0);

    const history = db.getHistory();
    expect(history.some((entry) => entry.sql.includes("INSERT INTO telegram_pending_alerts"))).toBe(false);
    expect(history.some((entry) => entry.sql.includes("INSERT INTO admin_action_audit"))).toBe(true);
  });
});
