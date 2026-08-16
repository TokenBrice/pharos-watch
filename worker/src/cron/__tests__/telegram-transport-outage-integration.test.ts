import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createSqliteD1 } from "../../test-helpers/sqlite-d1";
import { mockFetch } from "../../test-helpers/__shared/mock-fetch";
import { drainPendingQueue } from "../telegram-pending";

const NOW = 1_800_000_000;
const databases: DatabaseSync[] = [];
let fetchSpy: ReturnType<typeof mockFetch>;

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

function insertRows(
  sqlite: DatabaseSync,
  count: number,
  sourceType: "legacy" | "admin_broadcast" = "legacy",
  firstChatId = 10_000,
): void {
  const subscriber = sqlite.prepare(
    `INSERT INTO telegram_subscribers (chat_id, created_at, last_active_at)
     VALUES (?, ?, ?)`,
  );
  const pending = sqlite.prepare(
    `INSERT INTO telegram_pending_alerts (
       chat_id, message_html, disable_notification, created_at, expires_at,
       not_before_at, priority, source_type, chunk_index, updated_at
     ) VALUES (?, ?, 0, ?, ?, NULL, ?, ?, 0, ?)`,
  );
  for (let index = 0; index < count; index += 1) {
    const chatId = String(firstChatId + index);
    subscriber.run(chatId, NOW - 100, NOW - 10);
    pending.run(
      chatId,
      `<b>Alert ${index}</b>`,
      NOW - 10,
      NOW + 3_600,
      sourceType === "admin_broadcast" ? 90 : 50,
      sourceType,
      NOW - 10,
    );
  }
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW * 1_000);
  fetchSpy = mockFetch([], { requireMatch: true });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  while (databases.length > 0) databases.pop()?.close();
});

describe("Telegram outage-controlled pending scheduler", () => {
  it("does not claim or attempt a 900-row tail while the circuit is open", async () => {
    const { sqlite, db } = setupLatestSchema();
    insertRows(sqlite, 900);
    sqlite.prepare(
      `UPDATE telegram_transport_circuit
          SET state = 'open', generation = 1, cause_class = 'auth_error', cause_scope = 'fatal',
              opened_at = ?, next_probe_at = ?, updated_at = ?
        WHERE singleton_id = 1`,
    ).run(NOW, NOW + 900, NOW);

    const result = await drainPendingQueue(db, "bot-token", 900);

    expect(result.attempted).toBe(0);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(sqlite.prepare(
      "SELECT COUNT(*) AS count FROM telegram_pending_alerts WHERE processing_owner IS NOT NULL",
    ).get()).toEqual({ count: 0 });
  });

  it("opens after one systemic wave and leaves the untouched tail unchanged", async () => {
    const { sqlite, db } = setupLatestSchema();
    insertRows(sqlite, 8);
    fetchSpy.mockResolvedValue(new Response(JSON.stringify({
      ok: false,
      error_code: 503,
      description: "Service unavailable",
    }), { status: 503 }));

    const result = await drainPendingQueue(db, "bot-token", 8);

    expect(result.attempted).toBe(4);
    expect(fetchSpy).toHaveBeenCalledTimes(4);
    expect(sqlite.prepare(
      "SELECT state, cause_scope, distinct_failure_count FROM telegram_transport_circuit WHERE singleton_id = 1",
    ).get()).toEqual({ state: "open", cause_scope: "transient", distinct_failure_count: 4 });
    expect(sqlite.prepare(
      "SELECT COUNT(*) AS count FROM telegram_pending_alerts WHERE attempts = 0 AND not_before_at IS NULL",
    ).get()).toEqual({ count: 4 });
    expect(sqlite.prepare(
      "SELECT COUNT(DISTINCT priority) AS priorities, MIN(expires_at) AS min_expiry, MAX(expires_at) AS max_expiry FROM telegram_pending_alerts",
    ).get()).toEqual({ priorities: 1, min_expiry: NOW + 3_600, max_expiry: NOW + 3_600 });
  });

  it("bounds a due half-open recovery probe to four actual chats", async () => {
    const { sqlite, db } = setupLatestSchema();
    insertRows(sqlite, 10);
    sqlite.prepare(
      `UPDATE telegram_transport_circuit
          SET state = 'open', generation = 1, cause_class = 'server_error', cause_scope = 'transient',
              opened_at = ?, next_probe_at = ?, updated_at = ?
        WHERE singleton_id = 1`,
    ).run(NOW - 60, NOW, NOW);
    fetchSpy.mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 }));

    const result = await drainPendingQueue(db, "bot-token", 900);

    expect(result.attempted).toBe(4);
    expect(result.sent).toBe(4);
    expect(fetchSpy).toHaveBeenCalledTimes(4);
    expect(sqlite.prepare(
      "SELECT state, last_success_at FROM telegram_transport_circuit WHERE singleton_id = 1",
    ).get()).toEqual({ state: "closed", last_success_at: NOW });
    expect(sqlite.prepare("SELECT COUNT(*) AS count FROM telegram_pending_alerts").get()).toEqual({ count: 6 });
  });

  it("holds admin-broadcast rows during an admin pause without blocking risk rows", async () => {
    const { sqlite, db } = setupLatestSchema();
    insertRows(sqlite, 2, "admin_broadcast");
    insertRows(sqlite, 2, "legacy", 20_000);
    sqlite.prepare(
      `INSERT INTO telegram_delivery_pauses
         (mode, generation, expires_at, reason, actor, created_at, updated_at)
       VALUES ('admin', 1, ?, 'incident', 'operator', ?, ?)`,
    ).run(NOW + 300, NOW, NOW);
    fetchSpy.mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 }));

    const result = await drainPendingQueue(db, "bot-token", 10);

    expect(result.attempted).toBe(2);
    expect(result.sent).toBe(2);
    expect(sqlite.prepare(
      "SELECT COUNT(*) AS count FROM telegram_pending_alerts WHERE source_type = 'admin_broadcast' AND attempts = 0",
    ).get()).toEqual({ count: 2 });
  });
});
