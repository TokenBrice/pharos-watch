import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";

function migrationSql(name: string): string {
  return readFileSync(resolve(process.cwd(), "worker", "migrations", name), "utf8");
}

describe("0188 Telegram webhook operation intent migration", () => {
  const databases: DatabaseSync[] = [];
  afterEach(() => {
    while (databases.length > 0) databases.pop()?.close();
  });

  it("enforces bounded metadata and accepts mutation proof only for the live planned generation", () => {
    const sqlite = new DatabaseSync(":memory:");
    databases.push(sqlite);
    sqlite.exec("PRAGMA foreign_keys = ON");
    sqlite.exec(migrationSql("0122_telegram_processed_updates.sql"));
    sqlite.exec(`
      ALTER TABLE telegram_processed_updates ADD COLUMN effect_state TEXT NOT NULL DEFAULT 'unstarted';
      ALTER TABLE telegram_processed_updates ADD COLUMN effect_key TEXT;
      ALTER TABLE telegram_processed_updates ADD COLUMN effect_started_at INTEGER;
      ALTER TABLE telegram_processed_updates ADD COLUMN claim_owner TEXT;
      ALTER TABLE telegram_processed_updates ADD COLUMN claim_generation INTEGER NOT NULL DEFAULT 0;
    `);
    sqlite.exec(migrationSql("0188_telegram_webhook_operation_intents.sql"));

    sqlite.prepare(`
      INSERT INTO telegram_processed_updates (
        update_id, received_at, status, effect_state, claim_owner, claim_generation,
        intent_version, intent_kind, intent_mutates, intent_payload, intent_recorded_at
      ) VALUES (1, 100, 'processing', 'unstarted', 'owner', 2, 1, 'command:set', 1, '{}', 100)
    `).run();

    expect(() => sqlite.prepare(`
      INSERT INTO telegram_webhook_operation_mutations (update_id, claim_generation, applied_at)
      VALUES (1, 2, 101)
    `).run()).toThrow(/invalid telegram webhook mutation claim/);

    sqlite.prepare("UPDATE telegram_processed_updates SET effect_state = 'planned' WHERE update_id = 1").run();
    expect(() => sqlite.prepare(`
      INSERT INTO telegram_webhook_operation_mutations (update_id, claim_generation, applied_at)
      VALUES (1, 1, 101)
    `).run()).toThrow(/invalid telegram webhook mutation claim/);

    sqlite.prepare(`
      INSERT INTO telegram_webhook_operation_mutations (update_id, claim_generation, applied_at)
      VALUES (1, 2, 101)
    `).run();
    expect(sqlite.prepare(`
      SELECT mutation_applied_at FROM telegram_processed_updates WHERE update_id = 1
    `).get()).toEqual({ mutation_applied_at: 101 });

    expect(() => sqlite.prepare(`
      UPDATE telegram_processed_updates SET intent_mutates = 2 WHERE update_id = 1
    `).run()).toThrow(/CHECK constraint failed/);
    expect(() => sqlite.prepare(`
      UPDATE telegram_processed_updates SET effect_ordinal = -1 WHERE update_id = 1
    `).run()).toThrow(/CHECK constraint failed/);
    expect(() => sqlite.prepare(`
      UPDATE telegram_processed_updates SET effect_kind = ? WHERE update_id = 1
    `).run("x".repeat(65))).toThrow(/CHECK constraint failed/);
    expect(() => sqlite.prepare(`
      UPDATE telegram_processed_updates SET intent_payload = ? WHERE update_id = 1
    `).run("x".repeat(65_537))).toThrow(/CHECK constraint failed/);
  });
});
