import { describe, expect, it } from "vitest";
import { mockD1 } from "@shared/test-utils/mock-d1";
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
import { DDR_FORECAST_READINESS_BACKSTOP_DELAY_SEC, DDR_FORECAST_READINESS_STRICT_EARLY_LOCK_THRESHOLD, DDR_FORECAST_READINESS_VERSION } from "@shared/lib/methodology-versions/depeg-resolver";
import { coverageRowForIncident } from "../../cron/depeg-resolver-review/coverage-rows";
import {
  FLAP_MIGRATION_REPLAY_SCENARIOS,
  ensureIncident,
  insertLiveEvent,
  insertOpenEvent,
  insertPredictionErratum,
  makeSqliteD1,
  sealExistingIncident,
  sealPredictionFixture,
  sealPublicFixture,
  sealedPayloadWithHash,
  seedFlapMigrationIncident,
  withSqliteD1,
  type SqliteD1,
} from "./depeg-resolver-ddrv2-store.test-support";

function row<T>(db: SqliteD1, sql: string, ...binds: unknown[]): T {
  return db.sqlite.prepare(sql).get(...(binds as never[])) as T;
}

function rows<T>(db: SqliteD1, sql: string, ...binds: unknown[]): T[] {
  return db.sqlite.prepare(sql).all(...(binds as never[])) as T[];
}

function eventInput(eventId: number, startedAt: number, peakDeviationBps = -350, endedAt?: number | null) {
  return { eventId, stablecoinId: "lusd-liquity", pegCurrency: "USD" as const, direction: "below" as const, startedAt, endedAt, peakDeviationBps, source: "live" as const };
}

describe("DDRv2 storage contract cases", () => {
  it("keeps split public-prediction triggers and immutable incident links", async () => withSqliteD1(async (db) => {
    await ensureIncident(db);
    const names = new Set(rows<{ name: string }>(db, `SELECT name FROM sqlite_master WHERE type = 'trigger' AND tbl_name = 'depeg_resolver_public_predictions'`).map(({ name }) => name));
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
    expect(() => db.sqlite.exec("UPDATE depeg_resolver_incident_event_links SET relation = 'merged' WHERE event_id = 1")).toThrow(/append-only/);
  }));

  it("bootstraps incidents, policy membership, lock audit state, and idempotent reads", async () => withSqliteD1(async (db) => {
    const incident = await ensureIncident(db);
    expect(incident).toMatchObject({
      sourceFingerprint: "57575ce509837e748c284019c4ce62a0941aece26a0106ede5775b736270184e",
      incidentKey: "ddr2:2867d8491b313b47ae432676cf15acbb",
      policyMembership: { policyUniverseIncluded: true, policyUniverseReason: "post_effective_public_tracked" },
    });
    expect(row<{ source_fingerprint: string }>(db, "SELECT source_fingerprint FROM depeg_resolver_incidents WHERE incident_key = ?", incident.incidentKey).source_fingerprint).toBe(incident.sourceFingerprint);

    const lock = { incidentKey: incident.incidentKey, eventId: 1, predictionPolicyVersion: "sticky-24h-v1", eligibleAt: 143200, runAt: 143200, action: "deferred", reason: "scheduler unhealthy", healthStatus: "degraded", runId: "ddr:test:deferral", lockTrigger: "forecast_readiness" as const, forecastReadinessScore: 0.81, forecastReadinessVersion: DDR_FORECAST_READINESS_VERSION, readinessThreshold: DDR_FORECAST_READINESS_STRICT_EARLY_LOCK_THRESHOLD, backstopAt: 100000 + DDR_FORECAST_READINESS_BACKSTOP_DELAY_SEC, backstopDelaySec: DDR_FORECAST_READINESS_BACKSTOP_DELAY_SEC } as const;
    await recordLockDeferral(db, lock);
    await recordLockDeferral(db, lock);
    await recordLockDeferral(db, { ...lock, runId: "ddr:test:deferral:next", runAt: 144100 });
    const [loaded] = await loadCanonicalIncidents(db, { stablecoinIds: ["lusd-liquity"], predictionPolicyVersion: "sticky-24h-v1", policyUniverseIncluded: true });
    expect(loaded).toMatchObject({ incidentKey: incident.incidentKey, eventId: 1, policyUniverseIncluded: true, lockState: { eligibleAt: 143200, deferralCount: 2, lastDeferralReason: "scheduler unhealthy", lastState: "lock_deferred", lockTrigger: "forecast_readiness", forecastReadinessScore: 0.81, backstopDelaySec: DDR_FORECAST_READINESS_BACKSTOP_DELAY_SEC } });
    expect(JSON.parse(loaded?.policyMembership?.registrySnapshotJson ?? "null")).toEqual({ id: "lusd-liquity", symbol: "LUSD" });
    expect(rows<{ run_id: string }>(db, "SELECT run_id FROM depeg_resolver_lock_opportunity_audit WHERE incident_key = ? ORDER BY run_at", incident.incidentKey).map(({ run_id }) => run_id)).toEqual(["ddr:test:deferral", "ddr:test:deferral:next"]);

    const [again] = await ensureCanonicalIncidents(db, [{ eventId: 1, stablecoinId: "lusd-liquity", pegCurrency: "USD", direction: "below", startedAt: 100000, peakDeviationBps: -300, source: "live" }], { nowSec: 200100, predictionPolicyVersion: "sticky-24h-v1", ddrV2EffectiveAt: 90000 });
    expect(again).toMatchObject({ incidentKey: incident.incidentKey, sourceFingerprint: incident.sourceFingerprint });
    expect(await loadCanonicalIncidents(db, { limit: 1 })).toHaveLength(1);
  }));

  it.each(["exact-key collision", "missing provenance", "invalid fingerprint"] as const)("rejects %s before unsafe adoption", async (caseName) => withSqliteD1(async (db) => {
    if (caseName === "invalid fingerprint") {
      await expect(ensureCanonicalIncidents(db, [{ ...eventInput(1, 100000, -300), sourceFingerprint: "not-a-hash" }], { nowSec: 200000, predictionPolicyVersion: "sticky-24h-v1", ddrV2EffectiveAt: 90000 })).rejects.toThrow(/64-character lowercase hex hash/);
      return;
    }
    const incident = await ensureIncident(db, 1, 100500);
    if (caseName === "exact-key collision") insertLiveEvent(db, { eventId: 2, startedAt: 100000, peakDeviationBps: -300 });
    await expect(ensureCanonicalIncidents(db, [eventInput(2, caseName === "exact-key collision" ? 100000 : 100900, caseName === "exact-key collision" ? -300 : -350)], { nowSec: 101000, predictionPolicyVersion: "sticky-24h-v1", ddrV2EffectiveAt: 90000 })).rejects.toThrow(caseName === "exact-key collision" ? `Unlinked depeg event 2 maps to existing incident ${incident.incidentKey}` : "lacks matching canonical live provenance");
  }));

  it.each(["pre-lock", "recovered"] as const)("adopts a nearby %s live event only with ordered provenance", async (kind) => withSqliteD1(async (db) => {
    const incident = await ensureIncident(db, 1, 100500);
    const endedAt = kind === "recovered" ? 101200 : null;
    insertLiveEvent(db, { eventId: 2, startedAt: 100900, endedAt, peakDeviationBps: -350 });
    const [adopted] = await ensureCanonicalIncidents(db, [eventInput(2, 100900, -350, endedAt)], { nowSec: 101300, predictionPolicyVersion: "sticky-24h-v1", ddrV2EffectiveAt: 90000, createdBy: "vitest" });
    expect(adopted).toMatchObject({ incidentKey: incident.incidentKey, eventId: 2, currentEventId: 2, relation: "repair_replacement" });
    expect(row<{ relation: string }>(db, "SELECT relation FROM depeg_resolver_incident_event_links WHERE event_id = 2").relation).toBe("repair_replacement");
  }));

  it("quarantines out-of-order overlaps, but processes clean events in the same batch", async () => withSqliteD1(async (db) => {
    const incident = await ensureIncident(db, 1, 100500);
    insertLiveEvent(db, { eventId: 2, startedAt: 99900 });
    const quarantined: Array<{ eventId: number; reason: string }> = [];
    const [clean] = await ensureCanonicalIncidents(db, [eventInput(2, 99900), eventInput(3, 900000, -200)], { nowSec: 901000, predictionPolicyVersion: "sticky-24h-v1", ddrV2EffectiveAt: 90000, onRepairRequired: (eventId, reason) => quarantined.push({ eventId, reason }) });
    expect(quarantined).toEqual([{ eventId: 2, reason: expect.stringContaining(incident.incidentKey) }]);
    expect(clean?.eventId).toBe(3);
    expect(row<{ count: number }>(db, "SELECT COUNT(*) AS count FROM depeg_resolver_incident_event_links WHERE event_id = 2")).toEqual({ count: 0 });
  }));

  it.each(["link-count", "incident-span"] as const)("quarantines automatic adoption at the %s cap", async (cap) => withSqliteD1(async (db) => {
    const incident = await ensureIncident(db, 1, 100500);
    if (cap === "link-count") {
      for (let index = 1; index < DDR_FLAP_TOLERANT_MAX_LINK_COUNT_V1; index += 1) db.sqlite.prepare(`INSERT INTO depeg_resolver_incident_event_links (incident_key, event_id, relation, repair_authorization_id, linked_at, note) VALUES (?, ?, 'repair_replacement', NULL, ?, 'cap fixture')`).run(incident.incidentKey, 1000 + index, 100500 + index);
    } else {
      const predecessorStartedAt = 100000 + DDR_FLAP_TOLERANT_MAX_INCIDENT_SPAN_SEC_V1 - 3600;
      db.sqlite.prepare(`INSERT INTO depeg_events (id, stablecoin_id, symbol, peg_type, direction, peak_deviation_bps, started_at, ended_at, start_price, peak_price, recovery_price, peg_reference, source) VALUES (3, 'lusd-liquity', 'LUSD', 'peggedUSD', 'below', -300, ?, NULL, 0.98, 0.97, NULL, 1, 'live')`).run(predecessorStartedAt);
      db.sqlite.prepare(`INSERT INTO depeg_resolver_incident_event_links (incident_key, event_id, relation, repair_authorization_id, linked_at, note) VALUES (?, 3, 'repair_replacement', NULL, ?, 'span fixture predecessor')`).run(incident.incidentKey, predecessorStartedAt);
      db.sqlite.prepare(`INSERT INTO depeg_resolver_incident_revisions (incident_key, previous_event_id, current_event_id, reason, repair_authorization_id, erratum_id, created_at, created_by) VALUES (?, 1, 3, 'span fixture predecessor', NULL, NULL, ?, 'vitest')`).run(incident.incidentKey, predecessorStartedAt);
      db.sqlite.prepare("UPDATE depeg_resolver_incidents SET current_event_id = 3, current_started_at = ?, updated_at = ? WHERE incident_key = ?").run(predecessorStartedAt, predecessorStartedAt, incident.incidentKey);
    }
    const startedAt = cap === "link-count" ? 100900 : 100000 + DDR_FLAP_TOLERANT_MAX_INCIDENT_SPAN_SEC_V1 + 1;
    insertLiveEvent(db, { eventId: 2, startedAt, peakDeviationBps: -350 });
    const quarantined: number[] = [];
    expect(await ensureCanonicalIncidents(db, [eventInput(2, startedAt)], { nowSec: startedAt + 60, predictionPolicyVersion: "sticky-24h-v1", ddrV2EffectiveAt: 90000, onRepairRequired: (eventId) => quarantined.push(eventId) })).toEqual([]);
    expect(quarantined).toEqual([2]);
  }));

  it("closes, resurrects, and finally excludes recovered pre-lock incidents", async () => withSqliteD1(async (db) => {
    const firstStartedAt = 100000;
    const firstEndedAt = firstStartedAt + 900;
    insertOpenEvent(db, 90511);
    const first = await ensureIncident(db, 90511, firstStartedAt + 300);
    db.sqlite.prepare("UPDATE depeg_events SET ended_at = ?, recovery_price = NULL, close_reason = 'recovered-native' WHERE id = ?").run(firstEndedAt, 90511);
    const closeAt = firstEndedAt + DDR_INCIDENT_REOPEN_MERGE_WINDOW_SEC + DDR_PRE_LOCK_CLOSE_SETTLE_MARGIN_SEC_V1;
    expect(await closeRecoveredPreLockIncidents(db, closeAt - 1)).toBe(0);
    expect(await closeRecoveredPreLockIncidents(db, closeAt)).toBe(1);
    const [closed] = await loadCanonicalIncidents(db, { incidentKeys: [first.incidentKey], includeSuperseded: true });
    expect(closed).toMatchObject({ incidentState: "closed_pre_lock", closedPreLockAt: closeAt });
    expect(coverageRowForIncident(closed!, { eventId: 90511, currentEventId: 90511, startedAt: firstStartedAt, endedAt: firstEndedAt, recoveryPrice: null, closeReason: "recovered-native", stablecoinStatus: null, terminalObserved: null, terminalEvidenceAt: null, terminalEvidenceInterval: null, terminalEvidencePrecision: null }, closeAt)).toMatchObject({ predictionState: "resolved_before_prediction", coverageCause: "pre_lock_recovered" });
    expect(await loadCanonicalIncidents(db, { incidentKeys: [first.incidentKey] })).toEqual([]);

    const outsideStart = firstEndedAt + DDR_INCIDENT_REOPEN_MERGE_WINDOW_SEC + 1;
    const outsideEnd = outsideStart + 900;
    insertLiveEvent(db, { eventId: 90512, startedAt: outsideStart, endedAt: outsideEnd, peakDeviationBps: -325 });
    const [fresh] = await ensureCanonicalIncidents(db, [eventInput(90512, outsideStart, -325, outsideEnd)], { nowSec: outsideEnd + 60, predictionPolicyVersion: "sticky-24h-v1", ddrV2EffectiveAt: 90000 });
    expect(fresh?.incidentKey).not.toBe(first.incidentKey);
    const freshCloseAt = outsideEnd + DDR_INCIDENT_REOPEN_MERGE_WINDOW_SEC + DDR_PRE_LOCK_CLOSE_SETTLE_MARGIN_SEC_V1;
    expect(await closeRecoveredPreLockIncidents(db, freshCloseAt)).toBe(1);
    const withinStart = outsideEnd + 3600;
    const withinEnd = withinStart + 900;
    insertLiveEvent(db, { eventId: 90513, startedAt: withinStart, endedAt: withinEnd, peakDeviationBps: -350 });
    const [resurrected] = await ensureCanonicalIncidents(db, [eventInput(90513, withinStart, -350, withinEnd)], { nowSec: withinEnd + 60, predictionPolicyVersion: "sticky-24h-v1", ddrV2EffectiveAt: 90000 });
    expect(resurrected).toMatchObject({ incidentKey: fresh?.incidentKey, currentEventId: 90513, incidentState: "active", closedPreLockAt: null });
    db.sqlite.prepare("UPDATE depeg_events SET close_reason = 'superseded-direction' WHERE id = 90513").run();
    expect(await closeRecoveredPreLockIncidents(db, withinEnd + DDR_INCIDENT_REOPEN_MERGE_WINDOW_SEC + DDR_PRE_LOCK_CLOSE_SETTLE_MARGIN_SEC_V1)).toBe(0);
  }));

  it("does not close a recovered incident after its public outcome is sealed", async () => withSqliteD1(async (db) => {
    const { incident } = await sealPredictionFixture(db);
    db.sqlite.prepare("UPDATE depeg_events SET ended_at = 101000, recovery_price = 1 WHERE id = 1").run();
    expect(await closeRecoveredPreLockIncidents(db, 101000 + DDR_INCIDENT_REOPEN_MERGE_WINDOW_SEC + DDR_PRE_LOCK_CLOSE_SETTLE_MARGIN_SEC_V1)).toBe(0);
    expect(row<{ closed_pre_lock_at: number | null }>(db, "SELECT closed_pre_lock_at FROM depeg_resolver_incidents WHERE incident_key = ?", incident.incidentKey)).toEqual({ closed_pre_lock_at: null });
  }));

  it("uses the current event for adoption recency and keeps same-regime sealed tails bounded", async () => withSqliteD1(async (db) => {
    const incident = await ensureIncident(db, 1, 100500);
    insertLiveEvent(db, { eventId: 2, startedAt: 100900, peakDeviationBps: -350 });
    const [adopted] = await ensureCanonicalIncidents(db, [eventInput(2, 100900)], { nowSec: 186400, predictionPolicyVersion: "sticky-24h-v1", ddrV2EffectiveAt: 90000 });
    expect(adopted).toMatchObject({ incidentKey: incident.incidentKey, currentEventId: 2 });

    const sealedDb = makeSqliteD1();
    try {
      insertLiveEvent(sealedDb, { eventId: 1, startedAt: 100000, peakDeviationBps: -113 });
      const [sealedIncident] = await ensureCanonicalIncidents(sealedDb, [{ ...eventInput(1, 100000, -113), publicTrackedAtFirstSeen: true, registrySnapshot: { id: "lusd-liquity", symbol: "LUSD" } }], { nowSec: 100100, predictionPolicyVersion: "sticky-24h-v1", ddrV2EffectiveAt: 90000 });
      await sealExistingIncident(sealedDb, sealedIncident! as Awaited<ReturnType<typeof ensureIncident>>, { lockTimePeakDeviationBps: -300 });
      sealedDb.sqlite.prepare("UPDATE depeg_events SET ended_at = 190000, recovery_price = 1 WHERE id = 1").run();
      insertLiveEvent(sealedDb, { eventId: 2, startedAt: 191000, peakDeviationBps: -1000 });
      const [tail] = await ensureCanonicalIncidents(sealedDb, [eventInput(2, 191000, -1000)], { nowSec: 191100, predictionPolicyVersion: "sticky-24h-v1", ddrV2EffectiveAt: 90000 });
      expect(tail).toMatchObject({ incidentKey: sealedIncident?.incidentKey, relation: "repair_replacement" });
      expect(row<{ count: number }>(sealedDb, "SELECT COUNT(*) AS count FROM depeg_resolver_incidents WHERE stablecoin_id = 'lusd-liquity'")).toEqual({ count: 1 });
    } finally {
      sealedDb.close();
    }
  }));

  it("writes both automated repair authorizations for a sealed live tail", async () => withSqliteD1(async (db) => {
    const { incident } = await sealPredictionFixture(db);
    insertLiveEvent(db, { eventId: 2, startedAt: 100900, peakDeviationBps: -350 });
    const [tail] = await ensureCanonicalIncidents(db, [eventInput(2, 100900)], { nowSec: 201000, predictionPolicyVersion: "sticky-24h-v1", ddrV2EffectiveAt: 90000 });
    expect(tail).toMatchObject({ incidentKey: incident.incidentKey, currentEventId: 2, relation: "repair_replacement" });
    expect(rows<{ operation: string; target_table: string }>(db, "SELECT operation, target_table FROM depeg_resolver_event_repair_authorization_uses WHERE event_id = 2 ORDER BY authorization_id")).toEqual([
      { operation: "incident_link", target_table: "depeg_resolver_incident_event_links" },
      { operation: "incident_current_update", target_table: "depeg_resolver_incidents" },
    ]);
  }));

  it("replays every migration flap fixture and preserves the append-only lineage", async () => {
    for (const scenario of FLAP_MIGRATION_REPLAY_SCENARIOS) await withSqliteD1(async (db) => {
      const incident = await seedFlapMigrationIncident(db, scenario);
      scenario.tails.forEach((tail) => insertLiveEvent(db, { ...tail, stablecoinId: scenario.stablecoinId, symbol: scenario.symbol, pegCurrency: scenario.pegCurrency }));
      const inputs = scenario.tails.map((tail) => ({ eventId: tail.eventId, stablecoinId: scenario.stablecoinId, pegCurrency: scenario.pegCurrency, direction: "below" as const, startedAt: tail.startedAt, endedAt: tail.endedAt, peakDeviationBps: tail.peakDeviationBps, source: "live" as const }));
      const incidents = await ensureCanonicalIncidents(db, inputs, { nowSec: Math.max(...scenario.tails.map((tail) => tail.endedAt ?? tail.startedAt)) + 60, predictionPolicyVersion: "sticky-24h-v1", policyDelaySec: 72 * 3600, ddrV2EffectiveAt: 90000, createdBy: "vitest" });
      expect(incidents.map(({ incidentKey }) => incidentKey)).toEqual(scenario.tails.map(() => incident.incidentKey));
      expect(rows<{ event_id: number; relation: string }>(db, `SELECT event_id, relation FROM depeg_resolver_incident_event_links WHERE event_id IN (${scenario.tails.map(() => "?").join(",")}) ORDER BY linked_at, event_id`, ...scenario.tails.map(({ eventId }) => eventId))).toEqual(scenario.tails.map(({ eventId }) => ({ event_id: eventId, relation: "repair_replacement" })));
    });
  });

  it("splits a sealed regime escalation and seals each resulting incident", async () => withSqliteD1(async (db) => {
    expect(DDR_SEALED_TAIL_REGIME_ESCALATION_MIN_PEAK_BPS_V1).toBe(1000);
    expect(DDR_SEALED_TAIL_REGIME_ESCALATION_MULTIPLIER_V1).toBe(4);
    const first = { eventId: 90130, stablecoinId: "mim-abracadabra", symbol: "MIM", pegCurrency: "USD", startedAt: 1780937476, endedAt: 1780980688, peakDeviationBps: -113 };
    insertLiveEvent(db, { ...first, endedAt: null });
    const [graded] = await ensureCanonicalIncidents(db, [{ ...eventInput(first.eventId, first.startedAt, first.peakDeviationBps), stablecoinId: first.stablecoinId, pegCurrency: first.pegCurrency, publicTrackedAtFirstSeen: true, registrySnapshot: { id: first.stablecoinId, symbol: first.symbol } }], { nowSec: first.startedAt + 60, policyDelaySec: 3600, predictionPolicyVersion: "sticky-24h-v1", ddrV2EffectiveAt: first.startedAt - 1 });
    await sealExistingIncident(db, graded! as Awaited<ReturnType<typeof ensureIncident>>, { eventId: first.eventId, stablecoinId: first.stablecoinId, symbol: first.symbol, name: "Magic Internet Money", startedAt: first.startedAt, lockTimePeakDeviationBps: first.peakDeviationBps, policyDelaySec: 3600 });
    db.sqlite.prepare("UPDATE depeg_events SET ended_at = ?, recovery_price = ? WHERE id = ?").run(first.endedAt, 1, first.eventId);
    const terminal = { ...first, eventId: 90141, startedAt: 1780997700, endedAt: null, peakDeviationBps: -9201 };
    insertLiveEvent(db, terminal);
    const [split] = await ensureCanonicalIncidents(db, [{ ...eventInput(terminal.eventId, terminal.startedAt, terminal.peakDeviationBps), stablecoinId: terminal.stablecoinId, pegCurrency: terminal.pegCurrency, publicTrackedAtFirstSeen: true, registrySnapshot: { id: terminal.stablecoinId, symbol: terminal.symbol } }], { nowSec: terminal.startedAt + 60, policyDelaySec: 3600, predictionPolicyVersion: "sticky-24h-v1", ddrV2EffectiveAt: first.startedAt - 1 });
    expect(split).toMatchObject({ relation: "observed" });
    expect(row<{ relation: string; from_incident_key: string; to_incident_key: string }>(db, "SELECT relation, from_incident_key, to_incident_key FROM depeg_resolver_incident_lineage WHERE from_incident_key = ?", split!.incidentKey)).toEqual({ relation: "split_from", from_incident_key: split!.incidentKey, to_incident_key: graded!.incidentKey });
    await sealExistingIncident(db, split! as Awaited<ReturnType<typeof ensureIncident>>, { eventId: terminal.eventId, stablecoinId: terminal.stablecoinId, symbol: terminal.symbol, name: "Magic Internet Money", startedAt: terminal.startedAt, lockTimePeakDeviationBps: terminal.peakDeviationBps, policyDelaySec: 3600 });
    expect(row<{ count: number }>(db, "SELECT COUNT(*) AS count FROM depeg_resolver_public_predictions")).toEqual({ count: 2 });
  }));

  it("authorizes sealed-tail adoption across races and close-gap reopening", async () => withSqliteD1(async (db) => {
    const { incident } = await sealPredictionFixture(db);
    insertLiveEvent(db, { eventId: 2, startedAt: 100900, peakDeviationBps: -350 });
    let raced = false;
    const raceDb = { ...db, batch: async (statements: D1PreparedStatement[]) => { if (!raced) { raced = true; await sealExistingIncident(db, incident); } return db.batch(statements); } } as SqliteD1;
    const [tail] = await ensureCanonicalIncidents(raceDb, [eventInput(2, 100900)], { nowSec: 201000, predictionPolicyVersion: "sticky-24h-v1", ddrV2EffectiveAt: 90000 });
    expect(tail?.incidentKey).toBe(incident.incidentKey);
    expect(row<{ count: number }>(db, "SELECT COUNT(*) AS count FROM depeg_resolver_event_repair_authorization_uses WHERE event_id = 2")).toEqual({ count: 2 });

    const reopenDb = makeSqliteD1();
    try {
      const { incident: reopenIncident } = await sealPredictionFixture(reopenDb);
      reopenDb.sqlite.prepare("UPDATE depeg_events SET ended_at = 1000000, recovery_price = 1.0001 WHERE id = 1").run();
      insertLiveEvent(reopenDb, { eventId: 2, startedAt: 1007200, peakDeviationBps: -425 });
      const [reopened] = await ensureCanonicalIncidents(reopenDb, [eventInput(2, 1007200, -425)], { nowSec: 1008000, predictionPolicyVersion: "sticky-24h-v1", ddrV2EffectiveAt: 90000 });
      expect(reopened).toMatchObject({ incidentKey: reopenIncident.incidentKey, currentEventId: 2, relation: "repair_replacement" });
    } finally {
      reopenDb.close();
    }
  }));

  it("maps superseded links and leaves non-live sealed overlaps for manual repair", async () => withSqliteD1(async (db) => {
    const { incident } = await sealPredictionFixture(db);
    db.sqlite.prepare(`INSERT INTO depeg_events (id, stablecoin_id, symbol, peg_type, direction, peak_deviation_bps, started_at, ended_at, start_price, peak_price, recovery_price, peg_reference, source) VALUES (2, 'lusd-liquity', 'LUSD', 'peggedUSD', 'below', -425, 1007200, NULL, 0.96, 0.9575, NULL, 1, 'live')`).run();
    db.sqlite.prepare(`INSERT INTO depeg_resolver_incident_event_links (incident_key, event_id, relation, repair_authorization_id, linked_at, note) VALUES ('ddr2:${"a".repeat(32)}', 2, 'observed', NULL, 1007201, 'duplicate incident link')`).run();
    db.sqlite.prepare(`INSERT INTO depeg_resolver_incidents (incident_key, stablecoin_id, peg_currency, direction, first_event_id, current_event_id, first_started_at, current_started_at, first_observed_peak_bucket_bps, incident_state, superseded_by_incident_key, source_fingerprint, created_at, updated_at) VALUES ('ddr2:${"a".repeat(32)}', 'lusd-liquity', 'USD', 'below', 2, 2, 1007200, 1007200, 425, 'superseded', ?, '${"a".repeat(64)}', 1007201, 1007201)`).run(incident.incidentKey);
    expect(await loadCanonicalIncidents(db, { eventIds: [2], includeSuperseded: true, policyDelaySec: 86400 })).toSatisfy((items) => items[0]?.incidentKey === incident.incidentKey && items[0]?.startedAt === 100000);
    await expect(ensureCanonicalIncidents(db, [{ ...eventInput(4, 100900), source: "backfill" }], { nowSec: 201000, predictionPolicyVersion: "sticky-24h-v1", ddrV2EffectiveAt: 90000 })).rejects.toThrow(/explicit repair required/);
  }));

  it("quarantines repair-required events without aborting clean work and propagates D1 reads", async () => {
    await withSqliteD1(async (db) => {
      const { incident } = await sealPredictionFixture(db);
      const quarantined: number[] = [];
      const [clean] = await ensureCanonicalIncidents(db, [{ ...eventInput(2, 100900), source: "backfill" }, eventInput(3, 900000, -200)], { nowSec: 901000, predictionPolicyVersion: "sticky-24h-v1", ddrV2EffectiveAt: 90000, onRepairRequired: (eventId) => quarantined.push(eventId) });
      expect(quarantined).toEqual([2]);
      expect(clean?.eventId).toBe(3);
      expect(incident.incidentKey).toMatch(/^ddr2:/);
    });
    const db = mockD1([{ match: "FROM depeg_resolver_incidents i", rows: [], throwError: new Error("D1_ERROR: incident read failed") }], { requireMatch: true });
    await expect(loadCanonicalIncidents(db, { stablecoinIds: ["lusd-liquity"] })).rejects.toThrow("D1_ERROR: incident read failed");
  });

  it("seals idempotent predictions, stores readiness/backstop locks, and preserves no-call fields", async () => withSqliteD1(async (db) => {
    const { incident, prediction } = await sealPredictionFixture(db);
    expect(prediction).toMatchObject({ incidentKey: incident.incidentKey, rowHash: expect.stringMatching(/^[0-9a-f]{64}$/), lockTrigger: null, backstopAt: null });
    const duplicate = sealedPayloadWithHash(incident.incidentKey);
    expect((await sealPublicPrediction(db, { incidentKey: incident.incidentKey, eventId: 1, stablecoinId: "lusd-liquity", symbol: "LUSD", name: "Liquity USD", pegCurrency: "USD", governance: "decentralized", direction: "below", startedAt: 100000, assessedAt: 186500, eventAgeSec: 86500, methodologyVersion: "2.1", methodologyVersionLabel: "v2.1", resolutionRubricVersion: "resolution-rubric-v2", durationModelVersion: "duration-landmark-v2", incidentGroupingVersion: "incident-group-v2", supportRulesVersion: "support-rules-v2", resolutionTier: "recovery_likely", durationSuppressed: false, sealedPayload: duplicate.payload, rowHash: duplicate.rowHash, predictionPolicyVersion: "sticky-24h-v1", policyDelaySec: 86400, eligibleAt: 186400, lockedAt: 186500, eventAgeAtLockSec: 86500, lockTiming: "late_freeze", createdAt: 186501 })).id).toBe(prediction.id);
    expect(() => db.sqlite.exec("UPDATE depeg_resolver_assessments SET row_json = '{}' WHERE checkpoint = 'public_prediction'")).toThrow(/immutable/);

    const readinessDb = makeSqliteD1();
    try {
      insertOpenEvent(readinessDb);
      const readinessIncident = await ensureIncident(readinessDb);
      const readiness = await sealPublicFixture(readinessDb, readinessIncident.incidentKey, "prediction", { payload: { eligibleAt: 143200, lockedAt: 143200, eventAgeAtLockSec: 43200, policyDelaySec: 43200, predictionExtras: { lockTrigger: "forecast_readiness", readiness: { version: DDR_FORECAST_READINESS_VERSION, score: 0.92, threshold: 0.9, strictEarlyLockReady: true, reasons: [], components: [] }, backstop: { version: DDR_FORECAST_READINESS_VERSION, delaySec: DDR_FORECAST_READINESS_BACKSTOP_DELAY_SEC, backstopAt: 100000 + DDR_FORECAST_READINESS_BACKSTOP_DELAY_SEC, reached: false } } }, lock: { lockTrigger: "forecast_readiness", forecastReadinessScore: 0.92, forecastReadinessVersion: DDR_FORECAST_READINESS_VERSION, readinessThreshold: 0.9, backstopAt: 100000 + DDR_FORECAST_READINESS_BACKSTOP_DELAY_SEC, backstopDelaySec: DDR_FORECAST_READINESS_BACKSTOP_DELAY_SEC } });
      expect(readiness).toMatchObject({ lockTrigger: "forecast_readiness", forecastReadinessScore: 0.92, readinessThreshold: 0.9 });
    } finally {
      readinessDb.close();
    }

    const noCallDb = makeSqliteD1();
    try {
      insertOpenEvent(noCallDb);
      const noCallIncident = await ensureIncident(noCallDb);
      const noCall = await sealPublicFixture(noCallDb, noCallIncident.incidentKey, "no_call", { payload: { eligibleAt: 359200, lockedAt: 359200, eventAgeAtLockSec: DDR_FORECAST_READINESS_BACKSTOP_DELAY_SEC, policyDelaySec: DDR_FORECAST_READINESS_BACKSTOP_DELAY_SEC, predictionExtras: { lockTrigger: "readiness_backstop", readiness: { version: DDR_FORECAST_READINESS_VERSION, score: 0.61, threshold: DDR_FORECAST_READINESS_STRICT_EARLY_LOCK_THRESHOLD, strictEarlyLockReady: false, reasons: [], components: [] }, backstop: { version: DDR_FORECAST_READINESS_VERSION, delaySec: DDR_FORECAST_READINESS_BACKSTOP_DELAY_SEC, backstopAt: 359200, reached: true } } }, lock: { lockTrigger: "readiness_backstop", forecastReadinessScore: 0.61, forecastReadinessVersion: DDR_FORECAST_READINESS_VERSION, readinessThreshold: DDR_FORECAST_READINESS_STRICT_EARLY_LOCK_THRESHOLD, backstopAt: 359200, backstopDelaySec: DDR_FORECAST_READINESS_BACKSTOP_DELAY_SEC } });
      expect(noCall).toMatchObject({ outcomeKind: "no_call", lockTrigger: "readiness_backstop", forecastReadinessScore: 0.61 });
      const flat = row<{ resolution_tier: string; duration_suppressed: number; horizons_json: string; factors_json: string }>(noCallDb, "SELECT resolution_tier, duration_suppressed, horizons_json, factors_json FROM depeg_resolver_assessments WHERE checkpoint = 'public_prediction' ORDER BY id DESC");
      expect({ ...flat, horizons: JSON.parse(flat.horizons_json), factors: JSON.parse(flat.factors_json) }).toMatchObject({ resolution_tier: "insufficient_signal", duration_suppressed: 1, horizons: [], factors: [] });
    } finally {
      noCallDb.close();
    }
  }));

  it.each(["invalid delay", "invalid score"] as const)("rejects readiness %s at the storage boundary", async (caseName) => withSqliteD1(async (db) => {
    insertOpenEvent(db);
    const incident = await ensureIncident(db);
    if (caseName === "invalid score") {
      await expect(recordLockOpportunity(db, { incidentKey: incident.incidentKey, eventId: 1, predictionPolicyVersion: "sticky-24h-v1", eligibleAt: 143200, runAt: 143200, action: "pending", reason: null, healthStatus: "healthy", lockTrigger: "forecast_readiness", forecastReadinessScore: 1.01, forecastReadinessVersion: DDR_FORECAST_READINESS_VERSION, readinessThreshold: DDR_FORECAST_READINESS_STRICT_EARLY_LOCK_THRESHOLD, backstopAt: 100000 + DDR_FORECAST_READINESS_BACKSTOP_DELAY_SEC, backstopDelaySec: DDR_FORECAST_READINESS_BACKSTOP_DELAY_SEC })).rejects.toThrow(/\[0, 1\]/);
      return;
    }
    const backstopAt = 143200;
    const { payload, rowHash } = sealedPayloadWithHash(incident.incidentKey, "no_call", { eligibleAt: backstopAt, lockedAt: backstopAt, eventAgeAtLockSec: 43200, policyDelaySec: 43200, predictionExtras: { lockTrigger: "readiness_backstop", backstop: { version: DDR_FORECAST_READINESS_VERSION, delaySec: 43200, backstopAt, reached: true } } });
    await expect(sealPublicNoCall(db, { incidentKey: incident.incidentKey, eventId: 1, stablecoinId: "lusd-liquity", symbol: "LUSD", name: "Liquity USD", pegCurrency: "USD", governance: "decentralized", direction: "below", startedAt: 100000, assessedAt: backstopAt, eventAgeSec: 43200, methodologyVersion: "2.0", methodologyVersionLabel: "v2.0", resolutionRubricVersion: "resolution-rubric-v2", durationModelVersion: "duration-landmark-v2", incidentGroupingVersion: "incident-group-v2", supportRulesVersion: "support-rules-v2", sealedPayload: payload, rowHash, predictionPolicyVersion: "sticky-24h-v1", policyDelaySec: 43200, eligibleAt: backstopAt, lockedAt: backstopAt, eventAgeAtLockSec: 43200, lockTiming: "on_time", createdAt: backstopAt + 1, lockTrigger: "readiness_backstop", backstopAt, backstopDelaySec: 43200 })).rejects.toThrow(/readiness-72h backstop delay/);
  }));

  it("overwrites pending lock metadata with the sealed backstop metadata", async () => withSqliteD1(async (db) => {
    insertOpenEvent(db);
    const incident = await ensureIncident(db);
    const backstopAt = 100000 + DDR_FORECAST_READINESS_BACKSTOP_DELAY_SEC;
    await recordLockOpportunity(db, { incidentKey: incident.incidentKey, eventId: 1, predictionPolicyVersion: "sticky-24h-v1", eligibleAt: 143200, runAt: 143200, action: "pending", reason: null, healthStatus: "healthy", lockTrigger: "forecast_readiness", forecastReadinessScore: 0.92, forecastReadinessVersion: DDR_FORECAST_READINESS_VERSION, readinessThreshold: DDR_FORECAST_READINESS_STRICT_EARLY_LOCK_THRESHOLD, backstopAt, backstopDelaySec: DDR_FORECAST_READINESS_BACKSTOP_DELAY_SEC });
    await sealPublicFixture(db, incident.incidentKey, "no_call", { payload: { eligibleAt: backstopAt, lockedAt: backstopAt, eventAgeAtLockSec: DDR_FORECAST_READINESS_BACKSTOP_DELAY_SEC, policyDelaySec: DDR_FORECAST_READINESS_BACKSTOP_DELAY_SEC, predictionExtras: { lockTrigger: "readiness_backstop", readiness: { version: DDR_FORECAST_READINESS_VERSION, score: 0.61, threshold: DDR_FORECAST_READINESS_STRICT_EARLY_LOCK_THRESHOLD, strictEarlyLockReady: false, reasons: [], components: [] }, backstop: { version: DDR_FORECAST_READINESS_VERSION, delaySec: DDR_FORECAST_READINESS_BACKSTOP_DELAY_SEC, backstopAt, reached: true } } }, lock: { lockTrigger: "readiness_backstop", forecastReadinessScore: 0.61, forecastReadinessVersion: DDR_FORECAST_READINESS_VERSION, readinessThreshold: DDR_FORECAST_READINESS_STRICT_EARLY_LOCK_THRESHOLD, backstopAt, backstopDelaySec: DDR_FORECAST_READINESS_BACKSTOP_DELAY_SEC } });
    expect(row(db, "SELECT last_state, lock_trigger, forecast_readiness_score, backstop_at, backstop_delay_sec FROM depeg_resolver_prediction_lock_state WHERE incident_key = ?", incident.incidentKey)).toEqual({ last_state: "no_call", lock_trigger: "readiness_backstop", forecast_readiness_score: 0.61, backstop_at: backstopAt, backstop_delay_sec: DDR_FORECAST_READINESS_BACKSTOP_DELAY_SEC });
  }));

  it("rejects malformed sealed payloads and supports append-only errata repair", async () => withSqliteD1(async (db) => {
    const { incident, prediction } = await sealPredictionFixture(db);
    const erratumId = insertPredictionErratum(db, { publicPredictionId: prediction.id, incidentKey: incident.incidentKey, eventId: 1, assessmentId: prediction.assessmentId, reason: "event_identity_error", operatorNote: "test repair evidence", rowHashBefore: prediction.rowHash, createdAt: 190000, createdBy: "vitest" });
    expect(erratumId).toBeGreaterThan(0);
    expect(() => db.sqlite.exec("UPDATE depeg_resolver_prediction_errata SET operator_note = 'mutated'")).toThrow(/append-only/);
    const authorization = await authorizeEventRepair(db, { eventId: 1, incidentKey: incident.incidentKey, operation: "identity_update", columns: ["started_at"], reason: "correct start timestamp", createdAt: 190010, expiresAt: 4102444800, createdBy: "vitest" });
    await consumeEventRepairAuthorization(db, { authorizationId: authorization.id, eventId: 1, incidentKey: incident.incidentKey, operation: "identity_update", consumedAt: 190011, consumer: "vitest" });
    expect(() => db.sqlite.exec("UPDATE depeg_events SET started_at = 100001 WHERE id = 1")).not.toThrow();
    expect(() => db.sqlite.exec("UPDATE depeg_events SET started_at = 100002 WHERE id = 1")).toThrow(/authorization/);
    await expect(consumeEventRepairAuthorization(db, { authorizationId: authorization.id, eventId: 1, incidentKey: incident.incidentKey, operation: "identity_update", consumedAt: 190012, consumer: "vitest" })).rejects.toThrow();
    expect(() => insertPredictionErratum(db, { publicPredictionId: prediction.id, incidentKey: incident.incidentKey, eventId: 1, assessmentId: prediction.assessmentId, reason: "hash_mismatch", operatorNote: "bad replacement hash", replacementRowHash: "not-a-hash", createdAt: 190000, createdBy: "vitest" })).toThrow(/CHECK constraint failed/);

    db.sqlite.exec("DROP TRIGGER trg_ddr_public_predictions_no_update");
    db.sqlite.exec("PRAGMA ignore_check_constraints = ON");
    db.sqlite.prepare("UPDATE depeg_resolver_public_predictions SET sealed_payload_json = ? WHERE id = ?").run("{bad", prediction.id);
    await expect(loadSealedPublicPredictions(db, { publicPredictionIds: [prediction.id] })).rejects.toThrow(/valid JSON/);
  }));

  it("finalizes compressed publication manifests atomically and retains the first membership", async () => withSqliteD1(async (db) => {
    const { prediction } = await sealPredictionFixture(db);
    const raw = sealedPayloadWithHash(prediction.incidentKey).payload;
    const manifestRow = { ...raw, prediction: { ...(raw.prediction as Record<string, unknown>), publicPredictionId: prediction.id, state: "frozen", publishedAt: 200000, publicationSnapshotToken: "ddrpub:test:1", snapshotGeneration: 2 } };
    const basePayload = { _meta: { publicPredictionIds: [prediction.id], publicPredictionRowHashes: { [prediction.id]: prediction.rowHash } }, rows: [manifestRow] };
    await expect(writePublicationManifest(db, { snapshotToken: "ddrpub:test:mutated", snapshotGeneration: 2, publishedAt: 199999, validatorVersion: "vitest", basePayload: { ...basePayload, rows: [{ ...manifestRow, frozen: { ...(manifestRow.frozen as Record<string, unknown>), tampered: true } }] } })).rejects.toThrow(/canonical hash/);
    const first = await writePublicationManifest(db, { snapshotToken: "ddrpub:test:1", snapshotGeneration: 2, publishedAt: 200000, validatorVersion: "vitest", basePayload });
    expect(first).toMatchObject({ publicPredictionIds: [prediction.id], publicPredictionCount: 1, publicPredictionRowHashes: { [prediction.id]: prediction.rowHash } });
    expect(() => db.sqlite.prepare("UPDATE depeg_resolver_publication_snapshots_v2 SET validator_version = 'tampered' WHERE snapshot_token = ?").run(first.snapshotToken)).toThrow(/append-only/);
    const storage = row<{ base_payload_bytes: number; compressed_payload_bytes: number }>(db, "SELECT base_payload_bytes, compressed_payload_bytes FROM depeg_resolver_publication_snapshots_v2 WHERE snapshot_token = ?", first.snapshotToken);
    expect(storage.compressed_payload_bytes).toBeLessThan(storage.base_payload_bytes);
    await writePublicationManifest(db, { snapshotToken: "ddrpub:test:2", snapshotGeneration: 2, publishedAt: 200100, validatorVersion: "vitest", basePayload });
    expect(await loadFirstPublicationMembership(db, { publicPredictionIds: [prediction.id] })).toMatchObject([{ snapshotToken: "ddrpub:test:1" }]);
    expect(await loadLatestPublicationManifest(db)).toMatchObject({ snapshotToken: "ddrpub:test:2", snapshotSequence: 2, snapshotGeneration: 2, publicPredictionCount: 1, validatorVersion: "vitest" });
    expect(row<{ count: number }>(db, "SELECT COUNT(*) AS count FROM depeg_resolver_publication_snapshots")).toEqual({ count: 0 });
  }));

  it("chooses a valid legacy manifest, rejects malformed metadata, and propagates batch failures", async () => {
    await withSqliteD1(async (db) => {
      const compressed = await writePublicationManifest(db, { snapshotToken: "ddrpub:test:compressed", snapshotGeneration: 2, publishedAt: 200000, validatorVersion: "vitest", basePayload: { _meta: { publicPredictionIds: [], publicPredictionRowHashes: {} }, rows: [] } });
      db.sqlite.prepare(`INSERT INTO depeg_resolver_publication_snapshots (snapshot_token, snapshot_kind, snapshot_sequence, snapshot_generation, published_at, base_payload_hash, public_prediction_ids_hash, public_prediction_ids_json, public_prediction_row_hashes_json, base_payload_json, base_row_count, public_prediction_count, created_at) VALUES (?, 'ddr_public', 2, 2, ?, ?, ?, '[]', '{}', ?, 0, 0, ?)`).run("ddrpub:test:legacy", 200100, compressed.basePayloadHash, compressed.publicPredictionIdsHash, compressed.basePayloadJson, 200100);
      db.sqlite.prepare(`INSERT INTO depeg_resolver_publication_snapshot_finalizations (snapshot_token, finalized_at, validator_version, validated_base_payload_hash, validated_public_prediction_ids_hash, validated_public_prediction_row_hashes_json, validated_base_row_count, validated_public_prediction_count) VALUES (?, ?, 'vitest-legacy', ?, ?, '{}', 0, 0)`).run("ddrpub:test:legacy", 200100, compressed.basePayloadHash, compressed.publicPredictionIdsHash);
      expect(await loadLatestPublicationManifest(db)).toMatchObject({ snapshotToken: "ddrpub:test:legacy", validatorVersion: "vitest-legacy" });
      db.sqlite.exec("DROP TRIGGER trg_ddr_publication_snapshots_v2_no_delete");
      db.sqlite.prepare("DELETE FROM depeg_resolver_publication_snapshots_v2").run();
      expect(await loadLatestPublicationManifest(db)).toMatchObject({ snapshotToken: "ddrpub:test:legacy" });
    });
    const db = mockD1([{ match: "INSERT INTO depeg_resolver_publication_snapshots", rows: [], throwError: new Error("D1_ERROR: manifest batch failed") }], { requireMatch: true });
    await expect(writePublicationManifest(db, { snapshotToken: "ddrpub:test:empty", snapshotGeneration: 2, publishedAt: 200000, validatorVersion: "vitest", basePayload: { _meta: { publicPredictionIds: [], publicPredictionRowHashes: {} }, rows: [] } })).rejects.toThrow("D1_ERROR: manifest batch failed");
  });

  it("rejects malformed publication metadata and records deduplicated retry state", async () => withSqliteD1(async (db) => {
    const { prediction, incident } = await sealPredictionFixture(db);
    const raw = sealedPayloadWithHash(prediction.incidentKey).payload;
    const payload = { ...raw, prediction: { ...(raw.prediction as Record<string, unknown>), publicPredictionId: prediction.id, state: "frozen", publishedAt: 200000, publicationSnapshotToken: "ddrpub:test:bad-json", snapshotGeneration: 2 } };
    await writePublicationManifest(db, { snapshotToken: "ddrpub:test:bad-json", snapshotGeneration: 2, publishedAt: 200000, validatorVersion: "vitest", basePayload: { _meta: { publicPredictionIds: [prediction.id], publicPredictionRowHashes: { [prediction.id]: prediction.rowHash } }, rows: [payload] } });
    db.sqlite.exec("DROP TRIGGER trg_ddr_publication_snapshots_v2_no_update");
    const stored = row<{ base_payload_bytes: number }>(db, "SELECT base_payload_bytes FROM depeg_resolver_publication_snapshots_v2 WHERE snapshot_token = ?", "ddrpub:test:bad-json");
    db.sqlite.prepare("UPDATE depeg_resolver_publication_snapshots_v2 SET base_payload_bytes = ? WHERE snapshot_token = ?").run(stored.base_payload_bytes + 1, "ddrpub:test:bad-json");
    await expect(loadLatestPublicationManifest(db)).rejects.toThrow(/payload length mismatch/);
    db.sqlite.prepare("UPDATE depeg_resolver_publication_snapshots_v2 SET base_payload_bytes = 1 WHERE snapshot_token = ?").run("ddrpub:test:bad-json");
    await expect(loadLatestPublicationManifest(db)).rejects.toThrow(/declared uncompressed byte length/);
    db.sqlite.prepare("UPDATE depeg_resolver_publication_snapshots_v2 SET base_payload_bytes = ?, public_prediction_ids_json = ? WHERE snapshot_token = ?").run(stored.base_payload_bytes, "{}", "ddrpub:test:bad-json");
    await expect(loadLatestPublicationManifest(db)).rejects.toThrow(/publicPredictionIdsJson must be a JSON array/);

    const retry = { incidentKey: incident.incidentKey, eventId: 1, predictionPolicyVersion: "sticky-24h-v1", eligibleAt: 186400, runAt: 200000, action: "publication_retry_pending", reason: "manifest write failed", healthStatus: "healthy", runId: "ddr:test:publication-retry" } as const;
    await recordLockOpportunity(db, retry);
    await recordLockOpportunity(db, retry);
    expect(row<{ last_state: string }>(db, "SELECT last_state FROM depeg_resolver_prediction_lock_state WHERE incident_key = ?", incident.incidentKey)).toEqual({ last_state: "publication_retry_pending" });
    expect(row<{ count: number }>(db, "SELECT COUNT(*) AS count FROM depeg_resolver_lock_opportunity_audit WHERE incident_key = ? AND action = 'publication_retry_pending'", incident.incidentKey)).toEqual({ count: 1 });
  }));
});
