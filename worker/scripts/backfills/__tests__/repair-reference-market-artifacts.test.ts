import { afterEach, expect, it } from "vitest";
import { createLatestSchemaFixtureTracker } from "@shared/test-utils/latest-schema-sqlite";
import { REFERENCE_MARKET_RETIRED_EVENTS } from "@shared/data/depegs/reference-market-retired-events";
import { handleEvents } from "../../../src/api/events";
import { projectDepegOpened, projectDepegResolved } from "../../../src/lib/tape-projectors/depeg";
import { handleBackfillDEWS } from "../../../src/api/backfill-dews";
import { makeDepegRow } from "../../../src/test-helpers/__shared/fixtures";
import { seedPsiEvent, seedPsiPairedHistory } from "../../../src/api/__tests__/psi-replay.test-support";
import { handleRepairReferenceMarketArtifacts, psiReversalWrites, verifyReviewedPsiDelta } from "../repair-reference-market-artifacts";
import { REFERENCE_MARKET_RESTORATIONS } from "../repair-reference-market-artifacts-restorations";

const fixtures = createLatestSchemaFixtureTracker();
afterEach(() => { fixtures.closeAll(); });

const apply = "&dry-run=false&time-travel-bookmark=test-before-repair";
const run = (db: D1Database, params: string, reviewed: string | null = "integration-fixture") =>
  handleRepairReferenceMarketArtifacts({ db, url: new URL(`https://operator.invalid/?${params}`) }, reviewed);

it.each([
  { id: 89170, pegType: "peggedBRL", start: "2023-02-11T02:00:00Z", end: "2023-02-13T07:00:00Z",
    peak: 2653, startPrice: 1.136875, pegReference: 1, recoveryPrice: 1,
    admitted: ["2023-02-12T22:20:00Z", "2023-02-12T22:30:00Z"],
    straddled: ["2023-02-12T21:58:00Z", "2023-02-12T22:03:00Z"], reason: "severe-onset-uncertain" },
  { id: 90814, pegType: "peggedGOLD", start: "2026-10-30T17:02:47Z", end: "2026-10-31T13:46:28Z",
    peak: 160, startPrice: 3968.1082287455, pegReference: 3905.570022877781, recoveryPrice: 3874.120308574863,
    admitted: ["2026-10-30T20:00:00Z", "2026-10-30T20:55:00Z"],
    straddled: ["2026-10-30T20:58:00Z", "2026-10-30T21:02:00Z"], reason: "recovery-clock-unverified" },
])("annotates $reason without overwriting the recorded event or recovery", async (example) => {
  const { sqlite, db } = fixtures.open();
  const seconds = (iso: string) => Date.parse(iso) / 1000;
  const startedAt = seconds(example.start);
  const endedAt = seconds(example.end);
  const [fromSec, toSec] = example.admitted.map(seconds);
  const straddled = example.straddled.map(seconds);
  const archive = example.id === 90814
    ? { intervals: [[1793381480, 1793381480]], atParIntervals: [[1793452609, 1793454388]],
        lastObservationKind: "trusted-at-par", lastTrusted: 1793454388, gap: 1793382381 }
    : { intervals: [[fromSec!, toSec!], straddled], atParIntervals: [],
        lastObservationKind: "trusted-off-peg", lastTrusted: toSec!, gap: null };
  seedPsiEvent(sqlite, { ...makeDepegRow({ id: example.id, peg_type: example.pegType, direction: "above",
    started_at: startedAt, ended_at: endedAt, peak_deviation_bps: example.peak, start_price: example.startPrice,
    peg_reference: example.pegReference, recovery_price: example.recoveryPrice }), confirmation_sources: null, pending_reason: null });
  const { lastTrusted, gap, ...coverage } = archive;
  sqlite.prepare(`UPDATE depeg_events SET stablecoin_id = ?, price_coverage_json = ?, last_trusted_price_at = ?,
    price_coverage_gap_started_at = ?, close_reason = 'recovered-primary' WHERE id = ?`)
    .run(example.id === 90814 ? "xaut-tether" : "brz-transfero", JSON.stringify(coverage), lastTrusted, gap, example.id);
  const getRow = () => sqlite.prepare("SELECT * FROM depeg_events WHERE id = ?").get(example.id)!;
  const preImage = getRow();
  if (example.id === 90814) {
    const seedTape = sqlite.prepare(`INSERT INTO tape_events (event_id, type, severity, ts, ends_at, title, summary,
      payload_json, source_table, source_row_id, transition, created_at)
      VALUES (?, ?, 'warning', ?, ?, 'Event', '', ?, 'depeg_events', '90814', ?, 1)`);
    for (const transition of ["opened", "resolved"]) seedTape.run(`old-xaut-${transition}`, `depeg.${transition}`,
      (transition === "opened" ? startedAt : endedAt) * 1000, endedAt * 1000, JSON.stringify({ endedAt }), transition);
  }
  const query = `after=${startedAt - 86_400}&limit=1`;
  expect(await (await run(db, query)).json()).toMatchObject({ dryRun: true, results: [{
    status: "planned", coverage: [{ preImage, admittedCoverage: null,
      reasons: expect.arrayContaining([example.reason, "off-peg-coverage-unavailable"]) }],
  }] });
  expect(getRow()).toEqual(preImage);
  expect((await run(db, `${query}&dry-run=false`)).status).toBe(400);
  const blocked = await run(db, query + apply, null);
  expect(blocked.status).toBe(409);
  expect(await blocked.json()).toMatchObject({ results: [{ blockers: ["repair-reader-integration-unverified"] }] });
  expect(getRow()).toEqual(preImage);
  expect((await run(db, query + apply)).status).toBe(200);
  expect(getRow()).toEqual({ ...preImage, disposition: "admitted-coverage", admitted_coverage_json: null });
  if (example.id === 90814) {
    const readOpening = () => sqlite.prepare(`SELECT ends_at, json_extract(payload_json, '$.endedAt') AS endedAt,
      suppressed_at FROM tape_events WHERE transition = 'opened'`).get();
    expect(readOpening()).toEqual({ ends_at: null, endedAt: null, suppressed_at: null });
    expect(sqlite.prepare("SELECT suppression_reason FROM tape_events WHERE transition = 'resolved'").get())
      .toEqual({ suppression_reason: "depeg-claim-retracted" });
    sqlite.exec("DELETE FROM tape_events");
    expect((await projectDepegOpened(db, { since: startedAt - 1, until: endedAt + 1 })).projected).toBe(1);
    expect(readOpening()).toEqual({ ends_at: null, endedAt: null, suppressed_at: null });
    expect((await projectDepegResolved(db, { since: startedAt - 1, until: endedAt + 1 })).projected).toBe(0);
    const backtest = await handleBackfillDEWS({ db, url: new URL("https://operator.invalid/api/backfill-dews") });
    expect(await backtest.json()).toMatchObject({ events: [{ stablecoinId: "xaut-tether", startedAt }] });
  }
});

it.each(REFERENCE_MARKET_RESTORATIONS)("blocks $event.symbol restoration without the reviewed replay inputs", async ({ reopen, event, legacyPsi }) => {
  const { sqlite, db } = fixtures.open();
  const [{ day, previousScore, repairedScore }] = legacyPsi;
  seedPsiPairedHistory(sqlite, day);
  const marker = { version: "3.69", method: "replay-delta", previousScore };
  sqlite.prepare(`INSERT INTO stability_index (computed_at, score, band, components, input_snapshot, methodology_version)
    VALUES (?, ?, 'STEADY', '{}', ?, '3.69')`).run(day, repairedScore, JSON.stringify({ referenceMarketRepair: marker }));
  const readDay = () => sqlite.prepare("SELECT * FROM stability_index WHERE computed_at = ?").get(day);
  const preImage = readDay();
  for (const price of [event.startPrice, event.pegReference]) {
    sqlite.prepare(`INSERT INTO supply_history (stablecoin_id, snapshot_date, circulating_usd, price)
      VALUES (?, ?, 50000000, ?) ON CONFLICT(stablecoin_id, snapshot_date) DO UPDATE SET price = excluded.price`)
      .run(event.stablecoinId, day, price);
    const response = await run(db, `after=${reopen - 1}${apply}`);
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ results: [{ days: [],
      blockers: [`reviewed-psi-reversal-unavailable:${event.id}:${day}`] }] });
    expect(readDay()).toEqual(preImage);
    expect(sqlite.prepare("SELECT id FROM depeg_events WHERE id = ?").get(event.id)).toBeUndefined();
  }
});

it.each([-0.7, 0])("validates the original adjustment and applies only the isolated %s delta", (delta) => {
  const originalComponents = { severity: 8, breadth: 3, stressBreadth: 0, trend: 0 };
  const repairedComponents = { ...originalComponents, severity: 2 };
  const severity = delta === 0 ? 0 : 0.5;
  const breadth = delta === 0 ? 0 : 0.2;
  const review = { inputHash: "fixture", replayAt: 1, replayMethodologyVersion: "3.69",
    removedEvents: [], originalComponents, repairedComponents, delta: { score: delta, severity, breadth } };
  const marker = { previousScore: 89.5, repairedScore: 95.7 };
  const before = { score: 87.3, components: { ...originalComponents, severity: 9 } };
  const after = { score: 93.5, components: { ...repairedComponents, severity: 3 } };
  const isolated = { score: after.score + delta, components: { ...after.components, severity: 3 + severity, breadth: 3 + breadth } };
  expect(verifyReviewedPsiDelta(review, marker, before, after, isolated)).toEqual({
    score: delta === 0 ? 95.7 : 95, components: { ...repairedComponents, severity: 2 + severity, breadth: 3 + breadth },
  });
  expect(verifyReviewedPsiDelta(review, marker, before, after, { ...isolated, score: 92 })).toBeNull();
  expect(verifyReviewedPsiDelta(review, marker, { ...before, score: 90 }, after, isolated)).toBeNull();
});

it.each([false, true])("commits the daily and sample corrections together (sample changed: %s)", async (changed) => {
  const { sqlite, db } = fixtures.open();
  const { day } = REFERENCE_MARKET_RESTORATIONS[1].legacyPsi[0];
  const at = day + 900;
  const components = { severity: 4, breadth: 5, stressBreadth: 0, trend: 0 };
  const preImage = { id: 1, computed_at: day, score: 82, band: "STEADY", components: JSON.stringify(components),
    input_snapshot: JSON.stringify({ referenceMarketRepair: { method: "replay-delta", version: "3.69" } }),
    methodology_version: "3.69" };
  sqlite.prepare(`INSERT INTO stability_index (id, computed_at, score, band, components, input_snapshot, methodology_version)
    VALUES (1, ?, 82, 'STEADY', ?, ?, '3.69')`).run(day, preImage.components, preImage.input_snapshot);
  const sample = { stored_at: at, score: 70, band: "TREMOR", components: "{}", input_snapshot: "{}", methodology_version: "3.69" };
  sqlite.prepare(`INSERT INTO stability_index_samples (stored_at, score, band, components, input_snapshot, methodology_version)
    VALUES (?, 70, 'TREMOR', '{}', '{}', '3.69')`).run(at);
  const writes = psiReversalWrites(db, {
    preImage, day, eventId: 89640, score: 81, components, delta: -1, samplePreImages: [sample], sampleScores: { [at]: 79 },
  }, at + 120);
  if (changed) {
    sqlite.exec("UPDATE stability_index_samples SET score = 71");
    await expect(db.batch(writes)).rejects.toThrow();
    expect(sqlite.prepare("SELECT * FROM stability_index").get()).toEqual(preImage);
  } else {
    await db.batch(writes);
    const daily = sqlite.prepare("SELECT score, input_snapshot FROM stability_index").get()!;
    expect(daily.score).toBe(81);
    expect(JSON.parse(String(daily.input_snapshot))).toMatchObject({
      referenceMarketRepair: { method: "samples", version: "3.69", sampleScores: { [at]: 79 } },
      referenceMarketRestoration: { eventId: 89640 },
    });
    expect(sqlite.prepare("SELECT score FROM stability_index_samples").get()).toEqual({ score: 70 });
  }
});

it.each([true, false])("only marks fully verified artifact families (both linked: %s)", async (bothLinked) => {
  const { sqlite, db } = fixtures.open();
  const incident = "ddr2:69a72ad462b65c78d4b4c0bf97bb1d42";
  for (const id of [91043, 91048]) {
    seedPsiEvent(sqlite, { ...makeDepegRow({ id, stablecoin_id: "audd-novatti", peg_type: "peggedAUD",
      started_at: 1_794_657_600 + id - 91043, ended_at: 1_794_670_000 }), confirmation_sources: null, pending_reason: null });
    if (id === 91043 || bothLinked) sqlite.prepare(
      "INSERT INTO depeg_resolver_incident_event_links (incident_key, event_id, relation, linked_at) VALUES (?, ?, 'observed', 1)",
    ).run(incident, id);
  }
  const response = await run(db, `after=1794783599${apply}`);
  expect(response.status).toBe(bothLinked ? 200 : 409);
  expect(sqlite.prepare("SELECT id, disposition, admitted_coverage_json FROM depeg_events ORDER BY id").all())
    .toEqual([91043, 91048].map((id) => ({ id, disposition: bothLinked ? "repaired" : null, admitted_coverage_json: bothLinked ? "[]" : null })));
  expect(sqlite.prepare("SELECT COUNT(*) AS count FROM depeg_resolver_incident_event_links").get())
    .toEqual({ count: bothLinked ? 2 : 1 });
});

it("excludes an effective DEWS target when its first incident fragment was disputed", async () => {
  const { sqlite, db } = fixtures.open();
  const incident = "ddr2:69a72ad462b65c78d4b4c0bf97bb1d42";
  const clock = 1_794_657_600;
  for (const id of [91043, 91048]) {
    seedPsiEvent(sqlite, { ...makeDepegRow({ id, stablecoin_id: "audd-novatti", peg_type: "peggedAUD",
      started_at: clock + id - 91043, ended_at: clock + 3600 }), confirmation_sources: null, pending_reason: null });
    sqlite.prepare(`INSERT INTO depeg_resolver_incident_event_links (incident_key, event_id, relation, linked_at)
      VALUES (?, ?, 'observed', ?)`).run(incident, id, clock);
  }
  sqlite.prepare(`INSERT INTO depeg_resolver_incidents
    (incident_key, stablecoin_id, peg_currency, direction, first_event_id, current_event_id, first_started_at,
    current_started_at, first_observed_peak_bucket_bps, source_fingerprint, created_at, updated_at)
    VALUES (?, 'audd-novatti', 'AUD', 'below', 91043, 91048, ?, ?, 350, ?, ?, ?)`)
    .run(incident, clock, clock + 5, "f".repeat(64), clock, clock);
  sqlite.prepare(`INSERT INTO depeg_event_provenance (event_id, source_kind, audit_verdict, public_json, created_at, updated_at)
    VALUES (91043, 'live', 'confirmed', '{"auditVerdict":"disputed"}', ?, ?)`).run(clock, clock);
  const request = new Request("https://operator.invalid/api/backfill-dews");
  const response = await handleBackfillDEWS({ db, request, url: new URL(request.url) });
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({
    events: [], summary: { totalEvents: 0, excludedTargets: { auditIneligible: 1, onsetUnavailable: 0 } },
  });
});

it("keeps all reviewed removed archive IDs except the two restorations", () => {
  const ids = REFERENCE_MARKET_RETIRED_EVENTS.flatMap(([, members]) => members);
  expect(new Set(ids).size).toBe(344);
  expect(ids).not.toContain(24994);
  expect(ids).not.toContain(89640);
});

it("retracts bare and composite archive identities and hydrates only one closure page", async () => {
  const { sqlite, db } = fixtures.open();
  const insert = sqlite.prepare(`INSERT INTO tape_events
    (event_id, type, severity, ts, title, summary, payload_json, source_table, source_row_id, transition, created_at)
    VALUES (?, ?, 'warning', 1775995487000, 'Event', '', '{}', 'depeg_events', ?, ?, 1)`);
  insert.run("old-kag", "depeg.opened", "89582", "opened");
  insert.run("old-dgld", "depeg.opened", "89581", "opened");
  insert.run("old-kag-peak", "depeg.peak-worsened", "89582:300", "updated");
  insert.run("later-kau", "depeg.opened", "90520", "opened");
  const statements: Array<{ sql: string; binds: unknown[] }> = [];
  const watchingDb = { ...db, prepare(sql: string) {
    const stmt = db.prepare(sql);
    const bind = stmt.bind.bind(stmt);
    stmt.bind = (...binds) => { statements.push({ sql, binds }); return bind(...binds); };
    return stmt;
  } };
  const query = "after=1775952000&limit=1";
  expect(await (await run(watchingDb, query)).json()).toMatchObject({ results: [{
    tape: expect.arrayContaining(["old-kag", "old-dgld", "old-kag-peak"].map((event_id) => expect.objectContaining({
      preImage: expect.objectContaining({ event_id }), reason: "depeg-source-retired",
    }))),
  }] });
  const details = statements.filter(({ sql }) => sql.includes("SELECT t.*"));
  expect(details).toHaveLength(1);
  expect(String(details[0]!.binds[0])).not.toContain("90520");
  expect(statements.some(({ sql }) => sql.includes("FROM stability_index"))).toBe(false);
  expect((await run(db, query + apply)).status).toBe(200);
  const permalink = await handleEvents(db, new URL("https://operator.invalid/api/events?event=old-kag-peak"));
  expect(permalink.status).toBe(404);
  expect(await permalink.json()).toMatchObject({ reason: "depeg-claim-retracted" });
  expect(sqlite.prepare("SELECT event_id FROM tape_events WHERE suppressed_at IS NOT NULL ORDER BY event_id").all())
    .toEqual(["old-dgld", "old-kag", "old-kag-peak"].map((event_id) => ({ event_id })));
});
