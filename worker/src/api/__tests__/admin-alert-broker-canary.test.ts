import { readFileSync } from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createSqliteD1 } from "../../test-helpers/sqlite-d1";

vi.mock("../../lib/alerts", () => ({
  sendAlert: vi.fn(async () => true),
}));

import { sendAlert } from "../../lib/alerts";
import { handleAlertBrokerCanary } from "../admin-alert-broker-canary";

const ALERT_MIGRATION = path.resolve(__dirname, "../../../migrations/0175_durable_alert_broker.sql");

function openDb(): { db: D1Database; sqlite: import("node:sqlite").DatabaseSync } {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { DatabaseSync } = require("node:sqlite") as typeof import("node:sqlite");
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(readFileSync(ALERT_MIGRATION, "utf8"));
  sqlite.exec(`
    CREATE TABLE admin_action_audit (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      created_at INTEGER NOT NULL,
      actor TEXT NOT NULL,
      action TEXT NOT NULL,
      target TEXT,
      result TEXT NOT NULL,
      http_status INTEGER,
      details_json TEXT
    );
  `);
  return { db: createSqliteD1(sqlite), sqlite };
}

function request(url: string, idempotencyKey?: string): Request {
  const headers = new Headers({ "X-Pharos-Admin": "1" });
  if (idempotencyKey) headers.set("Idempotency-Key", idempotencyKey);
  return new Request(url, { method: "POST", headers });
}

function context(
  db: D1Database,
  url: string,
  options: { idempotencyKey?: string; webhookUrl?: string | null } = {},
) {
  return {
    db,
    url: new URL(url),
    request: request(url, options.idempotencyKey),
    trustedAdmin: true,
    alertWebhookUrl: options.webhookUrl === undefined
      ? "https://hooks.slack.com/services/canary"
      : options.webhookUrl,
  };
}

describe("handleAlertBrokerCanary", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(sendAlert).mockResolvedValue(true);
  });

  it("defaults to a non-mutating broker dry run", async () => {
    const { db, sqlite } = openDb();
    const url = "https://ops-api.pharos.watch/api/alert-broker-canary";

    const response = await handleAlertBrokerCanary(context(db, url, { webhookUrl: null }));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      dryRun: true,
      targetConfigured: false,
      wouldEmit: ["incident", "recovery"],
      requiresIdempotencyKey: true,
    });
    expect(sendAlert).not.toHaveBeenCalled();
    expect(sqlite.prepare("SELECT COUNT(*) AS count FROM alert_broker_conditions").get()).toEqual({ count: 0 });
    expect(sqlite.prepare("SELECT COUNT(*) AS count FROM alert_broker_deliveries").get()).toEqual({ count: 0 });
    sqlite.close();
  });

  it("emits and verifies exactly one incident and one recovery", async () => {
    const { db, sqlite } = openDb();
    const url = "https://ops-api.pharos.watch/api/alert-broker-canary?execute=true&confirm=emit-incident-and-recovery";

    const response = await handleAlertBrokerCanary(context(db, url, {
      idempotencyKey: "night-watch-canary-success",
    }));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      dryRun: false,
      transitionContractSatisfied: true,
      deliverySucceeded: true,
      failedDeliveryVisible: false,
      deliveries: [
        expect.objectContaining({ transition: "incident", state: "delivered", attempts: 1 }),
        expect.objectContaining({ transition: "recovery", state: "delivered", attempts: 1 }),
      ],
    });
    expect(sendAlert).toHaveBeenCalledTimes(2);
    expect(sqlite.prepare("SELECT COUNT(*) AS count FROM alert_broker_deliveries").get()).toEqual({ count: 2 });
    sqlite.close();
  });

  it("returns failed delivery evidence without losing either transition", async () => {
    const { db, sqlite } = openDb();
    vi.mocked(sendAlert).mockResolvedValue(false);
    const url = "https://ops-api.pharos.watch/api/alert-broker-canary?execute=true&confirm=emit-incident-and-recovery";

    const response = await handleAlertBrokerCanary(context(db, url, {
      idempotencyKey: "night-watch-canary-failure",
    }));

    expect(response.status).toBe(502);
    await expect(response.json()).resolves.toMatchObject({
      ok: false,
      transitionContractSatisfied: true,
      deliverySucceeded: false,
      failedDeliveryVisible: true,
      deliveries: [
        expect.objectContaining({ transition: "incident", state: "failed", attempts: 1 }),
        expect.objectContaining({ transition: "recovery", state: "failed", attempts: 1 }),
      ],
    });
    expect(sqlite.prepare("SELECT COUNT(*) AS count FROM alert_broker_deliveries WHERE state = 'failed'").get())
      .toEqual({ count: 2 });
    sqlite.close();
  });

  it("refuses live execution without every guard", async () => {
    const { db, sqlite } = openDb();
    const missingConfirmation = "https://ops-api.pharos.watch/api/alert-broker-canary?execute=true";
    const confirmed = `${missingConfirmation}&confirm=emit-incident-and-recovery`;

    await expect(handleAlertBrokerCanary(context(db, missingConfirmation, {
      idempotencyKey: "night-watch-canary-guard",
    })).then((response) => response.status)).resolves.toBe(400);
    await expect(handleAlertBrokerCanary(context(db, confirmed)).then((response) => response.status)).resolves.toBe(400);
    await expect(handleAlertBrokerCanary(context(db, confirmed, {
      idempotencyKey: "night-watch-canary-target",
      webhookUrl: null,
    })).then((response) => response.status)).resolves.toBe(409);
    expect(sendAlert).not.toHaveBeenCalled();
    sqlite.close();
  });
});
