import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";

const MIGRATIONS_DIR = join(process.cwd(), "worker/migrations");
const PREVIOUS_MIGRATION = "0214_dex_price_publication_staging.sql";
const PREDECESSOR_REPAIR_MIGRATION = "0212_cngn_ddr_events_90638_90658_link.sql";
const TARGET_MIGRATION = "0215_cngn_ddr_events_90664_90666_link.sql";
const INCIDENT_KEY = "ddr2:d71d5088a08922584d989cfe03ae8388";

function applyMigration(db: DatabaseSync, file: string): void {
  // Test-only replay of repo-controlled migration files.
  // eslint-disable-next-line security/detect-non-literal-fs-filename
  db.exec(readFileSync(join(MIGRATIONS_DIR, file), "utf8"));
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
      (90608, 'cngn-compliant-naira', 'cNGN', 'peggedNGN', 'below', -154,
       1784211551, 1784212483, 0.984619, 0.984619, 0.986806, 1,
       'live', NULL, NULL, 'recovered-native'),
      (90638, 'cngn-compliant-naira', 'cNGN', 'peggedNGN', 'below', -155,
       1784319509, 1784320451, 0.98448, 0.98448, 0.986766, 1,
       'live', NULL, NULL, 'recovered-native'),
      (90658, 'cngn-compliant-naira', 'cNGN', 'peggedNGN', 'below', -156,
       1784375257, 1784379776, 0.984406, 0.984406, 0.985062, 1,
       'live', NULL, NULL, 'recovered-native');

    INSERT INTO depeg_resolver_incident_event_links
      (incident_key, event_id, relation, repair_authorization_id, linked_at, note)
    VALUES
      ('${INCIDENT_KEY}', 90511, 'observed', NULL,
       1783650915, 'initial canonical incident link'),
      ('${INCIDENT_KEY}', 90608, 'repair_replacement', NULL,
       1784211595, 'reviewed predecessor event adopted as current incident source');

    INSERT INTO depeg_resolver_incidents
      (incident_key, stablecoin_id, peg_currency, direction, first_event_id, current_event_id,
       first_started_at, current_started_at, first_observed_peak_bucket_bps, incident_state,
       superseded_by_incident_key, source_fingerprint, created_at, updated_at)
    VALUES
      ('${INCIDENT_KEY}', 'cngn-compliant-naira', 'NGN', 'below', 90511, 90608,
       1783650896, 1784211551, 150, 'active', NULL,
       'b34dc1832aa964c5828d0b50ac025a4181efdd854c644c14281838490b644a15',
       1783650915, 1784211595);

    INSERT INTO worker_repair_tasks
      (task_id, kind, subject_id, priority, state, attempt_count, payload_json, created_at, updated_at)
    VALUES
      ('repair:ddr-repair-required-event:90638', 'ddr-repair-required-event', '90638',
       50, 'open', 0, '{"eventId":90638,"reason":"Unlinked depeg event 90638 overlaps nearby canonical incident ddr2:d71d5088a08922584d989cfe03ae8388; explicit repair required"}', 1784319550, 1784382000),
      ('repair:ddr-repair-required-event:90658', 'ddr-repair-required-event', '90658',
       50, 'open', 0, '{"eventId":90658,"reason":"Unlinked depeg event 90658 overlaps nearby canonical incident ddr2:d71d5088a08922584d989cfe03ae8388; explicit repair required"}', 1784375300, 1784382000);

    INSERT INTO cache (key, value, updated_at)
    VALUES
      ('depeg-resolver:snapshot',
       '{"generation":3,"methodologyVersion":"3.04","payload":{}}', 1784382000),
      ('depeg-resolver-review:snapshot',
       '{"generation":3,"methodologyVersion":"3.04","payload":{}}', 1784382000),
      ('ddr:repair-debt:v1',
       '{"checkedAt":1784382000,"count":2,"events":[{"eventId":90638},{"eventId":90658}],"eventsTruncated":false}',
       1784382000);
  `);

  applyMigration(db, PREDECESSOR_REPAIR_MIGRATION);

  db.exec(`
    INSERT INTO depeg_events
      (id, stablecoin_id, symbol, peg_type, direction, peak_deviation_bps,
       started_at, ended_at, start_price, peak_price, recovery_price, peg_reference,
       source, confirmation_sources, pending_reason, close_reason)
    VALUES
      (90664, 'cngn-compliant-naira', 'cNGN', 'peggedNGN', 'below', -151,
       1784380665, 1784381584, 0.984936, 0.984936, 0.985057, 1,
       'live', NULL, NULL, 'recovered-native'),
      (90666, 'cngn-compliant-naira', 'cNGN', 'peggedNGN', 'below', -150,
       1784383381, 1784384266, 0.985047, 0.985047, 0.985088, 1,
       'live', NULL, NULL, 'recovered-native');

    INSERT INTO worker_repair_tasks
      (task_id, kind, subject_id, priority, state, attempt_count, payload_json, created_at, updated_at)
    VALUES
      ('repair:ddr-repair-required-event:90664', 'ddr-repair-required-event', '90664',
       50, 'open', 0, '{"eventId":90664,"reason":"Unlinked depeg event 90664 overlaps nearby canonical incident ddr2:d71d5088a08922584d989cfe03ae8388; explicit repair required"}', 1784380710, 1784395196),
      ('repair:ddr-repair-required-event:90666', 'ddr-repair-required-event', '90666',
       50, 'open', 0, '{"eventId":90666,"reason":"Unlinked depeg event 90666 overlaps nearby canonical incident ddr2:d71d5088a08922584d989cfe03ae8388; explicit repair required"}', 1784383404, 1784395196);

    UPDATE cache
    SET value = '{"generation":2,"methodologyVersion":"3.04","payload":{}}',
        updated_at = CASE key
          WHEN 'depeg-resolver:snapshot' THEN 1784395214
          ELSE 1784395219
        END
    WHERE key IN ('depeg-resolver:snapshot', 'depeg-resolver-review:snapshot');

    INSERT INTO cache (key, value, updated_at)
    VALUES
      ('ddr:repair-debt:v1',
       '{"checkedAt":1784395196,"count":2,"events":[{"eventId":90664},{"eventId":90666}],"eventsTruncated":false}',
       1784395203);
  `);
}

function migrationLedgerCounts(db: DatabaseSync): unknown {
  return db
    .prepare(
      `SELECT
         (SELECT COUNT(*) FROM depeg_resolver_event_repair_authorizations
          WHERE created_by = 'migration-0215') AS authorizations,
         (SELECT COUNT(*)
          FROM depeg_resolver_event_repair_authorization_consumptions c
          JOIN depeg_resolver_event_repair_authorizations a ON a.id = c.authorization_id
          WHERE a.created_by = 'migration-0215') AS consumptions,
         (SELECT COUNT(*) FROM depeg_resolver_incident_event_links
          WHERE event_id IN (90664, 90666)) AS links,
         (SELECT COUNT(*) FROM depeg_resolver_incident_revisions
          WHERE created_by = 'migration-0215') AS revisions`,
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
  ).toEqual({ current_event_id: 90658 });
  expect(
    db
      .prepare(
        `SELECT state, COUNT(*) AS count
         FROM worker_repair_tasks
         WHERE subject_id IN ('90664', '90666')
         GROUP BY state`,
      )
      .all(),
  ).toEqual([{ state: "open", count: 2 }]);
  expect(
    db
      .prepare(
        `SELECT key, json_extract(value, '$.methodologyVersion') AS methodology_version
         FROM cache
         WHERE key IN ('depeg-resolver:snapshot', 'depeg-resolver-review:snapshot')
         ORDER BY key`,
      )
      .all(),
  ).toEqual([
    { key: "depeg-resolver-review:snapshot", methodology_version: "3.04" },
    { key: "depeg-resolver:snapshot", methodology_version: "3.04" },
  ]);
  expect(db.prepare("SELECT COUNT(*) AS count FROM cache WHERE key = 'ddr:repair-debt:v1'").get()).toEqual({
    count: 1,
  });
}

describe("0215 cNGN DDR repair migration", () => {
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
             WHERE event_id IN (90664, 90666)
             ORDER BY event_id`,
          )
          .all(),
      ).toEqual(
        [90664, 90666].map((eventId) => ({
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
             WHERE created_by = 'migration-0215'
             ORDER BY id`,
          )
          .all(),
      ).toEqual([
        { previous_event_id: 90658, current_event_id: 90664 },
        { previous_event_id: 90664, current_event_id: 90666 },
      ]);
      expect(
        db
          .prepare(
            `SELECT current_event_id, current_started_at
             FROM depeg_resolver_incidents
             WHERE incident_key = ?`,
          )
          .get(INCIDENT_KEY),
      ).toEqual({ current_event_id: 90666, current_started_at: 1784383381 });
      expect(
        db
          .prepare(
            `SELECT state, COUNT(*) AS count
             FROM worker_repair_tasks
             WHERE subject_id IN ('90664', '90666')
             GROUP BY state`,
          )
          .all(),
      ).toEqual([{ state: "closed", count: 2 }]);
      expect(
        db
          .prepare(
            `SELECT COUNT(*) AS count
             FROM cache
             WHERE key IN ('depeg-resolver:snapshot', 'depeg-resolver-review:snapshot')
               AND json_extract(value, '$.methodologyVersion') = 'invalidated-cngn-ddr-repair-0215'`,
          )
          .get(),
      ).toEqual({ count: 2 });
      expect(db.prepare("SELECT COUNT(*) AS count FROM cache WHERE key = 'ddr:repair-debt:v1'").get()).toEqual({
        count: 0,
      });
      expect(migrationLedgerCounts(db)).toEqual({
        authorizations: 4,
        consumptions: 4,
        links: 2,
        revisions: 2,
      });

      applyMigration(db, TARGET_MIGRATION);

      expect(migrationLedgerCounts(db)).toEqual({
        authorizations: 4,
        consumptions: 4,
        links: 2,
        revisions: 2,
      });
    } finally {
      db.close();
    }
  });

  it("fails closed when a reviewed source-row fingerprint drifts", () => {
    const db = new DatabaseSync(":memory:");
    try {
      seedReviewedCngnState(db);
      db.prepare("UPDATE depeg_events SET recovery_price = ? WHERE id = 90666").run(0.985089);

      applyMigration(db, TARGET_MIGRATION);

      expectRepairNotApplied(db);
    } finally {
      db.close();
    }
  });

  it("fails closed when either target already has repair authorization provenance", () => {
    const db = new DatabaseSync(":memory:");
    try {
      seedReviewedCngnState(db);
      db.exec(`
        INSERT INTO depeg_resolver_event_repair_authorizations
          (event_id, incident_key, operation, columns_json, required_revision_id, required_erratum_id,
           reason, created_at, expires_at, created_by)
        VALUES
          (90664, '${INCIDENT_KEY}', 'incident_link', '["event_id","incident_key"]', NULL, NULL,
           'unexpected pre-existing authorization', 1784395300, 4102444800, 'unexpected-reviewer');
      `);

      applyMigration(db, TARGET_MIGRATION);

      expectRepairNotApplied(db);
      expect(
        db
          .prepare(
            `SELECT event_id, operation, created_by
             FROM depeg_resolver_event_repair_authorizations
             WHERE event_id IN (90664, 90666)`,
          )
          .all(),
      ).toEqual([{ event_id: 90664, operation: "incident_link", created_by: "unexpected-reviewer" }]);
    } finally {
      db.close();
    }
  });

  it("fails closed when the reviewed 0212 revisions are no longer the latest lineage", () => {
    const db = new DatabaseSync(":memory:");
    try {
      seedReviewedCngnState(db);
      db.exec(`
        INSERT INTO depeg_resolver_incident_revisions
          (incident_key, previous_event_id, current_event_id, reason, repair_authorization_id,
           erratum_id, created_at, created_by)
        VALUES
          ('${INCIDENT_KEY}', 90638, 90658, 'unexpected later lineage row', NULL,
           NULL, 4102444700, 'unexpected-reviewer');
      `);

      applyMigration(db, TARGET_MIGRATION);

      expectRepairNotApplied(db);
    } finally {
      db.close();
    }
  });
});
