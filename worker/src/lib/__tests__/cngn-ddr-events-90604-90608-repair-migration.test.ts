import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";

const MIGRATIONS_DIR = join(process.cwd(), "worker/migrations");
const PREVIOUS_MIGRATION = "0209_cngn_ddr_event_90599_link.sql";
const TARGET_MIGRATION = "0210_cngn_ddr_events_90604_90608_link.sql";
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
      (90599, 'cngn-compliant-naira', 'cNGN', 'peggedNGN', 'below', -158,
       1784151172, 1784154780, 0.984154, 0.984154, 0.985718, 1,
       'live', NULL, NULL, 'recovered-native'),
      (90604, 'cngn-compliant-naira', 'cNGN', 'peggedNGN', 'below', -152,
       1784189952, 1784190853, 0.984754, 0.984754, 0.988983, 1,
       'live', NULL, NULL, 'recovered-native'),
      (90606, 'cngn-compliant-naira', 'cNGN', 'peggedNGN', 'below', -152,
       1784192670, 1784194450, 0.984802, 0.984802, 0.985531, 1,
       'live', NULL, NULL, 'recovered-native'),
      (90607, 'cngn-compliant-naira', 'cNGN', 'peggedNGN', 'below', -192,
       1784197137, 1784203436, 0.982094, 0.980764, 0.985359, 1,
       'live', NULL, NULL, 'recovered-native'),
      (90608, 'cngn-compliant-naira', 'cNGN', 'peggedNGN', 'below', -154,
       1784211551, 1784212483, 0.984619, 0.984619, 0.986806, 1,
       'live', NULL, NULL, 'recovered-native');

    INSERT INTO depeg_resolver_incident_event_links
      (incident_key, event_id, relation, repair_authorization_id, linked_at, note)
    VALUES
      ('${INCIDENT_KEY}', 90511, 'observed', NULL,
       1783650915, 'initial canonical incident link'),
      ('${INCIDENT_KEY}', 90599, 'repair_replacement', NULL,
       1784153527, 'reviewed predecessor event adopted as current incident source');

    INSERT INTO depeg_resolver_incidents
      (incident_key, stablecoin_id, peg_currency, direction, first_event_id, current_event_id,
       first_started_at, current_started_at, first_observed_peak_bucket_bps, incident_state,
       superseded_by_incident_key, source_fingerprint, created_at, updated_at)
    VALUES
      ('${INCIDENT_KEY}', 'cngn-compliant-naira', 'NGN', 'below', 90511, 90599,
       1783650896, 1784151172, 150, 'active', NULL,
       'b34dc1832aa964c5828d0b50ac025a4181efdd854c644c14281838490b644a15',
       1783650915, 1784153527);

    INSERT INTO worker_repair_tasks
      (task_id, kind, subject_id, priority, state, attempt_count, payload_json, created_at, updated_at)
    VALUES
      ('repair:ddr-repair-required-event:90604', 'ddr-repair-required-event', '90604',
       50, 'open', 0, '{"eventId":90604,"reason":"Unlinked depeg event 90604 overlaps nearby canonical incident ddr2:d71d5088a08922584d989cfe03ae8388; explicit repair required"}', 1784189990, 1784262798),
      ('repair:ddr-repair-required-event:90606', 'ddr-repair-required-event', '90606',
       50, 'open', 0, '{"eventId":90606,"reason":"Unlinked depeg event 90606 overlaps nearby canonical incident ddr2:d71d5088a08922584d989cfe03ae8388; explicit repair required"}', 1784192716, 1784262798),
      ('repair:ddr-repair-required-event:90607', 'ddr-repair-required-event', '90607',
       50, 'open', 0, '{"eventId":90607,"reason":"Unlinked depeg event 90607 overlaps nearby canonical incident ddr2:d71d5088a08922584d989cfe03ae8388; explicit repair required"}', 1784197203, 1784262798),
      ('repair:ddr-repair-required-event:90608', 'ddr-repair-required-event', '90608',
       50, 'open', 0, '{"eventId":90608,"reason":"Unlinked depeg event 90608 overlaps nearby canonical incident ddr2:d71d5088a08922584d989cfe03ae8388; explicit repair required"}', 1784211595, 1784262798);

    INSERT INTO cache (key, value, updated_at)
    VALUES
      ('depeg-resolver:snapshot',
       '{"generation":2,"methodologyVersion":"3.04","payload":{}}', 1784142261),
      ('depeg-resolver-review:snapshot',
       '{"generation":2,"methodologyVersion":"3.04","payload":{}}', 1784142261),
      ('ddr:repair-debt:v1',
       '{"checkedAt":1784142257,"count":4,"events":[{"eventId":90604},{"eventId":90606},{"eventId":90607},{"eventId":90608}],"eventsTruncated":false}',
       1784142261);
  `);
}

function migrationLedgerCounts(db: DatabaseSync): unknown {
  return db
    .prepare(
      `SELECT
         (SELECT COUNT(*) FROM depeg_resolver_event_repair_authorizations
          WHERE created_by = 'migration-0210') AS authorizations,
         (SELECT COUNT(*)
          FROM depeg_resolver_event_repair_authorization_consumptions c
          JOIN depeg_resolver_event_repair_authorizations a ON a.id = c.authorization_id
          WHERE a.created_by = 'migration-0210') AS consumptions,
         (SELECT COUNT(*) FROM depeg_resolver_incident_event_links
          WHERE event_id IN (90604, 90606, 90607, 90608)) AS links,
         (SELECT COUNT(*) FROM depeg_resolver_incident_revisions
          WHERE created_by = 'migration-0210') AS revisions`,
    )
    .get();
}

describe("0210 cNGN DDR repair migration", () => {
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
             WHERE event_id IN (90604, 90606, 90607, 90608)
             ORDER BY event_id`,
          )
          .all(),
      ).toEqual(
        [90604, 90606, 90607, 90608].map((eventId) => ({
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
             WHERE created_by = 'migration-0210'
             ORDER BY id`,
          )
          .all(),
      ).toEqual([
        { previous_event_id: 90599, current_event_id: 90604 },
        { previous_event_id: 90604, current_event_id: 90606 },
        { previous_event_id: 90606, current_event_id: 90607 },
        { previous_event_id: 90607, current_event_id: 90608 },
      ]);
      expect(
        db
          .prepare(
            `SELECT current_event_id, current_started_at
             FROM depeg_resolver_incidents
             WHERE incident_key = ?`,
          )
          .get(INCIDENT_KEY),
      ).toEqual({ current_event_id: 90608, current_started_at: 1784211551 });
      expect(
        db
          .prepare(
            `SELECT state, COUNT(*) AS count
             FROM worker_repair_tasks
             WHERE subject_id IN ('90604', '90606', '90607', '90608')
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
               AND json_extract(value, '$.methodologyVersion') = 'invalidated-cngn-ddr-repair-0210'`,
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
      seedReviewedCngnState(db);
      db.prepare("UPDATE depeg_events SET recovery_price = ? WHERE id = 90606").run(0.985532);

      applyMigration(db, TARGET_MIGRATION);

      expect(migrationLedgerCounts(db)).toEqual({
        authorizations: 0,
        consumptions: 0,
        links: 0,
        revisions: 0,
      });
      expect(
        db.prepare("SELECT current_event_id FROM depeg_resolver_incidents WHERE incident_key = ?").get(INCIDENT_KEY),
      ).toEqual({ current_event_id: 90599 });
      expect(
        db
          .prepare(
            `SELECT state, COUNT(*) AS count
             FROM worker_repair_tasks
             WHERE subject_id IN ('90604', '90606', '90607', '90608')
             GROUP BY state`,
          )
          .all(),
      ).toEqual([{ state: "open", count: 4 }]);
    } finally {
      db.close();
    }
  });

  it("fails closed when a deterministic repair-task payload drifts", () => {
    const db = new DatabaseSync(":memory:");
    try {
      seedReviewedCngnState(db);
      db.prepare("UPDATE worker_repair_tasks SET payload_json = ? WHERE subject_id = '90608'").run(
        '{"eventId":90608,"reason":"operator review changed"}',
      );

      applyMigration(db, TARGET_MIGRATION);

      expect(migrationLedgerCounts(db)).toEqual({
        authorizations: 0,
        consumptions: 0,
        links: 0,
        revisions: 0,
      });
      expect(
        db.prepare("SELECT current_event_id FROM depeg_resolver_incidents WHERE incident_key = ?").get(INCIDENT_KEY),
      ).toEqual({ current_event_id: 90599 });
    } finally {
      db.close();
    }
  });
});
