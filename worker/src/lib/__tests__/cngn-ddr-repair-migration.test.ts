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
const TARGET_MIGRATION = "0206_cngn_ddr_events_90573_90584_link.sql";

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

function seedReviewedCngnState(db: DatabaseSync): void {
  applyThrough(db, "0202_safety_score_v9_movement_reviews.sql");

  db.exec(`
    INSERT INTO depeg_events
      (id, stablecoin_id, symbol, peg_type, direction, peak_deviation_bps,
       started_at, ended_at, start_price, peak_price, recovery_price, peg_reference,
       source, confirmation_sources, pending_reason, close_reason)
    VALUES
      (90548, 'cngn-compliant-naira', 'cNGN', 'peggedNGN', 'below', -172,
       1783946864, 1783947766, 0.982818, 0.982818, 0.989082, 1,
       'live', NULL, NULL, 'recovered-native');

    INSERT INTO depeg_resolver_incident_event_links
      (incident_key, event_id, relation, repair_authorization_id, linked_at, note)
    VALUES
      ('ddr2:d71d5088a08922584d989cfe03ae8388', 90511, 'observed', NULL,
       1783650915, 'initial canonical incident link'),
      ('ddr2:d71d5088a08922584d989cfe03ae8388', 90526, 'repair_replacement', NULL,
       1783791336, 'pre-lock nearby event adopted as current incident source');

    INSERT INTO depeg_resolver_incidents
      (incident_key, stablecoin_id, peg_currency, direction, first_event_id, current_event_id,
       first_started_at, current_started_at, first_observed_peak_bucket_bps, incident_state,
       superseded_by_incident_key, source_fingerprint, created_at, updated_at)
    VALUES
      ('ddr2:d71d5088a08922584d989cfe03ae8388', 'cngn-compliant-naira', 'NGN', 'below',
       90511, 90526, 1783650896, 1783791323, 150, 'active', NULL,
       'b34dc1832aa964c5828d0b50ac025a4181efdd854c644c14281838490b644a15',
       1783650915, 1783791336);

    INSERT INTO worker_repair_tasks
      (task_id, kind, subject_id, priority, state, attempt_count, payload_json, created_at, updated_at)
    VALUES
      ('repair:ddr-repair-required-event:90548', 'ddr-repair-required-event', '90548',
       50, 'open', 0, '{"eventId":90548}', 1783947770, 1783947770);
  `);

  applyMigration(db, "0203_cngn_ddr_event_90548_link.sql");
  applyMigration(db, "0204_safety_score_history_v2_identity_schema.sql");
  applyMigration(db, "0205_dex_measured_execution.sql");

  db.exec(`
    INSERT INTO depeg_events
      (id, stablecoin_id, symbol, peg_type, direction, peak_deviation_bps,
       started_at, ended_at, start_price, peak_price, recovery_price, peg_reference,
       source, confirmation_sources, pending_reason, close_reason)
    VALUES
      (90573, 'cngn-compliant-naira', 'cNGN', 'peggedNGN', 'below', -151,
       1784085475, 1784089078, 0.985015, 0.984898, 0.985054, 1,
       'live', NULL, NULL, 'recovered-native'),
      (90576, 'cngn-compliant-naira', 'cNGN', 'peggedNGN', 'below', -151,
       1784089988, 1784098070, 0.984992, 0.984903, 0.985182, 1,
       'live', NULL, NULL, 'recovered-native'),
      (90584, 'cngn-compliant-naira', 'cNGN', 'peggedNGN', 'below', -150,
       1784108016, 1784108885, 0.98504, 0.98504, 0.985101, 1,
       'live', NULL, NULL, 'recovered-native');

    INSERT INTO worker_repair_tasks
      (task_id, kind, subject_id, priority, state, attempt_count, payload_json, created_at, updated_at)
    VALUES
      ('repair:ddr-repair-required-event:90573', 'ddr-repair-required-event', '90573',
       50, 'open', 0, '{"eventId":90573}', 1784089080, 1784124363),
      ('repair:ddr-repair-required-event:90576', 'ddr-repair-required-event', '90576',
       50, 'open', 0, '{"eventId":90576}', 1784098072, 1784124363),
      ('repair:ddr-repair-required-event:90584', 'ddr-repair-required-event', '90584',
       50, 'open', 0, '{"eventId":90584}', 1784108887, 1784124363);

    INSERT INTO cache (key, value, updated_at)
    VALUES
      ('depeg-resolver:snapshot',
       '{"generation":2,"methodologyVersion":"3.04","payload":{}}', 1784124363),
      ('depeg-resolver-review:snapshot',
       '{"generation":2,"methodologyVersion":"3.04","payload":{}}', 1784124363),
      ('ddr:repair-debt:v1',
       '{"checkedAt":1784124358,"count":3,"events":[{"eventId":90573},{"eventId":90576},{"eventId":90584}],"eventsTruncated":false}',
       1784124363);
  `);
}

function migrationLedgerCounts(db: DatabaseSync): unknown {
  return db
    .prepare(
      `SELECT
         (SELECT COUNT(*) FROM depeg_resolver_event_repair_authorizations
          WHERE created_by = 'migration-0206') AS authorizations,
         (SELECT COUNT(*)
          FROM depeg_resolver_event_repair_authorization_consumptions c
          JOIN depeg_resolver_event_repair_authorizations a ON a.id = c.authorization_id
          WHERE a.created_by = 'migration-0206') AS consumptions,
         (SELECT COUNT(*) FROM depeg_resolver_incident_event_links
          WHERE event_id IN (90573, 90576, 90584)) AS links,
         (SELECT COUNT(*) FROM depeg_resolver_incident_revisions
          WHERE created_by = 'migration-0206') AS revisions`,
    )
    .get();
}

describe("0206 cNGN DDR repair migration", () => {
  it("links all reviewed flaps, advances each revision in order, and replays idempotently", () => {
    const db = new DatabaseSync(":memory:");
    try {
      seedReviewedCngnState(db);
      applyMigration(db, TARGET_MIGRATION);

      expect(
        db
          .prepare(
            `SELECT event_id, incident_key, relation, repair_authorization_id IS NOT NULL AS authorized
             FROM depeg_resolver_incident_event_links
             WHERE event_id IN (90573, 90576, 90584)
             ORDER BY event_id`,
          )
          .all(),
      ).toEqual([
        {
          event_id: 90573,
          incident_key: "ddr2:d71d5088a08922584d989cfe03ae8388",
          relation: "repair_replacement",
          authorized: 1,
        },
        {
          event_id: 90576,
          incident_key: "ddr2:d71d5088a08922584d989cfe03ae8388",
          relation: "repair_replacement",
          authorized: 1,
        },
        {
          event_id: 90584,
          incident_key: "ddr2:d71d5088a08922584d989cfe03ae8388",
          relation: "repair_replacement",
          authorized: 1,
        },
      ]);
      expect(
        db
          .prepare(
            `SELECT previous_event_id, current_event_id
             FROM depeg_resolver_incident_revisions
             WHERE created_by = 'migration-0206'
             ORDER BY id`,
          )
          .all(),
      ).toEqual([
        { previous_event_id: 90548, current_event_id: 90573 },
        { previous_event_id: 90573, current_event_id: 90576 },
        { previous_event_id: 90576, current_event_id: 90584 },
      ]);
      expect(
        db
          .prepare(
            `SELECT current_event_id, current_started_at
             FROM depeg_resolver_incidents
             WHERE incident_key = 'ddr2:d71d5088a08922584d989cfe03ae8388'`,
          )
          .get(),
      ).toEqual({ current_event_id: 90584, current_started_at: 1784108016 });
      expect(
        db
          .prepare(
            `SELECT operation, COUNT(*) AS count
             FROM depeg_resolver_event_repair_authorizations
             WHERE created_by = 'migration-0206'
             GROUP BY operation
             ORDER BY operation`,
          )
          .all(),
      ).toEqual([
        { operation: "incident_current_update", count: 3 },
        { operation: "incident_link", count: 3 },
      ]);
      expect(
        db
          .prepare(
            `SELECT state, COUNT(*) AS count
             FROM worker_repair_tasks
             WHERE subject_id IN ('90573', '90576', '90584')
             GROUP BY state`,
          )
          .all(),
      ).toEqual([{ state: "closed", count: 3 }]);
      expect(
        db
          .prepare(
            `SELECT COUNT(*) AS count
             FROM cache
             WHERE key IN ('depeg-resolver:snapshot', 'depeg-resolver-review:snapshot')
               AND json_extract(value, '$.methodologyVersion') = 'invalidated-cngn-ddr-repair-0206'`,
          )
          .get(),
      ).toEqual({ count: 2 });
      expect(db.prepare("SELECT COUNT(*) AS count FROM cache WHERE key = 'ddr:repair-debt:v1'").get()).toEqual({
        count: 0,
      });
      expect(migrationLedgerCounts(db)).toEqual({ authorizations: 6, consumptions: 6, links: 3, revisions: 3 });

      applyMigration(db, TARGET_MIGRATION);

      expect(migrationLedgerCounts(db)).toEqual({ authorizations: 6, consumptions: 6, links: 3, revisions: 3 });
      expect(
        db
          .prepare(
            `SELECT current_event_id FROM depeg_resolver_incidents
             WHERE incident_key = 'ddr2:d71d5088a08922584d989cfe03ae8388'`,
          )
          .get(),
      ).toEqual({ current_event_id: 90584 });
    } finally {
      db.close();
    }
  });

  it("refuses the entire repair when one reviewed source-row fingerprint changes", () => {
    const db = new DatabaseSync(":memory:");
    try {
      seedReviewedCngnState(db);
      db.prepare("UPDATE depeg_events SET recovery_price = ? WHERE id = ?").run(0.985183, 90576);

      applyMigration(db, TARGET_MIGRATION);

      expect(migrationLedgerCounts(db)).toEqual({ authorizations: 0, consumptions: 0, links: 0, revisions: 0 });
      expect(
        db
          .prepare(
            `SELECT current_event_id FROM depeg_resolver_incidents
             WHERE incident_key = 'ddr2:d71d5088a08922584d989cfe03ae8388'`,
          )
          .get(),
      ).toEqual({ current_event_id: 90548 });
      expect(
        db
          .prepare(
            `SELECT state, COUNT(*) AS count
             FROM worker_repair_tasks
             WHERE subject_id IN ('90573', '90576', '90584')
             GROUP BY state`,
          )
          .all(),
      ).toEqual([{ state: "open", count: 3 }]);
      expect(
        db
          .prepare(
            `SELECT COUNT(*) AS count FROM cache
             WHERE key = 'ddr:repair-debt:v1'`,
          )
          .get(),
      ).toEqual({ count: 1 });
      expect(
        db
          .prepare(
            `SELECT COUNT(*) AS count FROM cache
             WHERE key IN ('depeg-resolver:snapshot', 'depeg-resolver-review:snapshot')
               AND json_extract(value, '$.methodologyVersion') = '3.04'`,
          )
          .get(),
      ).toEqual({ count: 2 });
    } finally {
      db.close();
    }
  });

  it("keeps a repair-debt marker that also contains unrelated cache-only debt", () => {
    const db = new DatabaseSync(":memory:");
    try {
      seedReviewedCngnState(db);
      const marker =
        '{"checkedAt":1784124358,"count":4,"events":[{"eventId":90573},{"eventId":90576},{"eventId":90584},{"eventId":99999}],"eventsTruncated":false}';
      db.prepare("UPDATE cache SET value = ? WHERE key = 'ddr:repair-debt:v1'").run(marker);

      applyMigration(db, TARGET_MIGRATION);

      expect(
        db
          .prepare(
            `SELECT current_event_id FROM depeg_resolver_incidents
             WHERE incident_key = 'ddr2:d71d5088a08922584d989cfe03ae8388'`,
          )
          .get(),
      ).toEqual({ current_event_id: 90584 });
      expect(db.prepare("SELECT value FROM cache WHERE key = 'ddr:repair-debt:v1'").get()).toEqual({ value: marker });
    } finally {
      db.close();
    }
  });

  it("keeps a malformed marker with an extra event that has no event ID", () => {
    const db = new DatabaseSync(":memory:");
    try {
      seedReviewedCngnState(db);
      const marker =
        '{"checkedAt":1784124358,"count":3,"events":[{"eventId":90573},{"eventId":90576},{"eventId":90584},{}],"eventsTruncated":false}';
      db.prepare("UPDATE cache SET value = ? WHERE key = 'ddr:repair-debt:v1'").run(marker);

      applyMigration(db, TARGET_MIGRATION);

      expect(
        db
          .prepare(
            `SELECT current_event_id FROM depeg_resolver_incidents
             WHERE incident_key = 'ddr2:d71d5088a08922584d989cfe03ae8388'`,
          )
          .get(),
      ).toEqual({ current_event_id: 90584 });
      expect(db.prepare("SELECT value FROM cache WHERE key = 'ddr:repair-debt:v1'").get()).toEqual({ value: marker });
    } finally {
      db.close();
    }
  });
});
