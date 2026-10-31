import { afterEach, describe, expect, it } from "vitest";
import type { DatabaseSync } from "node:sqlite";
import type { D1Database } from "@shared/types/cloudflare-runtime";
import { DISPUTED_AUDIT_VERDICTS } from "@shared/types/depeg-audit";
import { createLatestSchemaFixtureTracker } from "@shared/test-utils/latest-schema-sqlite";
import { handleDepegEvents } from "../../api/depeg-events";
import { EXCLUDE_SUPERSEDED_ACTIVE_INCIDENT_EVENTS_SQL } from "../depeg-event-projection";
import { DEPEG_EVENTS_COUNT_CACHE_KEY, prepareDepegEventsCountStatements } from "../depeg-events-count-cache";

const DISPUTED_VERDICT_SQL = DISPUTED_AUDIT_VERDICTS.map((verdict) => `'${verdict}'`).join(", ");

const fixtures = createLatestSchemaFixtureTracker();
afterEach(() => fixtures.closeAll());
interface Fixture {
  sqlite: DatabaseSync;
  db: D1Database;
}
const firstIncident = `ddr2:${"a".repeat(32)}`;
const aliasIncident = `ddr2:${"b".repeat(32)}`;

function insertEvent({ sqlite }: Fixture, id: number, stablecoinId = "usdt-tether", endedAt: number | null = null) {
  sqlite.prepare(`INSERT INTO depeg_events
    (id, stablecoin_id, symbol, peg_type, direction, peak_deviation_bps, started_at, ended_at, start_price, peg_reference)
    VALUES (?, ?, 'USDT', 'peggedUSD', 'below', 200, ?, ?, 0.98, 1)`)
    .run(id, stablecoinId, 1_700_000_000 + id, endedAt);
}

function insertProvenance({ sqlite }: Fixture, eventId: number, auditVerdict: string | null) {
  sqlite.prepare(`INSERT INTO depeg_event_provenance
    (event_id, source_kind, audit_verdict, created_at, updated_at)
    VALUES (?, 'live', ?, 1700000000, 1700000000)`).run(eventId, auditVerdict);
}

function insertLink({ sqlite }: Fixture, incidentKey: string, eventId: number) {
  sqlite.prepare(`INSERT INTO depeg_resolver_incident_event_links (incident_key, event_id, relation, linked_at)
    VALUES (?, ?, 'observed', 1700000100)`).run(incidentKey, eventId);
}

function insertIncident(fixture: Fixture, incidentKey: string, eventId: number) {
  insertLink(fixture, incidentKey, eventId);
  fixture.sqlite.prepare(`INSERT INTO depeg_resolver_incidents
    (incident_key, stablecoin_id, peg_currency, direction, first_event_id, current_event_id,
     first_started_at, current_started_at, first_observed_peak_bucket_bps, source_fingerprint, created_at, updated_at)
    VALUES (?, 'usdt-tether', 'USD', 'below', ?, ?, ?, ?, 200, ?, 1700000100, 1700000100)`)
    .run(incidentKey, eventId, eventId, 1_700_000_000 + eventId, 1_700_000_000 + eventId, "a".repeat(64));
}

async function readCount({ db }: Fixture, stablecoinId: string | null = null, active = false) {
  const results = await db.batch<{ total: number }>(prepareDepegEventsCountStatements(db, stablecoinId, active));
  return results[1]!.results[0]!.total;
}

function cacheRow({ sqlite }: Fixture) {
  return sqlite.prepare("SELECT value, updated_at FROM cache WHERE key = ?").get(DEPEG_EVENTS_COUNT_CACHE_KEY);
}

async function expectLegacyCounts(fixture: Fixture) {
  for (const stablecoinId of [null, "usdt-tether", "usdc-circle", "absent"]) {
    for (const active of [false, true]) {
      const conditions = [EXCLUDE_SUPERSEDED_ACTIVE_INCIDENT_EVENTS_SQL];
      if (stablecoinId) conditions.push("stablecoin_id = ?");
      if (active) conditions.push("ended_at IS NULL");
      const expected = fixture.sqlite.prepare(`SELECT COUNT(*) AS total FROM depeg_events_with_provenance
        WHERE ${conditions.join(" AND ")}
          AND (provenance_audit_verdict IS NULL OR provenance_audit_verdict NOT IN (${DISPUTED_VERDICT_SQL}))`)
        .get(...(stablecoinId ? [stablecoinId] : [])) as { total: number };
      expect(await readCount(fixture, stablecoinId, active)).toBe(expected.total);
    }
  }
}

async function expectInvalidation(fixture: Fixture, mutate: () => void) {
  await readCount(fixture);
  expect(cacheRow(fixture)).toBeDefined();
  mutate();
  expect(cacheRow(fixture)).toBeUndefined();
  await expectLegacyCounts(fixture);
}

describe("depeg event count publication cache", () => {
  it("matches uncached global/stablecoin/active totals and reuses one summary across pages", async () => {
    const fixture = fixtures.open();
    insertEvent(fixture, 1);
    insertEvent(fixture, 2, "usdt-tether", 1_700_000_020);
    insertEvent(fixture, 3, "usdc-circle");
    await expectLegacyCounts(fixture);
    const cached = cacheRow(fixture);
    // A hit must not replace/rewrite its generation; the outer NOT EXISTS gate
    // prevents evaluating the grouped-history aggregate on this path.
    fixture.sqlite.exec(`CREATE TRIGGER reject_count_cache_rewrite BEFORE INSERT ON cache
      WHEN NEW.key = 'depeg-events:counts:v1'
      BEGIN SELECT RAISE(ABORT, 'count cache was rewritten'); END;`);
    for (const query of ["limit=1", "stablecoin=usdt-tether&active=true", "offset=1&limit=1"]) {
      const response = await handleDepegEvents(fixture.db, new URL(`https://x/api/depeg-events?${query}`));
      expect(response.status).toBe(200);
      const body = await response.json() as { total: number; totalExact: boolean };
      expect(body.total).toBe(query.includes("stablecoin=") ? 1 : 3);
      expect(body.totalExact).toBe(true);
      expect(cacheRow(fixture)).toEqual(cached);
    }
  });

  it("excludes disputed and false-positive provenance while null and unknown verdicts keep counting", async () => {
    const fixture = fixtures.open();
    for (const id of [1, 2, 3, 4, 5]) insertEvent(fixture, id);
    insertProvenance(fixture, 1, "disputed");
    insertProvenance(fixture, 2, "false_positive");
    insertProvenance(fixture, 3, "confirmed");
    insertProvenance(fixture, 4, null);
    // Pre-vocabulary legacy rows are not rewritten; an unknown non-null verdict
    // makes no claim and keeps counting (R2).
    fixture.sqlite.exec("DROP TRIGGER trg_depeg_provenance_audit_verdict_insert_guard");
    insertProvenance(fixture, 5, "legacy_unknown");
    await expectLegacyCounts(fixture);
    expect(await readCount(fixture)).toBe(3);
    expect(await readCount(fixture, "usdt-tether")).toBe(3);
    expect(await readCount(fixture, "usdt-tether", true)).toBe(3);
  });

  it("never serves a cached pre-change count after a verdict becomes disputed", async () => {
    const fixture = fixtures.open();
    insertEvent(fixture, 1);
    insertEvent(fixture, 2);
    insertProvenance(fixture, 2, "confirmed");
    expect(await readCount(fixture)).toBe(2);
    const cached = cacheRow(fixture);
    expect(cached).toBeDefined();
    fixture.sqlite.prepare("UPDATE depeg_event_provenance SET audit_verdict = 'disputed' WHERE event_id = 2").run();
    // No invalidation trigger runs on provenance, so the persisted summary is
    // still the pre-change generation; the public count must not repeat it.
    expect(cacheRow(fixture)).toEqual(cached);
    expect(await readCount(fixture)).toBe(1);
    expect(await readCount(fixture, "usdt-tether")).toBe(1);
  });

  it("keeps an empty publication exact and invalidates on new events, closure, reclassification and deletes", async () => {
    const fixture = fixtures.open();
    expect(await readCount(fixture)).toBe(0);
    await expectInvalidation(fixture, () => insertEvent(fixture, 1));
    expect(await readCount(fixture)).toBe(1);
    await expectInvalidation(fixture, () => fixture.sqlite.exec("UPDATE depeg_events SET ended_at = 1700000200 WHERE id = 1"));
    await expectInvalidation(fixture, () => fixture.sqlite.exec("UPDATE depeg_events SET ended_at = NULL WHERE id = 1"));
    await expectInvalidation(fixture, () => fixture.sqlite.exec("UPDATE depeg_events SET stablecoin_id = 'usdc-circle' WHERE id = 1"));
    await expectInvalidation(fixture, () => fixture.sqlite.exec("UPDATE depeg_events SET id = 5 WHERE id = 1"));
    await expectInvalidation(fixture, () => fixture.sqlite.exec("DELETE FROM depeg_events WHERE id = 5"));
    expect(await readCount(fixture)).toBe(0);
  });

  it("does not invalidate on peak observations or closed-to-closed timestamp corrections", async () => {
    const fixture = fixtures.open();
    insertEvent(fixture, 1, "usdt-tether", 1_700_000_020);
    await readCount(fixture);
    const cached = cacheRow(fixture);
    fixture.sqlite.exec("UPDATE depeg_events SET peak_deviation_bps = 300, ended_at = 1700000300 WHERE id = 1");
    expect(cacheRow(fixture)).toEqual(cached);
    await expectLegacyCounts(fixture);
  });

  it("invalidates on incident insert/delete, linked repairs, current pointers and supersession", async () => {
    const fixture = fixtures.open();
    for (const id of [1, 2, 3]) insertEvent(fixture, id);
    insertLink(fixture, firstIncident, 1);
    await expectInvalidation(fixture, () => fixture.sqlite.prepare(`INSERT INTO depeg_resolver_incidents
      (incident_key, stablecoin_id, peg_currency, direction, first_event_id, current_event_id,
       first_started_at, current_started_at, first_observed_peak_bucket_bps, source_fingerprint, created_at, updated_at)
      VALUES (?, 'usdt-tether', 'USD', 'below', 1, 1, 1700000001, 1700000001, 200, ?, 1700000100, 1700000100)`)
      .run(firstIncident, "a".repeat(64)));
    await expectInvalidation(fixture, () => insertLink(fixture, firstIncident, 2));
    expect(await readCount(fixture)).toBe(2);
    await expectInvalidation(fixture, () => fixture.sqlite.prepare(`UPDATE depeg_resolver_incidents
      SET current_event_id = 2, current_started_at = 1700000002 WHERE incident_key = ?`).run(firstIncident));
    fixture.sqlite.exec("UPDATE depeg_events SET started_at = 1700001000 WHERE id = 2");
    const response = await handleDepegEvents(fixture.db, new URL("https://x/api/depeg-events?limit=1"));
    const body = await response.json() as { events: Array<{ id: number }>; total: number; nextCursor: string };
    expect(body.total).toBe(2);
    expect(body.events.map((event) => event.id)).toEqual([3]);
    const continuation = await handleDepegEvents(fixture.db, new URL(`https://x/api/depeg-events?limit=1&cursor=${body.nextCursor}`));
    expect(await continuation.json()).toMatchObject({
      total: 2, events: [{ id: 2, startedAt: 1_700_000_001, constituentEventCount: 2 }], nextCursor: null,
    });
    insertIncident(fixture, aliasIncident, 3);
    await expectInvalidation(fixture, () => fixture.sqlite.prepare(`UPDATE depeg_resolver_incidents
      SET incident_state = 'superseded', superseded_by_incident_key = ? WHERE incident_key = ?`)
      .run(firstIncident, aliasIncident));
    await expectInvalidation(fixture, () => fixture.sqlite.prepare(`UPDATE depeg_resolver_incidents
      SET superseded_by_incident_key = NULL WHERE incident_key = ?`).run(aliasIncident));
    await expectInvalidation(fixture, () => fixture.sqlite.prepare(`UPDATE depeg_resolver_incidents
      SET incident_state = 'merged' WHERE incident_key = ?`).run(firstIncident));
    await expectInvalidation(fixture, () => fixture.sqlite.prepare(
      "DELETE FROM depeg_resolver_incidents WHERE incident_key = ?",
    ).run(aliasIncident));
  });

  it("preserves cache on rolled-back writes and retains append-only link guards", async () => {
    const fixture = fixtures.open();
    insertEvent(fixture, 1);
    insertIncident(fixture, firstIncident, 1);
    await readCount(fixture);
    const cached = cacheRow(fixture);
    fixture.sqlite.exec("BEGIN");
    insertEvent(fixture, 2);
    expect(cacheRow(fixture)).toBeUndefined();
    fixture.sqlite.exec("ROLLBACK");
    expect(cacheRow(fixture)).toEqual(cached);
    expect(() => fixture.sqlite.exec("DELETE FROM depeg_resolver_incident_event_links")).toThrow("append-only");
    expect(() => fixture.sqlite.exec("UPDATE depeg_resolver_incident_event_links SET event_id = 2")).toThrow("append-only");
    expect(cacheRow(fixture)).toEqual(cached);
  });
});
