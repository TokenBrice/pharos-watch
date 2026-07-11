import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";

const MIGRATIONS_DIR = join(process.cwd(), "worker/migrations");

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

describe("0178 historical data debt migration", () => {
  it("links the four reviewed BRLA events through repair provenance and closes their tasks", () => {
    const db = new DatabaseSync(":memory:");
    try {
      applyThrough(db, "0177_pricing_provider_and_dex_coverage_state.sql");
      db.exec(`
        INSERT INTO depeg_events
          (id, stablecoin_id, symbol, peg_type, direction, peak_deviation_bps,
           started_at, ended_at, start_price, peak_price, recovery_price, peg_reference, source)
        VALUES
          (90491, 'brla-brla-digital', 'BRLA', 'peggedBRL', 'below', -162, 1782691226, 1782720045, 0.2, 0.19, 0.2, 0.2, 'backfill'),
          (90492, 'brla-brla-digital', 'BRLA', 'peggedBRL', 'below', -151, 1782723750, 1782730804, 0.2, 0.19, 0.2, 0.2, 'backfill'),
          (90493, 'brla-brla-digital', 'BRLA', 'peggedBRL', 'below', -154, 1782734422, 1782741747, 0.2, 0.19, 0.2, 0.2, 'backfill'),
          (90494, 'brla-brla-digital', 'BRLA', 'peggedBRL', 'below', -230, 1782853271, 1782910849, 0.2, 0.18, 0.2, 0.2, 'backfill'),
          (90495, 'brla-brla-digital', 'BRLA', 'peggedBRL', 'below', -153, 1783069242, 1783076553, 0.2, 0.19, 0.2, 0.2, 'backfill'),
          (90496, 'brla-brla-digital', 'BRLA', 'peggedBRL', 'below', -242, 1783080116, 1783368059, 0.2, 0.18, 0.2, 0.2, 'backfill');

        INSERT INTO depeg_resolver_incident_event_links
          (incident_key, event_id, relation, repair_authorization_id, linked_at, note)
        VALUES
          ('ddr2:0c95520aa5c8a0c1529cf911bdeb1f2d', 90491, 'observed', NULL, 1783505139, 'canonical event'),
          ('ddr2:fd0c5d2bd3c92ebd1acbd52ec2cfae2e', 90495, 'observed', NULL, 1783505139, 'canonical event');

        INSERT INTO depeg_resolver_incidents
          (incident_key, stablecoin_id, peg_currency, direction, first_event_id, current_event_id,
           first_started_at, current_started_at, first_observed_peak_bucket_bps, incident_state,
           superseded_by_incident_key, source_fingerprint, created_at, updated_at)
        VALUES
          ('ddr2:0c95520aa5c8a0c1529cf911bdeb1f2d', 'brla-brla-digital', 'BRL', 'below',
           90491, 90491, 1782691226, 1782691226, 100, 'active', NULL,
           '37517be120a79462580f92df10aaa3c18b68787da3050b646529145614eade16', 1783505139, 1783505139),
          ('ddr2:fd0c5d2bd3c92ebd1acbd52ec2cfae2e', 'brla-brla-digital', 'BRL', 'below',
           90495, 90495, 1783069242, 1783069242, 100, 'active', NULL,
           '87e10c835eaf9ca80185377977cab093c49b0a50059d0234bf0b60ed00484399', 1783505139, 1783505139);

        INSERT INTO worker_repair_tasks
          (task_id, kind, subject_id, priority, state, attempt_count, payload_json, created_at, updated_at)
        VALUES
          ('repair:ddr-repair-required-event:90492', 'ddr-repair-required-event', '90492', 50, 'open', 0, '{"eventId":90492}', 1783505139, 1783666207),
          ('repair:ddr-repair-required-event:90493', 'ddr-repair-required-event', '90493', 50, 'open', 0, '{"eventId":90493}', 1783505139, 1783666207),
          ('repair:ddr-repair-required-event:90494', 'ddr-repair-required-event', '90494', 50, 'open', 0, '{"eventId":90494}', 1783505139, 1783666207),
          ('repair:ddr-repair-required-event:90496', 'ddr-repair-required-event', '90496', 50, 'open', 0, '{"eventId":90496}', 1783505139, 1783666207);

        INSERT INTO cache (key, value, updated_at) VALUES
          ('depeg-resolver:snapshot', '{"generation":1,"methodologyVersion":"3.04","payload":{}}', 1783666207),
          ('depeg-resolver-review:snapshot', '{"generation":1,"methodologyVersion":"3.04","payload":{}}', 1783666207),
          ('ddr:repair-debt:v1', '{"count":4,"events":[{"eventId":90492},{"eventId":90493},{"eventId":90494},{"eventId":90496}]}', 1783666207);
      `);

      applyMigration(db, "0178_historical_data_debt_closure.sql");

      expect(
        db
          .prepare(
            `SELECT event_id, incident_key, relation, repair_authorization_id IS NOT NULL AS authorized
           FROM depeg_resolver_incident_event_links
           WHERE event_id IN (90492, 90493, 90494, 90496)
           ORDER BY event_id`,
          )
          .all(),
      ).toEqual([
        {
          event_id: 90492,
          incident_key: "ddr2:0c95520aa5c8a0c1529cf911bdeb1f2d",
          relation: "repair_replacement",
          authorized: 1,
        },
        {
          event_id: 90493,
          incident_key: "ddr2:0c95520aa5c8a0c1529cf911bdeb1f2d",
          relation: "repair_replacement",
          authorized: 1,
        },
        {
          event_id: 90494,
          incident_key: "ddr2:0c95520aa5c8a0c1529cf911bdeb1f2d",
          relation: "repair_replacement",
          authorized: 1,
        },
        {
          event_id: 90496,
          incident_key: "ddr2:fd0c5d2bd3c92ebd1acbd52ec2cfae2e",
          relation: "repair_replacement",
          authorized: 1,
        },
      ]);
      expect(
        db
          .prepare(
            `SELECT incident_key, current_event_id
           FROM depeg_resolver_incidents
           WHERE stablecoin_id = 'brla-brla-digital'
           ORDER BY first_event_id`,
          )
          .all(),
      ).toEqual([
        { incident_key: "ddr2:0c95520aa5c8a0c1529cf911bdeb1f2d", current_event_id: 90494 },
        { incident_key: "ddr2:fd0c5d2bd3c92ebd1acbd52ec2cfae2e", current_event_id: 90496 },
      ]);
      expect(
        db
          .prepare(
            `SELECT COUNT(*) AS count
           FROM depeg_resolver_event_repair_authorization_consumptions c
           JOIN depeg_resolver_event_repair_authorizations a ON a.id = c.authorization_id
           WHERE a.created_by = 'migration-0178'`,
          )
          .get(),
      ).toEqual({ count: 6 });
      expect(
        db
          .prepare(
            `SELECT state, COUNT(*) AS count
           FROM worker_repair_tasks
           WHERE subject_id IN ('90492','90493','90494','90496')
           GROUP BY state`,
          )
          .all(),
      ).toEqual([{ state: "closed", count: 4 }]);
      expect(db.prepare("SELECT COUNT(*) AS count FROM cache WHERE key = 'ddr:repair-debt:v1'").get()).toEqual({
        count: 0,
      });
      expect(
        db
          .prepare(
            `SELECT COUNT(*) AS count FROM cache
           WHERE key IN ('depeg-resolver:snapshot', 'depeg-resolver-review:snapshot')
             AND json_extract(value, '$.methodologyVersion') = 'invalidated-brla-ddr-repair-0178'`,
          )
          .get(),
      ).toEqual({ count: 2 });
    } finally {
      db.close();
    }
  });

  it("refuses to repair a BRLA event when the reviewed source-row fingerprint no longer matches", () => {
    const db = new DatabaseSync(":memory:");
    try {
      applyThrough(db, "0177_pricing_provider_and_dex_coverage_state.sql");
      db.exec(`
        INSERT INTO depeg_events
          (id, stablecoin_id, symbol, peg_type, direction, peak_deviation_bps,
           started_at, ended_at, start_price, peak_price, recovery_price, peg_reference, source)
        VALUES
          (90495, 'brla-brla-digital', 'BRLA', 'peggedBRL', 'below', -153,
           1783069242, 1783076553, 0.2, 0.19, 0.2, 0.2, 'backfill'),
          (90496, 'brla-brla-digital', 'BRLA', 'peggedBRL', 'below', -241,
           1783080116, 1783368059, 0.2, 0.18, 0.2, 0.2, 'backfill');

        INSERT INTO depeg_resolver_incident_event_links
          (incident_key, event_id, relation, repair_authorization_id, linked_at, note)
        VALUES
          ('ddr2:fd0c5d2bd3c92ebd1acbd52ec2cfae2e', 90495, 'observed', NULL, 1783505139, 'canonical event');

        INSERT INTO depeg_resolver_incidents
          (incident_key, stablecoin_id, peg_currency, direction, first_event_id, current_event_id,
           first_started_at, current_started_at, first_observed_peak_bucket_bps, incident_state,
           superseded_by_incident_key, source_fingerprint, created_at, updated_at)
        VALUES
          ('ddr2:fd0c5d2bd3c92ebd1acbd52ec2cfae2e', 'brla-brla-digital', 'BRL', 'below',
           90495, 90495, 1783069242, 1783069242, 100, 'active', NULL,
           '87e10c835eaf9ca80185377977cab093c49b0a50059d0234bf0b60ed00484399', 1783505139, 1783505139);

        INSERT INTO worker_repair_tasks
          (task_id, kind, subject_id, priority, state, attempt_count, payload_json, created_at, updated_at)
        VALUES
          ('repair:ddr-repair-required-event:90496', 'ddr-repair-required-event', '90496', 50, 'open', 0,
           '{"eventId":90496}', 1783505139, 1783666207);
      `);

      applyMigration(db, "0178_historical_data_debt_closure.sql");

      expect(
        db.prepare("SELECT COUNT(*) AS count FROM depeg_resolver_incident_event_links WHERE event_id = 90496").get(),
      ).toEqual({ count: 0 });
      expect(db.prepare("SELECT state FROM worker_repair_tasks WHERE subject_id = '90496'").get()).toEqual({
        state: "open",
      });
      expect(
        db
          .prepare(
            "SELECT current_event_id FROM depeg_resolver_incidents WHERE incident_key = 'ddr2:fd0c5d2bd3c92ebd1acbd52ec2cfae2e'",
          )
          .get(),
      ).toEqual({ current_event_id: 90495 });
    } finally {
      db.close();
    }
  });
});
