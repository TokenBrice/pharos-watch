import { DatabaseSync } from "node:sqlite";
import type { D1Database } from "@cloudflare/workers-types";
import { describe, expect, it } from "vitest";
import { mockD1 } from "@shared/test-utils/mock-d1";
import { createLatestSchemaSqlite } from "../../test-helpers/latest-schema-sqlite";
import {
  closeRecoveredPreLockIncidents,
  DDR_FLAP_TOLERANT_MAX_INCIDENT_SPAN_SEC_V1,
  DDR_FLAP_TOLERANT_MAX_LINK_COUNT_V1,
  DDR_INCIDENT_REOPEN_MERGE_WINDOW_SEC,
  DDR_PRE_LOCK_CLOSE_SETTLE_MARGIN_SEC_V1,
  DDR_SEALED_TAIL_REGIME_ESCALATION_MIN_PEAK_BPS_V1,
  DDR_SEALED_TAIL_REGIME_ESCALATION_MULTIPLIER_V1,
  ensureCanonicalIncidents,
  loadCanonicalIncidents,
} from "../depeg-resolver-incident-store";
import { recordLockDeferral, recordLockOpportunity } from "../depeg-resolver-lock-opportunity-store";
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
} from "@shared/lib/methodology-versions/depeg-resolver";
import { coverageRowForIncident } from "../../cron/depeg-resolver-review/coverage-rows";

interface SqliteD1 extends D1Database {
  close(): void;
  sqlite: DatabaseSync;
}

function makeSqliteD1(): SqliteD1 {
  const { sqlite, db } = createLatestSchemaSqlite();
  return Object.assign(db, { sqlite, close: () => sqlite.close() }) as SqliteD1;
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

interface LiveEventFixture {
  eventId: number;
  stablecoinId?: string;
  symbol?: string;
  pegCurrency?: string;
  direction?: "above" | "below";
  peakDeviationBps?: number;
  startedAt: number;
  endedAt?: number | null;
}

function insertLiveEvent(db: SqliteD1, input: LiveEventFixture): void {
  const endedAt = input.endedAt ?? null;
  db.sqlite
    .prepare(
      `INSERT INTO depeg_events
       (id, stablecoin_id, symbol, peg_type, direction, peak_deviation_bps,
        started_at, ended_at, start_price, peak_price, recovery_price, peg_reference, source)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0.98, 0.97, ?, 1, 'live')`,
    )
    .run(
      input.eventId,
      input.stablecoinId ?? "lusd-liquity",
      input.symbol ?? "LUSD",
      `pegged${input.pegCurrency ?? "USD"}`,
      input.direction ?? "below",
      input.peakDeviationBps ?? -300,
      input.startedAt,
      endedAt,
      endedAt == null ? null : 1,
    );
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
    stablecoinId?: string;
    symbol?: string;
    name?: string;
    pegCurrency?: string;
    governance?: string;
    direction?: "above" | "below";
    startedAt?: number;
    lockTimePeakDeviationBps?: number;
    eligibleAt?: number;
    lockedAt?: number;
    eventAgeAtLockSec?: number;
    policyDelaySec?: number;
    lockTiming?: "on_time" | "late_confirmation" | "late_freeze" | "deferred";
    predictionExtras?: Record<string, unknown>;
  } = {},
) {
  const eventId = options.eventId ?? 1;
  const stablecoinId = options.stablecoinId ?? "lusd-liquity";
  const symbol = options.symbol ?? "LUSD";
  const name = options.name ?? "Liquity USD";
  const pegCurrency = options.pegCurrency ?? "USD";
  const governance = options.governance ?? "decentralized";
  const direction = options.direction ?? "below";
  const startedAt = options.startedAt ?? 100000;
  const policyDelaySec = options.policyDelaySec ?? 86400;
  const eligibleAt = options.eligibleAt ?? startedAt + policyDelaySec;
  const lockedAt = options.lockedAt ?? eligibleAt;
  const eventAgeAtLockSec = options.eventAgeAtLockSec ?? lockedAt - startedAt;
  const base = {
    kind,
    eventId,
    incidentKey,
    stablecoinId,
    symbol,
    name,
    pegCurrency,
    governance,
    status: "active",
    direction,
    startedAt,
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
          sourceRow: {
            eventId,
            stablecoinId,
            peakDeviationBps: options.lockTimePeakDeviationBps ?? -300,
          },
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

async function sealExistingIncident(
  db: SqliteD1,
  incident: Awaited<ReturnType<typeof ensureIncident>>,
  options: Parameters<typeof sealedPayload>[2] = {},
) {
  const eventId = options.eventId ?? 1;
  const stablecoinId = options.stablecoinId ?? "lusd-liquity";
  const symbol = options.symbol ?? "LUSD";
  const name = options.name ?? "Liquity USD";
  const pegCurrency = options.pegCurrency ?? "USD";
  const governance = options.governance ?? "decentralized";
  const direction = options.direction ?? "below";
  const startedAt = options.startedAt ?? 100000;
  const policyDelaySec = options.policyDelaySec ?? 86400;
  const eligibleAt = options.eligibleAt ?? startedAt + policyDelaySec;
  const lockedAt = options.lockedAt ?? eligibleAt;
  const eventAgeAtLockSec = options.eventAgeAtLockSec ?? lockedAt - startedAt;
  const { payload, rowHash } = sealedPayloadWithHash(incident.incidentKey, "prediction", {
    ...options,
    eventId,
    stablecoinId,
    symbol,
    name,
    pegCurrency,
    governance,
    direction,
    startedAt,
    policyDelaySec,
    eligibleAt,
    lockedAt,
    eventAgeAtLockSec,
  });
  return sealPublicPrediction(db, {
    incidentKey: incident.incidentKey,
    eventId,
    stablecoinId,
    symbol,
    name,
    pegCurrency,
    governance,
    direction,
    startedAt,
    assessedAt: lockedAt,
    eventAgeSec: eventAgeAtLockSec,
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
    policyDelaySec,
    eligibleAt,
    lockedAt,
    eventAgeAtLockSec,
    lockTiming: options.lockTiming ?? "on_time",
    createdAt: lockedAt + 1,
    runId: "ddr:test",
  });
}

async function sealPredictionFixture(db: SqliteD1) {
  insertOpenEvent(db);
  const incident = await ensureIncident(db);
  const prediction = await sealExistingIncident(db, incident);
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

interface FlapMigrationReplayScenario {
  migration: string;
  stablecoinId: string;
  symbol: string;
  pegCurrency: string;
  firstEventId: number;
  firstStartedAt: number;
  current: {
    eventId: number;
    startedAt: number;
    endedAt: number;
    peakDeviationBps: number;
  };
  tails: Array<{
    eventId: number;
    startedAt: number;
    endedAt: number | null;
    peakDeviationBps: number;
  }>;
}

const FLAP_MIGRATION_REPLAY_SCENARIOS: FlapMigrationReplayScenario[] = [
  {
    migration: "0203",
    stablecoinId: "cngn-compliant-naira",
    symbol: "cNGN",
    pegCurrency: "NGN",
    firstEventId: 90511,
    firstStartedAt: 1783650896,
    current: { eventId: 90526, startedAt: 1783791305, endedAt: 1783792143, peakDeviationBps: -172 },
    tails: [
      { eventId: 90548, startedAt: 1783946864, endedAt: 1783947766, peakDeviationBps: -172 },
    ],
  },
  {
    migration: "0206",
    stablecoinId: "cngn-compliant-naira",
    symbol: "cNGN",
    pegCurrency: "NGN",
    firstEventId: 90511,
    firstStartedAt: 1783650896,
    current: { eventId: 90548, startedAt: 1783946864, endedAt: 1783947766, peakDeviationBps: -172 },
    tails: [
      { eventId: 90573, startedAt: 1784085475, endedAt: 1784089078, peakDeviationBps: -151 },
      { eventId: 90576, startedAt: 1784089988, endedAt: 1784098070, peakDeviationBps: -151 },
      { eventId: 90584, startedAt: 1784108016, endedAt: 1784108885, peakDeviationBps: -150 },
    ],
  },
  {
    migration: "0208",
    stablecoinId: "eurq-quantoz",
    symbol: "EURQ",
    pegCurrency: "EUR",
    firstEventId: 90527,
    firstStartedAt: 1783798508,
    current: { eventId: 90560, startedAt: 1784033283, endedAt: 1784044075, peakDeviationBps: -166 },
    tails: [
      { eventId: 90589, startedAt: 1784126070, endedAt: 1784126921, peakDeviationBps: -156 },
      { eventId: 90591, startedAt: 1784127861, endedAt: 1784128727, peakDeviationBps: -150 },
      { eventId: 90594, startedAt: 1784133252, endedAt: 1784135051, peakDeviationBps: -170 },
      { eventId: 90595, startedAt: 1784135928, endedAt: null, peakDeviationBps: -151 },
    ],
  },
  {
    migration: "0209",
    stablecoinId: "cngn-compliant-naira",
    symbol: "cNGN",
    pegCurrency: "NGN",
    firstEventId: 90511,
    firstStartedAt: 1783650896,
    current: { eventId: 90584, startedAt: 1784108016, endedAt: 1784108885, peakDeviationBps: -150 },
    tails: [
      { eventId: 90599, startedAt: 1784151172, endedAt: null, peakDeviationBps: -158 },
    ],
  },
  {
    migration: "0215",
    stablecoinId: "cngn-compliant-naira",
    symbol: "cNGN",
    pegCurrency: "NGN",
    firstEventId: 90511,
    firstStartedAt: 1783650896,
    current: { eventId: 90658, startedAt: 1784375257, endedAt: 1784379776, peakDeviationBps: -156 },
    tails: [
      { eventId: 90664, startedAt: 1784380665, endedAt: 1784381584, peakDeviationBps: -151 },
      { eventId: 90666, startedAt: 1784383381, endedAt: 1784384266, peakDeviationBps: -150 },
    ],
  },
  {
    migration: "0227",
    stablecoinId: "cngn-compliant-naira",
    symbol: "cNGN",
    pegCurrency: "NGN",
    firstEventId: 90511,
    firstStartedAt: 1783650896,
    current: { eventId: 90666, startedAt: 1784383381, endedAt: 1784384266, peakDeviationBps: -150 },
    tails: [
      { eventId: 90718, startedAt: 1784486946, endedAt: 1784487834, peakDeviationBps: -153 },
      { eventId: 90729, startedAt: 1784521129, endedAt: 1784522926, peakDeviationBps: -150 },
      { eventId: 90738, startedAt: 1784641668, endedAt: null, peakDeviationBps: -170 },
    ],
  },
];

async function seedFlapMigrationIncident(
  db: SqliteD1,
  scenario: FlapMigrationReplayScenario,
) {
  insertLiveEvent(db, {
    eventId: scenario.firstEventId,
    stablecoinId: scenario.stablecoinId,
    symbol: scenario.symbol,
    pegCurrency: scenario.pegCurrency,
    peakDeviationBps: -150,
    startedAt: scenario.firstStartedAt,
    endedAt: scenario.firstStartedAt + 900,
  });
  const [incident] = await ensureCanonicalIncidents(
    db,
    [
      {
        eventId: scenario.firstEventId,
        stablecoinId: scenario.stablecoinId,
        pegCurrency: scenario.pegCurrency,
        direction: "below",
        startedAt: scenario.firstStartedAt,
        endedAt: scenario.firstStartedAt + 900,
        peakDeviationBps: -150,
        source: "live",
      },
    ],
    {
      nowSec: scenario.firstStartedAt + 60,
      predictionPolicyVersion: "sticky-24h-v1",
      ddrV2EffectiveAt: 90_000,
      createdBy: "vitest",
    },
  );
  if (!incident) throw new Error(`Failed to seed ${scenario.migration} incident`);

  insertLiveEvent(db, {
    ...scenario.current,
    stablecoinId: scenario.stablecoinId,
    symbol: scenario.symbol,
    pegCurrency: scenario.pegCurrency,
  });
  db.sqlite
    .prepare(
      `INSERT INTO depeg_resolver_incident_event_links
       (incident_key, event_id, relation, repair_authorization_id, linked_at, note)
       VALUES (?, ?, 'repair_replacement', NULL, ?, 'migration replay predecessor')`,
    )
    .run(incident.incidentKey, scenario.current.eventId, scenario.current.startedAt);
  db.sqlite
    .prepare(
      `INSERT INTO depeg_resolver_incident_revisions
       (incident_key, previous_event_id, current_event_id, reason, repair_authorization_id,
        erratum_id, created_at, created_by)
       VALUES (?, ?, ?, 'migration replay predecessor', NULL, NULL, ?, 'vitest')`,
    )
    .run(
      incident.incidentKey,
      scenario.firstEventId,
      scenario.current.eventId,
      scenario.current.startedAt,
    );
  db.sqlite
    .prepare(
      `UPDATE depeg_resolver_incidents
       SET current_event_id = ?, current_started_at = ?, updated_at = ?
       WHERE incident_key = ?`,
    )
    .run(
      scenario.current.eventId,
      scenario.current.startedAt,
      scenario.current.startedAt,
      incident.incidentKey,
    );
  return incident;
}

describe("DDRv2 storage migrations and stores", () => {
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

      const deferralInput = {
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
      } as const;
      await recordLockDeferral(db, deferralInput);
      await recordLockDeferral(db, deferralInput);
      await recordLockDeferral(db, { ...deferralInput, runId: "ddr:test:deferral:next", runAt: 144100 });

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
          deferralCount: 2,
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
      const auditRows = db.sqlite
        .prepare("SELECT run_id, attempt_key FROM depeg_resolver_lock_opportunity_audit WHERE incident_key = ? ORDER BY run_at")
        .all(incident.incidentKey) as Array<{ run_id: string; attempt_key: string }>;
      expect(auditRows).toHaveLength(2);
      expect(auditRows.map((row) => row.run_id)).toEqual(["ddr:test:deferral", "ddr:test:deferral:next"]);
      expect(auditRows.map((row) => row.attempt_key)).toEqual([
        expect.stringMatching(/^[0-9a-f]{64}$/),
        expect.stringMatching(/^[0-9a-f]{64}$/),
      ]);
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
      insertLiveEvent(db, { eventId: 2, startedAt: 100900, peakDeviationBps: -350 });
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

  it("quarantines out-of-order nearby overlaps instead of minting a fresh incident", async () => {
    const db = makeSqliteD1();
    try {
      const incident = await ensureIncident(db, 1, 100500);
      insertLiveEvent(db, { eventId: 2, startedAt: 99900, peakDeviationBps: -350 });
      const quarantined: Array<{ eventId: number; reason: string }> = [];

      const incidents = await ensureCanonicalIncidents(
        db,
        [
          {
            eventId: 2,
            stablecoinId: "lusd-liquity",
            pegCurrency: "USD",
            direction: "below",
            startedAt: 99900,
            peakDeviationBps: -350,
            source: "live",
          },
        ],
        {
          nowSec: 101000,
          predictionPolicyVersion: "sticky-24h-v1",
          ddrV2EffectiveAt: 90000,
          createdBy: "vitest",
          onRepairRequired: (eventId, reason) => quarantined.push({ eventId, reason }),
        },
      );

      expect(incidents).toEqual([]);
      expect(quarantined).toEqual([
        {
          eventId: 2,
          reason:
            `Unlinked depeg event 2 overlaps nearby canonical incident ${incident.incidentKey} without strict successor ordering; explicit repair required`,
        },
      ]);
      expect(
        db.sqlite
          .prepare("SELECT COUNT(*) AS count FROM depeg_resolver_incidents WHERE stablecoin_id = 'lusd-liquity'")
          .get(),
      ).toEqual({ count: 1 });
      expect(
        db.sqlite
          .prepare("SELECT COUNT(*) AS count FROM depeg_resolver_incident_event_links WHERE event_id = 2")
          .get(),
      ).toEqual({ count: 0 });
    } finally {
      db.close();
    }
  });

  it("requires persisted canonical live provenance before automatic adoption", async () => {
    const db = makeSqliteD1();
    try {
      await ensureIncident(db, 1, 100500);
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
          { nowSec: 101000, predictionPolicyVersion: "sticky-24h-v1", ddrV2EffectiveAt: 90000, createdBy: "vitest" },
        ),
      ).rejects.toThrow("Unlinked depeg event 2 lacks matching canonical live provenance; explicit repair required");
    } finally {
      db.close();
    }
  });

  it("adopts recovered nearby events into an unsealed canonical incident", async () => {
    const db = makeSqliteD1();
    try {
      const incident = await ensureIncident(db, 1, 100500);
      insertLiveEvent(db, { eventId: 2, startedAt: 100900, endedAt: 101200, peakDeviationBps: -350 });
      const [nearby] = await ensureCanonicalIncidents(
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
        { nowSec: 101300, predictionPolicyVersion: "sticky-24h-v1", ddrV2EffectiveAt: 90000, createdBy: "vitest" },
      );

      const current = db.sqlite
        .prepare("SELECT current_event_id, current_started_at FROM depeg_resolver_incidents WHERE incident_key = ?")
        .get(incident.incidentKey) as { current_event_id: number; current_started_at: number };
      expect(nearby?.incidentKey).toBe(incident.incidentKey);
      expect(current).toEqual({ current_event_id: 2, current_started_at: 100900 });
    } finally {
      db.close();
    }
  });

  it.each(FLAP_MIGRATION_REPLAY_SCENARIOS)(
    "replays migration $migration flap lineage through the primary predicate",
    async (scenario) => {
      const db = makeSqliteD1();
      try {
        const incident = await seedFlapMigrationIncident(db, scenario);
        for (const tail of scenario.tails) {
          insertLiveEvent(db, {
            ...tail,
            stablecoinId: scenario.stablecoinId,
            symbol: scenario.symbol,
            pegCurrency: scenario.pegCurrency,
          });
        }

        const incidents = await ensureCanonicalIncidents(
          db,
          scenario.tails.map((tail) => ({
            eventId: tail.eventId,
            stablecoinId: scenario.stablecoinId,
            pegCurrency: scenario.pegCurrency,
            direction: "below" as const,
            startedAt: tail.startedAt,
            endedAt: tail.endedAt,
            peakDeviationBps: tail.peakDeviationBps,
            source: "live",
          })),
          {
            nowSec: Math.max(...scenario.tails.map((tail) => tail.endedAt ?? tail.startedAt)) + 60,
            predictionPolicyVersion: "sticky-24h-v1",
            policyDelaySec: 72 * 3600,
            ddrV2EffectiveAt: 90_000,
            createdBy: "vitest",
          },
        );
        const tailIds = scenario.tails.map((tail) => tail.eventId);

        expect(incidents.map((entry) => entry.incidentKey)).toEqual(
          tailIds.map(() => incident.incidentKey),
        );
        expect(
          db.sqlite
            .prepare(
              `SELECT event_id, relation
               FROM depeg_resolver_incident_event_links
               WHERE event_id IN (${tailIds.map(() => "?").join(", ")})
               ORDER BY linked_at, event_id`,
            )
            .all(...tailIds),
        ).toEqual(
          tailIds.map((eventId) => ({ event_id: eventId, relation: "repair_replacement" })),
        );
        expect(
          db.sqlite
            .prepare(
              `SELECT previous_event_id, current_event_id
               FROM depeg_resolver_incident_revisions
               WHERE current_event_id IN (${tailIds.map(() => "?").join(", ")})
               ORDER BY id`,
            )
            .all(...tailIds),
        ).toEqual(
          tailIds.map((currentEventId, index) => ({
            previous_event_id: index === 0 ? scenario.current.eventId : tailIds[index - 1],
            current_event_id: currentEventId,
          })),
        );
        expect(
          db.sqlite
            .prepare(
              `SELECT current_event_id, current_started_at
               FROM depeg_resolver_incidents
               WHERE incident_key = ?`,
            )
            .get(incident.incidentKey),
        ).toEqual({
          current_event_id: tailIds[tailIds.length - 1],
          current_started_at: scenario.tails[scenario.tails.length - 1]?.startedAt,
        });
      } finally {
        db.close();
      }
    },
  );

  it.each(["link-count", "incident-span"] as const)(
    "quarantines automatic adoption at the %s cap",
    async (cap) => {
      const db = makeSqliteD1();
      try {
        insertOpenEvent(db);
        const incident = await ensureIncident(db, 1, 100500);
        let tailStartedAt = 100900;

        if (cap === "link-count") {
          for (let index = 1; index < DDR_FLAP_TOLERANT_MAX_LINK_COUNT_V1; index += 1) {
            db.sqlite
              .prepare(
                `INSERT INTO depeg_resolver_incident_event_links
                 (incident_key, event_id, relation, repair_authorization_id, linked_at, note)
                 VALUES (?, ?, 'repair_replacement', NULL, ?, 'cap fixture')`,
              )
              .run(incident.incidentKey, 1000 + index, 100500 + index);
          }
        } else {
          const currentStartedAt =
            100000 + DDR_FLAP_TOLERANT_MAX_INCIDENT_SPAN_SEC_V1 - 3600;
          tailStartedAt =
            100000 + DDR_FLAP_TOLERANT_MAX_INCIDENT_SPAN_SEC_V1 + 1;
          insertLiveEvent(db, { eventId: 3, startedAt: currentStartedAt });
          db.sqlite
            .prepare(
              `INSERT INTO depeg_resolver_incident_event_links
               (incident_key, event_id, relation, repair_authorization_id, linked_at, note)
               VALUES (?, 3, 'repair_replacement', NULL, ?, 'span fixture predecessor')`,
            )
            .run(incident.incidentKey, currentStartedAt);
          db.sqlite
            .prepare(
              `INSERT INTO depeg_resolver_incident_revisions
               (incident_key, previous_event_id, current_event_id, reason, repair_authorization_id,
                erratum_id, created_at, created_by)
               VALUES (?, 1, 3, 'span fixture predecessor', NULL, NULL, ?, 'vitest')`,
            )
            .run(incident.incidentKey, currentStartedAt);
          db.sqlite
            .prepare(
              `UPDATE depeg_resolver_incidents
               SET current_event_id = 3, current_started_at = ?, updated_at = ?
               WHERE incident_key = ?`,
            )
            .run(currentStartedAt, currentStartedAt, incident.incidentKey);
        }

        insertLiveEvent(db, { eventId: 2, startedAt: tailStartedAt, peakDeviationBps: -350 });
        const quarantined: number[] = [];
        const incidents = await ensureCanonicalIncidents(
          db,
          [
            {
              eventId: 2,
              stablecoinId: "lusd-liquity",
              pegCurrency: "USD",
              direction: "below",
              startedAt: tailStartedAt,
              peakDeviationBps: -350,
              source: "live",
            },
          ],
          {
            nowSec: tailStartedAt + 60,
            predictionPolicyVersion: "sticky-24h-v1",
            policyDelaySec: 72 * 3600,
            ddrV2EffectiveAt: 90_000,
            createdBy: "vitest",
            onRepairRequired: (eventId) => quarantined.push(eventId),
          },
        );

        expect(incidents).toEqual([]);
        expect(quarantined).toEqual([2]);
        expect(
          db.sqlite
            .prepare(
              "SELECT COUNT(*) AS count FROM depeg_resolver_incident_event_links WHERE event_id = 2",
            )
            .get(),
        ).toEqual({ count: 0 });
      } finally {
        db.close();
      }
    },
  );

  it("closes recovered pre-lock incidents and keeps cNGN-shaped flaps in bounded chains", async () => {
    const db = makeSqliteD1();
    try {
      const firstStartedAt = 100_000;
      const firstEndedAt = firstStartedAt + 900;
      insertOpenEvent(db, 90511);
      const firstIncident = await ensureIncident(db, 90511, firstStartedAt + 300);
      db.sqlite
        .prepare(
          "UPDATE depeg_events SET ended_at = ?, recovery_price = NULL, close_reason = 'recovered-native' WHERE id = ?",
        )
        .run(firstEndedAt, 90511);

      const closeEligibleAt =
        firstEndedAt +
        DDR_INCIDENT_REOPEN_MERGE_WINDOW_SEC +
        DDR_PRE_LOCK_CLOSE_SETTLE_MARGIN_SEC_V1;
      expect(await closeRecoveredPreLockIncidents(db, closeEligibleAt - 1)).toBe(0);
      expect(await closeRecoveredPreLockIncidents(db, closeEligibleAt)).toBe(1);

      const [closed] = await loadCanonicalIncidents(db, {
        incidentKeys: [firstIncident.incidentKey],
        includeSuperseded: true,
      });
      expect(closed).toMatchObject({
        incidentKey: firstIncident.incidentKey,
        incidentState: "closed_pre_lock",
        closedPreLockAt: closeEligibleAt,
      });
      expect(
        coverageRowForIncident(
          closed,
          {
            eventId: 90511,
            currentEventId: 90511,
            startedAt: firstStartedAt,
            endedAt: firstEndedAt,
            recoveryPrice: null,
            closeReason: "recovered-native",
            stablecoinStatus: null,
            terminalObserved: null,
            terminalEvidenceAt: null,
            terminalEvidenceInterval: null,
            terminalEvidencePrecision: null,
          },
          closeEligibleAt,
        ),
      ).toMatchObject({
        predictionState: "resolved_before_prediction",
        coverageCause: "pre_lock_recovered",
      });
      expect(await loadCanonicalIncidents(db, { incidentKeys: [firstIncident.incidentKey] })).toEqual([]);

      const outsideStartedAt = firstEndedAt + DDR_INCIDENT_REOPEN_MERGE_WINDOW_SEC + 1;
      const outsideEndedAt = outsideStartedAt + 900;
      db.sqlite
        .prepare(
          `INSERT INTO depeg_events
           (id, stablecoin_id, symbol, peg_type, direction, peak_deviation_bps,
            started_at, ended_at, start_price, peak_price, recovery_price, peg_reference, source)
           VALUES (?, 'lusd-liquity', 'LUSD', 'peggedUSD', 'below', -325, ?, ?, 0.98, 0.97, 1, 1, 'live')`,
        )
        .run(90512, outsideStartedAt, outsideEndedAt);
      const quarantined: number[] = [];
      const [fresh] = await ensureCanonicalIncidents(
        db,
        [
          {
            eventId: 90512,
            stablecoinId: "lusd-liquity",
            pegCurrency: "USD",
            direction: "below",
            startedAt: outsideStartedAt,
            endedAt: outsideEndedAt,
            peakDeviationBps: -325,
            source: "live",
          },
        ],
        {
          nowSec: outsideEndedAt + 60,
          predictionPolicyVersion: "sticky-24h-v1",
          ddrV2EffectiveAt: 90_000,
          createdBy: "vitest",
          onRepairRequired: (eventId) => quarantined.push(eventId),
        },
      );
      expect(quarantined).toEqual([]);
      expect(fresh.incidentKey).not.toBe(firstIncident.incidentKey);

      const freshCloseAt =
        outsideEndedAt +
        DDR_INCIDENT_REOPEN_MERGE_WINDOW_SEC +
        DDR_PRE_LOCK_CLOSE_SETTLE_MARGIN_SEC_V1;
      expect(await closeRecoveredPreLockIncidents(db, freshCloseAt)).toBe(1);

      const withinStartedAt = outsideEndedAt + 3600;
      const withinEndedAt = withinStartedAt + 900;
      db.sqlite
        .prepare(
          `INSERT INTO depeg_events
           (id, stablecoin_id, symbol, peg_type, direction, peak_deviation_bps,
            started_at, ended_at, start_price, peak_price, recovery_price, peg_reference, source)
           VALUES (?, 'lusd-liquity', 'LUSD', 'peggedUSD', 'below', -350, ?, ?, 0.98, 0.965, 1, 1, 'live')`,
        )
        .run(90513, withinStartedAt, withinEndedAt);
      const [resurrected] = await ensureCanonicalIncidents(
        db,
        [
          {
            eventId: 90513,
            stablecoinId: "lusd-liquity",
            pegCurrency: "USD",
            direction: "below",
            startedAt: withinStartedAt,
            endedAt: withinEndedAt,
            peakDeviationBps: -350,
            source: "live",
          },
        ],
        {
          nowSec: withinEndedAt + 60,
          predictionPolicyVersion: "sticky-24h-v1",
          ddrV2EffectiveAt: 90_000,
          createdBy: "vitest",
        },
      );

      expect(resurrected).toMatchObject({
        incidentKey: fresh.incidentKey,
        currentEventId: 90513,
        incidentState: "active",
        closedPreLockAt: null,
        relation: "repair_replacement",
      });
      expect(
        db.sqlite
          .prepare(
            `SELECT previous_event_id, current_event_id, reason
             FROM depeg_resolver_incident_revisions
             WHERE incident_key = ? AND current_event_id = 90513`,
          )
          .get(fresh.incidentKey),
      ).toEqual({
        previous_event_id: 90512,
        current_event_id: 90513,
        reason: "pre-lock closed incident resurrected with nearby event",
      });
      expect(
        db.sqlite
          .prepare("SELECT COUNT(*) AS count FROM depeg_resolver_incidents WHERE stablecoin_id = 'lusd-liquity'")
          .get(),
      ).toEqual({ count: 2 });

      db.sqlite
        .prepare("UPDATE depeg_events SET close_reason = 'superseded-direction' WHERE id = 90513")
        .run();
      expect(
        await closeRecoveredPreLockIncidents(
          db,
          withinEndedAt + DDR_INCIDENT_REOPEN_MERGE_WINDOW_SEC + DDR_PRE_LOCK_CLOSE_SETTLE_MARGIN_SEC_V1,
        ),
      ).toBe(0);
    } finally {
      db.close();
    }
  });

  it("does not close a recovered incident after a public outcome is sealed", async () => {
    const db = makeSqliteD1();
    try {
      const { incident } = await sealPredictionFixture(db);
      db.sqlite
        .prepare("UPDATE depeg_events SET ended_at = 101000, recovery_price = 1 WHERE id = 1")
        .run();

      expect(
        await closeRecoveredPreLockIncidents(
          db,
          101000 + DDR_INCIDENT_REOPEN_MERGE_WINDOW_SEC + DDR_PRE_LOCK_CLOSE_SETTLE_MARGIN_SEC_V1,
        ),
      ).toBe(0);
      expect(
        db.sqlite
          .prepare("SELECT closed_pre_lock_at FROM depeg_resolver_incidents WHERE incident_key = ?")
          .get(incident.incidentKey),
      ).toEqual({ closed_pre_lock_at: null });
    } finally {
      db.close();
    }
  });

  it("anchors unsealed adoption recency to the current event instead of the first event", async () => {
    const db = makeSqliteD1();
    try {
      const incident = await ensureIncident(db, 1, 100500);
      insertLiveEvent(db, { eventId: 2, startedAt: 100900, peakDeviationBps: -350 });
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
        { nowSec: 186400, predictionPolicyVersion: "sticky-24h-v1", ddrV2EffectiveAt: 90000, createdBy: "vitest" },
      );
      expect(nearby?.incidentKey).toBe(incident.incidentKey);
      expect(nearby?.currentEventId).toBe(2);
    } finally {
      db.close();
    }
  });

  it("links sealed live tails through automated repair authorizations", async () => {
    const db = makeSqliteD1();
    try {
      const { incident } = await sealPredictionFixture(db);
      insertLiveEvent(db, { eventId: 2, startedAt: 100900, peakDeviationBps: -350 });
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

  it("splits a MIM-shaped regime escalation into a second canonical incident and lock", async () => {
    const db = makeSqliteD1();
    try {
      const gradedStartedAt = 1_780_937_476;
      const gradedEndedAt = 1_780_980_688;
      const terminalStartedAt = 1_780_997_700;
      expect(DDR_SEALED_TAIL_REGIME_ESCALATION_MIN_PEAK_BPS_V1).toBe(1_000);
      expect(DDR_SEALED_TAIL_REGIME_ESCALATION_MULTIPLIER_V1).toBe(4);

      insertLiveEvent(db, {
        eventId: 90130,
        stablecoinId: "mim-abracadabra",
        symbol: "MIM",
        startedAt: gradedStartedAt,
        peakDeviationBps: -113,
      });
      const [gradedIncident] = await ensureCanonicalIncidents(
        db,
        [
          {
            eventId: 90130,
            stablecoinId: "mim-abracadabra",
            pegCurrency: "USD",
            direction: "below",
            startedAt: gradedStartedAt,
            peakDeviationBps: -113,
            source: "live",
            publicTrackedAtFirstSeen: true,
            registrySnapshot: { id: "mim-abracadabra", symbol: "MIM" },
          },
        ],
        {
          nowSec: gradedStartedAt + 60,
          policyDelaySec: 3600,
          predictionPolicyVersion: "sticky-24h-v1",
          ddrV2EffectiveAt: gradedStartedAt - 1,
          createdBy: "vitest",
        },
      );
      if (!gradedIncident) throw new Error("graded MIM incident was not created");
      await sealExistingIncident(db, gradedIncident, {
        eventId: 90130,
        stablecoinId: "mim-abracadabra",
        symbol: "MIM",
        name: "Magic Internet Money",
        startedAt: gradedStartedAt,
        lockTimePeakDeviationBps: -113,
        policyDelaySec: 3600,
      });
      db.sqlite
        .prepare("UPDATE depeg_events SET ended_at = ?, recovery_price = ? WHERE id = 90130")
        .run(gradedEndedAt, 1);

      insertLiveEvent(db, {
        eventId: 90141,
        stablecoinId: "mim-abracadabra",
        symbol: "MIM",
        startedAt: terminalStartedAt,
        peakDeviationBps: -9201,
      });
      const [terminalIncident] = await ensureCanonicalIncidents(
        db,
        [
          {
            eventId: 90141,
            stablecoinId: "mim-abracadabra",
            pegCurrency: "USD",
            direction: "below",
            startedAt: terminalStartedAt,
            peakDeviationBps: -9201,
            source: "live",
            publicTrackedAtFirstSeen: true,
            registrySnapshot: { id: "mim-abracadabra", symbol: "MIM" },
          },
        ],
        {
          nowSec: terminalStartedAt + 60,
          policyDelaySec: 3600,
          predictionPolicyVersion: "sticky-24h-v1",
          ddrV2EffectiveAt: gradedStartedAt - 1,
          createdBy: "vitest",
        },
      );
      if (!terminalIncident) throw new Error("terminal MIM incident was not created");

      expect(terminalIncident.incidentKey).not.toBe(gradedIncident.incidentKey);
      expect(terminalIncident.relation).toBe("observed");
      expect(
        db.sqlite
          .prepare(
            `SELECT first_event_id, current_event_id
             FROM depeg_resolver_incidents
             WHERE incident_key = ?`,
          )
          .get(gradedIncident.incidentKey),
      ).toEqual({ first_event_id: 90130, current_event_id: 90130 });
      expect(
        db.sqlite
          .prepare(
            `SELECT from_incident_key, to_incident_key, relation, created_by
             FROM depeg_resolver_incident_lineage
             WHERE from_incident_key = ?`,
          )
          .get(terminalIncident.incidentKey),
      ).toEqual({
        from_incident_key: terminalIncident.incidentKey,
        to_incident_key: gradedIncident.incidentKey,
        relation: "split_from",
        created_by: "ddr-worker:auto-regime-split",
      });

      await sealExistingIncident(db, terminalIncident, {
        eventId: 90141,
        stablecoinId: "mim-abracadabra",
        symbol: "MIM",
        name: "Magic Internet Money",
        startedAt: terminalStartedAt,
        lockTimePeakDeviationBps: -9201,
        policyDelaySec: 3600,
      });
      expect(
        db.sqlite
          .prepare(
            `SELECT event_id, incident_key
             FROM depeg_resolver_public_predictions
             WHERE event_id IN (90130, 90141)
             ORDER BY event_id`,
          )
          .all(),
      ).toEqual([
        { event_id: 90130, incident_key: gradedIncident.incidentKey },
        { event_id: 90141, incident_key: terminalIncident.incidentKey },
      ]);
    } finally {
      db.close();
    }
  });

  it("uses the sealed lock-time peak instead of the first-event bucket for same-regime tails", async () => {
    const db = makeSqliteD1();
    try {
      insertLiveEvent(db, { eventId: 1, startedAt: 100000, peakDeviationBps: -113 });
      const [incident] = await ensureCanonicalIncidents(
        db,
        [
          {
            eventId: 1,
            stablecoinId: "lusd-liquity",
            pegCurrency: "USD",
            direction: "below",
            startedAt: 100000,
            peakDeviationBps: -113,
            source: "live",
            publicTrackedAtFirstSeen: true,
            registrySnapshot: { id: "lusd-liquity", symbol: "LUSD" },
          },
        ],
        {
          nowSec: 100100,
          predictionPolicyVersion: "sticky-24h-v1",
          ddrV2EffectiveAt: 90000,
          createdBy: "vitest",
        },
      );
      if (!incident) throw new Error("same-regime incident was not created");
      expect(incident.firstObservedPeakBucketBps).toBe(100);
      await sealExistingIncident(db, incident, { lockTimePeakDeviationBps: -300 });
      db.sqlite
        .prepare("UPDATE depeg_events SET ended_at = 190000, recovery_price = 1 WHERE id = 1")
        .run();
      insertLiveEvent(db, { eventId: 2, startedAt: 191000, peakDeviationBps: -1000 });

      const [tail] = await ensureCanonicalIncidents(
        db,
        [
          {
            eventId: 2,
            stablecoinId: "lusd-liquity",
            pegCurrency: "USD",
            direction: "below",
            startedAt: 191000,
            peakDeviationBps: -1000,
            source: "live",
          },
        ],
        {
          nowSec: 191100,
          predictionPolicyVersion: "sticky-24h-v1",
          ddrV2EffectiveAt: 90000,
          createdBy: "vitest",
        },
      );

      expect(tail?.incidentKey).toBe(incident.incidentKey);
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

  it("falls back to authorized sealed-tail adoption when sealing wins the link race", async () => {
    const db = makeSqliteD1();
    try {
      insertOpenEvent(db);
      const incident = await ensureIncident(db);
      insertLiveEvent(db, { eventId: 2, startedAt: 100900, peakDeviationBps: -350 });
      let sealedDuringBatch = false;
      const raceDb = {
        ...db,
        batch: async (statements: D1PreparedStatement[]) => {
          if (!sealedDuringBatch) {
            sealedDuringBatch = true;
            await sealExistingIncident(db, incident);
          }
          return db.batch(statements);
        },
      } as SqliteD1;

      const [tail] = await ensureCanonicalIncidents(
        raceDb,
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

      expect(sealedDuringBatch).toBe(true);
      expect(tail?.incidentKey).toBe(incident.incidentKey);
      expect(
        db.sqlite
          .prepare(
            `SELECT repair_authorization_id
             FROM depeg_resolver_incident_event_links
             WHERE event_id = 2`,
          )
          .get(),
      ).toEqual({ repair_authorization_id: expect.any(Number) });
      expect(
        db.sqlite
          .prepare(
            `SELECT COUNT(*) AS count
             FROM depeg_resolver_event_repair_authorization_uses
             WHERE event_id = 2`,
          )
          .get(),
      ).toEqual({ count: 2 });
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
      insertLiveEvent(db, { eventId: 2, startedAt: 1_007_200, peakDeviationBps: -425 });

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
    ], { requireMatch: true });

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
            `UPDATE depeg_resolver_publication_snapshots_v2
             SET validator_version = 'tampered'
             WHERE snapshot_token = ?`,
          )
          .run(manifest.snapshotToken),
      ).toThrow(/compressed publication snapshots are append-only/);

      const storage = db.sqlite
        .prepare(
          `SELECT base_payload_bytes, compressed_payload_bytes
             FROM depeg_resolver_publication_snapshots_v2
            WHERE snapshot_token = ?`,
        )
        .get(manifest.snapshotToken) as { base_payload_bytes: number; compressed_payload_bytes: number };
      expect(storage.compressed_payload_bytes).toBeLessThan(storage.base_payload_bytes);
      expect(
        db.sqlite.prepare("SELECT COUNT(*) AS count FROM depeg_resolver_publication_snapshots").get(),
      ).toEqual({ count: 0 });

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

  it("selects a newer valid legacy manifest from a mixed v1/v2 history", async () => {
    const db = makeSqliteD1();
    try {
      const compressed = await writePublicationManifest(db, {
        snapshotToken: "ddrpub:test:compressed",
        snapshotGeneration: 2,
        publishedAt: 200000,
        validatorVersion: "vitest",
        basePayload: {
          _meta: { publicPredictionIds: [], publicPredictionRowHashes: {} },
          rows: [],
        },
      });

      db.sqlite
        .prepare(
          `INSERT INTO depeg_resolver_publication_snapshots
           (snapshot_token, snapshot_kind, snapshot_sequence, snapshot_generation, published_at,
            base_payload_hash, public_prediction_ids_hash, public_prediction_ids_json,
            public_prediction_row_hashes_json, base_payload_json, base_row_count,
            public_prediction_count, created_at)
           VALUES (?, 'ddr_public', 2, 2, ?, ?, ?, '[]', '{}', ?, 0, 0, ?)`,
        )
        .run(
          "ddrpub:test:legacy",
          200100,
          compressed.basePayloadHash,
          compressed.publicPredictionIdsHash,
          compressed.basePayloadJson,
          200100,
        );
      db.sqlite
        .prepare(
          `INSERT INTO depeg_resolver_publication_snapshot_finalizations
           (snapshot_token, finalized_at, validator_version, validated_base_payload_hash,
            validated_public_prediction_ids_hash, validated_public_prediction_row_hashes_json,
            validated_base_row_count, validated_public_prediction_count)
           VALUES (?, ?, 'vitest-legacy', ?, ?, '{}', 0, 0)`,
        )
        .run(
          "ddrpub:test:legacy",
          200100,
          compressed.basePayloadHash,
          compressed.publicPredictionIdsHash,
        );

      await expect(loadLatestPublicationManifest(db)).resolves.toMatchObject({
        snapshotToken: "ddrpub:test:legacy",
        snapshotSequence: 2,
        publishedAt: 200100,
        validatorVersion: "vitest-legacy",
      });

      db.sqlite.exec("DROP TRIGGER trg_ddr_publication_snapshots_v2_no_delete");
      db.sqlite.prepare("DELETE FROM depeg_resolver_publication_snapshots_v2").run();
      await expect(loadLatestPublicationManifest(db)).resolves.toMatchObject({
        snapshotToken: "ddrpub:test:legacy",
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

      db.sqlite.exec("DROP TRIGGER trg_ddr_publication_snapshots_v2_no_update");
      const storedLength = db.sqlite
        .prepare(
          `SELECT base_payload_bytes
             FROM depeg_resolver_publication_snapshots_v2
            WHERE snapshot_token = ?`,
        )
        .get("ddrpub:test:bad-json") as { base_payload_bytes: number };
      db.sqlite
        .prepare(
          `UPDATE depeg_resolver_publication_snapshots_v2
              SET base_payload_bytes = ?
            WHERE snapshot_token = ?`,
        )
        .run(storedLength.base_payload_bytes + 1, "ddrpub:test:bad-json");
      await expect(loadLatestPublicationManifest(db)).rejects.toThrow(/payload length mismatch/);

      db.sqlite
        .prepare(
          `UPDATE depeg_resolver_publication_snapshots_v2
              SET base_payload_bytes = 1
            WHERE snapshot_token = ?`,
        )
        .run("ddrpub:test:bad-json");
      await expect(loadLatestPublicationManifest(db)).rejects.toThrow(
        /exceeds its declared uncompressed byte length/,
      );

      db.sqlite
        .prepare(
          `UPDATE depeg_resolver_publication_snapshots_v2
           SET base_payload_bytes = ?, public_prediction_ids_json = ?
           WHERE snapshot_token = ?`,
        )
        .run(storedLength.base_payload_bytes, "{}", "ddrpub:test:bad-json");

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
    ], { requireMatch: true });

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

      const retryInput = {
        incidentKey: incident.incidentKey,
        eventId: 1,
        predictionPolicyVersion: "sticky-24h-v1",
        eligibleAt: 186400,
        runAt: 200000,
        action: "publication_retry_pending",
        reason: "manifest write failed",
        healthStatus: "healthy",
        runId: "ddr:test:publication-retry",
      } as const;
      await recordLockOpportunity(db, retryInput);
      await recordLockOpportunity(db, retryInput);

      const row = db.sqlite
        .prepare("SELECT last_state FROM depeg_resolver_prediction_lock_state WHERE incident_key = ?")
        .get(incident.incidentKey) as { last_state: string };
      expect(row.last_state).toBe("publication_retry_pending");
      const auditCount = db.sqlite
        .prepare("SELECT COUNT(*) AS count FROM depeg_resolver_lock_opportunity_audit WHERE incident_key = ? AND action = 'publication_retry_pending'")
        .get(incident.incidentKey) as { count: number };
      expect(auditCount.count).toBe(1);
    } finally {
      db.close();
    }
  });
});
