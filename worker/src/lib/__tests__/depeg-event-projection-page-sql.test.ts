import { afterEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import type { DatabaseSync } from "node:sqlite";
import { DISPUTED_AUDIT_VERDICTS } from "@shared/types/depeg-audit";
import { createLatestSchemaFixtureTracker } from "@shared/test-utils/latest-schema-sqlite";
import { createSqliteD1 } from "@shared/test-utils/sqlite-d1";
import { handleDepegEvents } from "../../api/depeg-events";
import { fetchPaginatedEvents } from "../api-pagination";
import {
  EXCLUDE_SUPERSEDED_ACTIVE_INCIDENT_EVENTS_SQL,
  PUBLIC_DEPEG_EVENTS_SQL,
  buildPublicDepegEventsPageQuery,
  decodeActiveIncidentProjections,
  prepareActiveIncidentProjections,
} from "../depeg-event-projection";
import { prepareDepegEventsCountStatements } from "../depeg-events-count-cache";

const fixtures = createLatestSchemaFixtureTracker();
afterEach(() => fixtures.closeAll());

const MIGRATION = readFileSync("worker/migrations/0292_depeg_event_effective_onset_lookup_indexes.sql", "utf8");
const CURRENT_EVENT_INDEX = "idx_ddr_incident_current_event_all";
const ALIAS_INDEX = "idx_ddr_incident_superseded_alias";
const PAGE_ORDER = "effective_started_at DESC, id DESC";

/** Frozen pre-0292 materialized projection; only whitespace is compacted. */
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
const ACTIVE_POINTING_H = incidentKey("5");
const ACTIVE_POINTING_I = incidentKey("6");
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

/** Alias recency/id ties, canonical wins, nested/merged owners and onset ties. */
function seed(): Fixture {
  const fixture = fixtures.open();
  const events: Array<[number, number, { stablecoinId?: string; endedAt?: number }?]> = [
    [1, BASE + 10], [2, BASE + 20], [3, BASE + 30], [4, BASE + 40], [5, BASE + 50],
    [6, BASE + 60, { stablecoinId: "usdc-circle" }],
    [7, BASE + 70], [8, BASE + 80], [9, BASE + 90], [10, BASE + 100, { endedAt: BASE + 230 }], [11, BASE + 110],
    [12, BASE + 120, { endedAt: BASE + 220 }],
    [13, BASE + 5],
    [14, BASE + 65, { stablecoinId: "usdc-circle", endedAt: BASE + 165 }],
    [15, BASE + 65],
    [16, BASE + 10, { stablecoinId: "usdc-circle" }],
    // First fragments.
    [17, BASE + 55, { stablecoinId: "usdc-circle" }],
    [18, BASE + 95, { stablecoinId: "usdc-circle", endedAt: BASE + 130 }],
    // Nested supersession.
    [19, BASE + 130], [20, BASE + 140], [21, BASE + 150], [22, BASE + 160],
    [23, BASE + 170], [24, BASE + 180],
    // Active incidents with pointers.
    [25, BASE + 190], [26, BASE + 200], [27, BASE + 210], [28, BASE + 220],
  ];
  for (const [id, startedAt, options] of events) insertEvent(fixture, id, startedAt, options);
  insertProvenance(fixture, 13, "disputed");
  insertProvenance(fixture, 14, "confirmed");

  const incidents: Array<[string, number, number, number, number, Parameters<typeof insertIncident>[1]["state"]?, string?, string?]> = [
    [CANONICAL_A, 1, 3, 10, 30],
    [ALIAS_A1, 2, 5, 20, 50, "superseded", CANONICAL_A],
    [ALIAS_A2, 4, 7, 40, 45, "superseded", CANONICAL_A],
    [ALIAS_A3, 8, 9, 80, 50, "superseded", CANONICAL_A], // Wins A1's clock tie by id.
    [CANONICAL_B, 17, 6, 55, 60, "active", undefined, "usdc-circle"],
    [CANONICAL_C, 18, 10, 95, 100],
    [ALIAS_C, 11, 11, 90, 90, "superseded", CANONICAL_C], // Older than C.
    [MERGED_D, 12, 12, 120, 120, "merged"],
    [CANONICAL_E, 19, 20, 130, 140],
    [ALIAS_F, 21, 22, 150, 160, "superseded", CANONICAL_E],
    [ALIAS_G, 23, 24, 170, 180, "superseded", ALIAS_F], // Nested G stays raw.
    [ACTIVE_POINTING_H, 25, 26, 190, 200, "active", MERGED_D],
    [ACTIVE_POINTING_I, 27, 28, 210, 220, "active", CANONICAL_A], // Projects but is excluded.
  ];
  for (const [key, firstEventId, currentEventId, first, current, state, supersededBy, stablecoinId] of incidents) {
    insertIncident(fixture, { key, firstEventId, currentEventId, firstStartedAt: BASE + first,
      currentStartedAt: BASE + current, state, supersededBy, stablecoinId });
  }
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

function pageSql(fromClause: string | null, { conditions, bindings }: Query, limit: number, offset: number) {
  const where = conditions.length > 0 ? ` WHERE ${conditions.join(" AND ")}` : "";
  if (fromClause === null) return buildPublicDepegEventsPageQuery(where, bindings, limit, offset);
  return {
    sql: `SELECT * FROM ${fromClause}${where} ORDER BY effective_started_at DESC, id DESC LIMIT ${limit} OFFSET ${offset}`,
    bindings,
  };
}

function rows({ sqlite }: Fixture, fromClause: string | null, query: Query, limit: number, offset: number) {
  const page = pageSql(fromClause, query, limit, offset);
  return sqlite.prepare(page.sql).all(...page.bindings) as Array<Record<string, unknown>>;
}

function queryPlan({ sqlite }: Fixture, sql: string, bindings: unknown[] = []): string[] {
  return (sqlite.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...(bindings as never[])) as Array<{ detail: string }>)
    .map((row) => row.detail);
}

/** Capture production SQL and bindings. */
async function handlerPageSql(fixture: Fixture, query: string) {
  const statements: Array<{ sql: string; bindings: unknown[] }> = [];
  const db = createSqliteD1(fixture.sqlite);
  const prepare = db.prepare.bind(db);
  db.prepare = (sql) => {
    const statement = prepare(sql);
    const bind = statement.bind.bind(statement);
    statement.bind = (...bindings) => {
      if (sql.includes("pharos:depeg-events:page */")) statements.push({ sql, bindings });
      return bind(...bindings);
    };
    return statement;
  };
  const response = await handleDepegEvents(db, new URL(`https://x/api/depeg-events?${query}`));
  expect(response.status).toBe(200);
  expect(statements).toHaveLength(1);
  return statements[0]!;
}

describe("public depeg page effective onset", () => {
  it.each([
    ["started_at DESC, id DESC", "effective_started_at", "DESC", "number", 2],
    [PAGE_ORDER, "started_at", "DESC", "number", 2],
    [PAGE_ORDER, "effective_started_at", "ASC", "number", 2],
    [PAGE_ORDER, "effective_started_at", "DESC", "string", 2],
    [PAGE_ORDER, "effective_started_at", "DESC", "number", 1],
    [PAGE_ORDER, "effective_started_at", "DESC", "number", 0],
  ] as const)("rejects incompatible depeg ordering %j %j %j %j %j", async (orderBy, column, direction, type, size) => {
    await expect(fetchPaginatedEvents(seed().db, {
      tableName: "depeg_events_public", orderBy, conditions: [], filterBindings: [], limit: 1, offset: 0,
      cursor: size ? { columns: [column, "id"].slice(0, size).map((column) => ({ column, direction, type, getValue: () => 0 })) } : undefined,
      mapRow: (row) => row,
    })).rejects.toThrow("Public depeg pagination");
  });

  it("returns byte-identical pages and counts to the materialized projection", () => {
    const fixture = seed();
    const parity = (query: Query, limit: number, offset: number) => {
      const current = rows(fixture, null, query, limit, offset);
      for (const reference of [LEGACY_PUBLIC_DEPEG_EVENTS_SQL, PUBLIC_DEPEG_EVENTS_SQL]) {
        expect(current).toEqual(rows(fixture, reference, query, limit, offset));
      }
      return current;
    };
    // Every filter includes projected rows.
    for (const query of FILTERS) {
      const legacy = rows(fixture, LEGACY_PUBLIC_DEPEG_EVENTS_SQL, query, 1000, 0);
      const current = parity(query, 1000, 0);
      expect(current.length).toBeGreaterThan(0);
      expect(current).toEqual(legacy);
      expect(current.some((row) => row.effective_started_at !== row.started_at)).toBe(true);
    }

    for (const query of FILTERS) {
      for (const [limit, offset] of [[1, 0], [1, 1], [3, 0], [3, 3], [2, 5], [100, 0]]) {
        parity(query, limit, offset);
      }
      // Include cursors on projected ties.
      const first = parity(query, 2, 0);
      expect(first).toHaveLength(2);
      for (const last of parity(query, 1000, 0)) {
        parity({
          conditions: [...query.conditions, "((effective_started_at < ?) OR (effective_started_at = ? AND id < ?))"],
          bindings: [...query.bindings, last.effective_started_at as number, last.effective_started_at as number, last.id as number],
        }, 2, 0);
      }
    }
    for (const [condition, ids] of [["id = 9", [9]], ["id = -1", []], ["provenance_audit_verdict = 'disputed'", [13]]] as const) {
      expect(parity({ conditions: [condition], bindings: [] }, 3, 0).map((row) => row.id)).toEqual(ids);
    }
    // Nonempty deep-offset pages.
    fixture.sqlite.exec(`WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<50010)
      INSERT INTO depeg_events (id, stablecoin_id, symbol, peg_type, direction, peak_deviation_bps, started_at, start_price, peg_reference)
      SELECT 100+x, 'usdt-tether', 'USDT', 'peggedUSD', 'below', 200, ${BASE}-x, .98, 1 FROM n`);
    for (const query of FILTERS) {
      for (const offset of [0, 5000, 50000]) parity(query, 3, offset);
    }
  });

  it("preserves handler pages and dispute-adjusted counts", async () => {
    const fixture = seed();
    for (const stablecoinId of [null, "usdt-tether", "usdc-circle", "absent"]) {
      for (const active of [false, true]) {
        const conditions = [EXCLUDE_SUPERSEDED_ACTIVE_INCIDENT_EVENTS_SQL];
        const bindings: Array<string | number> = [];
        if (stablecoinId) {
          conditions.push("stablecoin_id = ?");
          bindings.push(stablecoinId);
        }
        if (active) conditions.push("ended_at IS NULL");
        const expected = fixture.sqlite.prepare(`SELECT COUNT(*) AS total,
          COUNT(CASE WHEN provenance_audit_verdict IN (${DISPUTED_VERDICT_SQL}) THEN 1 END) AS disputed
          FROM depeg_events_with_provenance WHERE ${conditions.join(" AND ")}`)
          .get(...bindings) as { total: number; disputed: number };
        const legacy = rows(fixture, LEGACY_PUBLIC_DEPEG_EVENTS_SQL, { conditions, bindings }, 1000, 0);
        for (const source of [null, PUBLIC_DEPEG_EVENTS_SQL]) {
          expect(rows(fixture, source, { conditions, bindings }, 1000, 0)).toEqual(legacy);
        }
        expect(expected.total).toBe(legacy.length);
        const countBatch = await fixture.db.batch<{ total: number }>(
          prepareDepegEventsCountStatements(fixture.db, stablecoinId, active),
        );
        expect(countBatch[1]!.results[0]!.total).toBe(expected.total - expected.disputed);
        if (stablecoinId === "absent") continue;
        for (const limit of [1, 1000]) {
          const response = await handleDepegEvents(fixture.db, new URL(`https://x/api/depeg-events?limit=${limit}&active=${active}${stablecoinId ? `&stablecoin=${stablecoinId}` : ""}`));
          const body = await response.json() as { events: { id: number }[]; total: number };
          expect(response.status).toBe(200);
          expect(body.events.map((row) => row.id)).toEqual(legacy.slice(0, limit).map((row) => row.id));
          // Pre-existing: pages include disputes; exact totals subtract them.
          expect(body.total).toBe(expected.total - expected.disputed);
        }
      }
    }
  });

  it("publishes exactly the onsets of the separately loaded incident projection", async () => {
    const fixture = seed();
    const load = decodeActiveIncidentProjections(await prepareActiveIncidentProjections(fixture.db, null).all());
    expect(load.available).toBe(true);
    if (!load.available) return;
    const published = rows(fixture, null, { conditions: [], bindings: [] }, 1000, 0);
    const idsSql = buildPublicDepegEventsPageQuery("", [], 1, 0).sql.split(", ordinary AS")[0]
      + " SELECT effective_event_id FROM effective_ids)";
    const effectiveIds = fixture.sqlite.prepare(idsSql).all().map((row) => row.effective_event_id);
    const byId = new Map(published.map((row) => [row.id as number, row]));
    let projectedRows = 0;
    for (const row of published) {
      if (row.effective_started_at !== row.started_at) expect(effectiveIds).toContain(row.id);
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
    // A3/B/C/F/H/I project; nested G and merged D remain raw.
    expect([...load.projections.keys()].sort((a, b) => a - b)).toEqual([6, 9, 10, 22, 26, 28]);
    expect(projectedRows).toBe(6);
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

    const cursor = btoa(JSON.stringify({ v: 2, values: [BASE + 10, 16] }));
    for (const query of ["limit=3", "limit=3&active=true", "limit=3&stablecoin=usdt-tether", "limit=3&stablecoin=usdt-tether&active=true", `limit=3&cursor=${cursor}`]) {
      const page = await handlerPageSql(fixture, query);
      const plan = queryPlan(fixture, page.sql, page.bindings);
      const ordinary = plan.slice(plan.indexOf("CO-ROUTINE ordinary"), plan.indexOf("SCAN ordinary"));
      expect(ordinary.some((detail) => /(?:SCAN|SEARCH) .*USING INDEX idx_depeg_(?:started_id|coin_started_id|open_started_id)/.test(detail))).toBe(true);
      expect(ordinary.some((detail) => detail.includes("USE TEMP B-TREE FOR ORDER BY"))).toBe(false);
      expect(plan).toContain("SEARCH e USING INTEGER PRIMARY KEY (rowid=?)");
      expect(plan).toContain(`SEARCH owner USING INDEX ${CURRENT_EVENT_INDEX} (current_event_id=?)`);
      expect(plan).toContain(`SEARCH alias USING INDEX ${ALIAS_INDEX} (superseded_by_incident_key=? AND incident_state=?)`);
      if (query.includes("cursor=")) {
        expect(page.sql).toContain("effective_started_at < ?");
        expect(page.sql).toContain("id < ?");
        expect(page.bindings).toContain(BASE + 10);
        expect(page.bindings).toContain(16);
      }
    }

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
