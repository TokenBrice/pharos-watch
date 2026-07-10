import { readFileSync } from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createSqliteD1 } from "../../test-helpers/sqlite-d1";

vi.mock("../alerts", () => ({
  sendAlert: vi.fn(async () => true),
}));

import { sendAlert } from "../alerts";
import {
  dispatchPendingAlertBrokerDeliveries,
  loadAlertBrokerSummary,
  normalizeAlertBrokerMode,
  reportAlertCondition,
} from "../alert-broker";

const MIGRATION = path.resolve(__dirname, "../../../migrations/0175_durable_alert_broker.sql");

function openDb(): { db: D1Database; sqlite: import("node:sqlite").DatabaseSync } {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { DatabaseSync } = require("node:sqlite") as typeof import("node:sqlite");
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(readFileSync(MIGRATION, "utf8"));
  return { db: createSqliteD1(sqlite), sqlite };
}

function condition(overrides: Partial<Parameters<typeof reportAlertCondition>[1]> = {}) {
  return {
    conditionKey: "cron:sync-live-reserves",
    active: true,
    fingerprint: { reason: "expired-attempt" },
    severity: "critical" as const,
    title: "Reserve sync failed",
    message: "The current reserve attempt expired.",
    recoveryTitle: "Reserve sync recovered",
    recoveryMessage: "A current reserve attempt completed.",
    mode: "alert",
    webhookUrl: "https://hooks.slack.com/services/test",
    nowSec: 1_000,
    ...overrides,
  };
}

describe("durable alert broker", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(sendAlert).mockResolvedValue(true);
  });

  it("normalizes operational modes and defaults unknown values to shadow", () => {
    expect(normalizeAlertBrokerMode("OFF")).toBe("off");
    expect(normalizeAlertBrokerMode("shadow")).toBe("shadow");
    expect(normalizeAlertBrokerMode("status")).toBe("status");
    expect(normalizeAlertBrokerMode("ALERT")).toBe("alert");
    expect(normalizeAlertBrokerMode(undefined)).toBe("shadow");
    expect(normalizeAlertBrokerMode("enabled")).toBe("shadow");
  });

  it("emits exactly one incident and one recovery per episode", async () => {
    const { db, sqlite } = openDb();

    await expect(reportAlertCondition(db, condition())).resolves.toMatchObject({
      transition: "incident",
      deliveryState: "delivered",
    });
    await expect(reportAlertCondition(db, condition({ nowSec: 1_010 }))).resolves.toMatchObject({
      transition: null,
    });
    await expect(reportAlertCondition(db, condition({ active: false, nowSec: 1_020 }))).resolves.toMatchObject({
      transition: "recovery",
      deliveryState: "delivered",
    });
    await expect(reportAlertCondition(db, condition({ active: false, nowSec: 1_030 }))).resolves.toMatchObject({
      transition: null,
    });

    expect(sendAlert).toHaveBeenCalledTimes(2);
    const deliveries = sqlite
      .prepare("SELECT transition, state, episode FROM alert_broker_deliveries ORDER BY created_at, transition")
      .all() as Array<{ transition: string; state: string; episode: number }>;
    expect(deliveries).toHaveLength(2);
    expect(new Set(deliveries.map((row) => row.transition))).toEqual(new Set(["incident", "recovery"]));
    expect(deliveries.every((row) => row.state === "delivered" && row.episode === 1)).toBe(true);
    sqlite.close();
  });

  it("permits a later identical incident after recovery under a new episode", async () => {
    const { db, sqlite } = openDb();
    await reportAlertCondition(db, condition());
    await reportAlertCondition(db, condition({ active: false, nowSec: 1_010 }));
    await reportAlertCondition(db, condition({ nowSec: 1_020 }));

    const incidents = sqlite
      .prepare("SELECT episode FROM alert_broker_deliveries WHERE transition = 'incident' ORDER BY episode")
      .all() as Array<{ episode: number }>;
    expect(incidents.map((row) => row.episode)).toEqual([1, 2]);
    expect(sendAlert).toHaveBeenCalledTimes(3);
    sqlite.close();
  });

  it("suppresses recovery flaps until the persisted cooldown expires", async () => {
    const { db, sqlite } = openDb();
    await expect(reportAlertCondition(db, condition({ cooldownSec: 300 }))).resolves.toMatchObject({
      state: "active",
      transition: "incident",
    });
    await expect(reportAlertCondition(db, condition({
      active: false,
      cooldownSec: 300,
      nowSec: 1_010,
    }))).resolves.toMatchObject({
      state: "recovered",
      transition: "recovery",
    });
    await expect(reportAlertCondition(db, condition({ cooldownSec: 300, nowSec: 1_020 }))).resolves.toMatchObject({
      state: "pending",
      transition: null,
      deliveryState: null,
    });
    await expect(reportAlertCondition(db, condition({ cooldownSec: 300, nowSec: 1_299 }))).resolves.toMatchObject({
      state: "pending",
      transition: null,
      deliveryState: null,
    });

    const coolingDown = sqlite
      .prepare("SELECT state, episode, cooldown_until FROM alert_broker_conditions WHERE condition_key = ?")
      .get("cron:sync-live-reserves") as { state: string; episode: number; cooldown_until: number };
    expect(coolingDown).toEqual({ state: "pending", episode: 1, cooldown_until: 1_300 });
    expect(sendAlert).toHaveBeenCalledTimes(2);

    await expect(reportAlertCondition(db, condition({ cooldownSec: 300, nowSec: 1_300 }))).resolves.toMatchObject({
      state: "active",
      transition: "incident",
      deliveryState: "delivered",
    });
    const incidents = sqlite
      .prepare("SELECT episode FROM alert_broker_deliveries WHERE transition = 'incident' ORDER BY episode")
      .all() as Array<{ episode: number }>;
    expect(incidents.map((row) => row.episode)).toEqual([1, 2]);
    expect(sendAlert).toHaveBeenCalledTimes(3);
    sqlite.close();
  });

  it("keeps failed delivery retryable and claims it once", async () => {
    const { db, sqlite } = openDb();
    vi.mocked(sendAlert).mockResolvedValueOnce(false).mockResolvedValueOnce(true);

    await expect(reportAlertCondition(db, condition())).resolves.toMatchObject({ deliveryState: "failed" });
    await expect(dispatchPendingAlertBrokerDeliveries(db, {
      webhookUrl: "https://hooks.slack.com/services/test",
      nowSec: 1_299,
    })).resolves.toMatchObject({ due: 0 });
    await expect(dispatchPendingAlertBrokerDeliveries(db, {
      webhookUrl: "https://hooks.slack.com/services/test",
      nowSec: 1_300,
    })).resolves.toMatchObject({ due: 1, delivered: 1 });

    const row = sqlite
      .prepare("SELECT state, attempts FROM alert_broker_deliveries WHERE transition = 'incident'")
      .get() as { state: string; attempts: number };
    expect(row).toEqual({ state: "delivered", attempts: 2 });
    sqlite.close();
  });

  it("records a missing webhook instead of pretending delivery succeeded", async () => {
    const { db, sqlite } = openDb();
    const result = await reportAlertCondition(db, condition({ webhookUrl: null }));

    expect(result.deliveryState).toBe("missing_target");
    expect(sendAlert).not.toHaveBeenCalled();
    const row = sqlite
      .prepare("SELECT state, last_error FROM alert_broker_deliveries")
      .get() as { state: string; last_error: string };
    expect(row.state).toBe("missing_target");
    expect(row.last_error).toContain("ALERT_WEBHOOK_URL");
    sqlite.close();
  });

  it("keeps shadow and status behavior distinct without sending", async () => {
    const { db, sqlite } = openDb();
    const shadow = await reportAlertCondition(db, condition({
      conditionKey: "shadow-condition",
      mode: "shadow",
    }));
    const status = await reportAlertCondition(db, condition({
      conditionKey: "status-condition",
      mode: "status",
    }));

    expect(shadow.deliveryState).toBe("shadow");
    expect(status.deliveryState).toBe("status_only");
    expect(sendAlert).not.toHaveBeenCalled();
    await expect(loadAlertBrokerSummary(db)).resolves.toMatchObject({
      activeCount: 1,
      criticalActiveCount: 1,
      activeConditionKeys: ["status-condition"],
    });
    sqlite.close();
  });

  it("requires the configured streak before activating", async () => {
    const { db, sqlite } = openDb();
    const first = await reportAlertCondition(db, condition({ minStreak: 2 }));
    const second = await reportAlertCondition(db, condition({ minStreak: 2, nowSec: 1_010 }));

    expect(first).toMatchObject({ state: "pending", transition: null });
    expect(second).toMatchObject({ state: "active", transition: "incident" });
    expect(sendAlert).toHaveBeenCalledTimes(1);
    sqlite.close();
  });
});
