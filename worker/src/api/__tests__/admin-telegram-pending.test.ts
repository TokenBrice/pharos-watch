import { describe, expect, it } from "vitest";
import { handleClearTelegramPending } from "../admin-telegram-pending";
import { mockD1 } from "./helpers/mock-d1";

// Tests intentionally omit Idempotency-Key so the handler bypasses the
// idempotency layer (which requires admin_idempotency_keys rows in the mock).
// Handler behavior — validation, SQL, response shape — is unaffected by that path.
function adminRequest(url: string): Request {
  const headers = new Headers();
  headers.set("X-Pharos-Admin", "1");
  return new Request(url, { method: "POST", headers });
}

describe("handleClearTelegramPending", () => {
  it("dead-letters and deletes pending rows for a specific chat_id", async () => {
    const rows = [1, 2, 3].map((id) => ({
      id,
      chat_id: "42",
      message_html: `<b>Alert ${id}</b>`,
      created_at: 1_700_000_000,
      attempts: id,
      last_error_class: null,
      dedupe_key: `target-${id}`,
      chunk_index: id - 1,
      priority: 10,
      source_type: "risk_alert",
      alert_type: "depeg",
    }));
    const db = mockD1([
      { match: "SELECT id, chat_id, message_html", rows },
      { match: "INSERT INTO telegram_alert_dead_letters", rows: [] },
      { match: "UPDATE telegram_alert_job_targets", rows: [] },
      { match: "DELETE FROM telegram_pending_alerts", rows: [], runMeta: { changes: 3 } },
      { match: "INSERT INTO admin_action_audit", rows: [], runMeta: { changes: 1 } },
    ]);
    const url = new URL("https://ops-api.pharos.watch/api/telegram-pending?chat_id=42");
    const res = await handleClearTelegramPending({
      db,
      url,
      request: adminRequest(url.toString()),
      trustedAdmin: true,
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    const body = (await res.json()) as { ok: boolean; deleted: number };
    expect(body.ok).toBe(true);
    expect(body.deleted).toBe(3);

    const history = db.getHistory();
    const select = history.find((entry) => entry.sql.includes("FROM telegram_pending_alerts"));
    expect(select?.binds).toEqual(["42", 90]);
    const deadLetters = history.filter((entry) =>
      entry.sql.includes("INSERT INTO telegram_alert_dead_letters")
    );
    expect(deadLetters).toHaveLength(3);
    expect(deadLetters[0]?.binds).toContain("manual_clear");
    const targetUpdates = history.filter((entry) =>
      entry.sql.includes("UPDATE telegram_alert_job_targets")
    );
    expect(targetUpdates).toHaveLength(3);
    expect(targetUpdates[0]?.binds).toEqual(["failed", null, null, expect.any(Number), "manual_clear", "target-1"]);
    const del = history.find((entry) => entry.sql.includes("DELETE FROM telegram_pending_alerts"));
    expect(del?.binds).toEqual([1, 2, 3]);
    const audit = history.find((entry) => entry.sql.includes("INSERT INTO admin_action_audit"));
    expect(audit).toBeDefined();
  });

  it("previews a specific chat_id clear without mutating when dry_run is set", async () => {
    const db = mockD1([
      { match: "SELECT COUNT(*) AS count FROM telegram_pending_alerts WHERE chat_id = ?", rows: [{ count: 3 }] },
      { match: "INSERT INTO admin_action_audit", rows: [], runMeta: { changes: 1 } },
    ]);
    const url = new URL("https://ops-api.pharos.watch/api/telegram-pending?chat_id=42&dry_run=1");
    const res = await handleClearTelegramPending({
      db,
      url,
      request: adminRequest(url.toString()),
      trustedAdmin: true,
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; dryRun: boolean; matched: number };
    expect(body).toEqual({ ok: true, dryRun: true, matched: 3 });
    const history = db.getHistory();
    expect(history.some((entry) => entry.sql.includes("DELETE FROM telegram_pending_alerts"))).toBe(false);
    expect(history.some((entry) => entry.sql.includes("INSERT INTO telegram_alert_dead_letters"))).toBe(false);
    const audit = history.find((entry) => entry.sql.includes("INSERT INTO admin_action_audit"));
    expect(audit).toBeDefined();
    const details = JSON.parse(audit?.binds[6] as string) as Record<string, unknown>;
    expect(details).toMatchObject({ chatId: "42", dryRun: true, matched: 3 });
  });

  it("dead-letters and deletes pending rows older than the supplied window", async () => {
    const rows = [
      {
        id: 9,
        chat_id: "older-chat",
        message_html: "<b>Old alert</b>",
        created_at: 1_700_000_000,
        attempts: 0,
        last_error_class: null,
        dedupe_key: null,
        chunk_index: 0,
        priority: 50,
        source_type: "legacy",
        alert_type: null,
      },
    ];
    const db = mockD1([
      { match: "SELECT id, chat_id, message_html", rows },
      { match: "INSERT INTO telegram_alert_dead_letters", rows: [] },
      { match: "DELETE FROM telegram_pending_alerts", rows: [], runMeta: { changes: 1 } },
      { match: "INSERT INTO admin_action_audit", rows: [], runMeta: { changes: 1 } },
    ]);
    const url = new URL("https://ops-api.pharos.watch/api/telegram-pending?older_than_sec=600");
    const res = await handleClearTelegramPending({
      db,
      url,
      request: adminRequest(url.toString()),
      trustedAdmin: true,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; deleted: number };
    expect(body.deleted).toBe(1);

    const history = db.getHistory();
    const select = history.find((entry) => entry.sql.includes("FROM telegram_pending_alerts"));
    expect(select?.sql).toContain("created_at < ?");
    const cutoff = select?.binds?.[0] as number;
    const nowSec = Math.floor(Date.now() / 1000);
    expect(typeof cutoff).toBe("number");
    expect(cutoff).toBeGreaterThanOrEqual(nowSec - 600 - 5);
    expect(cutoff).toBeLessThanOrEqual(nowSec - 600 + 5);
    const del = history.find((entry) => entry.sql.includes("DELETE FROM telegram_pending_alerts"));
    expect(del?.binds).toEqual([9]);
  });

  it("previews an older_than_sec clear without mutating when dryRun is set", async () => {
    const db = mockD1([
      { match: "SELECT COUNT(*) AS count FROM telegram_pending_alerts WHERE created_at < ?", rows: [{ count: "4" }] },
      { match: "INSERT INTO admin_action_audit", rows: [], runMeta: { changes: 1 } },
    ]);
    const url = new URL("https://ops-api.pharos.watch/api/telegram-pending?older_than_sec=600&dryRun=true");
    const res = await handleClearTelegramPending({
      db,
      url,
      request: adminRequest(url.toString()),
      trustedAdmin: true,
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; dryRun: boolean; matched: number };
    expect(body).toEqual({ ok: true, dryRun: true, matched: 4 });
    const history = db.getHistory();
    const count = history.find((entry) => entry.sql.includes("SELECT COUNT(*) AS count"));
    expect(count?.sql).toContain("created_at < ?");
    expect(history.some((entry) => entry.sql.includes("DELETE FROM telegram_pending_alerts"))).toBe(false);
  });

  it("fails closed when pending rows cannot be dead-lettered before manual clear", async () => {
    const db = mockD1([
      {
        match: "SELECT id, chat_id, message_html",
        rows: [
          {
            id: 1,
            chat_id: "42",
            message_html: "<b>Alert</b>",
            created_at: 1_700_000_000,
            attempts: 0,
            last_error_class: null,
            dedupe_key: null,
            chunk_index: 0,
            priority: 10,
            source_type: "risk_alert",
            alert_type: "depeg",
          },
        ],
      },
      { match: "INSERT INTO telegram_alert_dead_letters", rows: [], throwError: new Error("D1 write failed") },
    ]);
    const url = new URL("https://ops-api.pharos.watch/api/telegram-pending?chat_id=42");
    const res = await handleClearTelegramPending({
      db,
      url,
      request: adminRequest(url.toString()),
      trustedAdmin: true,
    });
    expect(res.status).toBe(500);

    const history = db.getHistory();
    expect(history.some((entry) => entry.sql.includes("DELETE FROM telegram_pending_alerts"))).toBe(false);
  });

  it("rejects unfiltered requests with 400", async () => {
    const db = mockD1();
    const url = new URL("https://ops-api.pharos.watch/api/telegram-pending");
    const res = await handleClearTelegramPending({
      db,
      url,
      request: adminRequest(url.toString()),
      trustedAdmin: true,
    });
    expect(res.status).toBe(400);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
  });

  it("rejects requests that pass both filters with 400", async () => {
    const db = mockD1();
    const url = new URL(
      "https://ops-api.pharos.watch/api/telegram-pending?chat_id=42&older_than_sec=600",
    );
    const res = await handleClearTelegramPending({
      db,
      url,
      request: adminRequest(url.toString()),
      trustedAdmin: true,
    });
    expect(res.status).toBe(400);
  });

  it("rejects malformed older_than_sec values with 400", async () => {
    const db = mockD1();
    const url = new URL("https://ops-api.pharos.watch/api/telegram-pending?older_than_sec=abc");
    const res = await handleClearTelegramPending({
      db,
      url,
      request: adminRequest(url.toString()),
      trustedAdmin: true,
    });
    expect(res.status).toBe(400);
  });

  it("rejects non-positive older_than_sec values with 400", async () => {
    const db = mockD1();
    const url = new URL("https://ops-api.pharos.watch/api/telegram-pending?older_than_sec=0");
    const res = await handleClearTelegramPending({
      db,
      url,
      request: adminRequest(url.toString()),
      trustedAdmin: true,
    });
    expect(res.status).toBe(400);
  });
});
