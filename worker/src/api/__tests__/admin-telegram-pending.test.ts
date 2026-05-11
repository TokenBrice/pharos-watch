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
  it("deletes pending rows for a specific chat_id", async () => {
    const db = mockD1([
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
    const del = history.find((entry) => entry.sql.includes("DELETE FROM telegram_pending_alerts"));
    expect(del?.binds).toEqual(["42"]);
    const audit = history.find((entry) => entry.sql.includes("INSERT INTO admin_action_audit"));
    expect(audit).toBeDefined();
  });

  it("deletes pending rows older than the supplied window", async () => {
    const db = mockD1([
      { match: "DELETE FROM telegram_pending_alerts", rows: [], runMeta: { changes: 7 } },
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
    expect(body.deleted).toBe(7);

    const history = db.getHistory();
    const del = history.find((entry) => entry.sql.includes("DELETE FROM telegram_pending_alerts"));
    expect(del?.sql).toContain("created_at < ?");
    const cutoff = del?.binds?.[0] as number;
    const nowSec = Math.floor(Date.now() / 1000);
    expect(typeof cutoff).toBe("number");
    expect(cutoff).toBeGreaterThanOrEqual(nowSec - 600 - 5);
    expect(cutoff).toBeLessThanOrEqual(nowSec - 600 + 5);
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
