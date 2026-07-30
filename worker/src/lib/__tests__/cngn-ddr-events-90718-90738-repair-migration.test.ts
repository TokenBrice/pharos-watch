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
const PREVIOUS_MIGRATION = "0226_safety_score_v9_canonical_cache.sql";
const TARGET_MIGRATION = "0227_cngn_ddr_events_90718_90738_link.sql";
const INCIDENT_KEY = "ddr2:d71d5088a08922584d989cfe03ae8388";

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
  applyThrough(db, PREVIOUS_MIGRATION);

  db.exec(`
    INSERT INTO depeg_events
      (id, stablecoin_id, symbol, peg_type, direction, peak_deviation_bps,
       started_at, ended_at, start_price, peak_price, recovery_price, peg_reference,
       source, confirmation_sources, pending_reason, close_reason)
    VALUES
      (90666, 'cngn-compliant-naira', 'cNGN', 'peggedNGN', 'below', -150,
       1784383381, 1784384266, 0.985047, 0.985047, 0.985088, 1,
       'live', NULL, NULL, 'recovered-native'),
      (90718, 'cngn-compliant-naira', 'cNGN', 'peggedNGN', 'below', -153,
       1784486946, 1784487834, 0.984714, 0.984714, 0.985124, 1,
       'live', NULL, NULL, 'recovered-native'),
      (90729, 'cngn-compliant-naira', 'cNGN', 'peggedNGN', 'below', -150,
       1784521129, 1784522926, 0.984981, 0.984981, 0.985662, 1,
       'live', NULL, NULL, 'recovered-native'),
      (90738, 'cngn-compliant-naira', 'cNGN', 'peggedNGN', 'below', -348,
       1784641668, NULL, 0.9830659719443444, 0.9651966805021148, NULL, 1,
       'live', 'temporal:15m', 'confirmation-window+native-origin', NULL);

    INSERT INTO depeg_resolver_event_repair_authorizations
      (event_id, incident_key, operation, columns_json, required_revision_id, required_erratum_id,
       reason, created_at, expires_at, created_by)
    VALUES
      (90666, '${INCIDENT_KEY}', 'incident_link', '["event_id","incident_key"]',
       NULL, NULL,
       'cNGN live flap 90666 belongs to the unsealed event 90511 canonical incident',
       1784400878, 4102444800, 'migration-0215'),
      (90666, '${INCIDENT_KEY}', 'incident_current_update', '["current_event_id","current_started_at"]',
       NULL, NULL,
       'reviewed cNGN live flap 90666 follows event 90664 as the canonical current source',
       1784400879, 4102444800, 'migration-0215');

    INSERT INTO depeg_resolver_event_repair_authorization_consumptions
      (authorization_id, event_id, incident_key, operation, consumed_at, consumer)
    SELECT id, event_id, incident_key, operation, 1784400879, 'migration-0215'
    FROM depeg_resolver_event_repair_authorizations
    WHERE event_id = 90666 AND created_by = 'migration-0215';

    INSERT INTO depeg_resolver_incident_event_links
      (incident_key, event_id, relation, repair_authorization_id, linked_at, note)
    SELECT incident_key, event_id, 'repair_replacement', id, 1784400879,
           'reviewed cNGN live flap linked through explicit repair authorization'
    FROM depeg_resolver_event_repair_authorizations
    WHERE event_id = 90666
      AND operation = 'incident_link'
      AND created_by = 'migration-0215';

    INSERT INTO depeg_resolver_incidents
      (incident_key, stablecoin_id, peg_currency, direction, first_event_id, current_event_id,
       first_started_at, current_started_at, first_observed_peak_bucket_bps, incident_state,
       superseded_by_incident_key, source_fingerprint, created_at, updated_at)
    VALUES
      ('${INCIDENT_KEY}', 'cngn-compliant-naira', 'NGN', 'below', 90511, 90666,
       1783650896, 1784383381, 150, 'active', NULL,
       'b34dc1832aa964c5828d0b50ac025a4181efdd854c644c14281838490b644a15',
       1783650915, 1784400880);

    INSERT INTO depeg_resolver_incident_revisions
      (incident_key, previous_event_id, current_event_id, reason, repair_authorization_id,
       erratum_id, created_at, created_by)
    SELECT incident_key, 90664, 90666,
           'reviewed cNGN live flap 90666 adopted after event 90664',
           id, NULL, 1784400879, 'migration-0215'
    FROM depeg_resolver_event_repair_authorizations
    WHERE event_id = 90666
      AND operation = 'incident_current_update'
      AND created_by = 'migration-0215';

    INSERT INTO worker_repair_tasks
      (task_id, kind, subject_id, priority, state, attempt_count, payload_json, created_at, updated_at)
    VALUES
      ('repair:ddr-repair-required-event:90718', 'ddr-repair-required-event', '90718',
       50, 'open', 0, '{"eventId":90718,"reason":"Unlinked depeg event 90718 overlaps nearby canonical incident ${INCIDENT_KEY}; explicit repair required"}', 1784486988, 1785331051),
      ('repair:ddr-repair-required-event:90729', 'ddr-repair-required-event', '90729',
       50, 'open', 0, '{"eventId":90729,"reason":"Unlinked depeg event 90729 overlaps nearby canonical incident ${INCIDENT_KEY}; explicit repair required"}', 1784521171, 1785331051),
      ('repair:ddr-repair-required-event:90738', 'ddr-repair-required-event', '90738',
       50, 'open', 0, '{"eventId":90738,"reason":"Unlinked depeg event 90738 overlaps nearby canonical incident ${INCIDENT_KEY}; explicit repair required"}', 1784642653, 1785331051);

    INSERT INTO cache (key, value, updated_at)
    VALUES
      ('depeg-resolver:snapshot',
       '{"generation":3,"methodologyVersion":"3.04","payload":{}}', 1785331067),
      ('depeg-resolver-review:snapshot',
       '{"generation":3,"methodologyVersion":"3.04","payload":{}}', 1785331071),
      ('ddr:repair-debt:v1',
       '{"checkedAt":1785331051,"count":3,"events":[{"eventId":90718},{"eventId":90729},{"eventId":90738}],"eventsTruncated":false}',
       1785331056);
  `);
}

function migrationLedgerCounts(db: DatabaseSync): unknown {
  return db
    .prepare(
      `SELECT
         (SELECT COUNT(*) FROM depeg_resolver_event_repair_authorizations
          WHERE created_by = 'migration-0227') AS authorizations,
         (SELECT COUNT(*)
          FROM depeg_resolver_event_repair_authorization_consumptions c
          JOIN depeg_resolver_event_repair_authorizations a ON a.id = c.authorization_id
          WHERE a.created_by = 'migration-0227') AS consumptions,
         (SELECT COUNT(*) FROM depeg_resolver_incident_event_links
          WHERE event_id IN (90718, 90729, 90738)) AS links,
         (SELECT COUNT(*) FROM depeg_resolver_incident_revisions
          WHERE created_by = 'migration-0227') AS revisions`,
    )
    .get();
}

function expectRepairNotApplied(db: DatabaseSync): void {
  expect(migrationLedgerCounts(db)).toEqual({
    authorizations: 0,
    consumptions: 0,
    links: 0,
    revisions: 0,
  });
  expect(
    db.prepare("SELECT current_event_id FROM depeg_resolver_incidents WHERE incident_key = ?").get(INCIDENT_KEY),
  ).toEqual({ current_event_id: 90666 });
  expect(
    db
      .prepare(
        `SELECT state, COUNT(*) AS count
         FROM worker_repair_tasks
         WHERE subject_id IN ('90718', '90729', '90738')
         GROUP BY state`,
      )
      .all(),
  ).toEqual([{ state: "open", count: 3 }]);
}

describe("0227 cNGN DDR repair migration", () => {
  it("links the reviewed chain, advances ordered lineage, and replays idempotently", () => {
    const db = new DatabaseSync(":memory:");
    try {
      seedReviewedCngnState(db);
      applyMigration(db, TARGET_MIGRATION);

      expect(
        db
          .prepare(
            `SELECT event_id, incident_key, relation, repair_authorization_id IS NOT NULL AS authorized
             FROM depeg_resolver_incident_event_links
             WHERE event_id IN (90718, 90729, 90738)
             ORDER BY event_id`,
          )
          .all(),
      ).toEqual(
        [90718, 90729, 90738].map((eventId) => ({
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
             WHERE created_by = 'migration-0227'
             ORDER BY id`,
          )
          .all(),
      ).toEqual([
        { previous_event_id: 90666, current_event_id: 90718 },
        { previous_event_id: 90718, current_event_id: 90729 },
        { previous_event_id: 90729, current_event_id: 90738 },
      ]);
      expect(
        db
          .prepare(
            `SELECT current_event_id, current_started_at
             FROM depeg_resolver_incidents
             WHERE incident_key = ?`,
          )
          .get(INCIDENT_KEY),
      ).toEqual({ current_event_id: 90738, current_started_at: 1784641668 });
      expect(
        db
          .prepare(
            `SELECT state, COUNT(*) AS count
             FROM worker_repair_tasks
             WHERE subject_id IN ('90718', '90729', '90738')
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
               AND json_extract(value, '$.methodologyVersion') = 'invalidated-cngn-ddr-repair-0227'`,
          )
          .get(),
      ).toEqual({ count: 2 });
      expect(db.prepare("SELECT COUNT(*) AS count FROM cache WHERE key = 'ddr:repair-debt:v1'").get()).toEqual({
        count: 0,
      });
      expect(migrationLedgerCounts(db)).toEqual({
        authorizations: 6,
        consumptions: 6,
        links: 3,
        revisions: 3,
      });

      applyMigration(db, TARGET_MIGRATION);
      expect(migrationLedgerCounts(db)).toEqual({
        authorizations: 6,
        consumptions: 6,
        links: 3,
        revisions: 3,
      });
    } finally {
      db.close();
    }
  });

  it("does not depend on the live tail's mutable peak and terminal fields", () => {
    const db = new DatabaseSync(":memory:");
    try {
      seedReviewedCngnState(db);
      db.prepare(
        `UPDATE depeg_events
         SET peak_deviation_bps = ?, peak_price = ?, ended_at = ?,
             recovery_price = ?, close_reason = ?
         WHERE id = 90738`,
      ).run(-401, 0.9599, 1785332000, 0.9852, "recovered-native");

      applyMigration(db, TARGET_MIGRATION);

      expect(migrationLedgerCounts(db)).toEqual({
        authorizations: 6,
        consumptions: 6,
        links: 3,
        revisions: 3,
      });
      expect(db.prepare("SELECT current_event_id FROM depeg_resolver_incidents WHERE incident_key = ?").get(INCIDENT_KEY))
        .toEqual({ current_event_id: 90738 });
    } finally {
      db.close();
    }
  });

  it("fails closed when a reviewed closed-event fingerprint drifts", () => {
    const db = new DatabaseSync(":memory:");
    try {
      seedReviewedCngnState(db);
      db.prepare("UPDATE depeg_events SET recovery_price = ? WHERE id = 90729").run(0.985663);

      applyMigration(db, TARGET_MIGRATION);

      expectRepairNotApplied(db);
    } finally {
      db.close();
    }
  });
});
