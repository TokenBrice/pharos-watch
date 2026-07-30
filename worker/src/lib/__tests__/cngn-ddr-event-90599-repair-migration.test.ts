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
const PREVIOUS_MIGRATION = "0208_eurq_ddr_events_90589_90595_link.sql";
const TARGET_MIGRATION = "0209_cngn_ddr_event_90599_link.sql";
const INCIDENT_KEY = "ddr2:d71d5088a08922584d989cfe03ae8388";
const TASK_PAYLOAD =
  '{"eventId":90599,"reason":"Unlinked depeg event 90599 overlaps nearby canonical incident ddr2:d71d5088a08922584d989cfe03ae8388; explicit repair required"}';

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

function seedReviewedCngnReopen(db: DatabaseSync): void {
  applyThrough(db, PREVIOUS_MIGRATION);

  db.exec(`
    INSERT INTO depeg_events
      (id, stablecoin_id, symbol, peg_type, direction, peak_deviation_bps,
       started_at, ended_at, start_price, peak_price, recovery_price, peg_reference,
       source, confirmation_sources, pending_reason, close_reason)
    VALUES
      (90584, 'cngn-compliant-naira', 'cNGN', 'peggedNGN', 'below', -150,
       1784108016, 1784108885, 0.98504, 0.98504, 0.985101, 1,
       'live', NULL, NULL, 'recovered-native'),
      (90599, 'cngn-compliant-naira', 'cNGN', 'peggedNGN', 'below', -158,
       1784151172, NULL, 0.984154, 0.984154, NULL, 1,
       'live', NULL, NULL, NULL);

    INSERT INTO depeg_resolver_event_repair_authorizations
      (event_id, incident_key, operation, columns_json, required_revision_id, required_erratum_id,
       reason, created_at, expires_at, created_by)
    VALUES
      (90584, '${INCIDENT_KEY}', 'incident_link', '["event_id","incident_key"]',
       NULL, NULL, 'reviewed predecessor link', 1784130538, 4102444800, 'migration-0206');

    INSERT INTO depeg_resolver_event_repair_authorization_consumptions
      (authorization_id, event_id, incident_key, operation, consumed_at, consumer)
    SELECT id, event_id, incident_key, operation, 1784130538, 'migration-0206'
    FROM depeg_resolver_event_repair_authorizations
    WHERE event_id = 90584 AND operation = 'incident_link' AND created_by = 'migration-0206';

    INSERT INTO depeg_resolver_incident_event_links
      (incident_key, event_id, relation, repair_authorization_id, linked_at, note)
    VALUES
      ('${INCIDENT_KEY}', 90511, 'observed', NULL, 1783650915, 'initial canonical incident link');

    INSERT INTO depeg_resolver_incident_event_links
      (incident_key, event_id, relation, repair_authorization_id, linked_at, note)
    SELECT incident_key, event_id, 'repair_replacement', id, 1784130538,
           'recovered cNGN live flap linked through explicit repair authorization'
    FROM depeg_resolver_event_repair_authorizations
    WHERE event_id = 90584 AND operation = 'incident_link' AND created_by = 'migration-0206';

    INSERT INTO depeg_resolver_event_repair_authorizations
      (event_id, incident_key, operation, columns_json, required_revision_id, required_erratum_id,
       reason, created_at, expires_at, created_by)
    VALUES
      (90584, '${INCIDENT_KEY}', 'incident_current_update',
       '["current_event_id","current_started_at"]', NULL, NULL,
       'reviewed predecessor current update', 1784130538, 4102444800, 'migration-0206');

    INSERT INTO depeg_resolver_event_repair_authorization_consumptions
      (authorization_id, event_id, incident_key, operation, consumed_at, consumer)
    SELECT id, event_id, incident_key, operation, 1784130538, 'migration-0206'
    FROM depeg_resolver_event_repair_authorizations
    WHERE event_id = 90584
      AND operation = 'incident_current_update'
      AND created_by = 'migration-0206';

    INSERT INTO depeg_resolver_incident_revisions
      (incident_key, previous_event_id, current_event_id, reason, repair_authorization_id,
       erratum_id, created_at, created_by)
    SELECT incident_key, 90576, 90584, 'reviewed predecessor revision', id,
           NULL, 1784130538, 'migration-0206'
    FROM depeg_resolver_event_repair_authorizations
    WHERE event_id = 90584
      AND operation = 'incident_current_update'
      AND created_by = 'migration-0206';

    INSERT INTO depeg_resolver_incidents
      (incident_key, stablecoin_id, peg_currency, direction, first_event_id, current_event_id,
       first_started_at, current_started_at, first_observed_peak_bucket_bps, incident_state,
       superseded_by_incident_key, source_fingerprint, created_at, updated_at)
    VALUES
      ('${INCIDENT_KEY}', 'cngn-compliant-naira', 'NGN', 'below', 90511, 90584,
       1783650896, 1784108016, 150, 'active', NULL,
       'b34dc1832aa964c5828d0b50ac025a4181efdd854c644c14281838490b644a15',
       1783650915, 1784130538);

    INSERT INTO worker_repair_tasks
      (task_id, kind, subject_id, priority, state, attempt_count, payload_json, created_at, updated_at)
    VALUES
      ('repair:ddr-repair-required-event:90599', 'ddr-repair-required-event', '90599',
       50, 'open', 0, '${TASK_PAYLOAD}', 1784151184, 1784151184);

    INSERT INTO cache (key, value, updated_at)
    VALUES
      ('depeg-resolver:snapshot',
       '{"generation":2,"methodologyVersion":"3.04","payload":{}}', 1784151185),
      ('depeg-resolver-review:snapshot',
       '{"generation":2,"methodologyVersion":"3.04","payload":{}}', 1784151185),
      ('ddr:repair-debt:v1',
       '{"checkedAt":1784151184,"count":1,"events":[{"eventId":90599}],"eventsTruncated":false}',
       1784151185);
  `);
}

function migrationLedgerCounts(db: DatabaseSync): unknown {
  return db
    .prepare(
      `SELECT
         (SELECT COUNT(*) FROM depeg_resolver_event_repair_authorizations
          WHERE created_by = 'migration-0209') AS authorizations,
         (SELECT COUNT(*)
          FROM depeg_resolver_event_repair_authorization_consumptions c
          JOIN depeg_resolver_event_repair_authorizations a ON a.id = c.authorization_id
          WHERE a.created_by = 'migration-0209') AS consumptions,
         (SELECT COUNT(*) FROM depeg_resolver_incident_event_links
          WHERE event_id = 90599) AS links,
         (SELECT COUNT(*) FROM depeg_resolver_incident_revisions
          WHERE created_by = 'migration-0209') AS revisions`,
    )
    .get();
}

function expectRepairDidNotStart(db: DatabaseSync): void {
  expect(migrationLedgerCounts(db)).toEqual({
    authorizations: 0,
    consumptions: 0,
    links: 0,
    revisions: 0,
  });
  expect(
    db.prepare("SELECT current_event_id FROM depeg_resolver_incidents WHERE incident_key = ?").get(INCIDENT_KEY),
  ).toEqual({ current_event_id: 90584 });
  expect(db.prepare("SELECT state FROM worker_repair_tasks WHERE subject_id = '90599'").get()).toEqual({
    state: "open",
  });
}

describe("0209 cNGN DDR event 90599 repair migration", () => {
  it("links the reopen, advances lineage, preserves the event row, and replays idempotently", () => {
    const db = new DatabaseSync(":memory:");
    try {
      seedReviewedCngnReopen(db);
      const sourceBefore = db.prepare("SELECT * FROM depeg_events WHERE id = 90599").get();

      applyMigration(db, TARGET_MIGRATION);

      expect(
        db
          .prepare(
            `SELECT incident_key, relation, repair_authorization_id IS NOT NULL AS authorized
             FROM depeg_resolver_incident_event_links WHERE event_id = 90599`,
          )
          .get(),
      ).toEqual({ incident_key: INCIDENT_KEY, relation: "repair_replacement", authorized: 1 });
      expect(
        db
          .prepare(
            `SELECT previous_event_id, current_event_id
             FROM depeg_resolver_incident_revisions WHERE created_by = 'migration-0209'`,
          )
          .get(),
      ).toEqual({ previous_event_id: 90584, current_event_id: 90599 });
      expect(db.prepare("SELECT current_event_id, current_started_at FROM depeg_resolver_incidents").get()).toEqual({
        current_event_id: 90599,
        current_started_at: 1784151172,
      });
      expect(db.prepare("SELECT state FROM worker_repair_tasks WHERE subject_id = '90599'").get()).toEqual({
        state: "closed",
      });
      expect(
        db
          .prepare(
            `SELECT COUNT(*) AS count FROM cache
             WHERE key IN ('depeg-resolver:snapshot', 'depeg-resolver-review:snapshot')
               AND json_extract(value, '$.methodologyVersion') = 'invalidated-cngn-ddr-repair-0209'`,
          )
          .get(),
      ).toEqual({ count: 2 });
      expect(db.prepare("SELECT COUNT(*) AS count FROM cache WHERE key = 'ddr:repair-debt:v1'").get()).toEqual({
        count: 0,
      });
      expect(db.prepare("SELECT * FROM depeg_events WHERE id = 90599").get()).toEqual(sourceBefore);
      expect(migrationLedgerCounts(db)).toEqual({
        authorizations: 2,
        consumptions: 2,
        links: 1,
        revisions: 1,
      });

      applyMigration(db, TARGET_MIGRATION);
      expect(migrationLedgerCounts(db)).toEqual({
        authorizations: 2,
        consumptions: 2,
        links: 1,
        revisions: 1,
      });
    } finally {
      db.close();
    }
  });

  it("fails closed when the immutable source fingerprint drifts", () => {
    const db = new DatabaseSync(":memory:");
    try {
      seedReviewedCngnReopen(db);
      db.prepare("UPDATE depeg_events SET start_price = ? WHERE id = 90599").run(0.984155);

      applyMigration(db, TARGET_MIGRATION);

      expectRepairDidNotStart(db);
    } finally {
      db.close();
    }
  });

  it("fails closed when the deterministic repair-task payload drifts", () => {
    const db = new DatabaseSync(":memory:");
    try {
      seedReviewedCngnReopen(db);
      db.prepare("UPDATE worker_repair_tasks SET payload_json = ? WHERE subject_id = '90599'").run(
        '{"eventId":90599,"reason":"operator review changed"}',
      );

      applyMigration(db, TARGET_MIGRATION);

      expectRepairDidNotStart(db);
    } finally {
      db.close();
    }
  });

  it("fails closed when the canonical incident is already sealed", () => {
    const db = new DatabaseSync(":memory:");
    try {
      seedReviewedCngnReopen(db);
      const rowHash = "0000000000000000000000000000000000000000000000000000000000000000";
      const sealedPayload = JSON.stringify({
        kind: "no_call",
        eventId: 90584,
        incidentKey: INCIDENT_KEY,
        stablecoinId: "cngn-compliant-naira",
        pegCurrency: "NGN",
        direction: "below",
        startedAt: 1784108016,
        prediction: {
          eligibleAt: 1784194416,
          lockedAt: 1784194416,
          eventAgeAtLockSec: 86400,
          lockTiming: "on_time",
          policyDelaySec: 86400,
          predictionPolicyVersion: "test-policy",
          predictionMethodologyVersion: "test-methodology",
          resolutionRubricVersion: "test-rubric",
          durationModelVersion: "test-duration",
          incidentGroupingVersion: "test-grouping",
          supportRulesVersion: "test-support",
          rowHash,
        },
      });

      db.exec(`
        UPDATE depeg_events
        SET ended_at = NULL, recovery_price = NULL, close_reason = NULL
        WHERE id = 90584;

        INSERT INTO depeg_resolver_incident_policy_membership
          (incident_key, stablecoin_id, prediction_policy_version,
           public_tracked_at_first_seen, psi_shadow_at_first_seen,
           rollout_active_at_enablement, policy_universe_included,
           policy_universe_reason, registry_snapshot_json, created_at)
        VALUES
          ('${INCIDENT_KEY}', 'cngn-compliant-naira', 'test-policy',
           1, 0, 1, 1, 'post_effective_public_tracked', '{}', 1784108016);
      `);
      db.prepare(
        `INSERT INTO depeg_resolver_assessments
          (id, event_id, stablecoin_id, symbol, name, peg_currency, governance, direction,
           started_at, assessed_at, event_age_sec, checkpoint, methodology_version,
           methodology_version_label, resolution_rubric_version, duration_model_version,
           incident_grouping_version, support_rules_version, resolution_tier,
           duration_suppressed, duration_suppressed_reason, median_remaining_sec,
           iqr_low_remaining_sec, iqr_high_remaining_sec, stratum, horizons_json,
           factors_json, row_json, created_at, updated_at)
         VALUES
          (1, 90584, 'cngn-compliant-naira', 'cNGN', 'Compliant Naira', 'NGN',
           'centralized', 'below', 1784108016, 1784194416, 86400,
           'public_prediction', 'test-methodology', 'test methodology', 'test-rubric',
           'test-duration', 'test-grouping', 'test-support', 'insufficient_signal',
           1, 'insufficient_signal', NULL, NULL, NULL, NULL, '[]', '[]', ?,
           1784194416, 1784194416)`,
      ).run(sealedPayload);
      db.prepare(
        `INSERT INTO depeg_resolver_public_predictions
          (incident_key, event_id, assessment_id, outcome_kind, prediction_policy_version,
           prediction_methodology_version, prediction_methodology_version_label,
           resolution_rubric_version, duration_model_version, incident_grouping_version,
           support_rules_version, policy_delay_sec, eligible_at, locked_at,
           event_age_at_lock_sec, lock_timing, sealed_payload_json, row_hash, created_at)
         VALUES
          (?, 90584, 1, 'no_call', 'test-policy', 'test-methodology',
           'test methodology', 'test-rubric', 'test-duration', 'test-grouping',
           'test-support', 86400, 1784194416, 1784194416, 86400, 'on_time', ?, ?,
           1784194416)`,
      ).run(INCIDENT_KEY, sealedPayload, rowHash);
      db.exec(`
        UPDATE depeg_events
        SET ended_at = 1784108885,
            recovery_price = 0.985101,
            close_reason = 'recovered-native'
        WHERE id = 90584;
      `);

      applyMigration(db, TARGET_MIGRATION);

      expectRepairDidNotStart(db);
    } finally {
      db.close();
    }
  });

  it("accepts detector-owned peak and terminal updates without rewriting them", () => {
    const db = new DatabaseSync(":memory:");
    try {
      seedReviewedCngnReopen(db);
      db.prepare(
        `UPDATE depeg_events
         SET peak_deviation_bps = -190,
             peak_price = 0.981,
             ended_at = 1784153000,
             recovery_price = 0.9852,
             close_reason = 'recovered-native'
         WHERE id = 90599`,
      ).run();

      applyMigration(db, TARGET_MIGRATION);

      expect(
        db
          .prepare(
            `SELECT peak_deviation_bps, peak_price, ended_at, recovery_price, close_reason
             FROM depeg_events WHERE id = 90599`,
          )
          .get(),
      ).toEqual({
        peak_deviation_bps: -190,
        peak_price: 0.981,
        ended_at: 1784153000,
        recovery_price: 0.9852,
        close_reason: "recovered-native",
      });
      expect(migrationLedgerCounts(db)).toEqual({
        authorizations: 2,
        consumptions: 2,
        links: 1,
        revisions: 1,
      });
    } finally {
      db.close();
    }
  });
});
