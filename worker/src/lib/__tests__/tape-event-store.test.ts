import { afterEach, describe, expect, it, vi } from "vitest";
import { createLatestSchemaFixtureTracker } from "@shared/test-utils/latest-schema-sqlite";
import {
  filterUnprojectedTapeEvents,
  insertTapeEvents,
  queryTapeEvents,
} from "../tape-event-store";
import { mapTapeEventRow, parseDateStringToEpochSec } from "../tape-event-helpers";
import type { TapeEventInsert } from "../tape-event-types";

const fixtures = createLatestSchemaFixtureTracker();
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  fixtures.closeAll();
});

function event(sourceRowId: string): TapeEventInsert {
  return {
    eventId: `event-${sourceRowId}`,
    type: "catalog.entry.added",
    severity: "notice",
    ts: 1_000,
    endsAt: null,
    coinId: null,
    issuerId: null,
    pegCurrency: null,
    chain: null,
    title: sourceRowId,
    summary: sourceRowId,
    payload: {},
    sourceTable: "catalog",
    sourceRowId,
    transition: "opened",
    sourceUrl: null,
    methodologyVersion: null,
  };
}

function createTapeDatabase(): { db: D1Database } {
  return fixtures.open();
}

describe("Tape large-flow claim guard", () => {
  const flow = (amountUsd: number): TapeEventInsert => ({
    ...event("flow-1"), eventId: "flow-event", type: "mint_burn.large_mint", sourceTable: "mint_burn_events",
    transition: "updated", title: `flow ${amountUsd}`,
    payload: { direction: "mint", amountUsd, flowType: "standard", burnType: null },
  });
  const seedSource = (sqlite: ReturnType<typeof fixtures.open>["sqlite"], amountUsd: number) =>
    sqlite.prepare(`INSERT INTO mint_burn_events
      (id, stablecoin_id, symbol, chain_id, direction, amount, amount_usd, timestamp, flow_type,
       tx_hash, block_number, explorer_tx_url)
      VALUES ('flow-1', 'usdt-tether', 'USDT', 'ethereum', 'mint', 1, ?, 1000, 'standard', '0x', 1, 'https://example.com')`)
      .run(amountUsd);

  it("rejects stale or ineligible snapshots, updates only presentation, and never revives a suppressed claim", async () => {
    const { db, sqlite } = fixtures.open();
    const count = () => (sqlite.prepare("SELECT COUNT(*) AS n FROM tape_events").get() as { n: number }).n;
    await insertTapeEvents(db, [flow(20_000_000)]); // source missing
    expect(count()).toBe(0);
    seedSource(sqlite, 20_000_000);
    await insertTapeEvents(db, [flow(30_000_000)]); // stale snapshot
    expect(count()).toBe(0);
    await insertTapeEvents(db, [flow(20_000_000)]);
    const first = sqlite.prepare("SELECT * FROM tape_events").get()!;

    sqlite.prepare("UPDATE mint_burn_events SET amount_usd = 30000000").run();
    await insertTapeEvents(db, [{ ...flow(30_000_000), eventId: "other", ts: 9_999 }]);
    expect(sqlite.prepare("SELECT * FROM tape_events").get()).toEqual({
      ...first, title: "flow 30000000", payload_json: expect.stringContaining("30000000"),
    });

    sqlite.prepare("UPDATE tape_events SET suppressed_at = 1, suppression_reason = 'flow-claim-retracted'").run();
    sqlite.prepare("UPDATE mint_burn_events SET amount_usd = 40000000").run();
    await insertTapeEvents(db, [flow(40_000_000)]);
    expect(sqlite.prepare("SELECT title, suppressed_at FROM tape_events").get())
      .toEqual({ title: "flow 30000000", suppressed_at: 1 });
  });
});

describe("Tape event source-key conflicts", () => {
  it("keeps an identical peak's original identity and clocks without suppressing other source corrections", async () => {
    const { db, sqlite } = fixtures.open();
    vi.spyOn(Date, "now").mockReturnValue(1_700_000_000_000);
    const peak: TapeEventInsert = {
      ...event("7:200"), type: "depeg.peak_worsened", sourceTable: "depeg_events", transition: "updated",
    };
    const ordinary = event("correctable");
    await insertTapeEvents(db, [peak, ordinary]);
    const first = sqlite.prepare("SELECT * FROM tape_events WHERE source_row_id = '7:200'").get()!;

    vi.mocked(Date.now).mockReturnValue(1_700_000_060_000);
    await insertTapeEvents(db, [
      { ...peak, eventId: "retried-peak", ts: 61_000 },
      { ...ordinary, eventId: "corrected-event", title: "corrected", ts: 61_000 },
      { ...peak, sourceRowId: "7:300", eventId: "larger-peak", ts: 61_000 },
    ]);
    expect(sqlite.prepare("SELECT * FROM tape_events WHERE event_id = ?").get(peak.eventId)).toEqual(first);
    expect(sqlite.prepare("SELECT * FROM tape_events WHERE event_id = 'retried-peak'").get()).toBeUndefined();
    expect(sqlite.prepare("SELECT event_id, title, ts FROM tape_events WHERE source_row_id = 'correctable'").get())
      .toEqual({ event_id: "corrected-event", title: "corrected", ts: 61_000 });
    expect(sqlite.prepare("SELECT event_id FROM tape_events WHERE source_row_id = '7:300'").get())
      .toEqual({ event_id: "larger-peak" });
    expect(sqlite.prepare("SELECT COUNT(*) AS count FROM tape_events").get()?.count).toBe(3);
  });
});

describe("Tape event store static-catalog probes", () => {
  it("retries two overload failures and returns each unprojected event once", async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, "random").mockReturnValue(0);
    const { db } = createTapeDatabase();
    const observed = event("observed-after-overload");
    const pending = event("pending-after-overload");
    await insertTapeEvents(db, [observed]);

    const batch = db.batch.bind(db);
    let attempts = 0;
    const retryingDb = new Proxy(db, {
      get(target, property, receiver) {
        if (property === "batch") {
          return async (statements: D1PreparedStatement[]) => {
            attempts += 1;
            if (attempts <= 2) {
              throw new Error("D1_ERROR: D1 DB is overloaded. Requests queued for too long.");
            }
            return batch(statements);
          };
        }
        return Reflect.get(target, property, receiver);
      },
    });

    const filtering = filterUnprojectedTapeEvents(retryingDb, [observed, pending]);
    await vi.runAllTimersAsync();

    await expect(filtering).resolves.toEqual([pending]);
    expect(attempts).toBe(3);
  });
});

describe("Curated tape event dates", () => {
  it("round-trips valid month and day precision in UTC", () => {
    expect(parseDateStringToEpochSec("2024-02")).toBe(Date.UTC(2024, 1, 1) / 1000);
    expect(parseDateStringToEpochSec("2024-02-29")).toBe(Date.UTC(2024, 1, 29) / 1000);
  });

  it.each([undefined, null, "", "24-02-29", "2024-13", "2024-02-31"])(
    "rejects invalid curated date %j",
    (value) => {
      expect(parseDateStringToEpochSec(value)).toBeNull();
    },
  );
});


describe("Tape event read boundary", () => {
  it("serves a projector insert through the full wire schema", async () => {
    const { db } = createTapeDatabase();
    const inserted = event("round-trip");
    await insertTapeEvents(db, [inserted]);

    const { rows } = await queryTapeEvents(db, { filters: {}, limit: 10, cursor: null, includeTotal: false });
    const mapping = mapTapeEventRow(rows[0]!);

    expect(mapping.quarantine).toBeNull();
    expect(mapping.event).toMatchObject({
      id: inserted.eventId,
      type: inserted.type,
      severity: inserted.severity,
      ts: inserted.ts,
      payload: inserted.payload,
      sourceTable: inserted.sourceTable,
      sourceRowId: inserted.sourceRowId,
      transition: inserted.transition,
    });
  });

  it.each(["a".repeat(48), "a".repeat(49), "a".repeat(200), "%", "_", "\\", "\u8cc7\u7523"])(
    "matches literal substrings across searchable columns for %j", async (q) => {
      const { db } = createTapeDatabase();
      await insertTapeEvents(db, [
        { ...event("title"), title: `before ${q.toUpperCase()} after` },
        { ...event("summary"), summary: `before ${q.toUpperCase()} after` },
        { ...event("coin"), coinId: `before-${q.toUpperCase()}-after` },
        { ...event("distractor"), title: `before ${q.slice(0, -1)} after` },
      ]);
      const options = { limit: 10, cursor: null, includeTotal: true } as const;
      const result = await queryTapeEvents(db, { ...options, filters: { q } });
      expect(result.rows.map((row) => row.event_id)).toEqual(["event-coin", "event-summary", "event-title"]);
      expect(result.total).toBe(3);
      expect(result.hasMore).toBe(false);

      const missing = await queryTapeEvents(db, { ...options, filters: { q: `missing-${q}` } });
      expect(missing.rows).toEqual([]);
      expect(missing.total).toBe(0);
    },
  );

  it.each(["depeg", "de_peg", "a".repeat(1_000)])(
    "matches only literal dot-delimited type prefixes for %j", async (prefix) => {
      const { db } = createTapeDatabase();
      await insertTapeEvents(db, [
        { ...event("child"), type: `${prefix}.opened` },
        { ...event("nested"), type: `${prefix.toUpperCase()}.opened.updated` },
        { ...event("bare"), type: prefix },
        { ...event("not-delimited"), type: `${prefix}extra.opened` },
        { ...event("not-leading"), type: `other.${prefix}.opened` },
        { ...event("wildcard-decoy"), type: `${prefix.includes("_") ? prefix.replace(/_/g, "x") : "other"}.opened` },
      ]);
      const result = await queryTapeEvents(db, {
        filters: { typePrefixes: [prefix] }, limit: 10, cursor: null, includeTotal: true,
      });
      expect(result.rows.map((row) => row.event_id)).toEqual(["event-nested", "event-child"]);
      expect(result.total).toBe(2);
    },
  );
});
