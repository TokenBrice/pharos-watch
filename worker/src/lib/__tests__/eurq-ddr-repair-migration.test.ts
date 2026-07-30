import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";

const MIGRATIONS_DIR = join(process.cwd(), "worker/src/test-helpers/migration-fixtures");
const FIXTURES_DIR = join(process.cwd(), "worker/src/test-helpers/migration-fixtures");

// Migrations absorbed by the 2026-07-30 baseline squash live on as frozen test fixtures.
function resolveMigrationPath(file: string): string {
  const fixture = join(FIXTURES_DIR, file);
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- repo-controlled test fixture path
  return existsSync(fixture) ? fixture : join(MIGRATIONS_DIR, file);
}
const PREVIOUS_MIGRATION = "0207_telegram_execution_unknown_backlog_archive.sql";
const TARGET_MIGRATION = "0208_eurq_ddr_events_90589_90595_link.sql";
const INCIDENT_KEY = "ddr2:3a67bd822a7230458da31c0078ef2b4f";

function applyMigration(db: DatabaseSync, file: string): void {
  // Test-only replay of repo-controlled migration files.
  // eslint-disable-next-line security/detect-non-literal-fs-filename
  db.exec(readFileSync(resolveMigrationPath(file), "utf8"));
}

function applyThrough(db: DatabaseSync, throughFile: string): void {
  for (const file of readdirSync(MIGRATIONS_DIR)
    .filter((entry) => entry.endsWith(".sql"))
    .sort()) {
    applyMigration(db, file);
    if (file === throughFile) return;
  }
  throw new Error(`missing migration ${throughFile}`);
}

function seedReviewedEurqState(db: DatabaseSync): void {
  applyThrough(db, PREVIOUS_MIGRATION);

  db.exec(`
    INSERT INTO depeg_events
      (id, stablecoin_id, symbol, peg_type, direction, peak_deviation_bps,
       started_at, ended_at, start_price, peak_price, recovery_price, peg_reference,
       source, confirmation_sources, pending_reason, close_reason)
    VALUES
      (90560, 'eurq-quantoz', 'EURQ', 'peggedEUR', 'below', -166,
       1784033283, 1784044075, 0.983396, 0.983396, 0.985613, 1,
       'live', NULL, NULL, 'recovered-native'),
      (90589, 'eurq-quantoz', 'EURQ', 'peggedEUR', 'below', -156,
       1784126070, 1784126921, 0.984392, 0.984392, 0.988565, 1,
       'live', NULL, NULL, 'recovered-native'),
      (90591, 'eurq-quantoz', 'EURQ', 'peggedEUR', 'below', -150,
       1784127861, 1784128727, 0.985, 0.985, 0.985431, 1,
       'live', NULL, NULL, 'recovered-native'),
      (90594, 'eurq-quantoz', 'EURQ', 'peggedEUR', 'below', -170,
       1784133252, 1784135051, 0.984206, 0.982973, 0.985345, 1,
       'live', NULL, NULL, 'recovered-native'),
      (90595, 'eurq-quantoz', 'EURQ', 'peggedEUR', 'below', -166,
       1784135928, NULL, 0.984513, 0.983414, NULL, 1,
       'live', NULL, NULL, NULL);

    INSERT INTO depeg_resolver_incident_event_links
      (incident_key, event_id, relation, repair_authorization_id, linked_at, note)
    VALUES
      ('${INCIDENT_KEY}', 90527, 'observed', NULL,
       1783798540, 'initial canonical incident link'),
      ('${INCIDENT_KEY}', 90560, 'repair_replacement', NULL,
       1784033306, 'pre-lock nearby event adopted as current incident source');

    INSERT INTO depeg_resolver_incidents
      (incident_key, stablecoin_id, peg_currency, direction, first_event_id, current_event_id,
       first_started_at, current_started_at, first_observed_peak_bucket_bps, incident_state,
       superseded_by_incident_key, source_fingerprint, created_at, updated_at)
    VALUES
      ('${INCIDENT_KEY}', 'eurq-quantoz', 'EUR', 'below', 90527, 90560,
       1783798508, 1784033283, 150, 'active', NULL,
       '5067fbaa1421beab51c1807d3e913d3e6b49a6b4b016b5015ce6f748ce44ae1d',
       1783798540, 1784033306);

    INSERT INTO worker_repair_tasks
      (task_id, kind, subject_id, priority, state, attempt_count, payload_json, created_at, updated_at)
    VALUES
      ('repair:ddr-repair-required-event:90589', 'ddr-repair-required-event', '90589',
       50, 'open', 0, '{"eventId":90589}', 1784126110, 1784142257),
      ('repair:ddr-repair-required-event:90591', 'ddr-repair-required-event', '90591',
       50, 'open', 0, '{"eventId":90591}', 1784127898, 1784142257),
      ('repair:ddr-repair-required-event:90594', 'ddr-repair-required-event', '90594',
       50, 'open', 0, '{"eventId":90594}', 1784133297, 1784142257),
      ('repair:ddr-repair-required-event:90595', 'ddr-repair-required-event', '90595',
       50, 'open', 0, '{"eventId":90595}', 1784135968, 1784142257);

    INSERT INTO cache (key, value, updated_at)
    VALUES
      ('depeg-resolver:snapshot',
       '{"generation":2,"methodologyVersion":"3.04","payload":{}}', 1784142261),
      ('depeg-resolver-review:snapshot',
       '{"generation":2,"methodologyVersion":"3.04","payload":{}}', 1784142261),
      ('ddr:repair-debt:v1',
       '{"checkedAt":1784142257,"count":4,"events":[{"eventId":90589},{"eventId":90591},{"eventId":90594},{"eventId":90595}],"eventsTruncated":false}',
       1784142261);
  `);
}

function migrationLedgerCounts(db: DatabaseSync): unknown {
  return db
    .prepare(
      `SELECT
         (SELECT COUNT(*) FROM depeg_resolver_event_repair_authorizations
          WHERE created_by = 'migration-0208') AS authorizations,
         (SELECT COUNT(*)
          FROM depeg_resolver_event_repair_authorization_consumptions c
          JOIN depeg_resolver_event_repair_authorizations a ON a.id = c.authorization_id
          WHERE a.created_by = 'migration-0208') AS consumptions,
         (SELECT COUNT(*) FROM depeg_resolver_incident_event_links
          WHERE event_id IN (90589, 90591, 90594, 90595)) AS links,
         (SELECT COUNT(*) FROM depeg_resolver_incident_revisions
          WHERE created_by = 'migration-0208') AS revisions`,
    )
    .get();
}

describe("0208 EURQ DDR repair migration", () => {
  it("links the reviewed chain, advances ordered lineage, and replays idempotently", () => {
    const db = new DatabaseSync(":memory:");
    try {
      seedReviewedEurqState(db);
      applyMigration(db, TARGET_MIGRATION);

      expect(
        db
          .prepare(
            `SELECT event_id, incident_key, relation, repair_authorization_id IS NOT NULL AS authorized
             FROM depeg_resolver_incident_event_links
             WHERE event_id IN (90589, 90591, 90594, 90595)
             ORDER BY event_id`,
          )
          .all(),
      ).toEqual(
        [90589, 90591, 90594, 90595].map((eventId) => ({
          event_id: eventId,
          incident_key: INCIDENT_KEY,
          relation: "repair_replacement",
          authorized: 1,
        })),
      );
      expect(
        db
          .prepare(
            `SELECT previous_event_id, current_event_id
             FROM depeg_resolver_incident_revisions
             WHERE created_by = 'migration-0208'
             ORDER BY id`,
          )
          .all(),
      ).toEqual([
        { previous_event_id: 90560, current_event_id: 90589 },
        { previous_event_id: 90589, current_event_id: 90591 },
        { previous_event_id: 90591, current_event_id: 90594 },
        { previous_event_id: 90594, current_event_id: 90595 },
      ]);
      expect(
        db
          .prepare(
            `SELECT current_event_id, current_started_at
             FROM depeg_resolver_incidents
             WHERE incident_key = ?`,
          )
          .get(INCIDENT_KEY),
      ).toEqual({ current_event_id: 90595, current_started_at: 1784135928 });
      expect(
        db
          .prepare(
            `SELECT state, COUNT(*) AS count
             FROM worker_repair_tasks
             WHERE subject_id IN ('90589', '90591', '90594', '90595')
             GROUP BY state`,
          )
          .all(),
      ).toEqual([{ state: "closed", count: 4 }]);
      expect(
        db
          .prepare(
            `SELECT COUNT(*) AS count
             FROM cache
             WHERE key IN ('depeg-resolver:snapshot', 'depeg-resolver-review:snapshot')
               AND json_extract(value, '$.methodologyVersion') = 'invalidated-eurq-ddr-repair-0208'`,
          )
          .get(),
      ).toEqual({ count: 2 });
      expect(db.prepare("SELECT COUNT(*) AS count FROM cache WHERE key = 'ddr:repair-debt:v1'").get()).toEqual({
        count: 0,
      });
      expect(migrationLedgerCounts(db)).toEqual({
        authorizations: 8,
        consumptions: 8,
        links: 4,
        revisions: 4,
      });

      applyMigration(db, TARGET_MIGRATION);

      expect(migrationLedgerCounts(db)).toEqual({
        authorizations: 8,
        consumptions: 8,
        links: 4,
        revisions: 4,
      });
    } finally {
      db.close();
    }
  });

  it("fails closed when a recovered source-row fingerprint drifts", () => {
    const db = new DatabaseSync(":memory:");
    try {
      seedReviewedEurqState(db);
      db.prepare("UPDATE depeg_events SET recovery_price = ? WHERE id = 90591").run(0.985432);

      applyMigration(db, TARGET_MIGRATION);

      expect(migrationLedgerCounts(db)).toEqual({
        authorizations: 0,
        consumptions: 0,
        links: 0,
        revisions: 0,
      });
      expect(
        db.prepare("SELECT current_event_id FROM depeg_resolver_incidents WHERE incident_key = ?").get(INCIDENT_KEY),
      ).toEqual({ current_event_id: 90560 });
      expect(
        db
          .prepare(
            `SELECT state, COUNT(*) AS count
             FROM worker_repair_tasks
             WHERE subject_id IN ('90589', '90591', '90594', '90595')
             GROUP BY state`,
          )
          .all(),
      ).toEqual([{ state: "open", count: 4 }]);
    } finally {
      db.close();
    }
  });

  it("accepts natural peak and terminal updates to the current live tail", () => {
    const db = new DatabaseSync(":memory:");
    try {
      seedReviewedEurqState(db);
      db.prepare(
        `UPDATE depeg_events
         SET peak_deviation_bps = -180,
             peak_price = 0.9825,
             ended_at = 1784143000,
             recovery_price = 0.9855,
             close_reason = 'recovered-native'
         WHERE id = 90595`,
      ).run();

      applyMigration(db, TARGET_MIGRATION);

      expect(
        db.prepare("SELECT current_event_id FROM depeg_resolver_incidents WHERE incident_key = ?").get(INCIDENT_KEY),
      ).toEqual({ current_event_id: 90595 });
      expect(migrationLedgerCounts(db)).toEqual({
        authorizations: 8,
        consumptions: 8,
        links: 4,
        revisions: 4,
      });
      expect(
        db.prepare("SELECT ended_at, recovery_price FROM depeg_events WHERE id = 90595").get(),
      ).toEqual({ ended_at: 1784143000, recovery_price: 0.9855 });
    } finally {
      db.close();
    }
  });
});
