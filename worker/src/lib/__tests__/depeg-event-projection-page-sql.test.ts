import { afterEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import type { DatabaseSync } from "node:sqlite";
import { DISPUTED_AUDIT_VERDICTS } from "@shared/types/depeg-audit";
import { createLatestSchemaFixtureTracker } from "@shared/test-utils/latest-schema-sqlite";
import { createSqliteD1 } from "@shared/test-utils/sqlite-d1";
import { handleDepegEvents } from "../../api/depeg-events";
import {
  EXCLUDE_SUPERSEDED_ACTIVE_INCIDENT_EVENTS_SQL,
  PUBLIC_DEPEG_EVENTS_SQL,
  decodeActiveIncidentProjections,
  prepareActiveIncidentProjections,
} from "../depeg-event-projection";
import { prepareDepegEventsCountStatements } from "../depeg-events-count-cache";

const fixtures = createLatestSchemaFixtureTracker();
afterEach(() => fixtures.closeAll());

const MIGRATION = readFileSync("worker/migrations/0292_depeg_event_effective_onset_lookup_indexes.sql", "utf8");
const CURRENT_EVENT_INDEX = "idx_ddr_incident_current_event_all";
const ALIAS_INDEX = "idx_ddr_incident_superseded_alias";

/**
 * Frozen pre-0292 page definition: the public projection joined as a
 * materialized subquery keyed by `current_event_id`. Kept verbatim as the parity
 * reference for the per-row lookup that replaced it.
 */
const LEGACY_PROJECTION_SQL = `SELECT
          COALESCE(effective_alias.current_event_id, incidents.current_event_id) AS current_event_id,
          incidents.first_started_at,
          first_event.start_price AS first_start_price,
          first_event.peg_reference AS first_peg_reference,
          first_event.source AS first_source,
          first_event.peg_type AS first_peg_type,
          first_provenance.quote_mode AS first_quote_mode,
          COUNT(DISTINCT linked_event.id) AS constituent_event_count,
          CASE WHEN first_event.id IS NOT NULL AND current_event.id IS NOT NULL
            AND canonical_current_event.id IS NOT NULL
            AND MAX(CASE WHEN links.event_id = incidents.first_event_id THEN 1 ELSE 0 END) = 1
            AND MAX(CASE WHEN links.event_id = incidents.current_event_id THEN 1 ELSE 0 END) = 1
            AND MAX(CASE WHEN links.event_id = COALESCE(effective_alias.current_event_id, incidents.current_event_id) THEN 1 ELSE 0 END) = 1
            AND COUNT(CASE WHEN links.incident_key = incidents.incident_key THEN linked_event.id END)
              = COUNT(CASE WHEN links.incident_key = incidents.incident_key THEN links.event_id END)
            THEN 1 ELSE 0 END AS references_valid
         FROM depeg_resolver_incidents incidents
         LEFT JOIN depeg_events first_event
           ON first_event.id = incidents.first_event_id
         LEFT JOIN depeg_event_provenance first_provenance
           ON first_provenance.event_id = first_event.id
         LEFT JOIN depeg_resolver_incidents effective_alias
      ON effective_alias.incident_key = (
           SELECT alias.incident_key
             FROM depeg_resolver_incidents alias
            WHERE alias.superseded_by_incident_key = incidents.incident_key
              AND alias.incident_state = 'superseded'
              AND (alias.current_started_at > incidents.current_started_at
                OR (alias.current_started_at = incidents.current_started_at
                    AND alias.current_event_id > incidents.current_event_id))
            ORDER BY alias.current_started_at DESC, alias.current_event_id DESC
            LIMIT 1)
         LEFT JOIN depeg_events current_event
           ON current_event.id = COALESCE(effective_alias.current_event_id, incidents.current_event_id)
         LEFT JOIN depeg_events canonical_current_event
           ON canonical_current_event.id = incidents.current_event_id
         LEFT JOIN depeg_resolver_incident_event_links links
           ON links.incident_key = incidents.incident_key
           OR links.incident_key IN (
                SELECT alias.incident_key
                  FROM depeg_resolver_incidents alias
                 WHERE alias.superseded_by_incident_key = incidents.incident_key
                   AND alias.incident_state = 'superseded'
              )
         LEFT JOIN depeg_events linked_event
           ON linked_event.id = links.event_id
        WHERE incidents.incident_state = 'active'
        GROUP BY incidents.incident_key, incidents.first_started_at,
                 first_event.start_price, first_event.peg_reference,
                 first_event.source, first_event.peg_type, first_provenance.quote_mode,
                 COALESCE(effective_alias.current_event_id, incidents.current_event_id)`;

const LEGACY_PUBLIC_DEPEG_EVENTS_SQL = `(
  SELECT events.*, COALESCE(projection.first_started_at, events.started_at) AS effective_started_at
    FROM depeg_events_with_provenance events
    LEFT JOIN (${LEGACY_PROJECTION_SQL}) projection ON projection.current_event_id = events.id
)`;

const BASE = 1_700_000_000;
const incidentKey = (seed: string) => `ddr2:${seed.repeat(32)}`;
const CANONICAL_A = incidentKey("a");
const ALIAS_A1 = incidentKey("b");
const ALIAS_A2 = incidentKey("c");
const ALIAS_A3 = incidentKey("d");
const CANONICAL_B = incidentKey("e");
const CANONICAL_C = incidentKey("f");
const ALIAS_C = incidentKey("0");
const MERGED_D = incidentKey("1");
const CANONICAL_E = incidentKey("2");
const ALIAS_F = incidentKey("3");
const ALIAS_G = incidentKey("4");
const DISPUTED_VERDICT_SQL = DISPUTED_AUDIT_VERDICTS.map((verdict) => `'${verdict}'`).join(", ");

type Fixture = { sqlite: DatabaseSync; db: ReturnType<typeof createSqliteD1> };

function insertEvent({ sqlite }: Fixture, id: number, startedAt: number, options: { stablecoinId?: string; endedAt?: number } = {}) {
  sqlite.prepare(`INSERT INTO depeg_events
    (id, stablecoin_id, symbol, peg_type, direction, peak_deviation_bps, started_at, ended_at, start_price, peg_reference)
    VALUES (?, ?, 'USDT', 'peggedUSD', 'below', 200, ?, ?, 0.98, 1)`)
    .run(id, options.stablecoinId ?? "usdt-tether", startedAt, options.endedAt ?? null);
}

function insertProvenance({ sqlite }: Fixture, eventId: number, auditVerdict: string | null) {
  sqlite.prepare(`INSERT INTO depeg_event_provenance
    (event_id, source_kind, audit_verdict, created_at, updated_at)
    VALUES (?, 'live', ?, 1700000000, 1700000000)`).run(eventId, auditVerdict);
}

function insertLink({ sqlite }: Fixture, key: string, eventId: number) {
  sqlite.prepare(`INSERT INTO depeg_resolver_incident_event_links (incident_key, event_id, relation, linked_at)
    VALUES (?, ?, 'observed', 1700000100)`).run(key, eventId);
}

function insertIncident(
  fixture: Fixture,
  incident: {
    key: string;
    firstEventId: number;
    currentEventId: number;
    firstStartedAt: number;
    currentStartedAt: number;
    state?: "active" | "superseded" | "merged";
    supersededBy?: string;
    stablecoinId?: string;
  },
) {
  for (const eventId of new Set([incident.firstEventId, incident.currentEventId])) {
    insertLink(fixture, incident.key, eventId);
  }
  fixture.sqlite.prepare(`INSERT INTO depeg_resolver_incidents
    (incident_key, stablecoin_id, peg_currency, direction, first_event_id, current_event_id,
     first_started_at, current_started_at, first_observed_peak_bucket_bps, incident_state,
     superseded_by_incident_key, source_fingerprint, created_at, updated_at)
    VALUES (?, ?, 'USD', 'below', ?, ?, ?, ?, 200, ?, ?, ?, 1700000100, 1700000100)`)
    .run(
      incident.key,
      incident.stablecoinId ?? "usdt-tether",
      incident.firstEventId,
      incident.currentEventId,
      incident.firstStartedAt,
      incident.currentStartedAt,
      incident.state ?? "active",
      incident.supersededBy ?? null,
      "a".repeat(64),
    );
}

/**
 * Events 1-11 belong to DDR incidents; 12 belongs to a merged (never projected)
 * incident; 13-16 are unlinked history. Canonical A is superseded by three
 * direct aliases where the newest fragment tie-breaks on `current_event_id`,
 * canonical C carries an alias older than itself (ineligible), and event 9/
 * event 16 share an effective onset to exercise the id tie-break. Started clocks
 * are unique per coin because `idx_depeg_unique` allows no duplicate event.
 */
function seed(): Fixture {
  const fixture = fixtures.open();
  const events: Array<[number, number, { stablecoinId?: string; endedAt?: number }?]> = [
    [1, BASE + 10], [2, BASE + 20], [3, BASE + 30], [4, BASE + 40], [5, BASE + 50],
    [6, BASE + 60, { stablecoinId: "usdc-circle" }],
    [7, BASE + 70], [8, BASE + 80], [9, BASE + 90], [10, BASE + 100], [11, BASE + 110],
    [12, BASE + 120, { endedAt: BASE + 220 }],
    [13, BASE + 5],
    [14, BASE + 65, { stablecoinId: "usdc-circle", endedAt: BASE + 165 }],
    [15, BASE + 65],
    [16, BASE + 10, { stablecoinId: "usdc-circle" }],
    // First fragments of the multi-event canonicals whose current fragment is
    // newer, so their projected onsets differ from the served row's own clock.
    [17, BASE + 55, { stablecoinId: "usdc-circle" }],
    [18, BASE + 95, { stablecoinId: "usdc-circle", endedAt: BASE + 130 }],
    // Nested supersession: E <- F <- G, where only E's direct alias F is effective.
    [19, BASE + 130], [20, BASE + 140], [21, BASE + 150], [22, BASE + 160],
    [23, BASE + 170], [24, BASE + 180],
  ];
  for (const [id, startedAt, options] of events) insertEvent(fixture, id, startedAt, options);
  insertProvenance(fixture, 13, "disputed");
  insertProvenance(fixture, 14, "confirmed");

  insertIncident(fixture, { key: CANONICAL_A, firstEventId: 1, currentEventId: 3, firstStartedAt: BASE + 10, currentStartedAt: BASE + 30 });
  insertIncident(fixture, {
    key: ALIAS_A1, state: "superseded", supersededBy: CANONICAL_A,
    firstEventId: 2, currentEventId: 5, firstStartedAt: BASE + 20, currentStartedAt: BASE + 50,
  });
  insertIncident(fixture, {
    key: ALIAS_A2, state: "superseded", supersededBy: CANONICAL_A,
    firstEventId: 4, currentEventId: 7, firstStartedAt: BASE + 40, currentStartedAt: BASE + 45,
  });
  // Equal `current_started_at` to ALIAS_A1 with the later current event: it wins.
  insertIncident(fixture, {
    key: ALIAS_A3, state: "superseded", supersededBy: CANONICAL_A,
    firstEventId: 8, currentEventId: 9, firstStartedAt: BASE + 80, currentStartedAt: BASE + 50,
  });
  insertIncident(fixture, {
    key: CANONICAL_B, stablecoinId: "usdc-circle",
    firstEventId: 17, currentEventId: 6, firstStartedAt: BASE + 55, currentStartedAt: BASE + 60,
  });
  insertIncident(fixture, { key: CANONICAL_C, firstEventId: 18, currentEventId: 10, firstStartedAt: BASE + 95, currentStartedAt: BASE + 100 });
  // Older than its canonical, so the canonical's own fragment stays effective.
  insertIncident(fixture, {
    key: ALIAS_C, state: "superseded", supersededBy: CANONICAL_C,
    firstEventId: 11, currentEventId: 11, firstStartedAt: BASE + 90, currentStartedAt: BASE + 90,
  });
  // A merged incident is never projected and its links stay public.
  insertIncident(fixture, {
    key: MERGED_D, state: "merged", firstEventId: 12, currentEventId: 12,
    firstStartedAt: BASE + 120, currentStartedAt: BASE + 120,
  });
  // Nested supersession: G is superseded by F, which is itself superseded by the
  // active canonical E. Only F's fragment is effective; G's events stay public
  // because its resolved canonical is not active.
  insertIncident(fixture, {
    key: CANONICAL_E, firstEventId: 19, currentEventId: 20,
    firstStartedAt: BASE + 130, currentStartedAt: BASE + 140,
  });
  insertIncident(fixture, {
    key: ALIAS_F, state: "superseded", supersededBy: CANONICAL_E,
    firstEventId: 21, currentEventId: 22, firstStartedAt: BASE + 150, currentStartedAt: BASE + 160,
  });
  insertIncident(fixture, {
    key: ALIAS_G, state: "superseded", supersededBy: ALIAS_F,
    firstEventId: 23, currentEventId: 24, firstStartedAt: BASE + 170, currentStartedAt: BASE + 180,
  });
  return fixture;
}

interface Query {
  conditions: string[];
  bindings: Array<string | number>;
}

const FILTERS: Query[] = [
  { conditions: [EXCLUDE_SUPERSEDED_ACTIVE_INCIDENT_EVENTS_SQL], bindings: [] },
  { conditions: [EXCLUDE_SUPERSEDED_ACTIVE_INCIDENT_EVENTS_SQL, "stablecoin_id = ?"], bindings: ["usdt-tether"] },
  { conditions: [EXCLUDE_SUPERSEDED_ACTIVE_INCIDENT_EVENTS_SQL, "ended_at IS NULL"], bindings: [] },
  {
    conditions: [EXCLUDE_SUPERSEDED_ACTIVE_INCIDENT_EVENTS_SQL, "stablecoin_id = ?", "ended_at IS NULL"],
    bindings: ["usdc-circle"],
  },
];

function pageSql(fromClause: string, { conditions, bindings }: Query, limit: number, offset: number) {
  const where = conditions.length > 0 ? ` WHERE ${conditions.join(" AND ")}` : "";
  return {
    sql: `SELECT * FROM ${fromClause}${where} ORDER BY effective_started_at DESC, id DESC LIMIT ${limit} OFFSET ${offset}`,
    bindings,
  };
}

function rows({ sqlite }: Fixture, fromClause: string, query: Query, limit: number, offset: number) {
  const page = pageSql(fromClause, query, limit, offset);
  return sqlite.prepare(page.sql).all(...page.bindings) as Array<Record<string, unknown>>;
}

function queryPlan({ sqlite }: Fixture, sql: string, bindings: unknown[] = []): string[] {
  return (sqlite.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...(bindings as never[])) as Array<{ detail: string }>)
    .map((row) => row.detail);
}

/** Runs the real handler so the asserted plan is the SQL production composes. */
async function handlerPageSql(fixture: Fixture, query: string): Promise<string> {
  const statements: string[] = [];
  const db = createSqliteD1(fixture.sqlite, {
    onRun: (sql) => {
      if (sql.includes("pharos:depeg-events:page */")) statements.push(sql);
    },
  });
  const response = await handleDepegEvents(db, new URL(`https://x/api/depeg-events?${query}`));
  expect(response.status).toBe(200);
  expect(statements).toHaveLength(1);
  return statements[0]!;
}

describe("public depeg page effective onset", () => {
  it("returns byte-identical pages and counts to the materialized projection", () => {
    const fixture = seed();
    // Sanity: every filter shape is non-empty and some onsets are projected.
    for (const query of FILTERS) {
      const legacy = rows(fixture, LEGACY_PUBLIC_DEPEG_EVENTS_SQL, query, 1000, 0);
      const current = rows(fixture, PUBLIC_DEPEG_EVENTS_SQL, query, 1000, 0);
      expect(current.length).toBeGreaterThan(0);
      expect(current).toEqual(legacy);
      expect(current.some((row) => row.effective_started_at !== row.started_at)).toBe(true);
    }

    for (const query of FILTERS) {
      for (const [limit, offset] of [[3, 0], [3, 3], [2, 5], [100, 0]]) {
        expect(rows(fixture, PUBLIC_DEPEG_EVENTS_SQL, query, limit, offset)).toEqual(
          rows(fixture, LEGACY_PUBLIC_DEPEG_EVENTS_SQL, query, limit, offset),
        );
      }
      // Version-2 cursor continuation on (effective_started_at DESC, id DESC).
      const first = rows(fixture, PUBLIC_DEPEG_EVENTS_SQL, query, 2, 0);
      const last = first[first.length - 1]!;
      expect(first).toEqual(rows(fixture, LEGACY_PUBLIC_DEPEG_EVENTS_SQL, query, 2, 0));
      const cursor: Query = {
        conditions: [
          ...query.conditions,
          "((effective_started_at < ?) OR (effective_started_at = ? AND id < ?))",
        ],
        bindings: [...query.bindings, last.effective_started_at as number, last.effective_started_at as number, last.id as number],
      };
      expect(rows(fixture, PUBLIC_DEPEG_EVENTS_SQL, cursor, 2, 0)).toEqual(
        rows(fixture, LEGACY_PUBLIC_DEPEG_EVENTS_SQL, cursor, 2, 0),
      );
    }
  });

  it("keeps cached counts equal to both page memberships", async () => {
    const fixture = seed();
    const undisputed = `(provenance_audit_verdict IS NULL OR provenance_audit_verdict NOT IN (${DISPUTED_VERDICT_SQL}))`;
    for (const stablecoinId of [null, "usdt-tether", "usdc-circle", "absent"]) {
      for (const active of [false, true]) {
        const conditions = [EXCLUDE_SUPERSEDED_ACTIVE_INCIDENT_EVENTS_SQL, undisputed];
        const bindings: Array<string | number> = [];
        if (stablecoinId) {
          conditions.push("stablecoin_id = ?");
          bindings.push(stablecoinId);
        }
        if (active) conditions.push("ended_at IS NULL");
        const expected = fixture.sqlite.prepare(`SELECT COUNT(*) AS total FROM depeg_events_with_provenance
          WHERE ${conditions.join(" AND ")}`).get(...bindings) as { total: number };
        const legacy = rows(fixture, LEGACY_PUBLIC_DEPEG_EVENTS_SQL, { conditions, bindings }, 1000, 0);
        expect(rows(fixture, PUBLIC_DEPEG_EVENTS_SQL, { conditions, bindings }, 1000, 0)).toEqual(legacy);
        expect(expected.total).toBe(legacy.length);
        const countBatch = await fixture.db.batch<{ total: number }>(
          prepareDepegEventsCountStatements(fixture.db, stablecoinId, active),
        );
        expect(countBatch[1]!.results[0]!.total).toBe(expected.total);
      }
    }
  });

  it("publishes exactly the onsets of the separately loaded incident projection", async () => {
    const fixture = seed();
    const load = decodeActiveIncidentProjections(await prepareActiveIncidentProjections(fixture.db, null).all());
    expect(load.available).toBe(true);
    if (!load.available) return;
    const published = rows(fixture, PUBLIC_DEPEG_EVENTS_SQL, { conditions: [], bindings: [] }, 1000, 0);
    const byId = new Map(published.map((row) => [row.id as number, row]));
    let projectedRows = 0;
    for (const row of published) {
      const projection = load.projections.get(row.id as number);
      if (projection) {
        expect(row.effective_started_at).toBe(projection.startedAt);
        projectedRows += 1;
        continue;
      }
      expect(row.effective_started_at).toBe(row.started_at);
    }
    for (const [eventId, projection] of load.projections) {
      const row = byId.get(eventId);
      if (row) expect(row.effective_started_at).toBe(projection.startedAt);
    }
    // ALIAS_A3 is the effective fragment of canonical A, CANONICAL_B and
    // CANONICAL_C keep their own fragments, and ALIAS_F is the effective
    // fragment of canonical E; G's and D's events stay unprojected.
    expect([...load.projections.keys()].sort((a, b) => a - b)).toEqual([6, 9, 10, 22]);
    expect(projectedRows).toBe(4);
  });

  it("resolves the effective fragment with indexed per-row lookups instead of a per-row projection scan", async () => {
    const fixture = seed();
    const exclusion: Query = { conditions: [EXCLUDE_SUPERSEDED_ACTIVE_INCIDENT_EVENTS_SQL], bindings: [] };
    const current = pageSql(PUBLIC_DEPEG_EVENTS_SQL, exclusion, 50, 0);
    const expectIndexedLookupPlan = (plan: string[]) => {
      // No materialized projection subquery is joined (or scanned) per event row.
      expect(plan.filter((detail) => /MATERIALIZE|SCAN projection/.test(detail))).toEqual([]);
      expect(plan).toContain(`SEARCH owner USING INDEX ${CURRENT_EVENT_INDEX} (current_event_id=?)`);
      expect(plan).toContain(`SEARCH alias USING INDEX ${ALIAS_INDEX} (superseded_by_incident_key=? AND incident_state=?)`);
    };
    expectIndexedLookupPlan(queryPlan(fixture, current.sql, []));

    // The SQL the endpoint composes plans the same way, with and without filters.
    expectIndexedLookupPlan(queryPlan(fixture, await handlerPageSql(fixture, "limit=3"), []));
    expectIndexedLookupPlan(queryPlan(fixture, await handlerPageSql(fixture, "limit=3&stablecoin=usdt-tether&active=true"), [null]));

    // The frozen definition still exhibits the incident's per-event-row hotspot.
    const legacy = pageSql(LEGACY_PUBLIC_DEPEG_EVENTS_SQL, exclusion, 50, 0);
    const legacyPlan = queryPlan(fixture, legacy.sql, []);
    expect(legacyPlan).toContain("MATERIALIZE projection");
    expect(legacyPlan).toContain("SCAN projection LEFT-JOIN");

    // The migration, not test-only SQL, is what supplies both access paths.
    fixture.sqlite.exec(`DROP INDEX ${CURRENT_EVENT_INDEX}`);
    fixture.sqlite.exec(`DROP INDEX ${ALIAS_INDEX}`);
    const unindexed = queryPlan(fixture, current.sql, []);
    expect(unindexed.some((detail) => /SCAN (owner|alias)\b/.test(detail))).toBe(true);
    fixture.sqlite.exec(MIGRATION);
    expectIndexedLookupPlan(queryPlan(fixture, current.sql, []));
  });

  it("keeps the count and projection snapshot statements free of per-incident incident scans", async () => {
    const fixture = seed();
    let snapshotSql = "";
    const capturingDb = createSqliteD1(fixture.sqlite, { onAll: (sql) => { snapshotSql = sql; } });
    await prepareActiveIncidentProjections(capturingDb, null).all();
    const snapshotPlan = queryPlan(fixture, snapshotSql, []);
    expect(snapshotPlan.some((detail) => detail === "SCAN alias")).toBe(false);
    expect(snapshotPlan).toContain(`SEARCH alias USING INDEX ${ALIAS_INDEX} (superseded_by_incident_key=? AND incident_state=?)`);

    const countSql: string[] = [];
    const countDb = createSqliteD1(fixture.sqlite, { onRun: (sql) => { if (sql.includes("pharos:depeg-events:count */")) countSql.push(sql); } });
    await countDb.batch(prepareDepegEventsCountStatements(countDb, null, false));
    expect(countSql).toHaveLength(1);
    const countPlan = queryPlan(fixture, countSql[0]!);
    expect(countPlan.some((detail) => detail === "SCAN alias")).toBe(false);
    expect(countPlan).toContain(`SEARCH alias USING INDEX ${ALIAS_INDEX} (superseded_by_incident_key=? AND incident_state=?)`);
  });
});
