import { describe, expect, it } from "vitest";
import { handleAdminTelegramBroadcast } from "../admin-telegram-broadcast";
import { mockD1 } from "./helpers/mock-d1";

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

  it("rejects unknown scope with 400", async () => {
    const db = mockD1();
    const res = await handleAdminTelegramBroadcast({
      db,
      request: adminRequest({ messageHtml: "<b>x</b>", scope: "everyone", dryRun: true }),
      trustedAdmin: true,
    });
    expect(res.status).toBe(400);
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

  it("dry-run returns target count and a sample without enqueuing or auditing", async () => {
    const chatIds = ["1", "2", "3", "4", "5", "6", "7"];
    const db = mockD1([allSubscriberRows(chatIds)]);
    const res = await handleAdminTelegramBroadcast({
      db,
      request: adminRequest({ messageHtml: "<b>x</b>", scope: "all", dryRun: true }),
      trustedAdmin: true,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { targetChatCount: number; sample: string[] };
    expect(body.targetChatCount).toBe(7);
    expect(body.sample).toEqual(["1", "2", "3", "4", "5"]);

    const history = db.getHistory();
    expect(history.some((entry) => entry.sql.includes("INSERT INTO telegram_pending_alerts"))).toBe(false);
    expect(history.some((entry) => entry.sql.includes("INSERT INTO admin_action_audit"))).toBe(false);
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

  it("live mode enqueues one pending row per chat and audits the action", async () => {
    const chatIds = ["10", "20", "30"];
    const db = mockD1([allSubscriberRows(chatIds), pendingInsertRow(), auditRow()]);
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

    const audit = history.find((entry) => entry.sql.includes("INSERT INTO admin_action_audit"));
    expect(audit).toBeDefined();
    expect(audit?.binds).toContain("admin-telegram-broadcast");
    expect(audit?.binds).toContain("all");
  });

  it("live mode with global-subscribers scope only enqueues filtered chats", async () => {
    const db = mockD1([globalSubscriberRows(["77"]), pendingInsertRow(), auditRow()]);
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
    const db = mockD1([allSubscriberRows([]), auditRow()]);
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
