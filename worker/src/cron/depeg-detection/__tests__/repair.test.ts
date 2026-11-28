import { afterEach, describe, expect, it } from "vitest";
import { createLatestSchemaFixtureTracker } from "@shared/test-utils/latest-schema-sqlite";
import { advanceDepegPriceCoverage } from "@shared/lib/depeg-price-coverage";
import { mergeDepegSeconds, mergeUnknownDepegSeconds } from "@shared/lib/peg-utils";
import { rowToDepegEvent, type DepegRow } from "../../../lib/depeg-helpers";
import { makeDepegRow } from "../../../test-helpers/__shared/fixtures";
import { buildDuplicateOpenEventRepair, buildOrphanCloseRepair } from "../repair";
import { applyHydratedEscalationMetadata, OPEN_DEPEG_EVENTS_HYDRATION_SELECT, type HydratedOpenEventRawRow } from "../escalation";
import { DDR_INCIDENT_REOPEN_MERGE_WINDOW_SEC } from "@shared/lib/depeg-config";
import { persistDepegCommands } from "../persistence";
import { seedOpenEvent } from "../../__tests__/detect-depegs.test-support";

const sqliteFixtures = createLatestSchemaFixtureTracker();
afterEach(() => sqliteFixtures.closeAll());

async function repairPersistedRows(rows: DepegRow[]) {
  const { sqlite, db } = sqliteFixtures.open();
  const ins = sqlite.prepare("INSERT INTO depeg_events (id, stablecoin_id, symbol, peg_type, direction, peak_deviation_bps, started_at, start_price, peak_price, peg_reference, source, price_coverage_json, last_trusted_price_at, price_coverage_gap_started_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)");
  for (const r of rows) ins.run(r.id, r.stablecoin_id, r.symbol, r.peg_type, r.direction, r.peak_deviation_bps, r.started_at, r.start_price, r.peak_price, r.peg_reference, r.source, r.price_coverage_json ?? null, r.last_trusted_price_at ?? null, r.price_coverage_gap_started_at ?? null);
  await persistDepegCommands(db, buildDuplicateOpenEventRepair(rows).commands);
  return (sqlite.prepare("SELECT * FROM depeg_events ORDER BY id").all() as unknown as DepegRow[]).map(rowToDepegEvent);
}

function makeOpenRow(overrides: Parameters<typeof makeDepegRow>[0] & { reviewed_disputed?: boolean } = {}): DepegRow & { reviewed_disputed?: boolean } {
  const { reviewed_disputed = false, ...rest } = overrides;
  return { ...makeDepegRow(rest), confirmation_sources: null, pending_reason: null, reviewed_disputed };
}

describe("buildDuplicateOpenEventRepair", () => {
  it.each(["first", "current", "link"] as const)("retains a duplicate referenced by an unsealed incident's %s reference", async (reference) => {
    const { sqlite, db } = sqliteFixtures.open();
    for (const [id, started_at, peak_deviation_bps] of [[1, 100, -200], [2, 200, -300], [3, 300, -250]]) seedOpenEvent(sqlite, { id, started_at, peak_deviation_bps });
    const key = "ddr2:00000000000000000000000000000001", first = reference === "first" ? 2 : 1, current = reference === "current" ? 2 : 1;
    for (const id of new Set([current, ...(reference === "link" ? [2] : [])])) sqlite.prepare("INSERT INTO depeg_resolver_incident_event_links (incident_key, event_id, relation, linked_at) VALUES (?, ?, 'observed', 300)").run(key, id);
    sqlite.prepare("INSERT INTO depeg_resolver_incidents (incident_key, stablecoin_id, peg_currency, direction, first_event_id, current_event_id, first_started_at, current_started_at, first_observed_peak_bucket_bps, source_fingerprint, created_at, updated_at) VALUES (?, 'usdt-tether', 'USD', 'below', ?, ?, ?, ?, 200, ?, 300, 300)").run(key, first, current, first === 2 ? 200 : 100, current === 2 ? 200 : 100, "a".repeat(64));
    const rows = (sqlite.prepare("SELECT * FROM depeg_events ORDER BY id").all() as unknown as DepegRow[]).map((r) => ({ ...r, reviewed_disputed: false }));
    await persistDepegCommands(db, buildDuplicateOpenEventRepair(rows).commands);
    expect(sqlite.prepare("SELECT id FROM depeg_events ORDER BY id").all()).toEqual([{ id: 1 }, { id: 2 }]);
    expect(sqlite.prepare("SELECT peak_deviation_bps FROM depeg_events WHERE id = 1").get()).toEqual({ peak_deviation_bps: -300 });
    expect(sqlite.prepare("SELECT first_event_id, current_event_id FROM depeg_resolver_incidents WHERE incident_key = ?").get(key)).toEqual({ first_event_id: first, current_event_id: current });
    expect(sqlite.prepare("SELECT COUNT(*) AS dangling FROM depeg_resolver_incident_event_links l LEFT JOIN depeg_events e ON e.id = l.event_id WHERE e.id IS NULL").get()).toEqual({ dangling: 0 });
  });

  it("unions duplicate trusted intervals without bridging gaps and preserves the earliest unresolved gap", async () => {
    const repaired = await repairPersistedRows([
      { ...makeOpenRow({ id: 3, started_at: 180 }), price_coverage_json: '{"intervals":[[650,650]]}', last_trusted_price_at: 650, price_coverage_gap_started_at: null },
      { ...makeOpenRow({ id: 1, started_at: 100 }), price_coverage_json: '{"intervals":[[100,200],[300,400]]}', last_trusted_price_at: 400, price_coverage_gap_started_at: 450 },
      { ...makeOpenRow({ id: 4, started_at: 200 }), price_coverage_json: '{"intervals":[]}', last_trusted_price_at: null, price_coverage_gap_started_at: 430 },
      { ...makeOpenRow({ id: 2, started_at: 150 }), price_coverage_json: '{"intervals":[[150,250],[500,600]]}', last_trusted_price_at: 600, price_coverage_gap_started_at: 480 },
    ]);
    expect(repaired.map((e) => e.id)).toEqual([1]);
    expect(mergeDepegSeconds(repaired, 0, 900)).toBe(350); expect(mergeUnknownDepegSeconds(repaired, 0, 900)).toBe(450);
    expect(repaired[0]!.priceCoverage).toMatchObject({ lastTrustedObservationAt: 650, gapStartedAt: 430 });
    const resumed = { ...repaired[0]!, priceCoverage: advanceDepegPriceCoverage(repaired[0]!.priceCoverage, 900, "trusted-off-peg") };
    expect(mergeDepegSeconds([resumed], 0, 900)).toBe(350); expect(mergeUnknownDepegSeconds([resumed], 0, 900)).toBe(450);
  });

  it("never re-imports a retained duplicate's superseded gap onto newer keeper coverage or resets its armed candidate", () => {
    const keeper = { ...makeOpenRow({ id: 1, started_at: 100 }), price_coverage_json: '{"intervals":[[100,250],[500,900]],"lastObservationKind":"trusted-off-peg"}', last_trusted_price_at: 900, peak_escalation_candidate_at: 900, peak_escalation_candidate_seen_at: 900 };
    const { commands, openEvents } = buildDuplicateOpenEventRepair([keeper, { ...makeOpenRow({ id: 2, started_at: 150 }), price_coverage_json: '{"intervals":[[150,250]]}', last_trusted_price_at: 250, price_coverage_gap_started_at: 300 }]);
    expect(commands.map((c) => c.type)).toEqual(["delete-event", "update-peak"]);
    expect(openEvents.get(keeper.stablecoin_id)).toMatchObject({ price_coverage_gap_started_at: null, peak_escalation_candidate_at: 900 });
  });

  it("retains known at-par intervals and their continuity across duplicate repair", async () => {
    const repaired = await repairPersistedRows([
      { ...makeOpenRow({ id: 1, started_at: 100 }), price_coverage_json: JSON.stringify({ intervals: [[100, 200]], atParIntervals: [[300, 400]], lastObservationKind: "trusted-at-par" }), last_trusted_price_at: 400, price_coverage_gap_started_at: 300 },
      { ...makeOpenRow({ id: 2, started_at: 150 }), price_coverage_json: JSON.stringify({ intervals: [[150, 250]], atParIntervals: [[350, 500]], lastObservationKind: "trusted-at-par" }), last_trusted_price_at: 500, price_coverage_gap_started_at: 350 },
    ]);
    expect(mergeDepegSeconds(repaired, 0, 600)).toBe(150); expect(mergeUnknownDepegSeconds(repaired, 0, 600)).toBe(150);
    const resumed = { ...repaired[0]!, priceCoverage: advanceDepegPriceCoverage(repaired[0]!.priceCoverage, 600, "trusted-at-par") };
    expect(mergeDepegSeconds([resumed], 0, 600)).toBe(150); expect(mergeUnknownDepegSeconds([resumed], 0, 600)).toBe(50);
  });

  it.each([false, true])("keeps legacy duplicate spans unknown when later duplicate instrumentation is %s", async (instrumented) => {
    const later = makeOpenRow({ id: 2, started_at: 200 });
    if (instrumented) { later.price_coverage_json = '{"intervals":[[200,300]]}'; later.last_trusted_price_at = 300; }
    const repaired = await repairPersistedRows([later, makeOpenRow({ id: 1, started_at: 50 })]);
    expect(repaired.map((e) => e.id)).toEqual([1]); expect(repaired[0]!.startedAt).toBe(50); expect(repaired[0]!.endedAt).toBeNull();
    expect(mergeDepegSeconds(repaired, 0, 500)).toBe(instrumented ? 100 : 0); expect(mergeUnknownDepegSeconds(repaired, 0, 500)).toBe(instrumented ? 350 : 450);
  });

  it("does not absorb a native-domain peak onto a USD-domain keeper", () => {
    const result = buildDuplicateOpenEventRepair([
      makeOpenRow({ id: 1, stablecoin_id: "pht-pht", symbol: "PHT", peg_type: "peggedPHP", direction: "below", peak_deviation_bps: -159, peak_price: 0.9841, peg_reference: 1, started_at: 100 }),
      makeOpenRow({ id: 2, stablecoin_id: "pht-pht", symbol: "PHT", peg_type: "peggedPHP", direction: "below", peak_deviation_bps: -400, peak_price: 0.0162, peg_reference: 0.016472576, started_at: 200 }),
    ]);
    expect(result.openEvents.get("pht-pht")).toMatchObject({ id: 1, peak_deviation_bps: -159, peak_price: 0.9841 });
    expect(result.commands).toEqual([{ type: "delete-event", id: 2 }, { type: "update-peak", id: 1, peakDeviationBps: -159, peakPrice: 0.9841 }]);
  });

  it("keeps the deeper paired gold peak and its receipt across a change in opening reference", async () => {
    const { sqlite, db } = sqliteFixtures.open();
    const gold = { stablecoin_id: "paxg-paxos", symbol: "PAXG", peg_type: "peggedGOLD", direction: "below", peak_quote_domain: "usd" } as const;
    const observation = { basis: "benchmark", price: 102, pegReference: 120, observedAt: 210, bps: -1500 };
    const first = { ...makeOpenRow(), ...gold, id: 1, started_at: 100, peg_reference: 100, peak_price: 98, peak_deviation_bps: -200, peak_peg_reference: 100 };
    const second = { ...first, id: 2, started_at: 200, peg_reference: 115, peak_price: 102, peak_deviation_bps: -1500, peak_peg_reference: 120, peer_basis_json: JSON.stringify({ peak: observation }) };
    const { reviewed_disputed: _d1, ...firstRow } = first;
    const { reviewed_disputed: _d2, ...secondRow } = second;
    seedOpenEvent(sqlite, firstRow);
    seedOpenEvent(sqlite, secondRow);
    const result = buildDuplicateOpenEventRepair([first, second]);
    await persistDepegCommands(db, result.commands);
    const stored = sqlite.prepare("SELECT peak_price, peak_peg_reference, peak_quote_domain, peer_basis_json FROM depeg_events WHERE id=1").get();
    expect(stored).toMatchObject({ peak_price: 102, peak_peg_reference: 120, peak_quote_domain: "usd" });
    expect(JSON.parse(String(stored?.peer_basis_json))).toEqual({ peak: observation });
    expect(result.openEvents.get(gold.stablecoin_id)?.peer_basis_json).toBe(stored?.peer_basis_json);
  });

  it("does not absorb a peak measured against a drifted reference", () => {
    const result = buildDuplicateOpenEventRepair([
      makeOpenRow({ id: 1, stablecoin_id: "kag-kinesis", symbol: "KAG", peg_type: "peggedGOLD", direction: "below", peak_deviation_bps: -632, peak_price: 58.42, peg_reference: 58.797, started_at: 100 }),
      makeOpenRow({ id: 2, stablecoin_id: "kag-kinesis", symbol: "KAG", peg_type: "peggedGOLD", direction: "below", peak_deviation_bps: -1190, peak_price: 55.42, peg_reference: 62.52, started_at: 200 }),
    ]);
    expect(result.openEvents.get("kag-kinesis")).toMatchObject({ id: 1, peak_deviation_bps: -632, peak_price: 58.42 });
    expect(result.commands).toEqual([{ type: "delete-event", id: 2 }, { type: "update-peak", id: 1, peakDeviationBps: -632, peakPrice: 58.42 }]);
  });

  it("does not absorb a peak when either row has no usable reference", () => {
    const result = buildDuplicateOpenEventRepair([
      makeOpenRow({ id: 1, peak_deviation_bps: -150, peak_price: 0.985, peg_reference: 0, started_at: 100 }),
      makeOpenRow({ id: 2, peak_deviation_bps: -300, peak_price: 0.97, peg_reference: 1, started_at: 200 }),
    ]);
    expect(result.openEvents.get("usdt-tether")).toMatchObject({ id: 1, peak_deviation_bps: -150, peak_price: 0.985 });
    expect(result.commands).toEqual([{ type: "delete-event", id: 2 }, { type: "update-peak", id: 1, peakDeviationBps: -150, peakPrice: 0.985 }]);
  });

  it("closes stale opposite-direction rows instead of absorbing their peak", () => {
    const result = buildDuplicateOpenEventRepair([
      makeOpenRow({ id: 1, direction: "below", peak_deviation_bps: -150, peak_price: 0.985, started_at: 100 }),
      makeOpenRow({ id: 2, direction: "below", peak_deviation_bps: -300, peak_price: 0.97, started_at: 200 }),
      makeOpenRow({ id: 3, direction: "above", peak_deviation_bps: 400, peak_price: 1.04, started_at: 300 }),
    ]);
    expect(result.openEvents.get("usdt-tether")).toMatchObject({ id: 3, direction: "above", peak_deviation_bps: 400, peak_price: 1.04 });
    expect(result.commands).toEqual([
      { type: "delete-event", id: 2 },
      { type: "update-peak", id: 1, peakDeviationBps: -300, peakPrice: 0.97, peakPegReference: null, peakQuoteDomain: null },
      { type: "close-event", id: 1, endedAt: 300, recoveryPrice: null, closeReason: "superseded-direction" },
    ]);
    // Clean older row + disputed newer opposite-direction row must defer close rather than emit endedAt <= started_at.
    const newerDisputed = buildDuplicateOpenEventRepair([
      makeOpenRow({ id: 1, direction: "below", started_at: 100 }),
      makeOpenRow({ id: 2, direction: "above", started_at: 200, reviewed_disputed: true }),
    ]);
    expect(newerDisputed.openEvents.get("usdt-tether")?.id).toBe(1);
    expect(newerDisputed.commands).toEqual([]);
  });

  it("enforces clean keeper selection, unverified deferral, disputed exclusion, protected-duplicate no-op, and indeterminate onset", async () => {
    const { sqlite, db } = sqliteFixtures.open();
    const t0 = 1_800_000_000, D = 86_400;
    const covJson = (at: number) => JSON.stringify({ intervals: [[t0 - 35 * D, at]], lastObservationKind: "trusted-off-peg" });
    seedOpenEvent(sqlite, { id: 1, started_at: t0 - 40 * D, peak_deviation_bps: -200, peak_price: 0.98, peak_escalation_anchor_bps: 300, peak_escalated_at: t0 - 5 * D, peak_escalation_candidate_at: t0, peak_escalation_candidate_seen_at: t0, price_coverage_json: covJson(t0), last_trusted_price_at: t0 });
    seedOpenEvent(sqlite, { id: 2, started_at: t0 - 39 * D, peak_deviation_bps: -900, peak_price: 0.91, peak_escalation_anchor_bps: 550, peak_escalated_at: t0 - 2 * D, peak_escalation_candidate_at: t0 + 200, peak_escalation_candidate_seen_at: t0 + 200 });
    seedOpenEvent(sqlite, { id: 3, started_at: t0 - 38 * D, peak_deviation_bps: -950, peak_price: 0.905, peak_escalation_anchor_bps: 900, peak_escalated_at: t0 - D, disposition: "repaired", admitted_coverage_json: "[]", price_coverage_json: covJson(t0 + 600), last_trusted_price_at: t0 + 600 });
    // Unverified duplicates (base fallback), even with null escalation columns, must defer coverage merge and deletion.
    const raw = sqlite.prepare("SELECT * FROM depeg_events WHERE id IN (1, 2) ORDER BY id").all() as unknown as DepegRow[];
    expect(buildDuplicateOpenEventRepair(raw).commands).toEqual([]);
    const rawNullEsc = [{ ...raw[0]!, peak_escalation_anchor_bps: null, peak_escalated_at: null }, { ...raw[1]!, peak_escalation_anchor_bps: null, peak_escalated_at: null, price_coverage_json: covJson(t0 + 600), last_trusted_price_at: t0 + 600 }];
    expect(buildDuplicateOpenEventRepair(rawNullEsc).commands).toEqual([]);
    const hydrated = (sqlite.prepare(OPEN_DEPEG_EVENTS_HYDRATION_SELECT).all(DDR_INCIDENT_REOPEN_MERGE_WINDOW_SEC, DDR_INCIDENT_REOPEN_MERGE_WINDOW_SEC, 200) as unknown as HydratedOpenEventRawRow[]).map(applyHydratedEscalationMetadata);
    expect([...hydrated].sort((a, b) => a.id - b.id).map((r) => [r.id, r.reviewed_disputed])).toEqual([[1, false], [2, false], [3, true]]);
    const r1 = hydrated.find((r) => r.id === 1)!, r2 = hydrated.find((r) => r.id === 2)!, r3 = hydrated.find((r) => r.id === 3)!;
    // Disputed earliest row must never delete a younger clean row; all-disputed defers destructive repair.
    const disputedFirst = buildDuplicateOpenEventRepair([{ ...r3, started_at: t0 - 50 * D }, { ...r1 }]);
    expect(disputedFirst.openEvents.get("usdt-tether")).toMatchObject({ id: 1, peak_deviation_bps: -200, last_trusted_price_at: t0, peak_escalated_at: t0 - 5 * D });
    expect(disputedFirst.commands).toEqual([{ type: "delete-event", id: 3 }]);
    expect(buildDuplicateOpenEventRepair([{ ...r3 }, { ...r3, id: 4, started_at: t0 - 37 * D }]).commands).toEqual([]);
    // Disputed duplicate must not copy coverage or peak, and unchanged evidence preserves keeper's armed candidate (retained protected dupe no-op).
    const disputedOnly = buildDuplicateOpenEventRepair([{ ...r1 }, { ...r3 }]);
    expect(disputedOnly.openEvents.get("usdt-tether")).toMatchObject({ id: 1, last_trusted_price_at: t0, peak_deviation_bps: -200, peak_escalation_candidate_at: t0, peak_escalation_candidate_seen_at: t0 });
    expect(disputedOnly.commands).toEqual([{ type: "delete-event", id: 3 }]);
    const sameEvidence = buildDuplicateOpenEventRepair([{ ...r1 }, { ...r1, id: 9, started_at: t0 - 39 * D, incident_started_at: t0 - 50 * D, carry_forward_escalation_anchor_bps: 400 }]);
    expect(sameEvidence.openEvents.get("usdt-tether")).toMatchObject({ peak_escalation_candidate_at: t0, peak_escalation_candidate_seen_at: t0 });
    expect(sameEvidence.commands.some((c) => c.type === "update-escalation" || c.type === "record-price-coverage")).toBe(false);
    // Indeterminate keeper (incident_started_at undefined) must never inherit a younger duplicate's onset.
    expect(buildDuplicateOpenEventRepair([{ ...r1, incident_started_at: undefined }, { ...r2, started_at: t0 - 5 * D, incident_started_at: t0 - 5 * D }]).openEvents.get("usdt-tether")?.incident_started_at).toBeUndefined();
    const result = buildDuplicateOpenEventRepair(hydrated);
    expect(result.commands).toContainEqual({ type: "update-escalation", id: 1, peakEscalatedAt: t0 - 2 * D, peakEscalationAnchorBps: 550, peakEscalationCandidateAt: null, peakEscalationCandidateSeenAt: null });
    await persistDepegCommands(db, result.commands);
    expect(sqlite.prepare("SELECT id, peak_deviation_bps, peak_escalated_at, peak_escalation_anchor_bps, peak_escalation_candidate_at, peak_escalation_candidate_seen_at FROM depeg_events ORDER BY id").all())
      .toEqual([{ id: 1, peak_deviation_bps: -900, peak_escalated_at: t0 - 2 * D, peak_escalation_anchor_bps: 550, peak_escalation_candidate_at: null, peak_escalation_candidate_seen_at: null }]);
  });
});

describe("buildOrphanCloseRepair", () => {
  it("closes untracked orphan events and reports the repair", () => {
    const result = buildOrphanCloseRepair({
      rows: [{ id: 10, stablecoin_id: "retired-coin", started_at: 100 }, { id: 11, stablecoin_id: "usdt-tether", started_at: 100 }, { id: 12, stablecoin_id: "new-coin", started_at: 500 }],
      seenEventIds: new Set(), syncStart: 500, trackedCoinIds: new Set(["usdt-tether"]), now: 1_000,
    });
    expect(result.commands).toEqual([{ type: "close-event", id: 10, endedAt: 1_000, recoveryPrice: null, closeReason: "orphan-tracking-removed" }]);
    expect(result.diagnostics).toEqual([{ level: "log", message: "[depeg] Closing orphan event for retired-coin (id=10)" }]);
  });
});
