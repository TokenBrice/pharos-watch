import { DatabaseSync } from "node:sqlite";
import type { D1Database } from "@cloudflare/workers-types";
import { attachDdrPublicRowHash, computeDdrPublicRowHash } from "@shared/lib/depeg-resolver/public-contract";
import { createLatestSchemaSqlite } from "../../test-helpers/latest-schema-sqlite";
import {
  ensureCanonicalIncidents,
} from "../depeg-resolver-incident-store";
import {
  sealPublicNoCall,
  sealPublicPrediction,
  type DdrPublicAssessmentSealInput,
} from "../depeg-resolver-publication-store";

export interface SqliteD1 extends D1Database {
  close(): void;
  sqlite: DatabaseSync;
}

export function makeSqliteD1(): SqliteD1 {
  const { sqlite, db } = createLatestSchemaSqlite();
  return Object.assign(db, { sqlite, close: () => sqlite.close() }) as SqliteD1;
}

export async function withSqliteD1<T>(run: (db: SqliteD1) => T | Promise<T>): Promise<T> {
  const db = makeSqliteD1();
  try {
    return await run(db);
  } finally {
    db.close();
  }
}

export function insertOpenEvent(db: SqliteD1, eventId = 1): void {
  db.sqlite
    .prepare(
      `INSERT INTO depeg_events
       (id, stablecoin_id, symbol, peg_type, direction, peak_deviation_bps,
        started_at, ended_at, start_price, peak_price, recovery_price, peg_reference, source)
       VALUES (?, 'lusd-liquity', 'LUSD', 'peggedUSD', 'below', -300, 100000, NULL, 0.98, 0.97, NULL, 1, 'live')`,
    )
    .run(eventId);
}

export interface LiveEventFixture {
  eventId: number;
  stablecoinId?: string;
  symbol?: string;
  pegCurrency?: string;
  direction?: "above" | "below";
  peakDeviationBps?: number;
  startedAt: number;
  endedAt?: number | null;
}

export function insertLiveEvent(db: SqliteD1, input: LiveEventFixture): void {
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

export async function ensureIncident(db: SqliteD1, eventId = 1, nowSec = 200000) {
  const [incident] = await ensureCanonicalIncidents(
    db,
    [{
      eventId,
      stablecoinId: "lusd-liquity",
      pegCurrency: "USD",
      direction: "below",
      startedAt: 100000,
      peakDeviationBps: -300,
      source: "live",
      publicTrackedAtFirstSeen: true,
      registrySnapshot: { id: "lusd-liquity", symbol: "LUSD" },
    }],
    { nowSec, predictionPolicyVersion: "sticky-24h-v1", ddrV2EffectiveAt: 90000, createdBy: "vitest" },
  );
  if (!incident) throw new Error("incident was not created");
  return incident;
}

export interface SealedPayloadOptions {
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
}

export function sealedPayload(
  incidentKey: string,
  kind: "prediction" | "no_call" = "prediction",
  options: SealedPayloadOptions = {},
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

export function sealedPayloadWithHash(
  incidentKey: string,
  kind: "prediction" | "no_call" = "prediction",
  options?: SealedPayloadOptions,
) {
  const payload = sealedPayload(incidentKey, kind, options);
  const rowHash = computeDdrPublicRowHash(payload);
  return { payload: attachDdrPublicRowHash(payload, rowHash), rowHash };
}

type SealPublicFixtureLockOverrides = Partial<Pick<
  DdrPublicAssessmentSealInput,
  | "healthStatus"
  | "lockTrigger"
  | "forecastReadinessScore"
  | "forecastReadinessVersion"
  | "readinessThreshold"
  | "backstopAt"
  | "backstopDelaySec"
>>;

export interface SealPublicFixtureOptions {
  payload?: SealedPayloadOptions;
  lock?: SealPublicFixtureLockOverrides;
  createdAt?: number;
  runId?: string | null;
}

export async function sealPublicFixture(
  db: SqliteD1,
  incidentKey: string,
  kind: "prediction" | "no_call" = "prediction",
  options: SealPublicFixtureOptions = {},
) {
  const { payload, rowHash } = sealedPayloadWithHash(incidentKey, kind, options.payload);
  const prediction = payload.prediction;
  const base = {
    incidentKey: payload.incidentKey,
    eventId: payload.eventId,
    stablecoinId: payload.stablecoinId,
    symbol: payload.symbol,
    name: payload.name,
    pegCurrency: payload.pegCurrency,
    governance: payload.governance,
    direction: payload.direction,
    startedAt: payload.startedAt,
    assessedAt: prediction.lockedAt,
    eventAgeSec: prediction.eventAgeAtLockSec,
    methodologyVersion: prediction.predictionMethodologyVersion,
    methodologyVersionLabel: `v${prediction.predictionMethodologyVersion}`,
    resolutionRubricVersion: prediction.resolutionRubricVersion,
    durationModelVersion: prediction.durationModelVersion,
    incidentGroupingVersion: prediction.incidentGroupingVersion,
    supportRulesVersion: prediction.supportRulesVersion,
    sealedPayload: payload,
    rowHash,
    predictionPolicyVersion: prediction.predictionPolicyVersion,
    policyDelaySec: prediction.policyDelaySec,
    eligibleAt: prediction.eligibleAt,
    lockedAt: prediction.lockedAt,
    eventAgeAtLockSec: prediction.eventAgeAtLockSec,
    lockTiming: prediction.lockTiming,
    createdAt: options.createdAt ?? prediction.lockedAt + 1,
    runId: options.runId !== undefined ? options.runId : kind === "prediction" ? "ddr:test" : undefined,
    ...options.lock,
  };

  return kind === "prediction"
    ? sealPublicPrediction(db, {
        ...base,
        resolutionTier: "at_risk",
        durationSuppressed: false,
        durationSuppressedReason: null,
        medianRemainingSec: 7200,
        iqrLowRemainingSec: 3600,
        iqrHighRemainingSec: 14400,
        stratum: payload.direction,
        horizons: [],
        factors: [],
      })
    : sealPublicNoCall(db, base);
}

export async function sealExistingIncident(
  db: SqliteD1,
  incident: Awaited<ReturnType<typeof ensureIncident>>,
  options: SealedPayloadOptions = {},
) {
  return sealPublicFixture(db, incident.incidentKey, "prediction", { payload: options });
}

export async function sealPredictionFixture(db: SqliteD1) {
  insertOpenEvent(db);
  const incident = await ensureIncident(db);
  const prediction = await sealExistingIncident(db, incident);
  return { incident, prediction };
}

export function insertPredictionErratum(
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

export interface FlapMigrationReplayScenario {
  migration: string;
  stablecoinId: string;
  symbol: string;
  pegCurrency: string;
  firstEventId: number;
  firstStartedAt: number;
  current: { eventId: number; startedAt: number; endedAt: number; peakDeviationBps: number };
  tails: Array<{ eventId: number; startedAt: number; endedAt: number | null; peakDeviationBps: number }>;
}

export const FLAP_MIGRATION_REPLAY_SCENARIOS: FlapMigrationReplayScenario[] = [
  {
    migration: "0203", stablecoinId: "cngn-compliant-naira", symbol: "cNGN", pegCurrency: "NGN", firstEventId: 90511,
    firstStartedAt: 1783650896, current: { eventId: 90526, startedAt: 1783791305, endedAt: 1783792143, peakDeviationBps: -172 },
    tails: [{ eventId: 90548, startedAt: 1783946864, endedAt: 1783947766, peakDeviationBps: -172 }],
  },
  {
    migration: "0206", stablecoinId: "cngn-compliant-naira", symbol: "cNGN", pegCurrency: "NGN", firstEventId: 90511,
    firstStartedAt: 1783650896, current: { eventId: 90548, startedAt: 1783946864, endedAt: 1783947766, peakDeviationBps: -172 },
    tails: [
      { eventId: 90573, startedAt: 1784085475, endedAt: 1784089078, peakDeviationBps: -151 },
      { eventId: 90576, startedAt: 1784089988, endedAt: 1784098070, peakDeviationBps: -151 },
      { eventId: 90584, startedAt: 1784108016, endedAt: 1784108885, peakDeviationBps: -150 },
    ],
  },
  {
    migration: "0208", stablecoinId: "eurq-quantoz", symbol: "EURQ", pegCurrency: "EUR", firstEventId: 90527,
    firstStartedAt: 1783798508, current: { eventId: 90560, startedAt: 1784033283, endedAt: 1784044075, peakDeviationBps: -166 },
    tails: [
      { eventId: 90589, startedAt: 1784126070, endedAt: 1784126921, peakDeviationBps: -156 },
      { eventId: 90591, startedAt: 1784127861, endedAt: 1784128727, peakDeviationBps: -150 },
      { eventId: 90594, startedAt: 1784133252, endedAt: 1784135051, peakDeviationBps: -170 },
      { eventId: 90595, startedAt: 1784135928, endedAt: null, peakDeviationBps: -151 },
    ],
  },
  {
    migration: "0209", stablecoinId: "cngn-compliant-naira", symbol: "cNGN", pegCurrency: "NGN", firstEventId: 90511,
    firstStartedAt: 1783650896, current: { eventId: 90584, startedAt: 1784108016, endedAt: 1784108885, peakDeviationBps: -150 },
    tails: [{ eventId: 90599, startedAt: 1784151172, endedAt: null, peakDeviationBps: -158 }],
  },
  {
    migration: "0215", stablecoinId: "cngn-compliant-naira", symbol: "cNGN", pegCurrency: "NGN", firstEventId: 90511,
    firstStartedAt: 1783650896, current: { eventId: 90658, startedAt: 1784375257, endedAt: 1784379776, peakDeviationBps: -156 },
    tails: [
      { eventId: 90664, startedAt: 1784380665, endedAt: 1784381584, peakDeviationBps: -151 },
      { eventId: 90666, startedAt: 1784383381, endedAt: 1784384266, peakDeviationBps: -150 },
    ],
  },
  {
    migration: "0227", stablecoinId: "cngn-compliant-naira", symbol: "cNGN", pegCurrency: "NGN", firstEventId: 90511,
    firstStartedAt: 1783650896, current: { eventId: 90666, startedAt: 1784383381, endedAt: 1784384266, peakDeviationBps: -150 },
    tails: [
      { eventId: 90718, startedAt: 1784486946, endedAt: 1784487834, peakDeviationBps: -153 },
      { eventId: 90729, startedAt: 1784521129, endedAt: 1784522926, peakDeviationBps: -150 },
      { eventId: 90738, startedAt: 1784641668, endedAt: null, peakDeviationBps: -170 },
    ],
  },
];

export async function seedFlapMigrationIncident(db: SqliteD1, scenario: FlapMigrationReplayScenario) {
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
    [{
      eventId: scenario.firstEventId,
      stablecoinId: scenario.stablecoinId,
      pegCurrency: scenario.pegCurrency,
      direction: "below",
      startedAt: scenario.firstStartedAt,
      endedAt: scenario.firstStartedAt + 900,
      peakDeviationBps: -150,
      source: "live",
    }],
    { nowSec: scenario.firstStartedAt + 60, predictionPolicyVersion: "sticky-24h-v1", ddrV2EffectiveAt: 90000, createdBy: "vitest" },
  );
  if (!incident) throw new Error(`Failed to seed ${scenario.migration} incident`);

  insertLiveEvent(db, { ...scenario.current, stablecoinId: scenario.stablecoinId, symbol: scenario.symbol, pegCurrency: scenario.pegCurrency });
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
    .run(incident.incidentKey, scenario.firstEventId, scenario.current.eventId, scenario.current.startedAt);
  db.sqlite
    .prepare(
      `UPDATE depeg_resolver_incidents
       SET current_event_id = ?, current_started_at = ?, updated_at = ?
       WHERE incident_key = ?`,
    )
    .run(scenario.current.eventId, scenario.current.startedAt, scenario.current.startedAt, incident.incidentKey);
  return incident;
}
