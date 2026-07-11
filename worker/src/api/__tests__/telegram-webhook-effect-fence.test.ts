import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { TRACKED_STABLECOINS } from "@shared/lib/stablecoins/registry";
import { executeAtomicBatch } from "../../lib/db";
import { createSqliteD1 } from "../../test-helpers/sqlite-d1";
import {
  TelegramWebhookEffectFence,
  createTelegramWebhookIntent,
} from "../telegram-webhook-effect-fence";
import { acquireTelegramCommandCooldown, claimTelegramProcessedUpdate } from "../telegram-webhook-store";
import { parseStoredCommandSelectionIntent } from "../telegram-webhook-disambiguation-selection";
import { clearPendingDisambiguation } from "../telegram-webhook-store";
import { resumeStoredPendingClearIntent } from "../telegram-webhook-pending-gate";

const NOW = 1_700_000_000;

function createFixture(): { sqlite: DatabaseSync; db: D1Database } {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE telegram_processed_updates (
      update_id INTEGER PRIMARY KEY,
      received_at INTEGER NOT NULL,
      processed_at INTEGER,
      update_type TEXT,
      chat_id TEXT,
      status TEXT NOT NULL DEFAULT 'processing',
      error_class TEXT,
      effect_state TEXT NOT NULL DEFAULT 'unstarted',
      effect_key TEXT,
      effect_started_at INTEGER,
      claim_owner TEXT,
      claim_generation INTEGER NOT NULL DEFAULT 0,
      intent_version INTEGER,
      intent_kind TEXT,
      intent_mutates INTEGER NOT NULL DEFAULT 0,
      intent_payload TEXT,
      intent_recorded_at INTEGER,
      mutation_applied_at INTEGER,
      effect_completed_at INTEGER,
      effect_kind TEXT,
      effect_ordinal INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE telegram_webhook_operation_mutations (
      update_id INTEGER PRIMARY KEY NOT NULL,
      claim_generation INTEGER NOT NULL,
      applied_at INTEGER NOT NULL,
      FOREIGN KEY (update_id) REFERENCES telegram_processed_updates(update_id) ON DELETE CASCADE
    );
    CREATE TRIGGER trg_telegram_webhook_operation_mutation_applied
    AFTER INSERT ON telegram_webhook_operation_mutations
    BEGIN
      UPDATE telegram_processed_updates
         SET mutation_applied_at = NEW.applied_at
       WHERE update_id = NEW.update_id
         AND claim_generation = NEW.claim_generation;
    END;
    CREATE TABLE domain_state (id INTEGER PRIMARY KEY, value TEXT NOT NULL);
    INSERT INTO domain_state (id, value) VALUES (1, 'before');
    CREATE TABLE telegram_pending_disambiguation (
      chat_id TEXT PRIMARY KEY,
      action_type TEXT,
      action_payload TEXT,
      alert_types TEXT NOT NULL,
      resolved_ids TEXT NOT NULL,
      ambiguous_ticker TEXT NOT NULL,
      candidates TEXT NOT NULL,
      remaining_tickers TEXT NOT NULL,
      expires_at INTEGER NOT NULL,
      initiator_user_id TEXT
    );
    CREATE TABLE cache (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL);
  `);
  return { sqlite, db: createSqliteD1(sqlite) };
}

function insertClaim(sqlite: DatabaseSync, updateId: number, owner: string, generation = 1): void {
  sqlite.prepare(`
    INSERT INTO telegram_processed_updates (
      update_id, received_at, update_type, chat_id, status, effect_state,
      effect_key, claim_owner, claim_generation
    ) VALUES (?, ?, 'message', '42', 'processing', 'unstarted', ?, ?, ?)
  `).run(updateId, NOW, `telegram-update:${updateId}`, owner, generation);
}

describe("TelegramWebhookEffectFence", () => {
  const fixtures: DatabaseSync[] = [];
  afterEach(() => {
    while (fixtures.length > 0) fixtures.pop()?.close();
  });

  it("atomically commits a domain mutation and its applied marker", async () => {
    const { sqlite, db } = createFixture();
    fixtures.push(sqlite);
    insertClaim(sqlite, 1, "owner-1");
    const fence = new TelegramWebhookEffectFence(db, 1, { owner: "owner-1", generation: 1 }, undefined, null);
    await fence.plan(createTelegramWebhookIntent("command:/set", { scope: "all" }, "required"));

    await executeAtomicBatch(db, [
      db.prepare("UPDATE domain_state SET value = 'after' WHERE id = 1"),
      fence.prepareMutationAppliedStatement(NOW + 1),
    ]);
    fence.confirmAtomicMutationApplied();
    await fence.finish();

    expect(sqlite.prepare("SELECT value FROM domain_state WHERE id = 1").get()).toEqual({ value: "after" });
    expect(sqlite.prepare(`
      SELECT status, effect_state, mutation_applied_at
        FROM telegram_processed_updates WHERE update_id = 1
    `).get()).toEqual({ status: "processed", effect_state: "complete", mutation_applied_at: NOW + 1 });
  });

  it("rolls back the domain mutation when a stale generation tries to mark it", async () => {
    const { sqlite, db } = createFixture();
    fixtures.push(sqlite);
    insertClaim(sqlite, 2, "owner-current", 2);
    const currentFence = new TelegramWebhookEffectFence(
      db,
      2,
      { owner: "owner-current", generation: 2 },
      undefined,
      null,
    );
    await currentFence.plan(createTelegramWebhookIntent("command:/set", { scope: "all" }, "required"));
    const staleFence = new TelegramWebhookEffectFence(
      db,
      2,
      { owner: "owner-stale", generation: 1 },
      currentFence.storedIntent ?? undefined,
      null,
    );

    await expect(executeAtomicBatch(db, [
      db.prepare("UPDATE domain_state SET value = 'stale-write' WHERE id = 1"),
      staleFence.prepareMutationAppliedStatement(NOW + 1),
    ])).rejects.toThrow();

    expect(sqlite.prepare("SELECT value FROM domain_state WHERE id = 1").get()).toEqual({ value: "before" });
    expect(sqlite.prepare("SELECT COUNT(*) AS count FROM telegram_webhook_operation_mutations").get())
      .toEqual({ count: 0 });
  });

  it("reclaims the exact planned intent and applied marker after a pre-reply crash", async () => {
    const { sqlite, db } = createFixture();
    fixtures.push(sqlite);
    insertClaim(sqlite, 3, "owner-old");
    const coinIds = TRACKED_STABLECOINS.slice(0, 410).map((coin) => coin.id);
    const intent = createTelegramWebhookIntent("command:subscribe", {
      coinIds,
      presetIds: [],
      alertTypes: ["depeg", "dews"],
      depegWorseningBpsStep: null,
      clearPending: true,
    }, "required");
    const firstFence = new TelegramWebhookEffectFence(db, 3, { owner: "owner-old", generation: 1 }, undefined, null);
    await firstFence.plan(intent);
    await executeAtomicBatch(db, [
      db.prepare("UPDATE domain_state SET value = 'after' WHERE id = 1"),
      firstFence.prepareMutationAppliedStatement(NOW + 1),
    ]);
    sqlite.prepare("UPDATE telegram_processed_updates SET received_at = ? WHERE update_id = 3").run(NOW - 600);

    const reclaim = await claimTelegramProcessedUpdate(db, {
      updateId: 3,
      nowSec: NOW,
      updateType: "message",
      chatId: "42",
      processingStaleSec: 300,
    });

    expect(reclaim.status).toBe("claimed");
    expect(reclaim.storedIntent).toEqual(intent);
    expect(reclaim.mutationAppliedAt).toBe(NOW + 1);
    expect(parseStoredCommandSelectionIntent(reclaim.storedIntent)?.initialCoinIds).toEqual(coinIds);
  });

  it("suppresses automatic replay after an outbound effect may have executed", async () => {
    const { sqlite, db } = createFixture();
    fixtures.push(sqlite);
    insertClaim(sqlite, 4, "owner-1");
    const fence = new TelegramWebhookEffectFence(db, 4, { owner: "owner-1", generation: 1 }, undefined, null);
    await fence.plan(createTelegramWebhookIntent("command:/help", { command: "/help" }));
    await fence.beforeIrreversibleEffect("command-reply");

    const duplicate = await claimTelegramProcessedUpdate(db, {
      updateId: 4,
      nowSec: NOW + 600,
      updateType: "message",
      chatId: "42",
      processingStaleSec: 300,
    });

    expect(duplicate.status).toBe("effect_unknown");
    expect(sqlite.prepare("SELECT effect_state FROM telegram_processed_updates WHERE update_id = 4").get())
      .toEqual({ effect_state: "execution_unknown" });
  });

  it("rejects non-finite intent values and quarantines corrupt normalized payloads", async () => {
    const { sqlite, db } = createFixture();
    fixtures.push(sqlite);
    insertClaim(sqlite, 7, "owner-1");
    const fence = new TelegramWebhookEffectFence(db, 7, { owner: "owner-1", generation: 1 }, undefined, null);
    await expect(fence.plan(createTelegramWebhookIntent("callback:snooze", {
      duration: "1h",
      untilSec: Number.NaN,
    }, "required"))).rejects.toThrow("Invalid Telegram webhook intent schema");

    sqlite.prepare(`
      UPDATE telegram_processed_updates
         SET effect_state = 'planned',
             received_at = ?,
             intent_version = 1,
             intent_kind = 'command:subscribe',
             intent_mutates = 1,
             intent_payload = ?
       WHERE update_id = 7
    `).run(NOW - 600, JSON.stringify({
      version: 1,
      kind: "command:subscribe",
      mutation: "required",
      payload: { coinIds: "not-an-array" },
    }));

    const reclaim = await claimTelegramProcessedUpdate(db, {
      updateId: 7,
      nowSec: NOW,
      updateType: "message",
      chatId: "42",
      processingStaleSec: 300,
    });
    expect(reclaim.status).toBe("effect_unknown");
    expect(sqlite.prepare(`
      SELECT status, effect_state, error_class
        FROM telegram_processed_updates WHERE update_id = 7
    `).get()).toEqual({
      status: "failed",
      effect_state: "execution_unknown",
      error_class: "corrupt_operation_intent",
    });
  });

  it.each([
    ["cancel", false],
    ["clear-and-run", true],
  ] as const)("resumes pending %s after the atomic delete committed before the reply", async (reason, continueCommand) => {
    const { sqlite, db } = createFixture();
    fixtures.push(sqlite);
    const updateId = reason === "cancel" ? 5 : 6;
    insertClaim(sqlite, updateId, "owner-old");
    sqlite.prepare(`
      INSERT INTO telegram_pending_disambiguation (
        chat_id, action_type, action_payload, alert_types, resolved_ids,
        ambiguous_ticker, candidates, remaining_tickers, expires_at, initiator_user_id
      ) VALUES ('42', 'subscribe', '{}', '[]', '[]', '', '[]', '[]', 200, NULL)
    `).run();
    const intent = createTelegramWebhookIntent(`pending:${reason}`, {
      actionType: "subscribe",
      expiresAt: 200,
      reason,
    }, "required");
    const firstFence = new TelegramWebhookEffectFence(
      db,
      updateId,
      { owner: "owner-old", generation: 1 },
      undefined,
      null,
    );
    await firstFence.plan(intent);
    await clearPendingDisambiguation(db, "42", {
      expected: { actionType: "subscribe", expiresAt: 200 },
      operationStatements: [firstFence.prepareMutationAppliedStatement(NOW + 1)],
    });
    sqlite.prepare("UPDATE telegram_processed_updates SET received_at = ? WHERE update_id = ?")
      .run(NOW - 600, updateId);

    const reclaim = await claimTelegramProcessedUpdate(db, {
      updateId,
      nowSec: NOW,
      updateType: "message",
      chatId: "42",
      processingStaleSec: 300,
    });
    expect(reclaim.status).toBe("claimed");
    const resumed = await resumeStoredPendingClearIntent({
      db,
      chatId: "42",
      intent: reclaim.storedIntent,
      operation: { wasMutationApplied: reclaim.mutationAppliedAt != null },
    });

    expect(resumed.handled).toBe(true);
    expect(resumed.continueCommand).toBe(continueCommand);
    expect(sqlite.prepare("SELECT COUNT(*) AS count FROM telegram_pending_disambiguation").get())
      .toEqual({ count: 0 });
  });

  it("does not let a pre-intent crash hold a read callback cooldown past stale takeover", async () => {
    const { sqlite, db } = createFixture();
    fixtures.push(sqlite);
    insertClaim(sqlite, 8, "owner-old");
    await expect(acquireTelegramCommandCooldown(db, {
      chatId: "42",
      commandKey: "/status",
      nowSec: NOW,
      cooldownSec: 20,
    })).resolves.toEqual({ allowed: true, retryAfterSec: 0 });
    sqlite.prepare("UPDATE telegram_processed_updates SET received_at = ? WHERE update_id = 8")
      .run(NOW - 600);

    const reclaim = await claimTelegramProcessedUpdate(db, {
      updateId: 8,
      nowSec: NOW + 300,
      updateType: "callback_query",
      chatId: "42",
      processingStaleSec: 300,
    });
    expect(reclaim.status).toBe("claimed");
    await expect(acquireTelegramCommandCooldown(db, {
      chatId: "42",
      commandKey: "/status",
      nowSec: NOW + 300,
      cooldownSec: 20,
    })).resolves.toEqual({ allowed: true, retryAfterSec: 0 });
  });
});
