import { describe, expect, it } from "vitest";
import { handleAdminTelegramChat } from "../admin-telegram-chat";
import { mockD1 } from "../../test-helpers/__shared/mock-d1";

interface SubscriberBody {
  chatId: string;
  username: string | null;
  createdAt: number;
  lastActiveAt: number;
  globalAlerts: {
    dews: number;
    depeg: number;
    safety: number;
    launch: number;
    depegWorseningBpsStep: number | null;
  };
  perCoinAlertFlags: { dews: number; depeg: number; safety: number; launch: number };
  quietHours: { enabled: boolean; startHourUtc: number | null; endHourUtc: number | null };
  snooze: { active: boolean; untilTs: number | null };
}

interface ResponseBody {
  chatId: string;
  subscriber: SubscriberBody;
  subscriptions: Array<Record<string, unknown>>;
  presets: Array<Record<string, unknown>>;
  pendingDisambiguation: Record<string, unknown> | null;
  pendingAlerts: {
    count: number;
    oldestCreatedAt: number | null;
    newestCreatedAt: number | null;
    earliestNotBeforeAt: number | null;
    recentRetryErrorClass: string | null;
  };
}

function buildRequest(): Request {
  return new Request("https://ops-api.pharos.watch/api/admin-telegram-chat/12345", {
    method: "GET",
  });
}

describe("handleAdminTelegramChat", () => {
  it("requires admin auth", async () => {
    const db = mockD1();
    const res = await handleAdminTelegramChat(db, "12345", false, buildRequest());
    expect(res.status).toBe(401);
  });

  it("returns 404 when no subscriber row exists", async () => {
    const db = mockD1([
      { match: "FROM telegram_subscribers", rows: [] },
    ]);
    const res = await handleAdminTelegramChat(db, "12345", true, buildRequest());
    expect(res.status).toBe(404);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    const body = (await res.json()) as { error: string; chatId: string };
    expect(body).toEqual({ error: "Not found", chatId: "12345" });
    const audit = db.getHistory().find((entry) => entry.sql.includes("INSERT INTO admin_action_audit"));
    expect(audit?.binds).toEqual([
      expect.any(Number),
      "internal",
      "inspect-telegram-chat",
      "12345",
      "error",
      404,
      JSON.stringify({ found: false }),
    ]);
  });

  it("returns full chat state payload for a known chat", async () => {
    const subscriberRow = {
      chat_id: "12345",
      username: "alice",
      alert_dews: 1,
      alert_depeg: 0,
      alert_safety: 1,
      alert_launch: 0,
      global_alert_dews: 1,
      global_alert_depeg: 0,
      global_alert_safety: 0,
      global_alert_launch: 1,
      global_depeg_worsening_bps_step: 250,
      quiet_hours_enabled: 1,
      quiet_hours_start_utc: 22,
      quiet_hours_end_utc: 7,
      alert_snooze_until_ts: Math.floor(Date.now() / 1000) + 600,
      created_at: 1700000000,
      last_active_at: 1700001000,
    };

    const db = mockD1([
      { match: "FROM telegram_subscribers", rows: [subscriberRow] },
      {
        match: "FROM telegram_subscriptions",
        rows: [
          {
            stablecoin_id: "usdc-circle",
            alert_dews: 1,
            alert_depeg: 1,
            alert_safety: 0,
            alert_launch: 0,
            dews_min_band: "WARNING",
            safety_mode: null,
            depeg_worsening_bps_step: 250,
          },
        ],
      },
      {
        match: "FROM telegram_preset_subscriptions",
        rows: [
          {
            preset_id: "usd-top25",
            alert_dews: 1,
            alert_depeg: 1,
            alert_safety: 0,
            depeg_worsening_bps_step: null,
            created_at: 1700000500,
            updated_at: 1700000500,
          },
        ],
      },
      {
        match: "FROM telegram_pending_disambiguation",
        rows: [
          {
            alert_types: "dews",
            resolved_ids: "[]",
            ambiguous_ticker: "USD",
            candidates: "[]",
            remaining_tickers: "[]",
            expires_at: 1700002000,
            action_type: "subscribe",
            action_payload: "{}",
            initiator_user_id: "user-1",
          },
        ],
      },
      {
        match: "SELECT COUNT(*) AS count",
        rows: [
          {
            count: 3,
            oldest_created_at: 1700000100,
            newest_created_at: 1700000800,
            earliest_not_before_at: 1700000900,
          },
        ],
      },
      {
        match: "WHERE chat_id = ? AND last_error_class IS NOT NULL",
        rows: [{ last_error_class: "telegram-429" }],
      },
    ]);

    const res = await handleAdminTelegramChat(db, "12345", true, buildRequest());
    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe("no-store");

    const body = (await res.json()) as ResponseBody;
    expect(body.chatId).toBe("12345");
    expect(body.subscriber.username).toBe("alice");
    expect(body.subscriber.globalAlerts).toEqual({
      dews: 1,
      depeg: 0,
      safety: 0,
      launch: 1,
      depegWorseningBpsStep: 250,
    });
    expect(body.subscriber.quietHours).toEqual({
      enabled: true,
      startHourUtc: 22,
      endHourUtc: 7,
    });
    expect(body.subscriber.snooze.active).toBe(true);
    expect(typeof body.subscriber.snooze.untilTs).toBe("number");
    expect(body.subscriptions).toHaveLength(1);
    expect(body.subscriptions[0]).toMatchObject({ stablecoin_id: "usdc-circle", dews_min_band: "WARNING" });
    expect(body.presets).toHaveLength(1);
    expect(body.presets[0]).toMatchObject({ preset_id: "usd-top25" });
    expect(body.pendingDisambiguation).toMatchObject({
      ambiguousTicker: "USD",
      actionType: "subscribe",
      initiatorUserId: "user-1",
    });
    expect(body.pendingAlerts).toEqual({
      count: 3,
      oldestCreatedAt: 1700000100,
      newestCreatedAt: 1700000800,
      earliestNotBeforeAt: 1700000900,
      recentRetryErrorClass: "telegram-429",
    });
    const audit = db.getHistory().find((entry) => entry.sql.includes("INSERT INTO admin_action_audit"));
    expect(audit).toBeDefined();
    expect(audit?.binds.slice(2, 6)).toEqual([
      "inspect-telegram-chat",
      "12345",
      "ok",
      200,
    ]);
    const details = JSON.parse(audit?.binds[6] as string) as Record<string, unknown>;
    expect(details).toEqual({
      found: true,
      subscriptionCount: 1,
      presetCount: 1,
      hasPendingDisambiguation: true,
      pendingAlertCount: 3,
    });
    expect(audit?.binds.join(" ")).not.toContain("alice");
  });

  it("returns empty/zero defaults when subscriber has no subscriptions, presets, pending state", async () => {
    const subscriberRow = {
      chat_id: "67890",
      username: null,
      alert_dews: 0,
      alert_depeg: 0,
      alert_safety: 0,
      alert_launch: 0,
      global_alert_dews: 0,
      global_alert_depeg: 0,
      global_alert_safety: 0,
      global_alert_launch: 0,
      global_depeg_worsening_bps_step: null,
      quiet_hours_enabled: 0,
      quiet_hours_start_utc: null,
      quiet_hours_end_utc: null,
      alert_snooze_until_ts: null,
      created_at: 1700000000,
      last_active_at: 1700000000,
    };

    const db = mockD1([
      { match: "FROM telegram_subscribers", rows: [subscriberRow] },
      { match: "FROM telegram_subscriptions", rows: [] },
      { match: "FROM telegram_preset_subscriptions", rows: [] },
      { match: "FROM telegram_pending_disambiguation", rows: [] },
      {
        match: "SELECT COUNT(*) AS count",
        rows: [
          {
            count: 0,
            oldest_created_at: null,
            newest_created_at: null,
            earliest_not_before_at: null,
          },
        ],
      },
      { match: "WHERE chat_id = ? AND last_error_class IS NOT NULL", rows: [] },
    ]);

    const req = new Request("https://ops-api.pharos.watch/api/admin-telegram-chat/67890");
    const res = await handleAdminTelegramChat(db, "67890", true, req);
    expect(res.status).toBe(200);

    const body = (await res.json()) as ResponseBody;
    expect(body.subscriber.snooze.active).toBe(false);
    expect(body.subscriber.snooze.untilTs).toBeNull();
    expect(body.subscriber.quietHours.enabled).toBe(false);
    expect(body.subscriptions).toEqual([]);
    expect(body.presets).toEqual([]);
    expect(body.pendingDisambiguation).toBeNull();
    expect(body.pendingAlerts).toEqual({
      count: 0,
      oldestCreatedAt: null,
      newestCreatedAt: null,
      earliestNotBeforeAt: null,
      recentRetryErrorClass: null,
    });
  });

  it("scopes the subscriber lookup to the given chatId", async () => {
    const db = mockD1([
      { match: "FROM telegram_subscribers", rows: [] },
    ]);
    await handleAdminTelegramChat(db, "-100123", true, new Request(
      "https://ops-api.pharos.watch/api/admin-telegram-chat/-100123",
    ));
    const history = db.getHistory();
    const subscriberQuery = history.find((row) => row.sql.includes("FROM telegram_subscribers"));
    expect(subscriberQuery?.binds).toEqual(["-100123"]);
  });
});
