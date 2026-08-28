import { readJsonResponse } from "../../test-helpers/__shared/auth";
import { describe, it, expect } from "vitest";
import { mockD1, type MockD1Database } from "@shared/test-utils/mock-d1";
import { handleEvents } from "../events";
import {
  SafetyScoreTapeProvenanceSchema,
  ScoreTapeEventPayloadSchema,
  TapeEventsResponseSchema,
} from "@shared/types/tape-event";

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

  it("emits and accepts a cursor for pagination", async () => {
    const row1 = makeRow({ id: 2, ts: SEC * 1000 + 1000 });
    const row2 = makeRow({ id: 1, ts: SEC * 1000 });
    const firstDb = mockD1([
      { match: "FROM tape_events", rows: [row1, row2] },
      { match: "cron_runs", rows: [], first: { started_at: SEC } },
    ]);

    const firstRes = await handleEvents(firstDb, new URL("https://x/api/events?limit=1"));
    const firstBody = TapeEventsResponseSchema.parse(await firstRes.json());
    expect(firstBody.events).toHaveLength(1);
    expect(firstBody.nextCursor).toBeTypeOf("string");

    const secondDb = mockD1([
      { match: "FROM tape_events", rows: [row2] },
      { match: "cron_runs", rows: [], first: { started_at: SEC } },
    ]) as MockD1Database;
    const url = new URL(`https://x/api/events?limit=1&cursor=${firstBody.nextCursor}`);
    const secondRes = await handleEvents(secondDb, url);
    expect(secondRes.status).toBe(200);
    const dataQuery = secondDb.getHistory().find((entry) => entry.sql.includes("FROM tape_events"));
    // (ts < ? OR (ts = ? AND id < ?)) — keyset clause emitted.
    expect(dataQuery?.sql).toContain("ts < ?");
    expect(dataQuery?.sql).toContain("id < ?");
  });

  it("rejects a malformed cursor with 400", async () => {
    const db = mockD1([]);
    const res = await handleEvents(db, new URL("https://x/api/events?cursor=!!!notbase64!!!"));
    expect(res.status).toBe(400);
  });

  it("applies severity floor by including all higher tiers", async () => {
    const db = mockD1([
      { match: "FROM tape_events", rows: [makeRow({ severity: "severe" })] },
      { match: "cron_runs", rows: [], first: { started_at: SEC } },
    ]) as MockD1Database;
    const res = await handleEvents(db, new URL("https://x/api/events?severityFloor=warning"));
    expect(res.status).toBe(200);
    const dataQuery = db.getHistory().find((entry) => entry.sql.includes("FROM tape_events"));
    // warning + severe + critical filter — 3 severity = ? predicates.
    const matches = (dataQuery?.sql.match(/severity = \?/g) ?? []).length;
    expect(matches).toBe(3);
  });

  it("rejects invalid severity floor with 400", async () => {
    const db = mockD1([]);
    const res = await handleEvents(db, new URL("https://x/api/events?severityFloor=panic"));
    expect(res.status).toBe(400);
  });

  it("expands type wildcards to LIKE prefix filters", async () => {
    const db = mockD1([
      { match: "FROM tape_events", rows: [] },
      { match: "cron_runs", rows: [], first: { started_at: SEC } },
    ]) as MockD1Database;
    const res = await handleEvents(db, new URL("https://x/api/events?type=depeg.*"));
    expect(res.status).toBe(200);
    const dataQuery = db.getHistory().find((entry) => entry.sql.includes("FROM tape_events"));
    expect(dataQuery?.sql).toContain("type LIKE ?");
    expect(dataQuery?.binds).toContain("depeg.%");
  });

  it("treats `class=foo` as a shortcut for type=foo.*", async () => {
    const db = mockD1([
      { match: "FROM tape_events", rows: [] },
      { match: "cron_runs", rows: [], first: { started_at: SEC } },
    ]) as MockD1Database;
    const res = await handleEvents(db, new URL("https://x/api/events?class=freeze"));
    expect(res.status).toBe(200);
    const dataQuery = db.getHistory().find((entry) => entry.sql.includes("FROM tape_events"));
    expect(dataQuery?.binds).toContain("freeze.%");
  });

  it("combines exact type and class filters as alternatives", async () => {
    const db = mockD1([
      { match: "FROM tape_events", rows: [] },
      { match: "cron_runs", rows: [], first: { started_at: SEC } },
    ]) as MockD1Database;
    const res = await handleEvents(
      db,
      new URL("https://x/api/events?type=depeg.opened&type=depeg.peak_worsened&class=methodology"),
    );
    expect(res.status).toBe(200);
    const dataQuery = db.getHistory().find((entry) => entry.sql.includes("FROM tape_events"));
    expect(dataQuery?.sql).toContain("(type = ? OR type = ? OR type LIKE ?)");
    expect(dataQuery?.sql).not.toContain("(type = ? OR type = ?) AND (type LIKE ?)");
    expect(dataQuery?.binds).toEqual(
      expect.arrayContaining(["depeg.opened", "depeg.peak_worsened", "methodology.%"]),
    );
  });

  it("clamps since and until into the SQL ts bounds", async () => {
    const db = mockD1([
      { match: "FROM tape_events", rows: [] },
      { match: "cron_runs", rows: [], first: { started_at: SEC } },
    ]) as MockD1Database;
    const res = await handleEvents(db, new URL("https://x/api/events?since=1000&until=2000"));
    expect(res.status).toBe(200);
    const dataQuery = db.getHistory().find((entry) => entry.sql.includes("FROM tape_events"));
    expect(dataQuery?.sql).toContain("ts >= ?");
    expect(dataQuery?.sql).toContain("ts <= ?");
    expect(dataQuery?.binds).toContain(1000);
    expect(dataQuery?.binds).toContain(2000);
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

  it("applies q as a parameterized LIKE across title/summary/coin_id", async () => {
    const db = mockD1([
      { match: "FROM tape_events", rows: [makeRow()] },
      { match: "cron_runs", rows: [], first: { started_at: SEC } },
    ]) as MockD1Database;
    const res = await handleEvents(db, new URL("https://x/api/events?q=PYUSD"));
    expect(res.status).toBe(200);
    const dataQuery = db.getHistory().find((entry) => entry.sql.includes("FROM tape_events"));
    expect(dataQuery?.sql).toContain("LOWER(title) LIKE ? ESCAPE '\\'");
    expect(dataQuery?.sql).toContain("LOWER(summary) LIKE ? ESCAPE '\\'");
    expect(dataQuery?.sql).toContain("LOWER(coin_id) LIKE ? ESCAPE '\\'");
    // q is lowercased and wrapped with % wildcards.
    expect(dataQuery?.binds).toContain("%pyusd%");
  });

  it("escapes q wildcard characters before binding LIKE filters", async () => {
    const db = mockD1([
      { match: "FROM tape_events", rows: [] },
      { match: "cron_runs", rows: [], first: { started_at: SEC } },
    ]) as MockD1Database;
    const url = new URL("https://x/api/events");
    url.searchParams.set("q", "US%_D\\x");
    const res = await handleEvents(db, url);
    expect(res.status).toBe(200);
    const dataQuery = db.getHistory().find((entry) => entry.sql.includes("FROM tape_events"));
    expect(dataQuery?.sql).toContain("LIKE ? ESCAPE '\\'");
    expect(dataQuery?.binds).toContain("%us\\%\\_d\\\\x%");
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
