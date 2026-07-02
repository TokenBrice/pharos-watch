import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { D1Database, D1PreparedStatement } from "@cloudflare/workers-types";
import { describe, expect, it } from "vitest";
import { mockD1 } from "../../test-helpers/__shared/mock-d1";
import {
  ensureCanonicalIncidents,
  loadCanonicalIncidents,
  recordLockDeferral,
  recordLockOpportunity,
} from "../depeg-resolver-incident-store";
import {
  loadFirstPublicationMembership,
  loadLatestPublicationManifest,
  loadSealedPublicPredictions,
  sealPublicNoCall,
  sealPublicPrediction,
  writePublicationManifest,
} from "../depeg-resolver-publication-store";
import { authorizeEventRepair, consumeEventRepairAuthorization } from "../depeg-resolver-repair-store";
import { attachDdrPublicRowHash, computeDdrPublicRowHash } from "@shared/lib/depeg-resolver/public-contract";
import {
  DDR_FORECAST_READINESS_BACKSTOP_DELAY_SEC,
  DDR_FORECAST_READINESS_STRICT_EARLY_LOCK_THRESHOLD,
  DDR_FORECAST_READINESS_VERSION,
} from "@shared/lib/depeg-resolver-version";

const MIGRATIONS_DIR = join(process.cwd(), "worker/migrations");
interface SqliteD1 extends D1Database {
  close(): void;
  sqlite: DatabaseSync;
}

function migrationFiles(): string[] {
  return readdirSync(MIGRATIONS_DIR).filter((entry) => entry.endsWith(".sql")).sort();
}

function applyMigrationFile(db: DatabaseSync, file: string): void {
  // Test-only migration replay loads repo-controlled SQL from the migration directory.
  // eslint-disable-next-line security/detect-non-literal-fs-filename
  db.exec(readFileSync(join(MIGRATIONS_DIR, file), "utf8"));
}

function applyMigrations(db: DatabaseSync): void {
  for (const file of migrationFiles()) applyMigrationFile(db, file);
}

function applyMigrationsThrough(db: DatabaseSync, throughFile: string): void {
  for (const file of migrationFiles()) {
    applyMigrationFile(db, file);
    if (file === throughFile) return;
  }
  throw new Error(`Migration ${throughFile} was not found`);
}

function makeSqliteD1(): SqliteD1 {
  const sqlite = new DatabaseSync(":memory:");
  applyMigrations(sqlite);

  function statement(sql: string, binds: unknown[] = []): D1PreparedStatement {
    const run = () => {
      const result = sqlite.prepare(sql).run(...(binds as never[]));
      return {
        success: true,
        meta: {
          changes: result.changes,
          last_row_id: Number(result.lastInsertRowid ?? 0),
        },
      };
    };
    return {
      bind: (...nextBinds: unknown[]) => statement(sql, nextBinds),
      run: async () => run(),
      first: async <T>() => (sqlite.prepare(sql).get(...(binds as never[])) ?? null) as T | null,
      all: async <T>() => ({
        results: sqlite.prepare(sql).all(...(binds as never[])) as T[],
        success: true,
        meta: {},
      }),
      raw: async () => sqlite.prepare(sql).all(...(binds as never[])) as unknown as unknown[][],
    } as unknown as D1PreparedStatement;
  }

  return {
    sqlite,
    prepare: (sql: string) => statement(sql),
    batch: async (statements: D1PreparedStatement[]) => {
      sqlite.exec("BEGIN");
      try {
        const results = [];
        for (const stmt of statements) results.push(await stmt.run());
        sqlite.exec("COMMIT");
        return results as Awaited<ReturnType<D1Database["batch"]>>;
      } catch (error) {
        sqlite.exec("ROLLBACK");
        throw error;
      }
    },
    exec: async (sql: string) => {
      sqlite.exec(sql);
      return { count: 0, duration: 0 };
    },
    dump: async () => new ArrayBuffer(0),
    close: () => sqlite.close(),
  } as SqliteD1;
}

function insertOpenEvent(db: SqliteD1, eventId = 1): void {
  db.sqlite
    .prepare(
      `INSERT INTO depeg_events
       (id, stablecoin_id, symbol, peg_type, direction, peak_deviation_bps,
        started_at, ended_at, start_price, peak_price, recovery_price, peg_reference, source)
       VALUES (?, 'lusd-liquity', 'LUSD', 'peggedUSD', 'below', -300, 100000, NULL, 0.98, 0.97, NULL, 1, 'live')`,
    )
    .run(eventId);
}

async function ensureIncident(db: SqliteD1, eventId = 1, nowSec = 200000) {
  const [incident] = await ensureCanonicalIncidents(
    db,
    [
      {
        eventId,
        stablecoinId: "lusd-liquity",
        pegCurrency: "USD",
        direction: "below",
        startedAt: 100000,
        peakDeviationBps: -300,
        source: "live",
        publicTrackedAtFirstSeen: true,
        registrySnapshot: { id: "lusd-liquity", symbol: "LUSD" },
      },
    ],
    {
      nowSec,
      predictionPolicyVersion: "sticky-24h-v1",
      ddrV2EffectiveAt: 90000,
      createdBy: "vitest",
    },
  );
  if (!incident) throw new Error("incident was not created");
  return incident;
}

function sealedPayload(
  incidentKey: string,
  kind: "prediction" | "no_call" = "prediction",
  options: {
    eventId?: number;
    eligibleAt?: number;
    lockedAt?: number;
    eventAgeAtLockSec?: number;
    policyDelaySec?: number;
    lockTiming?: "on_time" | "late_confirmation" | "late_freeze" | "deferred";
    predictionExtras?: Record<string, unknown>;
  } = {},
) {
  const eventId = options.eventId ?? 1;
  const eligibleAt = options.eligibleAt ?? 186400;
  const lockedAt = options.lockedAt ?? 186400;
  const eventAgeAtLockSec = options.eventAgeAtLockSec ?? 86400;
  const policyDelaySec = options.policyDelaySec ?? 86400;
  const base = {
    kind,
    eventId,
    incidentKey,
    stablecoinId: "lusd-liquity",
    symbol: "LUSD",
    name: "Liquity USD",
    pegCurrency: "USD",
    governance: "decentralized",
    status: "active",
    direction: "below",
    startedAt: 100000,
    prediction: {
      incidentKey,
      eligibleAt,
      lockedAt,
      eventAgeAtLockSec,
      lockTiming: options.lockTiming ?? "on_time",
      policyDelaySec,
      predictionPolicyVersion: "sticky-24h-v1",
      predictionMethodologyVersion: "2.0",
      resolutionRubricVersion: "resolution-rubric-v2",
      durationModelVersion: "duration-landmark-v2",
      incidentGroupingVersion: "incident-group-v2",
      supportRulesVersion: "support-rules-v2",
      ...(options.predictionExtras ?? {}),
    },
  };
  return kind === "prediction"
    ? {
        ...base,
        frozen: {
          resolution: { tier: "at_risk", factors: [] },
          duration: { suppressed: false, horizons: [] },
          relatedContext: {},
          sourceRow: { eventId, stablecoinId: "lusd-liquity" },
        },
      }
    : {
        ...base,
        noCall: {
          lockedAt,
          eventAgeAtLockSec,
          missingReasons: ["insufficient_signal"],
          relatedContext: {},
        },
        frozen: null,
      };
}

function sealedPayloadWithHash(
  incidentKey: string,
  kind: "prediction" | "no_call" = "prediction",
  options?: Parameters<typeof sealedPayload>[2],
) {
  const payload = sealedPayload(incidentKey, kind, options);
  const rowHash = computeDdrPublicRowHash(payload);
  return { payload: attachDdrPublicRowHash(payload, rowHash), rowHash };
}

async function sealPredictionFixture(db: SqliteD1) {
  insertOpenEvent(db);
  const incident = await ensureIncident(db);
  const { payload, rowHash } = sealedPayloadWithHash(incident.incidentKey);
  const prediction = await sealPublicPrediction(db, {
    incidentKey: incident.incidentKey,
    eventId: 1,
    stablecoinId: "lusd-liquity",
    symbol: "LUSD",
    name: "Liquity USD",
    pegCurrency: "USD",
    governance: "decentralized",
    direction: "below",
    startedAt: 100000,
    assessedAt: 186400,
    eventAgeSec: 86400,
    methodologyVersion: "2.0",
    methodologyVersionLabel: "v2.0",
    resolutionRubricVersion: "resolution-rubric-v2",
    durationModelVersion: "duration-landmark-v2",
    incidentGroupingVersion: "incident-group-v2",
    supportRulesVersion: "support-rules-v2",
    resolutionTier: "at_risk",
    durationSuppressed: false,
    durationSuppressedReason: null,
    medianRemainingSec: 7200,
    iqrLowRemainingSec: 3600,
    iqrHighRemainingSec: 14400,
    stratum: "below",
    horizons: [],
    factors: [],
    sealedPayload: payload,
    rowHash,
    predictionPolicyVersion: "sticky-24h-v1",
    policyDelaySec: 86400,
    eligibleAt: 186400,
    lockedAt: 186400,
    eventAgeAtLockSec: 86400,
    lockTiming: "on_time",
    createdAt: 186401,
    runId: "ddr:test",
  });
  return { incident, prediction };
}

function insertPredictionErratum(
  db: SqliteD1,
  input: {
    publicPredictionId: number;
    incidentKey: string;
    eventId: number;
    assessmentId: number;
    reason: string;
    operatorNote: string;
    replacementAssessmentId?: number | null;
    replacementRowHash?: string | null;
    rowHashBefore?: string | null;
    createdAt: number;
    createdBy: string;
  },
): number {
  const result = db.sqlite
    .prepare(
      `INSERT INTO depeg_resolver_prediction_errata
       (public_prediction_id, incident_key, event_id, assessment_id, reason, operator_note,
        replacement_assessment_id, replacement_row_hash, row_hash_before, created_at, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      input.publicPredictionId,
      input.incidentKey,
      input.eventId,
      input.assessmentId,
      input.reason,
      input.operatorNote,
      input.replacementAssessmentId ?? null,
      input.replacementRowHash ?? null,
      input.rowHashBefore ?? null,
      input.createdAt,
      input.createdBy,
    );
  return Number(result.lastInsertRowid ?? 0);
}

describe("DDRv2 storage migrations and stores", () => {
  it("ledgers LUSD event 90410 as a fresh DDR incident and closes repair debt", () => {
    const sqlite = new DatabaseSync(":memory:");
    try {
      applyMigrationsThrough(sqlite, "0168_surface_publication_generations.sql");

      sqlite.exec(`
        INSERT INTO depeg_events
          (id, stablecoin_id, symbol, peg_type, direction, peak_deviation_bps,
           started_at, ended_at, start_price, peak_price, recovery_price, peg_reference, source)
        VALUES
          (90404, 'lusd-liquity', 'LUSD', 'peggedUSD', 'above', 100,
           1782944363, 1782947931, 1.0096705168234137, 1.0096705168234137, 1.0085284741080422, 0.9997113947811964, 'live'),
          (90410, 'lusd-liquity', 'LUSD', 'peggedUSD', 'above', 100,
           1782970434, 1782973127, 1.0096702857093371, 1.0096702857093371, 1.0092109177692081, 0.99968, 'live');

        INSERT INTO depeg_resolver_incident_event_links
          (incident_key, event_id, relation, repair_authorization_id, linked_at, note)
        VALUES
          ('ddr2:ba7b7cb3eb0ef0237e1fac09475cd198', 90404, 'repair_replacement', NULL, 1782944403,
           'pre-lock nearby event adopted as current incident source');

        INSERT INTO depeg_resolver_incidents
          (incident_key, stablecoin_id, peg_currency, direction, first_event_id, current_event_id,
           first_started_at, current_started_at, first_observed_peak_bucket_bps, incident_state,
           superseded_by_incident_key, source_fingerprint, created_at, updated_at)
        VALUES
          ('ddr2:ba7b7cb3eb0ef0237e1fac09475cd198', 'lusd-liquity', 'USD', 'above',
           90361, 90404, 1782702288, 1782944363, 100, 'active', NULL,
           'a812e8287ccbedb13ec00d3b4d8a2ec1501b85dbf131a332a14715a6836c360b', 1782702297, 1782944403);

        INSERT INTO worker_repair_tasks
          (task_id, kind, subject_id, priority, state, attempt_count, next_attempt_at,
           payload_json, created_at, updated_at)
        VALUES
          ('repair:ddr-repair-required-event:90410', 'ddr-repair-required-event', '90410', 50, 'open', 0, NULL,
           '{"eventId":90410,"reason":"Unlinked depeg event 90410 overlaps nearby canonical incident ddr2:ba7b7cb3eb0ef0237e1fac09475cd198; explicit repair required"}',
           1782970440, 1782973133);

        INSERT INTO cache (key, value, updated_at)
        VALUES (
          'ddr:repair-debt:v1',
          '{"checkedAt":1782973133,"count":1,"events":[{"eventId":90410,"reason":"Unlinked depeg event 90410 overlaps nearby canonical incident ddr2:ba7b7cb3eb0ef0237e1fac09475cd198; explicit repair required"}],"eventsTruncated":false}',
          1782973133
        );
      `);

      applyMigrationFile(sqlite, "0169_lusd_ddr_event_90410_split.sql");

      expect(
        sqlite
          .prepare(
            `SELECT incident_key, relation, note
             FROM depeg_resolver_incident_event_links
             WHERE event_id = 90410`,
          )
          .get(),
      ).toEqual({
        incident_key: "ddr2:c14884852abe024faa4d4b9fc1f84742",
        relation: "observed",
        note: "fresh LUSD flap split from earlier recovered pre-lock chain",
      });
      expect(
        sqlite
          .prepare(
            `SELECT first_event_id, current_event_id, source_fingerprint
             FROM depeg_resolver_incidents
             WHERE incident_key = 'ddr2:c14884852abe024faa4d4b9fc1f84742'`,
          )
          .get(),
      ).toEqual({
        first_event_id: 90410,
        current_event_id: 90410,
        source_fingerprint: "09da1784f586d5bbfba3762fa54d4c3c1d47f1660fd5c315616a3187b480f687",
      });
      expect(
        sqlite
          .prepare(
            `SELECT policy_universe_included, policy_universe_reason
             FROM depeg_resolver_incident_policy_membership
             WHERE incident_key = 'ddr2:c14884852abe024faa4d4b9fc1f84742'`,
          )
          .get(),
      ).toEqual({
        policy_universe_included: 1,
        policy_universe_reason: "post_effective_public_tracked",
      });
      expect(
        sqlite
          .prepare(
            `SELECT current_event_id
             FROM depeg_resolver_incidents
             WHERE incident_key = 'ddr2:ba7b7cb3eb0ef0237e1fac09475cd198'`,
          )
          .get(),
      ).toEqual({ current_event_id: 90404 });
      expect(
        sqlite
          .prepare("SELECT state, closed_at IS NOT NULL AS has_closed_at FROM worker_repair_tasks WHERE subject_id = '90410'")
          .get(),
      ).toEqual({ state: "closed", has_closed_at: 1 });
      expect(
        sqlite
          .prepare("SELECT COUNT(*) AS count FROM cache WHERE key = 'ddr:repair-debt:v1'")
          .get(),
      ).toEqual({ count: 0 });
    } finally {
      sqlite.close();
    }
  });

  it("repairs APXUSD event 90203 when the earlier relink migration found an accidental link", () => {
    const sqlite = new DatabaseSync(":memory:");
    try {
      applyMigrationsThrough(sqlite, "0153_status_reliability_idempotency.sql");

      sqlite.exec(`
        INSERT INTO depeg_events
          (id, stablecoin_id, symbol, peg_type, direction, peak_deviation_bps,
           started_at, ended_at, start_price, peak_price, recovery_price, peg_reference, source)
        VALUES
          (90089, 'apxusd-apyx', 'apxUSD', 'peggedUSD', 'below', -1200,
           1780671044, 1781624981, 0.99, 0.88, 1.00, 1, 'live'),
          (90203, 'apxusd-apyx', 'apxUSD', 'peggedUSD', 'below', -900,
           1781632159, NULL, 0.99, 0.91, NULL, 1, 'live');

        INSERT INTO depeg_resolver_incident_event_links
          (incident_key, event_id, relation, repair_authorization_id, linked_at, note)
        VALUES
          ('ddr2:e32c8186781838eac1b740a44c3b8776', 90089, 'observed', NULL, 1781625000, 'canonical event'),
          ('ddr2:70a8e43c093e0afcdc8a37143a6849f9', 90203, 'observed', NULL, 1781632200, 'accidental tail');

        INSERT INTO depeg_resolver_incidents
          (incident_key, stablecoin_id, peg_currency, direction, first_event_id, current_event_id,
           first_started_at, current_started_at, first_observed_peak_bucket_bps, incident_state,
           superseded_by_incident_key, source_fingerprint, created_at, updated_at)
        VALUES
          ('ddr2:e32c8186781838eac1b740a44c3b8776', 'apxusd-apyx', 'USD', 'below',
           90089, 90089, 1780671044, 1780671044, 1200, 'active', NULL,
           'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 1781625000, 1781625000),
          ('ddr2:70a8e43c093e0afcdc8a37143a6849f9', 'apxusd-apyx', 'USD', 'below',
           90203, 90203, 1781632159, 1781632159, 900, 'active', NULL,
           'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', 1781632200, 1781632200);

        DROP TRIGGER IF EXISTS trg_ddr_public_predictions_relational_guard;
        DROP TRIGGER IF EXISTS trg_ddr_public_predictions_version_guard;
        DROP TRIGGER IF EXISTS trg_ddr_public_predictions_payload_identity_guard;
        DROP TRIGGER IF EXISTS trg_ddr_public_predictions_payload_prediction_guard;
        DROP TRIGGER IF EXISTS trg_ddr_public_predictions_prediction_kind_guard;
        DROP TRIGGER IF EXISTS trg_ddr_public_predictions_no_call_kind_guard;

        INSERT INTO depeg_resolver_public_predictions
          (incident_key, event_id, assessment_id, outcome_kind, prediction_policy_version,
           prediction_methodology_version, prediction_methodology_version_label, resolution_rubric_version,
           duration_model_version, incident_grouping_version, support_rules_version, policy_delay_sec,
           eligible_at, locked_at, event_age_at_lock_sec, lock_timing, sealed_payload_json, row_hash, created_at)
        VALUES
          ('ddr2:e32c8186781838eac1b740a44c3b8776', 90089, 1, 'prediction', 'sticky-24h-v1',
           'v1', 'v1', 'rubric-v1', 'duration-v1', 'group-v1', 'support-v1', 86400,
           1780757444, 1780757444, 86400, 'on_time', '{}',
           'cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc', 1780757444);

        INSERT INTO cache (key, value, updated_at)
        VALUES
          ('depeg-resolver:snapshot', '{}', 1781632300),
          ('depeg-resolver-review:snapshot', '{}', 1781632300);
      `);

      applyMigrationFile(sqlite, "0154_apxusd_ddr_tail_90203_link.sql");

      expect(
        sqlite
          .prepare("SELECT incident_key FROM depeg_resolver_incident_event_links WHERE event_id = 90203")
          .get(),
      ).toEqual({ incident_key: "ddr2:70a8e43c093e0afcdc8a37143a6849f9" });
      expect(
        sqlite
          .prepare("SELECT current_event_id FROM depeg_resolver_incidents WHERE incident_key = ?")
          .get("ddr2:e32c8186781838eac1b740a44c3b8776"),
      ).toEqual({ current_event_id: 90089 });

      applyMigrationFile(sqlite, "0161_apxusd_ddr_tail_90203_relink_repair.sql");

      expect(
        sqlite
          .prepare(
            `SELECT incident_key, relation
             FROM depeg_resolver_incident_event_links
             WHERE event_id = 90203`,
          )
          .get(),
      ).toEqual({
        incident_key: "ddr2:e32c8186781838eac1b740a44c3b8776",
        relation: "repair_replacement",
      });
      expect(
        sqlite
          .prepare(
            `SELECT current_event_id
             FROM depeg_resolver_incidents
             WHERE incident_key = ?`,
          )
          .get("ddr2:e32c8186781838eac1b740a44c3b8776"),
      ).toEqual({ current_event_id: 90203 });
      expect(
        sqlite
          .prepare(
            `SELECT incident_state, superseded_by_incident_key
             FROM depeg_resolver_incidents
             WHERE incident_key = ?`,
          )
          .get("ddr2:70a8e43c093e0afcdc8a37143a6849f9"),
      ).toEqual({
        incident_state: "superseded",
        superseded_by_incident_key: "ddr2:e32c8186781838eac1b740a44c3b8776",
      });
      expect(
        sqlite
          .prepare(
            `SELECT COUNT(*) AS count
             FROM depeg_resolver_event_repair_authorization_uses u
             JOIN depeg_resolver_event_repair_authorizations a
               ON a.id = u.authorization_id
             WHERE a.event_id = 90203
               AND a.incident_key = 'ddr2:e32c8186781838eac1b740a44c3b8776'
               AND a.operation IN ('incident_link', 'incident_current_update')`,
          )
          .get(),
      ).toEqual({ count: 2 });
      expect(
        sqlite
          .prepare(
            `SELECT sql
             FROM sqlite_master
             WHERE type = 'index'
               AND name = 'idx_ddr_incident_current_event'`,
          )
          .get(),
      ).toEqual({
        sql: "CREATE UNIQUE INDEX idx_ddr_incident_current_event\n  ON depeg_resolver_incidents(current_event_id)\n  WHERE incident_state = 'active'",
      });
    } finally {
      sqlite.close();
    }
  });

  it("invalidates sealed APXUSD duplicate predictions without relink order hazards", () => {
    const sqlite = new DatabaseSync(":memory:");
    try {
      applyMigrationsThrough(sqlite, "0153_status_reliability_idempotency.sql");

      sqlite.exec(`
        INSERT INTO depeg_events
          (id, stablecoin_id, symbol, peg_type, direction, peak_deviation_bps,
           started_at, ended_at, start_price, peak_price, recovery_price, peg_reference, source)
        VALUES
          (90089, 'apxusd-apyx', 'apxUSD', 'peggedUSD', 'below', -1200,
           1780671044, 1781624981, 0.99, 0.88, 1.00, 1, 'live'),
          (90203, 'apxusd-apyx', 'apxUSD', 'peggedUSD', 'below', -900,
           1781632159, NULL, 0.99, 0.91, NULL, 1, 'live');

        INSERT INTO depeg_resolver_incident_event_links
          (incident_key, event_id, relation, repair_authorization_id, linked_at, note)
        VALUES
          ('ddr2:e32c8186781838eac1b740a44c3b8776', 90089, 'observed', NULL, 1781625000, 'canonical event'),
          ('ddr2:70a8e43c093e0afcdc8a37143a6849f9', 90203, 'observed', NULL, 1781632200, 'accidental tail');

        INSERT INTO depeg_resolver_incidents
          (incident_key, stablecoin_id, peg_currency, direction, first_event_id, current_event_id,
           first_started_at, current_started_at, first_observed_peak_bucket_bps, incident_state,
           superseded_by_incident_key, source_fingerprint, created_at, updated_at)
        VALUES
          ('ddr2:e32c8186781838eac1b740a44c3b8776', 'apxusd-apyx', 'USD', 'below',
           90089, 90089, 1780671044, 1780671044, 1200, 'active', NULL,
           'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 1781625000, 1781625000),
          ('ddr2:70a8e43c093e0afcdc8a37143a6849f9', 'apxusd-apyx', 'USD', 'below',
           90203, 90203, 1781632159, 1781632159, 900, 'active', NULL,
           'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', 1781632200, 1781632200);

        INSERT INTO depeg_resolver_assessments
          (id, event_id, stablecoin_id, symbol, name, peg_currency, governance, direction,
           started_at, assessed_at, event_age_sec, checkpoint, methodology_version,
           methodology_version_label, resolution_rubric_version, duration_model_version,
           incident_grouping_version, support_rules_version, resolution_tier,
           duration_suppressed, duration_suppressed_reason, median_remaining_sec,
           iqr_low_remaining_sec, iqr_high_remaining_sec, stratum, horizons_json,
           factors_json, row_json, created_at, updated_at)
        VALUES
          (1, 90089, 'apxusd-apyx', 'apxUSD', 'APX USD', 'USD', 'centralized', 'below',
           1780671044, 1780757444, 86400, 'public_prediction', 'v1', 'v1',
           'rubric-v1', 'duration-v1', 'group-v1', 'support-v1', 'at_risk',
           0, NULL, NULL, NULL, NULL, NULL, '[]', '[]', '{}', 1780757444, 1780757444),
          (2, 90203, 'apxusd-apyx', 'apxUSD', 'APX USD', 'USD', 'centralized', 'below',
           1781632159, 1781718559, 86400, 'public_prediction', 'v1', 'v1',
           'rubric-v1', 'duration-v1', 'group-v1', 'support-v1', 'at_risk',
           0, NULL, NULL, NULL, NULL, NULL, '[]', '[]', '{}', 1781718559, 1781718559);

        DROP TRIGGER IF EXISTS trg_ddr_public_predictions_relational_guard;
        DROP TRIGGER IF EXISTS trg_ddr_public_predictions_version_guard;
        DROP TRIGGER IF EXISTS trg_ddr_public_predictions_payload_identity_guard;
        DROP TRIGGER IF EXISTS trg_ddr_public_predictions_payload_prediction_guard;
        DROP TRIGGER IF EXISTS trg_ddr_public_predictions_prediction_kind_guard;
        DROP TRIGGER IF EXISTS trg_ddr_public_predictions_no_call_kind_guard;

        INSERT INTO depeg_resolver_public_predictions
          (incident_key, event_id, assessment_id, outcome_kind, prediction_policy_version,
           prediction_methodology_version, prediction_methodology_version_label, resolution_rubric_version,
           duration_model_version, incident_grouping_version, support_rules_version, policy_delay_sec,
           eligible_at, locked_at, event_age_at_lock_sec, lock_timing, sealed_payload_json, row_hash, created_at)
        VALUES
          ('ddr2:e32c8186781838eac1b740a44c3b8776', 90089, 1, 'prediction', 'sticky-24h-v1',
           'v1', 'v1', 'rubric-v1', 'duration-v1', 'group-v1', 'support-v1', 86400,
           1780757444, 1780757444, 86400, 'on_time', '{}',
           'cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc', 1780757444),
          ('ddr2:70a8e43c093e0afcdc8a37143a6849f9', 90203, 2, 'prediction', 'sticky-24h-v1',
           'v1', 'v1', 'rubric-v1', 'duration-v1', 'group-v1', 'support-v1', 86400,
           1781718559, 1781718559, 86400, 'on_time', '{}',
           'dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd', 1781718559);

        INSERT INTO cache (key, value, updated_at)
        VALUES
          ('depeg-resolver:snapshot', '{}', 1781632300),
          ('depeg-resolver-review:snapshot', '{}', 1781632300);
      `);

      applyMigrationFile(sqlite, "0154_apxusd_ddr_tail_90203_link.sql");
      applyMigrationFile(sqlite, "0161_apxusd_ddr_tail_90203_relink_repair.sql");

      expect(
        sqlite
          .prepare("SELECT incident_key FROM depeg_resolver_incident_event_links WHERE event_id = 90203")
          .get(),
      ).toEqual({ incident_key: "ddr2:70a8e43c093e0afcdc8a37143a6849f9" });
      expect(
        sqlite
          .prepare("SELECT current_event_id FROM depeg_resolver_incidents WHERE incident_key = ?")
          .get("ddr2:e32c8186781838eac1b740a44c3b8776"),
      ).toEqual({ current_event_id: 90089 });

      applyMigrationFile(sqlite, "0162_apxusd_duplicate_ddr_prediction_erratum.sql");

      expect(
        sqlite
          .prepare(
            `SELECT incident_state, superseded_by_incident_key
             FROM depeg_resolver_incidents
             WHERE incident_key = ?`,
          )
          .get("ddr2:70a8e43c093e0afcdc8a37143a6849f9"),
      ).toEqual({
        incident_state: "superseded",
        superseded_by_incident_key: "ddr2:e32c8186781838eac1b740a44c3b8776",
      });
      expect(
        sqlite
          .prepare(
            `SELECT e.reason, e.replacement_assessment_id, e.created_by
             FROM depeg_resolver_prediction_errata e
             JOIN depeg_resolver_public_predictions p ON p.id = e.public_prediction_id
             WHERE p.incident_key = 'ddr2:70a8e43c093e0afcdc8a37143a6849f9'`,
          )
          .get(),
      ).toEqual({
        reason: "event_identity_error",
        replacement_assessment_id: 1,
        created_by: "migration-0162",
      });
      expect(
        sqlite
          .prepare(
            `SELECT relation, created_by
             FROM depeg_resolver_incident_lineage
             WHERE from_incident_key = 'ddr2:70a8e43c093e0afcdc8a37143a6849f9'
               AND to_incident_key = 'ddr2:e32c8186781838eac1b740a44c3b8776'`,
          )
          .get(),
      ).toEqual({ relation: "superseded_by", created_by: "migration-0162" });
      expect(
        sqlite
          .prepare(
            `SELECT COUNT(*) AS count
             FROM depeg_resolver_event_repair_authorization_uses u
             JOIN depeg_resolver_event_repair_authorizations a
               ON a.id = u.authorization_id
             WHERE a.event_id = 90203
               AND a.incident_key = 'ddr2:70a8e43c093e0afcdc8a37143a6849f9'
               AND a.operation = 'incident_current_update'`,
          )
          .get(),
      ).toEqual({ count: 1 });
    } finally {
      sqlite.close();
    }
  });

  it("replaces the monolithic public-prediction guard with split triggers", () => {
    const db = makeSqliteD1();
    try {
      const rows = db.sqlite
        .prepare(
          `SELECT name
           FROM sqlite_master
           WHERE type = 'trigger'
             AND tbl_name = 'depeg_resolver_public_predictions'`,
        )
        .all() as { name: string }[];
      const names = new Set(rows.map((row) => row.name));

      expect(names.has("trg_ddr_public_predictions_assessment_guard")).toBe(false);
      expect([...names]).toEqual(expect.arrayContaining([
        "trg_ddr_public_predictions_relational_guard",
        "trg_ddr_public_predictions_version_guard",
        "trg_ddr_public_predictions_payload_identity_guard",
        "trg_ddr_public_predictions_payload_prediction_guard",
        "trg_ddr_public_predictions_prediction_kind_guard",
        "trg_ddr_public_predictions_no_call_kind_guard",
        "trg_ddr_public_predictions_lock_policy_guard",
      ]));
    } finally {
      db.close();
    }
  });

  it("bootstraps canonical incidents with immutable links and policy membership", async () => {
    const db = makeSqliteD1();
    try {
      const incident = await ensureIncident(db);

      expect(incident.sourceFingerprint).toBe("57575ce509837e748c284019c4ce62a0941aece26a0106ede5775b736270184e");
      expect(incident.incidentKey).toBe("ddr2:2867d8491b313b47ae432676cf15acbb");
      expect(incident.policyMembership?.policyUniverseIncluded).toBe(true);
      expect(incident.policyMembership?.policyUniverseReason).toBe("post_effective_public_tracked");
      expect(() =>
        db.sqlite.exec("UPDATE depeg_resolver_incident_event_links SET relation = 'merged' WHERE event_id = 1"),
      ).toThrow(/incident event links are append-only/);
      const stored = db.sqlite
        .prepare("SELECT source_fingerprint FROM depeg_resolver_incidents WHERE incident_key = ?")
        .get(incident.incidentKey) as { source_fingerprint: string };
      expect(stored.source_fingerprint).toBe(incident.sourceFingerprint);

      const [again] = await ensureCanonicalIncidents(
        db,
        [
          {
            eventId: 1,
            stablecoinId: "lusd-liquity",
            pegCurrency: "USD",
            direction: "below",
            startedAt: 100000,
            peakDeviationBps: -300,
            source: "live",
          },
        ],
        { nowSec: 200100, predictionPolicyVersion: "sticky-24h-v1", ddrV2EffectiveAt: 90000 },
      );
      expect(again?.incidentKey).toBe(incident.incidentKey);
      expect(again?.sourceFingerprint).toBe(incident.sourceFingerprint);
    } finally {
      db.close();
    }
  });

  it("maps persisted incident membership and lock state rows on read", async () => {
    const db = makeSqliteD1();
    try {
      insertOpenEvent(db);
      const incident = await ensureIncident(db);
      const backstopAt = 100000 + DDR_FORECAST_READINESS_BACKSTOP_DELAY_SEC;

      await recordLockDeferral(db, {
        incidentKey: incident.incidentKey,
        eventId: 1,
        predictionPolicyVersion: "sticky-24h-v1",
        eligibleAt: 143200,
        runAt: 143200,
        action: "deferred",
        reason: "scheduler unhealthy",
        healthStatus: "degraded",
        runId: "ddr:test:deferral",
        lockTrigger: "forecast_readiness",
        forecastReadinessScore: 0.81,
        forecastReadinessVersion: DDR_FORECAST_READINESS_VERSION,
        readinessThreshold: DDR_FORECAST_READINESS_STRICT_EARLY_LOCK_THRESHOLD,
        backstopAt,
        backstopDelaySec: DDR_FORECAST_READINESS_BACKSTOP_DELAY_SEC,
      });

      const [loaded] = await loadCanonicalIncidents(db, {
        stablecoinIds: ["lusd-liquity"],
        predictionPolicyVersion: "sticky-24h-v1",
        policyUniverseIncluded: true,
      });

      expect(loaded).toMatchObject({
        incidentKey: incident.incidentKey,
        eventId: 1,
        relation: undefined,
        stablecoinId: "lusd-liquity",
        policyUniverseIncluded: true,
        rolloutActiveAtEnablement: false,
        policyMembership: {
          incidentKey: incident.incidentKey,
          stablecoinId: "lusd-liquity",
          predictionPolicyVersion: "sticky-24h-v1",
          publicTrackedAtFirstSeen: true,
          psiShadowAtFirstSeen: false,
          policyUniverseIncluded: true,
          policyUniverseReason: "post_effective_public_tracked",
          registrySnapshotJson: '{"id":"lusd-liquity","symbol":"LUSD"}',
          createdAt: 200000,
        },
        lockState: {
          eligibleAt: 143200,
          deferralCount: 1,
          lastDeferralReason: "scheduler unhealthy",
          lastState: "lock_deferred",
          lockTrigger: "forecast_readiness",
          forecastReadinessScore: 0.81,
          forecastReadinessVersion: DDR_FORECAST_READINESS_VERSION,
          readinessThreshold: DDR_FORECAST_READINESS_STRICT_EARLY_LOCK_THRESHOLD,
          backstopAt,
          backstopDelaySec: DDR_FORECAST_READINESS_BACKSTOP_DELAY_SEC,
        },
      });
    } finally {
      db.close();
    }
  });

  it("detects exact-key collisions for unlinked events via the batched pre-loop check", async () => {
    // A second, differently-IDed event with an identical canonical signature
    // maps to the existing incident's key. The batched key-collision check must
    // surface it as repair-required before any insert. [audit S-142]
    const db = makeSqliteD1();
    try {
      const incident = await ensureIncident(db);
      insertOpenEvent(db, 2);
      await expect(
        ensureCanonicalIncidents(
          db,
          [
            {
              eventId: 2,
              stablecoinId: "lusd-liquity",
              pegCurrency: "USD",
              direction: "below",
              startedAt: 100000,
              peakDeviationBps: -300,
              source: "live",
              publicTrackedAtFirstSeen: true,
              registrySnapshot: { id: "lusd-liquity", symbol: "LUSD" },
            },
          ],
          { nowSec: 200100, predictionPolicyVersion: "sticky-24h-v1", ddrV2EffectiveAt: 90000 },
        ),
      ).rejects.toThrow(`Unlinked depeg event 2 maps to existing incident ${incident.incidentKey}`);
    } finally {
      db.close();
    }
  });

  it("rejects malformed canonical incident source fingerprints", async () => {
    const db = makeSqliteD1();
    try {
      await expect(
        ensureCanonicalIncidents(
          db,
          [
            {
              eventId: 1,
              stablecoinId: "lusd-liquity",
              pegCurrency: "USD",
              direction: "below",
              startedAt: 100000,
              peakDeviationBps: -300,
              source: "live",
              sourceFingerprint: "not-a-hash",
            },
          ],
          { nowSec: 200000, predictionPolicyVersion: "sticky-24h-v1", ddrV2EffectiveAt: 90000 },
        ),
      ).rejects.toThrow(/sourceFingerprint for event 1 must be a 64-character lowercase hex hash/);
    } finally {
      db.close();
    }
  });

  it("adopts nearby pre-lock events into an unsealed canonical incident", async () => {
    const db = makeSqliteD1();
    try {
      const incident = await ensureIncident(db, 1, 100500);
      const [nearby] = await ensureCanonicalIncidents(
        db,
        [
          {
            eventId: 2,
            stablecoinId: "lusd-liquity",
            pegCurrency: "USD",
            direction: "below",
            startedAt: 100900,
            peakDeviationBps: -350,
            source: "live",
          },
        ],
        { nowSec: 101000, predictionPolicyVersion: "sticky-24h-v1", ddrV2EffectiveAt: 90000, createdBy: "vitest" },
      );

      expect(nearby?.incidentKey).toBe(incident.incidentKey);
      expect(nearby?.eventId).toBe(2);
      expect(nearby?.currentEventId).toBe(2);
      expect(nearby?.relation).toBe("repair_replacement");

      const link = db.sqlite
        .prepare("SELECT relation, note FROM depeg_resolver_incident_event_links WHERE event_id = 2")
        .get() as { relation: string; note: string };
      expect(link).toEqual({
        relation: "repair_replacement",
        note: "pre-lock nearby event adopted as current incident source",
      });

      const revision = db.sqlite
        .prepare("SELECT previous_event_id, current_event_id, reason, created_by FROM depeg_resolver_incident_revisions WHERE current_event_id = 2")
        .get() as { previous_event_id: number; current_event_id: number; reason: string; created_by: string };
      expect(revision).toEqual({
        previous_event_id: 1,
        current_event_id: 2,
        reason: "pre-lock nearby event adopted as current incident source",
        created_by: "vitest",
      });
    } finally {
      db.close();
    }
  });

  it("requires explicit repair for closed nearby pre-lock events", async () => {
    const db = makeSqliteD1();
    try {
      const incident = await ensureIncident(db);
      await expect(
        ensureCanonicalIncidents(
          db,
          [
            {
              eventId: 2,
              stablecoinId: "lusd-liquity",
              pegCurrency: "USD",
              direction: "below",
              startedAt: 100900,
              endedAt: 101200,
              peakDeviationBps: -350,
              source: "live",
            },
          ],
          { nowSec: 101000, predictionPolicyVersion: "sticky-24h-v1", ddrV2EffectiveAt: 90000, createdBy: "vitest" },
        ),
      ).rejects.toThrow(`Unlinked depeg event 2 overlaps nearby canonical incident ${incident.incidentKey}; explicit repair required`);

      const current = db.sqlite
        .prepare("SELECT current_event_id, current_started_at FROM depeg_resolver_incidents WHERE incident_key = ?")
        .get(incident.incidentKey) as { current_event_id: number; current_started_at: number };
      expect(current).toEqual({ current_event_id: 1, current_started_at: 100000 });
    } finally {
      db.close();
    }
  });

  it("requires explicit repair instead of sliding an unsealed incident beyond its original lock window", async () => {
    const db = makeSqliteD1();
    try {
      const incident = await ensureIncident(db);
      await expect(
        ensureCanonicalIncidents(
          db,
          [
            {
              eventId: 2,
              stablecoinId: "lusd-liquity",
              pegCurrency: "USD",
              direction: "below",
              startedAt: 100900,
              peakDeviationBps: -350,
              source: "live",
            },
          ],
          { nowSec: 186400, predictionPolicyVersion: "sticky-24h-v1", ddrV2EffectiveAt: 90000, createdBy: "vitest" },
        ),
      ).rejects.toThrow(`Unlinked depeg event 2 overlaps nearby canonical incident ${incident.incidentKey}; explicit repair required`);
    } finally {
      db.close();
    }
  });

  it("links sealed live tails through automated repair authorizations", async () => {
    const db = makeSqliteD1();
    try {
      const { incident } = await sealPredictionFixture(db);
      const [nearby] = await ensureCanonicalIncidents(
        db,
        [
          {
            eventId: 2,
            stablecoinId: "lusd-liquity",
            pegCurrency: "USD",
            direction: "below",
            startedAt: 100900,
            peakDeviationBps: -350,
            source: "live",
          },
        ],
        { nowSec: 201000, predictionPolicyVersion: "sticky-24h-v1", ddrV2EffectiveAt: 90000, createdBy: "vitest" },
      );

      expect(nearby?.incidentKey).toBe(incident.incidentKey);
      expect(nearby?.eventId).toBe(2);
      expect(nearby?.currentEventId).toBe(2);
      expect(nearby?.relation).toBe("repair_replacement");

      const link = db.sqlite
        .prepare(
          `SELECT relation, note, repair_authorization_id
           FROM depeg_resolver_incident_event_links
           WHERE event_id = 2`,
        )
        .get() as { relation: string; note: string; repair_authorization_id: number };
      expect(link).toEqual({
        relation: "repair_replacement",
        note: "sealed incident live tail linked through automated repair authorization",
        repair_authorization_id: expect.any(Number),
      });

      const authorizations = db.sqlite
        .prepare(
          `SELECT operation, columns_json, created_by
           FROM depeg_resolver_event_repair_authorizations
           WHERE event_id = 2
           ORDER BY id`,
        )
        .all() as Array<{ operation: string; columns_json: string; created_by: string }>;
      expect(authorizations).toEqual([
        {
          operation: "incident_link",
          columns_json: '["event_id","incident_key"]',
          created_by: "ddr-worker:auto-sealed-tail",
        },
        {
          operation: "incident_current_update",
          columns_json: '["current_event_id","current_started_at"]',
          created_by: "ddr-worker:auto-sealed-tail",
        },
      ]);

      const revision = db.sqlite
        .prepare(
          `SELECT previous_event_id, current_event_id, reason, repair_authorization_id, created_by
           FROM depeg_resolver_incident_revisions
           WHERE current_event_id = 2`,
        )
        .get() as {
          previous_event_id: number;
          current_event_id: number;
          reason: string;
          repair_authorization_id: number;
          created_by: string;
        };
      expect(revision).toEqual({
        previous_event_id: 1,
        current_event_id: 2,
        reason: "sealed incident live tail adopted as current source event",
        repair_authorization_id: expect.any(Number),
        created_by: "ddr-worker:auto-sealed-tail",
      });

      const uses = db.sqlite
        .prepare(
          `SELECT operation, target_table
           FROM depeg_resolver_event_repair_authorization_uses
           WHERE event_id = 2
           ORDER BY authorization_id`,
        )
        .all() as Array<{ operation: string; target_table: string }>;
      expect(uses).toEqual([
        { operation: "incident_link", target_table: "depeg_resolver_incident_event_links" },
        { operation: "incident_current_update", target_table: "depeg_resolver_incidents" },
      ]);
    } finally {
      db.close();
    }
  });

  it("links sealed live tails that reopen inside the close-gap merge window even when far from incident start", async () => {
    const db = makeSqliteD1();
    try {
      const { incident } = await sealPredictionFixture(db);
      db.sqlite
        .prepare("UPDATE depeg_events SET ended_at = ?, recovery_price = ? WHERE id = 1")
        .run(1_000_000, 1.0001);

      const [tail] = await ensureCanonicalIncidents(
        db,
        [
          {
            eventId: 2,
            stablecoinId: "lusd-liquity",
            pegCurrency: "USD",
            direction: "below",
            startedAt: 1_007_200,
            peakDeviationBps: -425,
            source: "live",
          },
        ],
        { nowSec: 1_008_000, predictionPolicyVersion: "sticky-24h-v1", ddrV2EffectiveAt: 90000, createdBy: "vitest" },
      );

      expect(tail?.incidentKey).toBe(incident.incidentKey);
      expect(tail?.eventId).toBe(2);
      expect(tail?.currentEventId).toBe(2);
      expect(tail?.relation).toBe("repair_replacement");
      expect(
        db.sqlite
          .prepare("SELECT COUNT(*) AS count FROM depeg_resolver_incidents WHERE stablecoin_id = 'lusd-liquity'")
          .get(),
      ).toEqual({ count: 1 });
    } finally {
      db.close();
    }
  });

  it("resolves superseded incident event links to the canonical incident when loading by event id", async () => {
    const db = makeSqliteD1();
    try {
      const { incident } = await sealPredictionFixture(db);
      db.sqlite
        .prepare(
          `INSERT INTO depeg_events
           (id, stablecoin_id, symbol, peg_type, direction, peak_deviation_bps,
            started_at, ended_at, start_price, peak_price, recovery_price, peg_reference, source)
           VALUES (2, 'lusd-liquity', 'LUSD', 'peggedUSD', 'below', -425,
                   1007200, NULL, 0.96, 0.9575, NULL, 1, 'live')`,
        )
        .run();
      db.sqlite
        .prepare(
          `INSERT INTO depeg_resolver_incident_event_links
           (incident_key, event_id, relation, repair_authorization_id, linked_at, note)
           VALUES ('ddr2:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 2, 'observed', NULL, 1007201, 'duplicate incident link')`,
        )
        .run();
      db.sqlite
        .prepare(
          `INSERT INTO depeg_resolver_incidents
           (incident_key, stablecoin_id, peg_currency, direction, first_event_id, current_event_id,
            first_started_at, current_started_at, first_observed_peak_bucket_bps, incident_state,
            superseded_by_incident_key, source_fingerprint, created_at, updated_at)
           VALUES ('ddr2:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 'lusd-liquity', 'USD', 'below', 2, 2,
                   1007200, 1007200, 425, 'superseded', ?,
                   'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 1007201, 1007201)`,
        )
        .run(incident.incidentKey);

      const [resolved] = await loadCanonicalIncidents(db, {
        eventIds: [2],
        includeSuperseded: true,
        policyDelaySec: 86400,
      });

      expect(resolved?.incidentKey).toBe(incident.incidentKey);
      expect(resolved?.eventId).toBe(2);
      expect(resolved?.currentEventId).toBe(2);
      expect(resolved?.currentStartedAt).toBe(1_007_200);
      expect(resolved?.startedAt).toBe(100_000);
    } finally {
      db.close();
    }
  });

  it("still requires manual repair for non-live nearby events after a public prediction is sealed", async () => {
    const db = makeSqliteD1();
    try {
      const { incident } = await sealPredictionFixture(db);
      await expect(
        ensureCanonicalIncidents(
          db,
          [
            {
              eventId: 2,
              stablecoinId: "lusd-liquity",
              pegCurrency: "USD",
              direction: "below",
              startedAt: 100900,
              peakDeviationBps: -350,
              source: "backfill",
            },
          ],
          { nowSec: 201000, predictionPolicyVersion: "sticky-24h-v1", ddrV2EffectiveAt: 90000, createdBy: "vitest" },
        ),
      ).rejects.toThrow(`Unlinked depeg event 2 overlaps nearby canonical incident ${incident.incidentKey}; explicit repair required`);
    } finally {
      db.close();
    }
  });

  it("quarantines repair-required events via onRepairRequired instead of failing the run", async () => {
    const db = makeSqliteD1();
    try {
      const { incident } = await sealPredictionFixture(db);
      const quarantined: Array<{ eventId: number; reason: string }> = [];
      const incidents = await ensureCanonicalIncidents(
        db,
        [
          {
            // Conflicted: overlaps the sealed incident without a link.
            eventId: 2,
            stablecoinId: "lusd-liquity",
            pegCurrency: "USD",
            direction: "below",
            startedAt: 100900,
            peakDeviationBps: -350,
            source: "backfill",
          },
          {
            // Clean: far from the sealed incident; must still be processed.
            eventId: 3,
            stablecoinId: "lusd-liquity",
            pegCurrency: "USD",
            direction: "below",
            startedAt: 900000,
            peakDeviationBps: -200,
            source: "live",
          },
        ],
        {
          nowSec: 901000,
          predictionPolicyVersion: "sticky-24h-v1",
          ddrV2EffectiveAt: 90000,
          createdBy: "vitest",
          onRepairRequired: (eventId, reason) => {
            quarantined.push({ eventId, reason });
          },
        },
      );

      expect(quarantined).toHaveLength(1);
      expect(quarantined[0].eventId).toBe(2);
      expect(quarantined[0].reason).toContain(incident.incidentKey);
      expect(incidents.map((entry) => entry.eventId)).toEqual([3]);
    } finally {
      db.close();
    }
  });

  it("propagates D1 read failures from incident reads", async () => {
    const db = mockD1([
      {
        match: "FROM depeg_resolver_incidents i",
        rows: [],
        throwError: new Error("D1_ERROR: incident read failed"),
      },
    ]);

    await expect(loadCanonicalIncidents(db, { stablecoinIds: ["lusd-liquity"] })).rejects.toThrow(
      "D1_ERROR: incident read failed",
    );
  });

  it("seals exactly one public prediction and makes the assessment immutable", async () => {
    const db = makeSqliteD1();
    try {
      const { incident, prediction } = await sealPredictionFixture(db);
      expect(prediction.incidentKey).toBe(incident.incidentKey);
      expect(prediction.rowHash).toMatch(/^[0-9a-f]{64}$/);
      expect(prediction.lockTrigger).toBeNull();
      expect(prediction.backstopAt).toBeNull();
      const duplicatePayload = sealedPayloadWithHash(incident.incidentKey);

      const duplicate = await sealPublicPrediction(db, {
        incidentKey: incident.incidentKey,
        eventId: 1,
        stablecoinId: "lusd-liquity",
        symbol: "LUSD",
        name: "Liquity USD",
        pegCurrency: "USD",
        governance: "decentralized",
        direction: "below",
        startedAt: 100000,
        assessedAt: 186500,
        eventAgeSec: 86500,
        methodologyVersion: "2.1",
        methodologyVersionLabel: "v2.1",
        resolutionRubricVersion: "resolution-rubric-v2",
        durationModelVersion: "duration-landmark-v2",
        incidentGroupingVersion: "incident-group-v2",
        supportRulesVersion: "support-rules-v2",
        resolutionTier: "recovery_likely",
        durationSuppressed: false,
        sealedPayload: duplicatePayload.payload,
        rowHash: duplicatePayload.rowHash,
        predictionPolicyVersion: "sticky-24h-v1",
        policyDelaySec: 86400,
        eligibleAt: 186400,
        lockedAt: 186500,
        eventAgeAtLockSec: 86500,
        lockTiming: "late_freeze",
        createdAt: 186501,
      });
      expect(duplicate.id).toBe(prediction.id);
      expect(() =>
        db.sqlite.exec("UPDATE depeg_resolver_assessments SET row_json = '{}' WHERE checkpoint = 'public_prediction'"),
      ).toThrow(/public_prediction assessments are immutable/);
    } finally {
      db.close();
    }
  });

  it("stores readiness-triggered public predictions without fixed 24h eligibility", async () => {
    const db = makeSqliteD1();
    try {
	      insertOpenEvent(db);
	      const incident = await ensureIncident(db);
	      const eligibleAt = 143200;
	      const backstopAt = 100000 + DDR_FORECAST_READINESS_BACKSTOP_DELAY_SEC;
	      const { payload, rowHash } = sealedPayloadWithHash(incident.incidentKey, "prediction", {
	        eligibleAt,
	        lockedAt: eligibleAt,
	        eventAgeAtLockSec: 43200,
	        policyDelaySec: 43200,
	        predictionExtras: {
	          lockTrigger: "forecast_readiness",
	          readiness: {
	            version: DDR_FORECAST_READINESS_VERSION,
	            score: 0.92,
	            threshold: 0.9,
	            strictEarlyLockReady: true,
	            reasons: [],
	            components: [],
	          },
	          backstop: {
	            version: DDR_FORECAST_READINESS_VERSION,
	            delaySec: DDR_FORECAST_READINESS_BACKSTOP_DELAY_SEC,
	            backstopAt,
	            reached: false,
	          },
	        },
	      });

      const prediction = await sealPublicPrediction(db, {
        incidentKey: incident.incidentKey,
        eventId: 1,
        stablecoinId: "lusd-liquity",
        symbol: "LUSD",
        name: "Liquity USD",
        pegCurrency: "USD",
        governance: "decentralized",
        direction: "below",
        startedAt: 100000,
        assessedAt: eligibleAt,
        eventAgeSec: 43200,
        methodologyVersion: "2.0",
        methodologyVersionLabel: "v2.0",
        resolutionRubricVersion: "resolution-rubric-v2",
        durationModelVersion: "duration-landmark-v2",
        incidentGroupingVersion: "incident-group-v2",
        supportRulesVersion: "support-rules-v2",
        resolutionTier: "at_risk",
        durationSuppressed: false,
        durationSuppressedReason: null,
        medianRemainingSec: 7200,
        iqrLowRemainingSec: 3600,
        iqrHighRemainingSec: 14400,
        stratum: "below",
        horizons: [],
        factors: [],
        sealedPayload: payload,
        rowHash,
        predictionPolicyVersion: "sticky-24h-v1",
        policyDelaySec: 43200,
        eligibleAt,
        lockedAt: eligibleAt,
        eventAgeAtLockSec: 43200,
        lockTiming: "on_time",
        createdAt: eligibleAt + 1,
	        runId: "ddr:test",
	        lockTrigger: "forecast_readiness",
	        forecastReadinessScore: 0.92,
	        forecastReadinessVersion: DDR_FORECAST_READINESS_VERSION,
	        readinessThreshold: 0.9,
	        backstopAt,
	        backstopDelaySec: DDR_FORECAST_READINESS_BACKSTOP_DELAY_SEC,
	      });

      expect(prediction.lockTrigger).toBe("forecast_readiness");
      expect(prediction.forecastReadinessScore).toBe(0.92);
      expect(prediction.readinessThreshold).toBe(0.9);
      expect(prediction.backstopAt).toBe(backstopAt);
	      expect(prediction.backstopDelaySec).toBe(DDR_FORECAST_READINESS_BACKSTOP_DELAY_SEC);

      const state = db.sqlite
        .prepare(
          `SELECT lock_trigger, forecast_readiness_score, forecast_readiness_version,
                  readiness_threshold, backstop_at, backstop_delay_sec
           FROM depeg_resolver_prediction_lock_state
           WHERE incident_key = ?`,
        )
        .get(incident.incidentKey) as {
          lock_trigger: string;
          forecast_readiness_score: number;
          forecast_readiness_version: string;
          readiness_threshold: number;
          backstop_at: number;
          backstop_delay_sec: number;
        };
      expect(state).toEqual({
        lock_trigger: "forecast_readiness",
        forecast_readiness_score: 0.92,
	        forecast_readiness_version: DDR_FORECAST_READINESS_VERSION,
        readiness_threshold: 0.9,
        backstop_at: backstopAt,
	        backstop_delay_sec: DDR_FORECAST_READINESS_BACKSTOP_DELAY_SEC,
	      });

      const audit = db.sqlite
        .prepare("SELECT lock_trigger, forecast_readiness_score FROM depeg_resolver_lock_opportunity_audit WHERE incident_key = ?")
        .get(incident.incidentKey) as { lock_trigger: string; forecast_readiness_score: number };
      expect(audit).toEqual({ lock_trigger: "forecast_readiness", forecast_readiness_score: 0.92 });
    } finally {
      db.close();
    }
  });

  it("stores backstop-triggered no-call locks with backstop metadata", async () => {
    const db = makeSqliteD1();
    try {
	      insertOpenEvent(db);
	      const incident = await ensureIncident(db);
	      const backstopAt = 100000 + DDR_FORECAST_READINESS_BACKSTOP_DELAY_SEC;
	      const { payload, rowHash } = sealedPayloadWithHash(incident.incidentKey, "no_call", {
	        eligibleAt: backstopAt,
	        lockedAt: backstopAt,
	        eventAgeAtLockSec: DDR_FORECAST_READINESS_BACKSTOP_DELAY_SEC,
	        policyDelaySec: DDR_FORECAST_READINESS_BACKSTOP_DELAY_SEC,
	        predictionExtras: {
	          lockTrigger: "readiness_backstop",
	          readiness: {
	            version: DDR_FORECAST_READINESS_VERSION,
	            score: 0.61,
	            threshold: DDR_FORECAST_READINESS_STRICT_EARLY_LOCK_THRESHOLD,
	            strictEarlyLockReady: false,
	            reasons: [],
	            components: [],
	          },
	          backstop: {
	            version: DDR_FORECAST_READINESS_VERSION,
	            delaySec: DDR_FORECAST_READINESS_BACKSTOP_DELAY_SEC,
	            backstopAt,
	            reached: true,
	          },
	        },
	      });

      const prediction = await sealPublicNoCall(db, {
        incidentKey: incident.incidentKey,
        eventId: 1,
        stablecoinId: "lusd-liquity",
        symbol: "LUSD",
        name: "Liquity USD",
        pegCurrency: "USD",
        governance: "decentralized",
	        direction: "below",
	        startedAt: 100000,
	        assessedAt: backstopAt,
	        eventAgeSec: DDR_FORECAST_READINESS_BACKSTOP_DELAY_SEC,
	        methodologyVersion: "2.0",
        methodologyVersionLabel: "v2.0",
        resolutionRubricVersion: "resolution-rubric-v2",
        durationModelVersion: "duration-landmark-v2",
        incidentGroupingVersion: "incident-group-v2",
        supportRulesVersion: "support-rules-v2",
        sealedPayload: payload,
	        rowHash,
	        predictionPolicyVersion: "sticky-24h-v1",
	        policyDelaySec: DDR_FORECAST_READINESS_BACKSTOP_DELAY_SEC,
	        eligibleAt: backstopAt,
	        lockedAt: backstopAt,
	        eventAgeAtLockSec: DDR_FORECAST_READINESS_BACKSTOP_DELAY_SEC,
	        lockTiming: "on_time",
	        createdAt: backstopAt + 1,
	        lockTrigger: "readiness_backstop",
	        forecastReadinessScore: 0.61,
	        forecastReadinessVersion: DDR_FORECAST_READINESS_VERSION,
	        readinessThreshold: DDR_FORECAST_READINESS_STRICT_EARLY_LOCK_THRESHOLD,
	        backstopAt,
	        backstopDelaySec: DDR_FORECAST_READINESS_BACKSTOP_DELAY_SEC,
	      });

      expect(prediction.outcomeKind).toBe("no_call");
	      expect(prediction.lockTrigger).toBe("readiness_backstop");
	      expect(prediction.backstopAt).toBe(backstopAt);
	      expect(prediction.backstopDelaySec).toBe(DDR_FORECAST_READINESS_BACKSTOP_DELAY_SEC);
	      expect(prediction.forecastReadinessScore).toBe(0.61);

      const audit = db.sqlite
        .prepare("SELECT action, lock_trigger, backstop_at, backstop_delay_sec FROM depeg_resolver_lock_opportunity_audit WHERE incident_key = ?")
        .get(incident.incidentKey) as { action: string; lock_trigger: string; backstop_at: number; backstop_delay_sec: number };
      expect(audit).toEqual({
	        action: "locked_no_call",
	        lock_trigger: "readiness_backstop",
	        backstop_at: backstopAt,
	        backstop_delay_sec: DDR_FORECAST_READINESS_BACKSTOP_DELAY_SEC,
	      });
    } finally {
      db.close();
    }
  });

  it("rejects readiness backstop locks that do not use the 72h backstop delay", async () => {
    const db = makeSqliteD1();
    try {
      insertOpenEvent(db);
      const incident = await ensureIncident(db);
      const backstopAt = 143200;
      const { payload, rowHash } = sealedPayloadWithHash(incident.incidentKey, "no_call", {
        eligibleAt: backstopAt,
        lockedAt: backstopAt,
        eventAgeAtLockSec: 43200,
        policyDelaySec: 43200,
        predictionExtras: {
          lockTrigger: "readiness_backstop",
          backstop: {
            version: DDR_FORECAST_READINESS_VERSION,
            delaySec: 43200,
            backstopAt,
            reached: true,
          },
        },
      });

      await expect(
        sealPublicNoCall(db, {
          incidentKey: incident.incidentKey,
          eventId: 1,
          stablecoinId: "lusd-liquity",
          symbol: "LUSD",
          name: "Liquity USD",
          pegCurrency: "USD",
          governance: "decentralized",
          direction: "below",
          startedAt: 100000,
          assessedAt: backstopAt,
          eventAgeSec: 43200,
          methodologyVersion: "2.0",
          methodologyVersionLabel: "v2.0",
          resolutionRubricVersion: "resolution-rubric-v2",
          durationModelVersion: "duration-landmark-v2",
          incidentGroupingVersion: "incident-group-v2",
          supportRulesVersion: "support-rules-v2",
          sealedPayload: payload,
          rowHash,
          predictionPolicyVersion: "sticky-24h-v1",
          policyDelaySec: 43200,
          eligibleAt: backstopAt,
          lockedAt: backstopAt,
          eventAgeAtLockSec: 43200,
          lockTiming: "on_time",
          createdAt: backstopAt + 1,
          lockTrigger: "readiness_backstop",
          backstopAt,
          backstopDelaySec: 43200,
        }),
      ).rejects.toThrow(/readiness-72h backstop delay/);
    } finally {
      db.close();
    }
  });

  it("rejects readiness metadata outside the unit interval", async () => {
    const db = makeSqliteD1();
    try {
      insertOpenEvent(db);
      const incident = await ensureIncident(db);
      await expect(
        recordLockOpportunity(db, {
          incidentKey: incident.incidentKey,
          eventId: 1,
          predictionPolicyVersion: "sticky-24h-v1",
          eligibleAt: 143200,
          runAt: 143200,
          action: "pending",
          reason: null,
          healthStatus: "healthy",
          lockTrigger: "forecast_readiness",
          forecastReadinessScore: 1.01,
          forecastReadinessVersion: DDR_FORECAST_READINESS_VERSION,
          readinessThreshold: DDR_FORECAST_READINESS_STRICT_EARLY_LOCK_THRESHOLD,
          backstopAt: 100000 + DDR_FORECAST_READINESS_BACKSTOP_DELAY_SEC,
          backstopDelaySec: DDR_FORECAST_READINESS_BACKSTOP_DELAY_SEC,
        }),
      ).rejects.toThrow(/\[0, 1\]/);
    } finally {
      db.close();
    }
  });

  it("overwrites unsealed lock-state metadata with the sealed lock metadata", async () => {
    const db = makeSqliteD1();
    try {
      insertOpenEvent(db);
      const incident = await ensureIncident(db);
      const backstopAt = 100000 + DDR_FORECAST_READINESS_BACKSTOP_DELAY_SEC;
      await recordLockOpportunity(db, {
        incidentKey: incident.incidentKey,
        eventId: 1,
        predictionPolicyVersion: "sticky-24h-v1",
        eligibleAt: 143200,
        runAt: 143200,
        action: "pending",
        reason: null,
        healthStatus: "healthy",
        lockTrigger: "forecast_readiness",
        forecastReadinessScore: 0.92,
        forecastReadinessVersion: DDR_FORECAST_READINESS_VERSION,
        readinessThreshold: DDR_FORECAST_READINESS_STRICT_EARLY_LOCK_THRESHOLD,
        backstopAt,
        backstopDelaySec: DDR_FORECAST_READINESS_BACKSTOP_DELAY_SEC,
      });

      const { payload, rowHash } = sealedPayloadWithHash(incident.incidentKey, "no_call", {
        eligibleAt: backstopAt,
        lockedAt: backstopAt,
        eventAgeAtLockSec: DDR_FORECAST_READINESS_BACKSTOP_DELAY_SEC,
        policyDelaySec: DDR_FORECAST_READINESS_BACKSTOP_DELAY_SEC,
        predictionExtras: {
          lockTrigger: "readiness_backstop",
          readiness: {
            version: DDR_FORECAST_READINESS_VERSION,
            score: 0.61,
            threshold: DDR_FORECAST_READINESS_STRICT_EARLY_LOCK_THRESHOLD,
            strictEarlyLockReady: false,
            reasons: [],
            components: [],
          },
          backstop: {
            version: DDR_FORECAST_READINESS_VERSION,
            delaySec: DDR_FORECAST_READINESS_BACKSTOP_DELAY_SEC,
            backstopAt,
            reached: true,
          },
        },
      });
      await sealPublicNoCall(db, {
        incidentKey: incident.incidentKey,
        eventId: 1,
        stablecoinId: "lusd-liquity",
        symbol: "LUSD",
        name: "Liquity USD",
        pegCurrency: "USD",
        governance: "decentralized",
        direction: "below",
        startedAt: 100000,
        assessedAt: backstopAt,
        eventAgeSec: DDR_FORECAST_READINESS_BACKSTOP_DELAY_SEC,
        methodologyVersion: "2.0",
        methodologyVersionLabel: "v2.0",
        resolutionRubricVersion: "resolution-rubric-v2",
        durationModelVersion: "duration-landmark-v2",
        incidentGroupingVersion: "incident-group-v2",
        supportRulesVersion: "support-rules-v2",
        sealedPayload: payload,
        rowHash,
        predictionPolicyVersion: "sticky-24h-v1",
        policyDelaySec: DDR_FORECAST_READINESS_BACKSTOP_DELAY_SEC,
        eligibleAt: backstopAt,
        lockedAt: backstopAt,
        eventAgeAtLockSec: DDR_FORECAST_READINESS_BACKSTOP_DELAY_SEC,
        lockTiming: "on_time",
        createdAt: backstopAt + 1,
        lockTrigger: "readiness_backstop",
        forecastReadinessScore: 0.61,
        forecastReadinessVersion: DDR_FORECAST_READINESS_VERSION,
        readinessThreshold: DDR_FORECAST_READINESS_STRICT_EARLY_LOCK_THRESHOLD,
        backstopAt,
        backstopDelaySec: DDR_FORECAST_READINESS_BACKSTOP_DELAY_SEC,
      });

      const state = db.sqlite
        .prepare(
          `SELECT last_state, lock_trigger, forecast_readiness_score, backstop_at, backstop_delay_sec
           FROM depeg_resolver_prediction_lock_state
           WHERE incident_key = ?`,
        )
        .get(incident.incidentKey) as {
          last_state: string;
          lock_trigger: string;
          forecast_readiness_score: number;
          backstop_at: number;
          backstop_delay_sec: number;
        };
      expect(state).toEqual({
        last_state: "no_call",
        lock_trigger: "readiness_backstop",
        forecast_readiness_score: 0.61,
        backstop_at: backstopAt,
        backstop_delay_sec: DDR_FORECAST_READINESS_BACKSTOP_DELAY_SEC,
      });
    } finally {
      db.close();
    }
  });

  it("rejects malformed sealed public prediction payload JSON on read", async () => {
    const db = makeSqliteD1();
    try {
      const { prediction } = await sealPredictionFixture(db);
      db.sqlite.exec("DROP TRIGGER trg_ddr_public_predictions_no_update");
      db.sqlite.exec("PRAGMA ignore_check_constraints = ON");
      db.sqlite
        .prepare("UPDATE depeg_resolver_public_predictions SET sealed_payload_json = ? WHERE id = ?")
        .run("{bad", prediction.id);

      await expect(
        loadSealedPublicPredictions(db, { publicPredictionIds: [prediction.id] }),
      ).rejects.toThrow(/sealedPayloadJson must be valid JSON/);
    } finally {
      db.close();
    }
  });

  it("stores no-call locks with flattened insufficient-signal fields", async () => {
    const db = makeSqliteD1();
    try {
      insertOpenEvent(db);
      const incident = await ensureIncident(db);
      const { payload, rowHash } = sealedPayloadWithHash(incident.incidentKey, "no_call");
      const prediction = await sealPublicNoCall(db, {
        incidentKey: incident.incidentKey,
        eventId: 1,
        stablecoinId: "lusd-liquity",
        symbol: "LUSD",
        name: "Liquity USD",
        pegCurrency: "USD",
        governance: "decentralized",
        direction: "below",
        startedAt: 100000,
        assessedAt: 186400,
        eventAgeSec: 86400,
        methodologyVersion: "2.0",
        methodologyVersionLabel: "v2.0",
        resolutionRubricVersion: "resolution-rubric-v2",
        durationModelVersion: "duration-landmark-v2",
        incidentGroupingVersion: "incident-group-v2",
        supportRulesVersion: "support-rules-v2",
        sealedPayload: payload,
        rowHash,
        predictionPolicyVersion: "sticky-24h-v1",
        policyDelaySec: 86400,
        eligibleAt: 186400,
        lockedAt: 186400,
        eventAgeAtLockSec: 86400,
        lockTiming: "on_time",
        createdAt: 186401,
      });

      expect(prediction.outcomeKind).toBe("no_call");
      const row = db.sqlite
        .prepare("SELECT resolution_tier, duration_suppressed, horizons_json, factors_json FROM depeg_resolver_assessments")
        .get() as { resolution_tier: string; duration_suppressed: number; horizons_json: string; factors_json: string };
      expect(row).toEqual({
        resolution_tier: "insufficient_signal",
        duration_suppressed: 1,
        horizons_json: "[]",
        factors_json: "[]",
      });
    } finally {
      db.close();
    }
  });

  it("enforces append-only errata and repair authorization consumption", async () => {
    const db = makeSqliteD1();
    try {
      const { incident, prediction } = await sealPredictionFixture(db);
      const erratumId = insertPredictionErratum(db, {
        publicPredictionId: prediction.id,
        incidentKey: incident.incidentKey,
        eventId: 1,
        assessmentId: prediction.assessmentId,
        reason: "event_identity_error",
        operatorNote: "test repair evidence",
        rowHashBefore: prediction.rowHash,
        createdAt: 190000,
        createdBy: "vitest",
      });
      expect(erratumId).toBeGreaterThan(0);
      expect(() => db.sqlite.exec("UPDATE depeg_resolver_prediction_errata SET operator_note = 'mutated'")).toThrow(
        /prediction errata are append-only/,
      );
      expect(() => db.sqlite.exec("UPDATE depeg_events SET started_at = 100001 WHERE id = 1")).toThrow(
        /sealed depeg event identity updates require incident repair authorization/,
      );

      const authorization = await authorizeEventRepair(db, {
        eventId: 1,
        incidentKey: incident.incidentKey,
        operation: "identity_update",
        columns: ["started_at"],
        reason: "correct start timestamp",
        createdAt: 190010,
        expiresAt: 4102444800,
        createdBy: "vitest",
      });
      await consumeEventRepairAuthorization(db, {
        authorizationId: authorization.id,
        eventId: 1,
        incidentKey: incident.incidentKey,
        operation: "identity_update",
        consumedAt: 190011,
        consumer: "vitest",
      });
      expect(() =>
        db.sqlite.exec("UPDATE depeg_events SET started_at = 100001 WHERE id = 1"),
      ).not.toThrow();
      expect(() => db.sqlite.exec("UPDATE depeg_events SET started_at = 100002 WHERE id = 1")).toThrow(
        /sealed depeg event identity updates require incident repair authorization/,
      );
      await expect(
        consumeEventRepairAuthorization(db, {
          authorizationId: authorization.id,
          eventId: 1,
          incidentKey: incident.incidentKey,
          operation: "identity_update",
          consumedAt: 190012,
          consumer: "vitest",
        }),
      ).rejects.toThrow();
    } finally {
      db.close();
    }
  });

  it("rejects malformed optional erratum hashes at the database boundary", async () => {
    const db = makeSqliteD1();
    try {
      const { incident, prediction } = await sealPredictionFixture(db);
      expect(() =>
        insertPredictionErratum(db, {
          publicPredictionId: prediction.id,
          incidentKey: incident.incidentKey,
          eventId: 1,
          assessmentId: prediction.assessmentId,
          reason: "hash_mismatch",
          operatorNote: "bad replacement hash",
          replacementRowHash: "not-a-hash",
          createdAt: 190000,
          createdBy: "vitest",
        }),
      ).toThrow(/CHECK constraint failed/);
    } finally {
      db.close();
    }
  });

  it("finalizes publication manifests atomically and records first-publication membership once", async () => {
      const db = makeSqliteD1();
    try {
      const { prediction } = await sealPredictionFixture(db);
      const rawManifestPayload = sealedPayload(prediction.incidentKey);
      const manifestPayload = attachDdrPublicRowHash(
        {
          ...rawManifestPayload,
          prediction: {
            ...(rawManifestPayload.prediction as Record<string, unknown>),
            publicPredictionId: prediction.id,
            state: "frozen",
            publishedAt: 200000,
            publicationSnapshotToken: "ddrpub:test:1",
            snapshotGeneration: 2,
          },
        },
        prediction.rowHash,
      );
      const basePayload = {
        _meta: {
          publicPredictionIds: [prediction.id],
          publicPredictionRowHashes: { [prediction.id]: prediction.rowHash },
        },
        rows: [manifestPayload],
      };
      await expect(
        writePublicationManifest(db, {
          snapshotToken: "ddrpub:test:mutated",
          snapshotGeneration: 2,
          publishedAt: 199999,
          validatorVersion: "vitest",
          basePayload: {
            ...basePayload,
            rows: [
              {
                ...manifestPayload,
                frozen: {
                  ...(manifestPayload.frozen as Record<string, unknown>),
                  tampered: true,
                },
              },
            ],
          },
        }),
      ).rejects.toThrow(/canonical hash does not match sealed row hash/);

      const manifest = await writePublicationManifest(db, {
        snapshotToken: "ddrpub:test:1",
        snapshotGeneration: 2,
        publishedAt: 200000,
        validatorVersion: "vitest",
        basePayload,
      });
      expect(manifest.publicPredictionIds).toEqual([prediction.id]);
      expect(manifest.publicPredictionCount).toBe(1);
      expect(manifest.publicPredictionRowHashes).toEqual({ [prediction.id]: prediction.rowHash });
      expect(() =>
        db.sqlite
          .prepare(
            `INSERT INTO depeg_resolver_publication_snapshot_rows
             (snapshot_token, public_prediction_id, incident_key, first_published)
             VALUES (?, ?, ?, 0)`,
          )
          .run(manifest.snapshotToken, prediction.id, prediction.incidentKey),
      ).toThrow(/cannot add rows to a finalized publication snapshot/);

      await writePublicationManifest(db, {
        snapshotToken: "ddrpub:test:2",
        snapshotGeneration: 2,
        publishedAt: 200100,
        validatorVersion: "vitest",
        basePayload,
      });

      const membership = await loadFirstPublicationMembership(db, { publicPredictionIds: [prediction.id] });
      expect(membership).toHaveLength(1);
      expect(membership[0]?.snapshotToken).toBe("ddrpub:test:1");

      const latest = await loadLatestPublicationManifest(db);
      expect(latest).toMatchObject({
        snapshotToken: "ddrpub:test:2",
        snapshotKind: "ddr_public",
        snapshotSequence: 2,
        snapshotGeneration: 2,
        publishedAt: 200100,
        publicPredictionIds: [prediction.id],
        publicPredictionRowHashes: { [prediction.id]: prediction.rowHash },
        baseRowCount: 1,
        publicPredictionCount: 1,
        validatorVersion: "vitest",
      });
    } finally {
      db.close();
    }
  });

  it("rejects malformed publication manifest metadata JSON on read", async () => {
    const db = makeSqliteD1();
    try {
      const { prediction } = await sealPredictionFixture(db);
      const rawManifestPayload = sealedPayload(prediction.incidentKey);
      const manifestPayload = attachDdrPublicRowHash(
        {
          ...rawManifestPayload,
          prediction: {
            ...(rawManifestPayload.prediction as Record<string, unknown>),
            publicPredictionId: prediction.id,
            state: "frozen",
            publishedAt: 200000,
            publicationSnapshotToken: "ddrpub:test:bad-json",
            snapshotGeneration: 2,
          },
        },
        prediction.rowHash,
      );

      await writePublicationManifest(db, {
        snapshotToken: "ddrpub:test:bad-json",
        snapshotGeneration: 2,
        publishedAt: 200000,
        validatorVersion: "vitest",
        basePayload: {
          _meta: {
            publicPredictionIds: [prediction.id],
            publicPredictionRowHashes: { [prediction.id]: prediction.rowHash },
          },
          rows: [manifestPayload],
        },
      });

      db.sqlite.exec("DROP TRIGGER trg_ddr_publication_snapshots_no_update");
      db.sqlite
        .prepare(
          `UPDATE depeg_resolver_publication_snapshots
           SET public_prediction_ids_json = ?
           WHERE snapshot_token = ?`,
        )
        .run("{}", "ddrpub:test:bad-json");

      await expect(loadLatestPublicationManifest(db)).rejects.toThrow(
        /publicPredictionIdsJson must be a JSON array/,
      );
    } finally {
      db.close();
    }
  });

  it("propagates D1 batch failures while writing publication manifests", async () => {
    const db = mockD1([
      {
        match: "INSERT INTO depeg_resolver_publication_snapshots",
        rows: [],
        throwError: new Error("D1_ERROR: manifest batch failed"),
      },
    ]);

    await expect(
      writePublicationManifest(db, {
        snapshotToken: "ddrpub:test:empty",
        snapshotGeneration: 2,
        publishedAt: 200000,
        validatorVersion: "vitest",
        basePayload: {
          _meta: {
            publicPredictionIds: [],
            publicPredictionRowHashes: {},
          },
          rows: [],
        },
      }),
    ).rejects.toThrow("D1_ERROR: manifest batch failed");
  });

  it("persists publication retry state for sealed rows", async () => {
    const db = makeSqliteD1();
    try {
      const { incident } = await sealPredictionFixture(db);

      await recordLockOpportunity(db, {
        incidentKey: incident.incidentKey,
        eventId: 1,
        predictionPolicyVersion: "sticky-24h-v1",
        eligibleAt: 186400,
        runAt: 200000,
        action: "publication_retry_pending",
        reason: "manifest write failed",
        healthStatus: "healthy",
      });

      const row = db.sqlite
        .prepare("SELECT last_state FROM depeg_resolver_prediction_lock_state WHERE incident_key = ?")
        .get(incident.incidentKey) as { last_state: string };
      expect(row.last_state).toBe("publication_retry_pending");
    } finally {
      db.close();
    }
  });
});
