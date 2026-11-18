import { afterEach, describe, it, expect, vi } from "vitest";
import { createLatestSchemaFixtureTracker } from "@shared/test-utils/latest-schema-sqlite";
import { mockD1, type MockD1Database } from "@shared/test-utils/mock-d1";
import { makeApiRequest, makeApiUrl, readJsonResponse, stubCryptoForAuth } from "../../../src/test-helpers/__shared/auth";
import { handleBackfillTape } from "../backfill-tape";
import { TAPE_PROJECTOR_JOBS } from "../../../src/lib/tape-projectors/registry";
import { projectDepegOpened, projectDepegPeakWorsened, projectDepegResolved } from "../../../src/lib/tape-projectors/depeg";
import { handleBackfillDEWS } from "../../../src/api/backfill-dews";
import { buildInsertDepegEventStmt } from "../../../src/lib/depeg-helpers";
import { getConditionBand } from "@shared/lib/psi-policy";

stubCryptoForAuth();
const fixtures = createLatestSchemaFixtureTracker();

afterEach(() => {
  vi.restoreAllMocks();
  fixtures.closeAll();
});

function emptyDb(): MockD1Database {
  return mockD1([
    ...[
      "FROM cache WHERE key",
      "ended_at IS NULL",
      "started_at > ?",
      "ended_at IS NOT NULL AND ended_at > ?",
      "ended_at > ? AND source = 'live'",
      "FROM blacklist_events",
      "FROM mint_burn_events",
      "FROM mint_burn_admission",
      "FROM mint_burn_publication_policy",
      "pharos:mint-burn-scan-coverage:read",
      "pharos:mint-burn-legacy-evidence",
      "FROM stress_signals",
      "FROM stability_index_samples",
      "FROM yield_history",
      "FROM yield_source_decisions",
      "FROM safety_score_history_v2",
      "FROM safety_grade_history",
    ].map((match) => ({ match, rows: [] })),
    { match: "SELECT 1 AS observed", rows: [{ observed: 1 }] },
  ]);
}

describe("handleBackfillTape", () => {
  it("honors query window and cap over conflicting JSON body integers", async () => {
    const job = TAPE_PROJECTOR_JOBS[0]!;
    const run = vi.spyOn(job, "run").mockResolvedValue({ projected: 0, advanced: null });
    const path = `/api/backfill-tape?class=${job.name}&since=200&until=300&maxRows=1`;
    const res = await handleBackfillTape({
      db: emptyDb(), url: makeApiUrl(path),
      request: new Request(makeApiUrl(path), { method: "POST", body: JSON.stringify({ since: 100, until: 400, maxRows: 5000 }) }),
    });
    expect(await readJsonResponse(res, 200)).toMatchObject({ since: 200, until: 300, maxRows: 1 });
    expect(run).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ since: 200, until: 300, maxRows: 1 }));
  });

  it("rejects an over-budget maxRows with 400", async () => {
    const res = await handleBackfillTape({ db: emptyDb(), url: makeApiUrl("/api/backfill-tape?maxRows=999999"), trustedAdmin: true, request: makeApiRequest("/api/backfill-tape?maxRows=999999", { method: "POST", adminKey: "secret" }) });
    expect(res.status).toBe(400);
  });

  it("filters the run to the explicit class list", async () => {
    const res = await handleBackfillTape({ db: emptyDb(), url: makeApiUrl("/api/backfill-tape?class=depeg.opened&class=score.upgraded&dryRun=true"), trustedAdmin: true, request: makeApiRequest("/api/backfill-tape?class=depeg.opened&class=score.upgraded&dryRun=true", {
        method: "POST",
        adminKey: "secret",
      }) });
    const body = (await readJsonResponse(res, 200)) as { selectedClasses: string[] };
    expect(body.selectedClasses).toEqual(["depeg.opened", "score.upgraded"]);
  });

  it("returns a non-success status when a selected projector fails", async () => {
    const job = TAPE_PROJECTOR_JOBS[0]!;
    vi.spyOn(job, "run").mockRejectedValueOnce(new Error("projector unavailable"));
    const path = `/api/backfill-tape?class=${encodeURIComponent(job.name)}&dryRun=true`;

    const res = await handleBackfillTape({ db: emptyDb(), url: makeApiUrl(path), trustedAdmin: true, request: makeApiRequest(path, { method: "POST", adminKey: "secret" }) });
    const body = (await readJsonResponse(res, 500)) as {
      ok: boolean;
      errors: Array<{ name: string; message: string }>;
      projected: number;
    };

    expect(body.ok).toBe(false);
    expect(body.projected).toBe(0);
    expect(body.errors).toEqual([{ name: job.name, message: "projector unavailable" }]);
  });

  it.each([false, true])("includes the successor in correction replay when retained (%s)", async (hasSuccessor) => {
    const { db, sqlite } = fixtures.open();
    const day = Date.parse("2026-11-16T00:00:00Z") / 1000;
    const changedAt = day + 900;
    const after = day + 1800;
    const sample = sqlite.prepare(`INSERT INTO stability_index_samples
      (stored_at, score, band, components, input_snapshot) VALUES (?, ?, ?, '{}', '{}')`);
    sample.run(day, 90, getConditionBand(90));
    sample.run(changedAt, 60, getConditionBand(60));
    if (hasSuccessor) sample.run(after, 90, getConditionBand(90));
    const job = TAPE_PROJECTOR_JOBS.find(({ name }) => name === "psi.band_changed")!;
    await job.run(db, { since: day, until: after });
    sqlite.prepare(`INSERT INTO stability_index (computed_at, score, band, components, input_snapshot)
      VALUES (?, 90, 'STEADY', '{}', ?)`).run(day, JSON.stringify({
      referenceMarketRepair: { method: "samples", sampleScores: { [changedAt]: 90 } },
    }));
    const url = makeApiUrl(`/api/backfill-tape?class=psi.band_changed&reconcilePsiRepairs=true&since=${day}&until=${changedAt}&maxRows=1`);
    const result = await handleBackfillTape({ db, url });
    expect(await readJsonResponse(result, 200)).toMatchObject({
      pendingReason: hasSuccessor ? null : "psi-sample-pair-unavailable",
    });
    expect(sqlite.prepare("SELECT ts, suppression_reason FROM tape_events ORDER BY ts").all())
      .toEqual(hasSuccessor ? [changedAt, after].map((at) => ({ ts: at * 1000, suppression_reason: "psi-sample-corrected" }))
        : [{ ts: changedAt * 1000, suppression_reason: null }]);
  });

  it.each([null, "disputed", "reviewed-conflict", "repaired"])("writes eligible Tape claims only (disposition %s)", async (disposition) => {
    const { db, sqlite } = fixtures.open();
    vi.spyOn(Date, "now").mockReturnValue(1730000000000);
    sqlite.exec(`INSERT INTO depeg_events
      (stablecoin_id, symbol, peg_type, direction, peak_deviation_bps, started_at, start_price, peg_reference)
      VALUES ('usdt-tether', 'USDT', 'peggedUSD', 'below', -200, 1730000000, 0.98, 1)`);
    if (disposition === "disputed") sqlite.exec(`INSERT INTO depeg_event_provenance
      (event_id, source_kind, audit_verdict, created_at, updated_at) VALUES (1, 'live', 'disputed', 1, 1)`);
    if (disposition === "reviewed-conflict") sqlite.exec(`INSERT INTO depeg_event_provenance
      (event_id, source_kind, audit_verdict, public_json, created_at, updated_at)
      VALUES (1, 'live', 'confirmed', '{"auditVerdict":"disputed"}', 1, 1)`);
    if (disposition === "repaired") sqlite.exec("UPDATE depeg_events SET disposition = 'repaired', admitted_coverage_json = '[]'");
    for (const dryRun of [true, false]) {
      const url = makeApiUrl(`/api/backfill-tape?class=depeg.opened&dryRun=${dryRun}`);
      const res = await handleBackfillTape({ db, url });
      expect(await readJsonResponse(res, 200)).toMatchObject({ projected: disposition == null ? 1 : 0 });
      expect(sqlite.prepare("SELECT source_row_id FROM tape_events").all())
        .toEqual(dryRun || disposition != null ? [] : [{ source_row_id: "1" }]);
      if (disposition == null) expect(sqlite.prepare("SELECT key, value FROM cache").all())
        .toEqual(dryRun ? [] : [{ key: "tape-projector:cursor:depeg.opened", value: "1730000000" }]);
    }
  });

  it.each([0, 600])("uses the at-par observation when the close was recorded %s seconds later", async (lag) => {
    const { db, sqlite } = fixtures.open();
    const start = 1730000000;
    const end = start + 3600;
    const observed = end - lag;
    vi.spyOn(Date, "now").mockReturnValue(end * 1000);
    sqlite.prepare(`INSERT INTO depeg_events (stablecoin_id, symbol, peg_type, direction, peak_deviation_bps,
      started_at, ended_at, start_price, recovery_price, peg_reference, recovery_peg_reference,
      price_coverage_json, last_trusted_price_at, admitted_coverage_json, close_reason)
      VALUES ('usdt-tether', 'USDT', 'peggedUSD', 'below', -200, ?, ?, 0.98, 1, 1, 1, ?, ?, ?, 'recovered-primary')`)
      .run(start, end, JSON.stringify({ intervals: [[start, start + 60]], atParIntervals: [[observed, observed]] }), observed,
        JSON.stringify([{ fromSec: start, toSec: start + 60 }]));
    const res = await handleBackfillTape({ db, url: makeApiUrl("/api/backfill-tape?class=depeg.resolved") });
    expect(await readJsonResponse(res, 200)).toMatchObject({ projected: 1 });
    const claim = sqlite.prepare("SELECT event_id, ts, ends_at, json_extract(payload_json, '$.endedAt') AS endedAt FROM tape_events");
    const eventId = claim.get()!.event_id;
    expect(claim.get()).toEqual({ event_id: eventId, ts: observed * 1000, ends_at: observed * 1000, endedAt: observed });
    if (lag > 0) {
      sqlite.prepare("UPDATE tape_events SET ts = ?, ends_at = ?, event_id = 'existing-permalink'").run(end * 1000, end * 1000);
      expect(await projectDepegResolved(db)).toMatchObject({ projected: 1 });
      expect(await projectDepegResolved(db)).toMatchObject({ projected: 0 });
      expect(claim.get()).toEqual({ event_id: "existing-permalink", ts: observed * 1000, ends_at: observed * 1000, endedAt: observed });
    }
  });

  it.each([[null, 1, true], [0.99, 1, false], [1, null, false]])(
    "qualifies the recovery independently of a suppressed opening (price %s, reference %s)",
    async (recoveryPrice, recoveryReference, expected) => {
      const { db, sqlite } = fixtures.open();
      const start = Date.parse("2026-11-14T15:00:00Z") / 1000;
      const end = Date.parse(recoveryPrice === 0.99 ? "2026-11-14T16:00:00Z" : "2026-11-16T15:00:00Z") / 1000;
      sqlite.prepare(`INSERT INTO depeg_events (stablecoin_id, symbol, peg_type, direction, peak_deviation_bps,
        started_at, ended_at, start_price, recovery_price, peg_reference, recovery_peg_reference,
        price_coverage_json, last_trusted_price_at, close_reason)
        VALUES ('audd-novatti', 'AUDD', 'peggedAUD', 'below', -200, ?, ?, 0.98, ?, 1, ?, ?, ?, 'recovered-primary')`)
        .run(start, end, recoveryPrice ?? 1, recoveryReference, JSON.stringify({
          intervals: [[end - 900, end - 900]], atParIntervals: [[end, end]],
        }), end);
      sqlite.prepare(`INSERT INTO tape_events (event_id, type, severity, ts, title, summary, payload_json,
        source_table, source_row_id, transition, methodology_version, created_at, suppressed_at, suppression_reason)
        VALUES ('retained-opening', 'depeg.opened', 'notice', ?, 'AUDD opened', 'held', '{}',
        'depeg_events', '1', 'opened', '6.47', ?, ?, 'depeg-claim-retracted')`).run(start * 1000, end, end);
      const options = { since: end - 1, until: end };
      expect(await projectDepegResolved(db, options)).toMatchObject({ projected: expected ? 1 : 0 });
      expect(await projectDepegResolved(db, options)).toMatchObject({ projected: 0 });
      expect(sqlite.prepare("SELECT event_id FROM tape_events WHERE suppressed_at IS NOT NULL").get())
        .toEqual({ event_id: "retained-opening" });
    },
  );

  it("fills capped pages through held rows and retains the reviewed BRZ opening in Tape and DEWS", async () => {
    const { db, sqlite } = fixtures.open();
    const brz = 1794678383;
    const insert = sqlite.prepare(`INSERT INTO depeg_events (id, stablecoin_id, symbol, peg_type, direction, peak_deviation_bps,
      started_at, ended_at, start_price, peg_reference, confirmation_sources)
      VALUES (?, ?, 'TEST', ?, 'below', -5000, ?, ?, 0.5, 1, ?)`);
    insert.run(91042, "brla-brla-digital", "peggedBRL", brz - 100, brz + 100, null);
    insert.run(91044, "brz-transfero", "peggedBRL", brz, brz + 200, "temporal:15m+native:brl+pool:curve:dl+pool:curve:cg_onchain");
    insert.run(91045, "usdt-tether", "peggedUSD", brz + 100, brz + 400, null);
    const options = { since: brz - 200, until: brz + 300, maxRows: 1 };
    for (const id of ["91044", "91045"]) {
      expect(await projectDepegOpened(db, options)).toMatchObject({ projected: 1 });
      expect(sqlite.prepare("SELECT source_row_id FROM tape_events ORDER BY ts DESC LIMIT 1").get()).toEqual({ source_row_id: id });
    }
    expect(await projectDepegOpened(db, options)).toMatchObject({ projected: 0 });
    expect(await readJsonResponse(await handleBackfillDEWS({ db, url: makeApiUrl("/api/backfill-dews") }), 200))
      .toMatchObject({ events: [{ stablecoinId: "brz-transfero", startedAt: brz }, { stablecoinId: "usdt-tether" }],
        summary: { totalEvents: 2, excludedTargets: { onsetUnavailable: 1 } } });
  });

  it.each([false, true])("uses the clocked OR-2 onset independently of the later confirmation (%s)", async (clocked) => {
    const { db, sqlite } = fixtures.open();
    const start = Date.parse("2026-11-14T15:00:00Z") / 1000;
    const end = start + 3600;
    const receipt = JSON.stringify({ onset: {
      basis: "peer-relative", observedAt: start, price: 0.98, pegReference: 1, bps: -200,
      corroboration: {
        basis: "peer-relative", confidence: "low", quoteObservedAt: start - 30,
        contributors: ["a", "b", "c"].map((id) => ({ id, provenanceKey: id, observedAtSec: clocked ? start - 15 : start + 86400 })),
        corroborator: { source: "pool:curve:defillama", observedAtSec: clocked ? start - 15 : start + 86400 },
      },
    } });
    await buildInsertDepegEventStmt(db, {
      id: 0, stablecoinId: "audd-novatti", symbol: "AUDD", pegType: "peggedAUD", direction: "below",
      peakDeviationBps: -200, startedAt: start, endedAt: null, startPrice: 0.98, peakPrice: 0.98,
      recoveryPrice: null, pegReference: 1, source: "live", pendingReason: "low-confidence+peer-relative",
      closeReason: null, provenance: null,
      confirmationSources: "temporal:15m+pool:curve",
      priceCoverage: { intervals: [[start, start + 900]], lastTrustedObservationAt: start + 900, gapStartedAt: null },
    }, receipt).run();
    sqlite.exec(`INSERT INTO cache (key, value, updated_at) VALUES ('tape-projector:peak-worsened-seen', '{"1":100}', 1)`);
    const options = { since: start - 1, until: end };
    expect(await projectDepegOpened(db, options)).toMatchObject({ projected: clocked ? 1 : 0 });
    expect(await projectDepegPeakWorsened(db, options)).toMatchObject({ projected: clocked ? 1 : 0 });
    sqlite.prepare("UPDATE depeg_events SET ended_at = ? WHERE id = 1").run(end);
    expect(await readJsonResponse(await handleBackfillDEWS({ db, url: makeApiUrl("/api/backfill-dews") }), 200))
      .toMatchObject({ events: clocked ? [{ startedAt: start }] : [], summary: { totalEvents: clocked ? 1 : 0 } });
  });

  it.each([
    ["opened", projectDepegOpened],
    ["resolved", projectDepegResolved],
    ["updated", projectDepegPeakWorsened],
  ] as const)("rechecks reviewed evidence before inserting a %s claim", async (transition, project) => {
    const { db, sqlite } = fixtures.open();
    const start = 1730000000;
    const end = start + 3600;
    sqlite.prepare(`INSERT INTO depeg_events (id, stablecoin_id, symbol, peg_type, direction, peak_deviation_bps,
      started_at, ended_at, start_price, recovery_price, peg_reference, close_reason)
      VALUES (1, 'usdt-tether', 'USDT', 'peggedUSD', 'below', -200, ?, ?, 0.98, 1, 1, ?)`)
      .run(start, transition === "updated" ? null : end, transition === "updated" ? null : "recovered-primary");
    sqlite.exec(`INSERT INTO cache (key, value, updated_at) VALUES ('tape-projector:peak-worsened-seen', '{"1":100}', 1)`);
    const options = { since: start - 1, until: end };
    expect(await project(db, { ...options, dryRun: true })).toMatchObject({ projected: 1 });
    const racingDb = { ...db, batch<T>(statements: D1PreparedStatement[]) {
      sqlite.exec(`INSERT OR IGNORE INTO depeg_event_provenance (event_id, source_kind, audit_verdict, public_json, created_at,
        updated_at) VALUES (1, 'live', 'confirmed', '{"auditVerdict":"disputed"}', 1, 1)`);
      return db.batch<T>(statements);
    } };
    expect(await project(racingDb, options)).toMatchObject({ projected: 0 });
    expect(sqlite.prepare("SELECT source_row_id FROM tape_events").all()).toEqual([]);
  });

});
