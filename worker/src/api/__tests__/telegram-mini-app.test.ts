import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mockD1 } from "./helpers/mock-d1";

const { handleTelegramMiniAppMutation, handleTelegramMiniAppSession } = await import("../telegram-mini-app");

const BOT_TOKEN = "123456:test-token";
const NOW_SEC = 1_800_000_000;
const encoder = new TextEncoder();

async function hmacSha256(keyBytes: Uint8Array, value: string): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey("raw", keyBytes, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(value)));
}

function hex(bytes: Uint8Array): string {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function signedInitData(fields: Record<string, string>): Promise<string> {
  const params = new URLSearchParams(fields);
  const check = [...params.entries()].map(([key, value]) => `${key}=${value}`).sort().join("\n");
  const secret = await hmacSha256(encoder.encode("WebAppData"), BOT_TOKEN);
  params.set("hash", hex(await hmacSha256(secret, check)));
  return params.toString();
}

function request(path: string, body: unknown): Request {
  return new Request(`https://api.pharos.watch${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW_SEC * 1000);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("handleTelegramMiniAppSession", () => {
  it("returns private-chat state", async () => {
    const initData = await signedInitData({
      auth_date: String(NOW_SEC - 60),
      chat_type: "private",
      user: JSON.stringify({ id: 42, username: "alice" }),
    });
    const db = mockD1([
      { match: "FROM telegram_subscribers", first: { global_alert_dews: 1, global_alert_depeg: 0, global_alert_safety: 0, global_alert_launch: 0, global_depeg_worsening_bps_step: 250, quiet_hours_enabled: 0, quiet_hours_start_utc: null, quiet_hours_end_utc: null, timezone: null, alert_snooze_until_ts: null }, rows: [] },
      { match: "FROM telegram_subscriptions", rows: [{ stablecoin_id: "usdc-circle", alert_dews: 1, alert_depeg: 1, alert_safety: 0, alert_launch: 0, dews_min_band: "ALERT", safety_mode: null, depeg_worsening_bps_step: 250, alert_snooze_until_ts: null }] },
      { match: "FROM telegram_preset_subscriptions", rows: [] },
      { match: "FROM telegram_chat_delivery_diagnostics", first: null, rows: [] },
      { match: "FROM telegram_pending_alerts", first: { queued_alerts: 0 }, rows: [] },
    ]);

    const response = await handleTelegramMiniAppSession(db, request("/api/telegram-mini-app/session", { initData }), BOT_TOKEN);
    const body = await response.json() as { viewer: { canMutate: boolean }; subscriptions: Array<{ stablecoinId: string; symbol: string }> };

    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(body.viewer.canMutate).toBe(true);
    expect(body.subscriptions[0]).toMatchObject({ stablecoinId: "usdc-circle", symbol: "USDC" });
  });

  it("marks group launches read-only", async () => {
    const initData = await signedInitData({
      auth_date: String(NOW_SEC - 60),
      chat_type: "supergroup",
      user: JSON.stringify({ id: 42, username: "alice" }),
    });
    const db = mockD1();

    const response = await handleTelegramMiniAppSession(db, request("/api/telegram-mini-app/session", { initData }), BOT_TOKEN);
    const body = await response.json() as { viewer: { canMutate: boolean; mutationBlockReason: string } };

    expect(response.status).toBe(200);
    expect(body.viewer.canMutate).toBe(false);
    expect(body.viewer.mutationBlockReason).toBe("not-private");
  });
});

describe("handleTelegramMiniAppMutation", () => {
  it("applies global alert mutations", async () => {
    const initData = await signedInitData({
      auth_date: String(NOW_SEC - 60),
      chat_type: "private",
      user: JSON.stringify({ id: 42, username: "alice" }),
    });
    const db = mockD1([
      { match: "FROM telegram_subscribers", first: { global_alert_dews: 0, global_alert_depeg: 0, global_alert_safety: 1, global_alert_launch: 0, global_depeg_worsening_bps_step: null, quiet_hours_enabled: 0, quiet_hours_start_utc: null, quiet_hours_end_utc: null, timezone: null, alert_snooze_until_ts: null }, rows: [] },
      { match: "FROM telegram_subscriptions", rows: [] },
      { match: "FROM telegram_preset_subscriptions", rows: [] },
      { match: "FROM telegram_chat_delivery_diagnostics", first: null, rows: [] },
      { match: "FROM telegram_pending_alerts", first: { queued_alerts: 0 }, rows: [] },
    ]);

    const response = await handleTelegramMiniAppMutation(db, request("/api/telegram-mini-app/mutate", {
      initData,
      operation: { kind: "set-global", alertType: "safety", enabled: true },
    }), BOT_TOKEN);

    expect(response.status).toBe(200);
    expect(db.getHistory().some((entry) => entry.sql.includes("global_alert_safety = excluded.global_alert_safety"))).toBe(true);
  });

  it("denies group mutations", async () => {
    const initData = await signedInitData({
      auth_date: String(NOW_SEC - 60),
      chat_type: "group",
      user: JSON.stringify({ id: 42 }),
    });
    const response = await handleTelegramMiniAppMutation(mockD1(), request("/api/telegram-mini-app/mutate", {
      initData,
      operation: { kind: "set-global", alertType: "dews", enabled: true },
    }), BOT_TOKEN);
    expect(response.status).toBe(403);
  });

  it("rejects stale mutation auth", async () => {
    const initData = await signedInitData({
      auth_date: String(NOW_SEC - 901),
      chat_type: "private",
      user: JSON.stringify({ id: 42 }),
    });
    const response = await handleTelegramMiniAppMutation(mockD1(), request("/api/telegram-mini-app/mutate", {
      initData,
      operation: { kind: "clear-snooze" },
    }), BOT_TOKEN);
    expect(response.status).toBe(401);
  });
});
