import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { createSqliteD1 } from "../../test-helpers/sqlite-d1";
import { makeApiRequest } from "../../test-helpers/__shared/auth";
import { handleDiscoveryCandidateDismiss } from "../admin-actions";

function setup() {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(`
    CREATE TABLE discovery_candidates (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      symbol TEXT NOT NULL,
      source TEXT NOT NULL,
      market_cap REAL,
      dismissed INTEGER NOT NULL DEFAULT 0,
      dismissed_at INTEGER,
      dismissed_mcap REAL
    );
    INSERT INTO discovery_candidates (id, name, symbol, source, market_cap, dismissed)
    VALUES (1, 'Big Dollar', 'BIG', 'both', 50000000, 0);
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
    CREATE TABLE admin_idempotency_keys (
      action TEXT NOT NULL,
      idempotency_key TEXT NOT NULL,
      request_hash TEXT NOT NULL,
      response_status INTEGER NOT NULL,
      response_body TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      reservation_owner TEXT,
      reservation_generation INTEGER NOT NULL DEFAULT 0,
      execution_started_at INTEGER,
      PRIMARY KEY (action, idempotency_key)
    );
  `);
  return { sqlite, db: createSqliteD1(sqlite) };
}

function request(key: string): Request {
  return makeApiRequest("/api/discovery-candidates/1/dismiss", {
    method: "POST",
    adminKey: "secret",
    headers: { "Idempotency-Key": key },
  });
}

describe("discovery dismissal idempotency", () => {
  it("audits one transition, replays it, and safely reconciles a new-key repeat", async () => {
    const { sqlite, db } = setup();
    const first = await handleDiscoveryCandidateDismiss(
      { db, request: request("dismiss-intent"), trustedAdmin: true },
      1,
    );
    const replay = await handleDiscoveryCandidateDismiss(
      { db, request: request("dismiss-intent"), trustedAdmin: true },
      1,
    );
    const repeated = await handleDiscoveryCandidateDismiss(
      { db, request: request("new-dismiss-intent"), trustedAdmin: true },
      1,
    );

    expect(first.status).toBe(200);
    await expect(first.json()).resolves.toMatchObject({
      ok: true,
      alreadyDismissed: false,
      candidate: { id: 1, symbol: "BIG" },
      auditAction: "dismiss-discovery-candidate",
    });
    expect(replay.headers.get("X-Idempotent-Replay")).toBe("true");
    await expect(replay.json()).resolves.toMatchObject({ ok: true, alreadyDismissed: false });
    expect(repeated.status).toBe(200);
    await expect(repeated.json()).resolves.toMatchObject({ ok: true, alreadyDismissed: true });
    expect(sqlite.prepare("SELECT dismissed FROM discovery_candidates WHERE id = 1").get()).toEqual({ dismissed: 1 });
    expect(sqlite.prepare("SELECT COUNT(*) AS count FROM admin_action_audit").get()).toEqual({ count: 1 });
    expect(sqlite.prepare("SELECT action, target FROM admin_action_audit").get()).toEqual({
      action: "dismiss-discovery-candidate",
      target: "candidate:1",
    });
  });
});
