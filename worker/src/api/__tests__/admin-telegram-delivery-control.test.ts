import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createSqliteD1 } from "../../test-helpers/sqlite-d1";
import { handleAdminTelegramDeliveryControl } from "../admin-telegram-delivery-control";

const NOW = 1_800_000_000;
const databases: DatabaseSync[] = [];

function setupLatestSchema(): { sqlite: DatabaseSync; db: D1Database } {
  const sqlite = new DatabaseSync(":memory:");
  const migrationDir = process.cwd().endsWith("/worker")
    ? join(process.cwd(), "migrations")
    : join(process.cwd(), "worker/migrations");
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- checked-in migration directory.
  for (const file of readdirSync(migrationDir).filter((entry) => entry.endsWith(".sql")).sort()) {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- checked-in migration replay.
    sqlite.exec(readFileSync(join(migrationDir, file), "utf8"));
  }
  databases.push(sqlite);
  return { sqlite, db: createSqliteD1(sqlite) };
}

function request(method: "GET" | "POST", body?: unknown): Request {
  const headers = new Headers({
    "Cf-Access-Authenticated-User-Email": "operator@example.com",
  });
  if (method === "POST") {
    headers.set("X-Pharos-Admin", "1");
    headers.set("Content-Type", "application/json");
  }
  return new Request("https://ops-api.pharos.watch/api/admin-telegram-delivery-control", {
    method,
    headers,
    ...(body == null ? {} : { body: JSON.stringify(body) }),
  });
}

afterEach(() => {
  vi.useRealTimers();
  while (databases.length > 0) databases.pop()?.close();
});

describe("admin Telegram delivery control", () => {
  it("returns the authoritative circuit and all pause rows", async () => {
    const { db } = setupLatestSchema();
    const response = await handleAdminTelegramDeliveryControl({
      db,
      request: request("GET"),
      trustedAdmin: true,
    });
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      circuit: { state: "closed", generation: 0 },
      pauses: [],
    });
  });

  it("audits a fenced pause and resume while preserving expired state", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW * 1_000);
    const { sqlite, db } = setupLatestSchema();
    const pauseResponse = await handleAdminTelegramDeliveryControl({
      db,
      request: request("POST", {
        action: "pause",
        mode: "pending",
        expectedGeneration: 0,
        durationSec: 300,
        reason: "Telegram incident",
      }),
      trustedAdmin: true,
    });
    expect(pauseResponse.status).toBe(200);
    await expect(pauseResponse.json()).resolves.toMatchObject({
      pauses: [{ mode: "pending", generation: 1, active: true, expiresAt: NOW + 300 }],
    });

    const resumeResponse = await handleAdminTelegramDeliveryControl({
      db,
      request: request("POST", {
        action: "resume",
        mode: "pending",
        expectedGeneration: 1,
      }),
      trustedAdmin: true,
    });
    expect(resumeResponse.status).toBe(200);
    await expect(resumeResponse.json()).resolves.toMatchObject({
      pauses: [{ mode: "pending", generation: 2, active: false, expiresAt: NOW }],
    });

    expect(sqlite.prepare(
      "SELECT action, target, result FROM admin_action_audit WHERE action LIKE 'telegram-delivery-%' ORDER BY id",
    ).all()).toEqual([
      { action: "telegram-delivery-pause", target: "pending", result: "ok" },
      { action: "telegram-delivery-resume", target: "pending", result: "ok" },
    ]);
  });

  it("rejects a stale generation and audits the conflict", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW * 1_000);
    const { sqlite, db } = setupLatestSchema();
    sqlite.prepare(
      `INSERT INTO telegram_delivery_pauses
         (mode, generation, expires_at, reason, actor, created_at, updated_at)
       VALUES ('fresh', 2, ?, 'existing', 'first@example.com', ?, ?)`,
    ).run(NOW + 300, NOW, NOW);

    const response = await handleAdminTelegramDeliveryControl({
      db,
      request: request("POST", {
        action: "pause",
        mode: "fresh",
        expectedGeneration: 1,
        durationSec: 600,
        reason: "stale update",
      }),
      trustedAdmin: true,
    });
    expect(response.status).toBe(409);
    expect(sqlite.prepare(
      "SELECT action, result, http_status FROM admin_action_audit WHERE action = 'telegram-delivery-pause'",
    ).get()).toEqual({ action: "telegram-delivery-pause", result: "error", http_status: 409 });
  });
});
