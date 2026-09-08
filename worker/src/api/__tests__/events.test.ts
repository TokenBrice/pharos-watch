import { readJsonResponse } from "../../test-helpers/__shared/auth";
import { afterEach, describe, it, expect } from "vitest";
import { mockD1, type MockD1Database } from "@shared/test-utils/mock-d1";
import { handleEvents } from "../events";
import {
  SafetyScoreTapeProvenanceSchema,
  ScoreTapeEventPayloadSchema,
  TapeEventsResponseSchema,
} from "@shared/types/tape-event";
import { createLatestSchemaFixtureTracker } from "@shared/test-utils/latest-schema-sqlite";

const fixtures = createLatestSchemaFixtureTracker();
afterEach(() => fixtures.closeAll());

function eventDb(rows: Record<string, string | number | null>[]) {
  const { sqlite, db } = fixtures.open();
  for (const row of rows) {
    sqlite.prepare(`INSERT INTO tape_events (${Object.keys(row).join(",")}) VALUES (${Object.keys(row).map(() => "?").join(",")})`)
      .run(...Object.values(row));
  }
  return db;
}

const SEC = 1_700_000_000;

function makeRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 1,
    event_id: `${SEC * 1000}-depeg.opened-aaaaaaaa`,
    type: "depeg.opened",
    severity: "warning",
    ts: SEC * 1000,
    ends_at: null,
    coin_id: "usdt-tether",
    issuer_id: "tether",
    peg_currency: "peggedUSD",
    chain: null,
    title: "USDT depeg opened (−500 bps)",
    summary: "USDT crossed peg threshold.",
    payload_json: JSON.stringify({ direction: "below", absDeviationBps: 500 }),
    source_table: "depeg_events",
    source_row_id: "1",
    transition: "opened",
    source_url: "/stablecoin/usdt-tether/#peg-history",
    methodology_version: "5.0",
    created_at: SEC,
    ...overrides,
  };
}

describe("handleEvents", () => {
  it("serializes a V9 score event with its complete policy identity", async () => {
    const payload = {
      prevGrade: "B",
      newGrade: "A",
      prevScore: 75,
      newScore: 90,
      safetyScore: {
        identityStatus: "complete",
        identity: {
          model: "v9",
          schemaVersion: 1,
          methodologyVersion: "9.0",
          policyId: "safety-score-v9-policy",
          policyDigest: "c".repeat(64),
          evaluationBuildDigest: "a".repeat(64),
          baseInputGenerationId: `report-cards-input:v1:${"b".repeat(64)}`,
          publicationGenerationId: "safety-score-v9:1700000000",
        },
      },
    };
    const db = mockD1([
      {
        match: "FROM tape_events",
        rows: [
          makeRow({
            type: "score.upgraded",
            payload_json: JSON.stringify(payload),
            source_table: "safety_score_history_v2",
          }),
        ],
      },
      { match: "cron_runs", rows: [], first: { started_at: SEC } },
    ]);

    const res = await handleEvents(db, new URL("https://x/api/events"));

    const body = TapeEventsResponseSchema.parse(await readJsonResponse(res, 200));
    expect(ScoreTapeEventPayloadSchema.parse(body.events[0]!.payload).safetyScore).toEqual(payload.safetyScore);
  });

  it("normalizes provenance-free legacy safety score events", async () => {
    const db = mockD1([
      {
        match: "FROM tape_events",
        rows: [
          makeRow({
            type: "score.downgraded",
            payload_json: JSON.stringify({
              prevGrade: "A",
              newGrade: "B",
              prevScore: 90,
              newScore: 75,
            }),
            source_table: "safety_grade_history",
          }),
        ],
      },
      { match: "cron_runs", rows: [], first: { started_at: SEC } },
    ]);

    const res = await handleEvents(db, new URL("https://x/api/events"));

    const body = TapeEventsResponseSchema.parse(await readJsonResponse(res, 200));
    expect(ScoreTapeEventPayloadSchema.parse(body.events[0]!.payload).safetyScore).toEqual({
      identityStatus: "legacy-v8-unidentified",
      identity: null,
    });
  });

  it("fails closed for malformed V2 score provenance", async () => {
    const db = mockD1([
      {
        match: "FROM tape_events",
        rows: [
          makeRow({
            type: "score.upgraded",
            payload_json: JSON.stringify({
              prevGrade: "B",
              newGrade: "A",
              prevScore: 75,
              newScore: 90,
              safetyScore: {
                identityStatus: "legacy-v8-unidentified",
                identity: null,
              },
            }),
            source_table: "safety_score_history_v2",
          }),
        ],
      },
      { match: "cron_runs", rows: [], first: { started_at: SEC } },
    ]);

    expect(
      SafetyScoreTapeProvenanceSchema.safeParse({
        identityStatus: "complete",
        identity: null,
      }).success,
    ).toBe(false);
    // Fails closed: the router boundary maps this throw to the JSON 500 pinned by
    // `router-contract.test.ts`.
    await expect(handleEvents(db, new URL("https://x/api/events"))).rejects.toThrow(
      "Invalid score tape event payload",
    );
  });

  it("returns 200 with mapped events and freshness meta", async () => {
    const db = mockD1([
      { match: "FROM tape_events", rows: [makeRow()] },
      { match: "cron_runs", rows: [], first: { started_at: SEC } },
    ]);
    const res = await handleEvents(db, new URL("https://x/api/events"));
    const body = TapeEventsResponseSchema.parse(await readJsonResponse(res, 200));
    expect(body.events).toHaveLength(1);
    expect(body.events[0]!.type).toBe("depeg.opened");
    expect(body.events[0]!.severity).toBe("warning");
    expect(body._meta.status).toBeDefined();
    expect(body.totalExact).toBe(false);
  });

  it("exhausts timestamp ties across cursor pages without gaps or duplicates", async () => {
    const db = eventDb([1, 3, 2].map((id) => makeRow({ id, event_id: `event-${id}`, source_row_id: String(id) })));
    let cursor: string | null = null;
    const ids: string[] = [];
    for (let page = 0; page < 3; page++) {
      const url = new URL("https://x/api/events?limit=1");
      if (cursor) url.searchParams.set("cursor", cursor);
      const body = TapeEventsResponseSchema.parse(await readJsonResponse(await handleEvents(db, url), 200));
      ids.push(...body.events.map((event) => event.id));
      cursor = body.nextCursor;
      expect(cursor === null).toBe(page === 2);
    }
    expect(ids).toEqual(["event-3", "event-2", "event-1"]);
  });

  it("rejects a malformed cursor with 400", async () => {
    const db = mockD1([]);
    const res = await handleEvents(db, new URL("https://x/api/events?cursor=!!!notbase64!!!"));
    expect(res.status).toBe(400);
  });

  it("applies severity floor to both selected rows and exact total", async () => {
    const db = eventDb(["info", "warning", "severe", "critical"].map((severity, index) =>
      makeRow({ id: index + 1, event_id: `severity-${index}`, source_row_id: String(index), severity })));
    const body = TapeEventsResponseSchema.parse(await readJsonResponse(
      await handleEvents(db, new URL("https://x/api/events?severityFloor=warning&includeTotal=true")), 200));
    expect(body.events.map((event) => event.id)).toEqual(["severity-3", "severity-2", "severity-1"]);
    expect(body.total).toBe(3);
  });

  it("rejects invalid severity floor with 400", async () => {
    const db = mockD1([]);
    const res = await handleEvents(db, new URL("https://x/api/events?severityFloor=panic"));
    expect(res.status).toBe(400);
  });

  it.each([
    ["type=depeg.*", ["type-2", "type-0"]],
    ["class=freeze", ["type-3"]],
    ["type=depeg.opened&type=depeg.peak_worsened&class=methodology", ["type-4", "type-2", "type-0"]],
  ])("selects type/class alternatives for %s", async (query, expected) => {
    const db = eventDb(["depeg.opened", "yield.warning", "depeg.peak_worsened", "freeze.blacklisted", "methodology.updated"]
      .map((type, index) => makeRow({ id: index + 1, event_id: `type-${index}`, source_row_id: String(index), type })));
    const body = TapeEventsResponseSchema.parse(await readJsonResponse(
      await handleEvents(db, new URL(`https://x/api/events?${query}&includeTotal=true`)), 200));
    expect(body.events.map((event) => event.id)).toEqual(expected);
    expect(body.total).toBe(expected.length);
  });

  it("includes both timestamp bounds and excludes neighboring rows", async () => {
    const db = eventDb([999, 1000, 2000, 2001].map((ts, index) =>
      makeRow({ id: index + 1, event_id: `time-${ts}`, source_row_id: String(index), ts })));
    const body = TapeEventsResponseSchema.parse(await readJsonResponse(
      await handleEvents(db, new URL("https://x/api/events?since=1000&until=2000")), 200));
    expect(body.events.map((event) => event.id)).toEqual(["time-2000", "time-1000"]);
  });

  it("rejects invalid epoch-ms since and until filters with 400", async () => {
    for (const query of [
      "since=-1",
      "since=0",
      "since=9007199254740993",
      "since=4102444800001",
      "until=-1",
      "until=0",
      "until=9007199254740993",
      "until=4102444800001",
    ]) {
      const res = await handleEvents(mockD1([]), new URL(`https://x/api/events?${query}`));
      expect(res.status, query).toBe(400);
    }
  });

  it("includes total only when includeTotal=true", async () => {
    const dbWith = mockD1([
      { match: "COUNT(*)", rows: [{ total: 42 }] },
      { match: "FROM tape_events", rows: [makeRow()] },
      { match: "cron_runs", rows: [], first: { started_at: SEC } },
    ]);
    const resWith = await handleEvents(dbWith, new URL("https://x/api/events?includeTotal=true"));
    const bodyWith = TapeEventsResponseSchema.parse(await resWith.json());
    expect(bodyWith.total).toBe(42);
    expect(bodyWith.totalExact).toBe(true);

    const dbWithout = mockD1([
      { match: "FROM tape_events", rows: [makeRow()] },
      { match: "cron_runs", rows: [], first: { started_at: SEC } },
    ]);
    const resWithout = await handleEvents(dbWithout, new URL("https://x/api/events"));
    const bodyWithout = TapeEventsResponseSchema.parse(await resWithout.json());
    expect(bodyWithout.total).toBeNull();
    expect(bodyWithout.totalExact).toBe(false);
  });

  it("rejects oversized limits with 400", async () => {
    const res = await handleEvents(mockD1([]), new URL("https://x/api/events?limit=501"));
    expect(res.status).toBe(400);
  });

  it("rejects unknown typed coin, peg-currency, and chain filters before querying", async () => {
    for (const query of [
      "coin=not-a-stablecoin",
      "pegCurrency=NOPE",
      "chain=not-a-chain",
    ]) {
      const res = await handleEvents(mockD1([]), new URL(`https://x/api/events?${query}`));
      expect(res.status, query).toBeGreaterThanOrEqual(400);
      expect(res.status, query).toBeLessThan(500);
    }
  });

  it("normalizes allowed peg-currency and chain filters through canonical registries", async () => {
    const db = mockD1([
      { match: "FROM tape_events", rows: [] },
      { match: "cron_runs", rows: [], first: { started_at: SEC } },
    ]) as MockD1Database;
    const res = await handleEvents(
      db,
      new URL("https://x/api/events?coin=usdt-tether&pegCurrency=eur&chain=Ethereum"),
    );
    expect(res.status).toBe(200);
    const dataQuery = db.getHistory().find((entry) => entry.sql.includes("FROM tape_events"));
    expect(dataQuery?.binds).toEqual(expect.arrayContaining(["usdt-tether", "EUR", "ethereum"]));
  });

  it.each([
    ["PYUSD", ["search-2", "search-1", "search-0"]],
    ["US%_D\\x", ["search-3"]],
  ])("searches title, summary and coin literally for %s", async (query, expected) => {
    const db = eventDb([
      { title: "pyusd supply" }, { summary: "PYUSD update" }, { coin_id: "pyusd-paypal" },
      { title: "US%_D\\x literal" }, { title: "USanythingAD\\x wildcard decoy" },
    ].map((overrides, index) => makeRow({ id: index + 1, event_id: `search-${index}`, source_row_id: String(index), ...overrides })));
    const url = new URL("https://x/api/events?includeTotal=true");
    url.searchParams.set("q", query);
    const body = TapeEventsResponseSchema.parse(await readJsonResponse(await handleEvents(db, url), 200));
    expect(body.events.map((event) => event.id)).toEqual(expected);
    expect(body.total).toBe(expected.length);
  });

  it("rejects overlong q filters with 400", async () => {
    const res = await handleEvents(mockD1([]), new URL(`https://x/api/events?q=${"a".repeat(201)}`));
    expect(res.status).toBe(400);
  });

  it("skips the q clause when empty", async () => {
    const db = mockD1([
      { match: "FROM tape_events", rows: [] },
      { match: "cron_runs", rows: [], first: { started_at: SEC } },
    ]) as MockD1Database;
    const res = await handleEvents(db, new URL("https://x/api/events?q="));
    expect(res.status).toBe(200);
    const dataQuery = db.getHistory().find((entry) => entry.sql.includes("FROM tape_events"));
    expect(dataQuery?.sql).not.toContain("LOWER(title) LIKE ?");
  });
});
