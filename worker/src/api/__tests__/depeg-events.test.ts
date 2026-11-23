import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { URL as NodeURL } from "node:url";
import { prepareDepegLedgerManifest } from "../../../scripts/prepare-depeg-ledger-manifest";
import { DEPEG_LEDGER_MANIFEST_KEY } from "@shared/types/depeg-event-projection";
import { stableJsonStringifyV1 } from "@shared/lib/stable-json";
import { sha256Hex } from "../../lib/hash";
import { readJsonResponse } from "../../test-helpers/__shared/auth";
import { DepegEventsResponseSchema } from "@shared/types/peg";
import { afterEach, describe, it, expect, vi } from "vitest";
import { mockD1, type MockD1Database, type MockTableConfig } from "@shared/test-utils/mock-d1";
import { createLatestSchemaFixtureTracker } from "@shared/test-utils/latest-schema-sqlite";
import { createSqliteD1 } from "@shared/test-utils/sqlite-d1";
import { makeDepegRow } from "../../test-helpers/__shared/fixtures";
import { registerStablecoinParameterContract } from "../../test-helpers/__shared/endpoint-contracts";
import { handleDepegEvents } from "../depeg-events";
import { DEPEG_PENDING_EXPIRY_SEC, DEPEG_PENDING_EXTENDED_EXPIRY_SEC, DEPEG_PENDING_SEVERE_EXPIRY_SEC } from "@shared/lib/depeg-config";

const fixtures = createLatestSchemaFixtureTracker();
afterEach(() => {
  vi.useRealTimers();
  fixtures.closeAll();
});

describe("handleDepegEvents", () => {
  const row = makeDepegRow();
  const call = (db: D1Database, q = "", lane?: "public-api" | "site-api" | null) =>
    handleDepegEvents(db, new URL(`https://x/api/depeg-events${q}`), lane);
  const LINK_SQL = "INSERT INTO depeg_resolver_incident_event_links (incident_key, event_id, relation, linked_at) VALUES (?, ?, 'observed', ?)";
  const ALIAS_INC_SQL = `INSERT INTO depeg_resolver_incidents (incident_key, stablecoin_id, peg_currency, direction, first_event_id, current_event_id,
    first_started_at, current_started_at, first_observed_peak_bucket_bps, incident_state, superseded_by_incident_key, source_fingerprint, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;

  function mockEvents(rows: Record<string, unknown>[], total: number | null, extra: MockTableConfig[] = []) {
    return mockD1([
      { match: "pharos:depeg-event-projection:active-incidents", rows: [] },
      ...(total === null ? [] : [{ match: "pharos:depeg-events:count", rows: [{ total }] }]),
      { match: "depeg_events", rows },
      ...extra,
    ]);
  }

  it("returns dependency unavailability rather than raw history when incident projection fails", async () => {
    const db = mockD1([
      { match: "pharos:depeg-event-projection:active-incidents", rows: [], throwError: new Error("projection read timed out") },
      { match: "pharos:depeg-events:count", rows: [{ total: 2 }] },
      { match: "depeg_events", rows: [row, { ...row, id: 2 }] },
    ]);
    const res = await call(db);
    expect(await readJsonResponse(res, 503)).toEqual({ error: "Canonical incident history unavailable", reason: "incident-projection-read-failed" });
    expect(res.headers.get("Cache-Control")).toBe("no-store");
  });

  it.each([
    { current_event_id: null }, { first_started_at: null }, { first_start_price: "0.97" },
    { first_peg_reference: -1 }, { constituent_event_count: 0 }, { constituent_event_count: 1.5 }, { incident_peak_json: "{}" },
  ].map((invalid) => ({
    current_event_id: 2, first_started_at: 1_700_000_000, first_start_price: 0.97,
    first_peg_reference: 1, constituent_event_count: 2, incident_peak_json: null, ...invalid,
  })))("withholds raw history when an incident projection row is malformed: %j", async (projection) => {
    const db = mockD1([
      { match: "pharos:depeg-event-projection:active-incidents", rows: [{ references_valid: 1, ...projection }] },
      { match: "pharos:depeg-events:count", rows: [{ total: 0 }] },
      { match: "pharos:depeg-events:page", rows: [] },
    ]);
    const res = await call(db);
    expect(await readJsonResponse(res, 503)).toEqual({ error: "Canonical incident history unavailable", reason: "incident-projection-invalid" });
    expect(res.headers.get("Cache-Control")).toBe("no-store");
  });

  it("keeps a successful empty incident projection readable", async () => {
    const body = await readJsonResponse(await call(mockEvents([row], 1)), 200) as { events: unknown[]; total: number };
    expect(body.total).toBe(1);
    expect(body.events).toHaveLength(1);
  });

  it("marks a row whose coin left the catalog as retired and leaves catalog rows unmarked", async () => {
    const db = mockEvents([
      makeDepegRow({ id: 1, stablecoin_id: "bean-beanstalk", symbol: "BEAN" }),
      makeDepegRow({ id: 2, stablecoin_id: "usdt-tether", symbol: "USDT" }),
    ], 2);
    const body = DepegEventsResponseSchema.parse(await readJsonResponse(await call(db), 200));
    const byId = new Map(body.events.map((event) => [event.id, event]));
    expect(byId.get(1)?.retired).toBe(true);
    expect(byId.get(2)).not.toHaveProperty("retired");
  });

  function seedIncident(firstId: number, currentId: number, eventIds: number[], linkIds = [firstId, currentId],
    [stablecoinId, symbol, pegCurrency] = ["usdt-tether", "USDT", "USD"], start = 1_700_000_000) {
    const { sqlite, db } = fixtures.open();
    const key = `ddr2:${"a".repeat(32)}`;
    for (const id of eventIds) {
      sqlite.prepare(`INSERT INTO depeg_events (id, stablecoin_id, symbol, peg_type, direction, peak_deviation_bps, started_at, start_price, peg_reference)
        VALUES (?, ?, ?, ?, 'below', 300, ?, ?, 1)`).run(id, stablecoinId, symbol, `pegged${pegCurrency}`, start + (id - firstId) * 1_000, id === firstId ? 0.97 : 0.96);
    }
    for (const id of new Set(linkIds)) sqlite.prepare(LINK_SQL).run(key, id, 1700000000);
    // Seed unsealed dangling pointers directly: no duplicate-deletion trigger or disabled seal guard.
    sqlite.prepare(`INSERT INTO depeg_resolver_incidents (incident_key, stablecoin_id, peg_currency, direction, first_event_id, current_event_id,
      first_started_at, current_started_at, first_observed_peak_bucket_bps, source_fingerprint, created_at, updated_at)
      VALUES (?, ?, ?, 'below', ?, ?, ?, ?, 300, ?, 1700000000, 1700001000)`).run(key, stablecoinId, pegCurrency, firstId, currentId, start, start + 1_000, "b".repeat(64));
    return { sqlite, db, key };
  }

  it("unions admitted member intervals, preserves the stored close, and applies reviewed exclusions to the family", async () => {
    const { sqlite, db } = seedIncident(101, 102, [101, 102]);
    const start = 1_700_000_000;
    const update = sqlite.prepare("UPDATE depeg_events SET admitted_coverage_json = ?, disposition = 'admitted-coverage' WHERE id = ?");
    const first = { fromSec: start + 1, toSec: start + 50 }, last = { fromSec: start + 1000, toSec: start + 1050 };
    update.run(JSON.stringify([first]), 101);
    update.run(JSON.stringify([last]), 102);
    sqlite.exec("UPDATE depeg_events SET peak_deviation_bps = CASE id WHEN 101 THEN -960 ELSE -437 END");
    sqlite.prepare("UPDATE depeg_events SET ended_at = ?, recovery_price = 1 WHERE id = 102").run(start + 1200);
    const readEvent = async () => (await readJsonResponse(await call(db), 200) as { events: Record<string, unknown>[] }).events[0];
    expect(await readEvent()).toMatchObject({ id: 102, startedAt: start, endedAt: start + 1200, peakDeviationBps: -960, analyticRecoveryAt: null, admittedCoverage: [first, last] });
    sqlite.prepare("UPDATE depeg_events SET admitted_coverage_json = '[]', disposition = 'repaired' WHERE id = 101").run();
    expect(await readEvent()).toMatchObject({ id: 102, endedAt: start + 1200, peakDeviationBps: -437, admittedCoverage: [], provenance: { pegScoreEligible: false } });
  });

  it("excludes only disputed constituents from a reviewed dispute's worst peak", async () => {
    const { sqlite, db } = fixtures.open(), start = 1_780_000_000, key = `ddr2:${"e".repeat(32)}`;
    const insertEvent = sqlite.prepare(`INSERT INTO depeg_events (id, stablecoin_id, symbol, peg_type, direction, peak_deviation_bps, started_at, ended_at, start_price, peg_reference, source)
      VALUES (?, 'audd-novatti', 'AUDD', 'peggedAUD', 'below', ?, ?, ?, 0.65, 1, 'live')`);
    for (const [id, peak, endedAt] of [[101, -293, start + 500], [102, -396, start + 900], [103, -960, start + 1400], [104, -437, null]] as const) {
      insertEvent.run(id, peak, start + (id - 101) * 100, endedAt);
      sqlite.prepare(LINK_SQL).run(key, id, 1780000000);
    }
    sqlite.prepare(`INSERT INTO depeg_resolver_incidents (incident_key, stablecoin_id, peg_currency, direction, first_event_id, current_event_id,
      first_started_at, current_started_at, first_observed_peak_bucket_bps, source_fingerprint, created_at, updated_at)
      VALUES (?, 'audd-novatti', 'AUD', 'below', 101, 104, ?, ?, 293, ?, 1780000000, 1780000100)`).run(key, start, start + 300, "f".repeat(64));
    sqlite.exec("UPDATE depeg_events SET peak_price = 0.60568, peak_peg_reference = 0.67, peak_quote_domain = 'usd' WHERE id = 103");
    const readEvent = async () => DepegEventsResponseSchema.parse(await readJsonResponse(await call(db, "?stablecoin=audd-novatti&active=true"), 200)).events[0]!;
    const markDisputed = sqlite.prepare("INSERT INTO depeg_event_provenance (event_id, source_kind, audit_verdict, created_at, updated_at) VALUES (?, 'live', 'disputed', 1780000200, 1780000200)");
    markDisputed.run(101);
    expect(await readEvent()).toMatchObject({
      id: 104, startedAt: start, constituentEventCount: 4, peakDeviationBps: -960, peakPrice: 0.60568, peakPegReference: 0.67,
      peakQuoteDomain: "usd", onsetFragmentPeakBps: -293, currentFragmentPeakBps: -437, admittedCoverage: [], provenance: { pegScoreEligible: false },
    });
    sqlite.exec("DELETE FROM depeg_event_provenance; UPDATE depeg_events SET peak_deviation_bps = -500 WHERE id = 102");
    markDisputed.run(103);
    expect(await readEvent()).toMatchObject({ id: 104, peakDeviationBps: -500, currentFragmentPeakBps: -437, admittedCoverage: [] });
    sqlite.exec("DELETE FROM depeg_event_provenance");
    markDisputed.run(104);
    const currentDisputed = await readEvent();
    expect(currentDisputed).toMatchObject({ id: 104, peakDeviationBps: -437, admittedCoverage: [], provenance: { pegScoreEligible: false } });
    expect(currentDisputed).not.toHaveProperty("currentFragmentPeakBps");
    sqlite.exec("DELETE FROM depeg_event_provenance");
    expect(await readEvent()).toMatchObject({ id: 104, peakDeviationBps: -960, peakPrice: 0.60568, currentFragmentPeakBps: -437 });
  });

  it("keeps the peer median outside the fiat conversion field and retains a reviewed BRZ peak", async () => {
    const reference = 0.2, price = 0.24;
    const sample = { basis: "peer-relative", observedAt: 1_700_000_100, price, pegReference: reference, bps: 2000 };
    const response = await call(mockEvents([{
      ...makeDepegRow({ id: 89170, stablecoin_id: "brz-transfero", symbol: "BRZ", peg_type: "peggedREAL", direction: "above",
        started_at: sample.observedAt, start_price: price, peg_reference: reference, peak_deviation_bps: 2000, peak_price: price }),
      peak_peg_reference: reference, peak_quote_domain: "usd", peer_basis_json: JSON.stringify({ onset: sample, peak: sample }),
    }], 1));
    const event = (await readJsonResponse(response, 200) as { events: Record<string, unknown>[] }).events[0];
    expect(event).toMatchObject({ peakPrice: price, onsetBasis: "peer-relative", peakBasis: "peer-relative", peakPeerMedianUsd: reference, peakReview: "unverified" });
    expect(event).not.toHaveProperty("peakPegReference");
  });

  it("pins exact full-ledger pages to the source manifest and refuses same-count revisions", async () => {
    const { db, sqlite } = fixtures.open();
    sqlite.exec(`WITH RECURSIVE ids(n) AS (VALUES(1) UNION ALL SELECT n + 1 FROM ids WHERE n < 1001)
      INSERT INTO depeg_events (id, stablecoin_id, symbol, peg_type, direction, peak_deviation_bps, started_at, start_price, peg_reference)
      SELECT n, 'usdt-tether', 'USDT', 'peggedUSD', 'below', -200, 1700000000 + n, 0.98, 1 FROM ids`);
    const url = new URL("https://x/api/depeg-events?limit=1000");
    type Page = { events: unknown[]; total: number; nextCursor: string | null };
    const first = (await (await handleDepegEvents(db, url)).json()) as Page;
    url.searchParams.set("ledgerGeneration", "latest");
    expect(await (await handleDepegEvents(db, url)).json()).toMatchObject({ reason: "ledger-manifest-unavailable" });
    const directory = mkdtempSync(join(tmpdir(), "pharos-ledger-test-")), path = join(directory, "export.sqlite");
    let prepared: Awaited<ReturnType<typeof prepareDepegLedgerManifest>>;
    try {
      sqlite.prepare("VACUUM INTO ?").run(path);
      const receipt = { version: 1, scope: "whole-public-depeg-ledger", snapshotSha256: await sha256Hex(readFileSync(path)),
        coveredFromSec: 1_700_000_000, coveredThroughSec: 1_700_100_000, attestedAtSec: 1_700_200_000,
        attestedBy: "fixture source", coverageEvidenceRef: "source-coverage-fixture" };
      await expect(prepareDepegLedgerManifest(path, { ...receipt, snapshotSha256: "0".repeat(64) })).rejects.toThrow("SHA-256");
      await expect(prepareDepegLedgerManifest(path, { ...receipt, coveredFromSec: undefined })).rejects.toThrow();
      prepared = await prepareDepegLedgerManifest(path, receipt);
      expect(await sha256Hex(readFileSync(path))).toBe(receipt.snapshotSha256);
    } finally { rmSync(directory, { recursive: true, force: true }); }
    const { manifest } = prepared;
    sqlite.exec(prepared.sql);
    const generation = await sha256Hex(stableJsonStringifyV1(manifest));
    const ledgerProof = { generation, coveredFromSec: manifest.coveredFromSec, coveredThroughSec: manifest.coveredThroughSec };
    expect(await (await handleDepegEvents(db, url)).json()).toMatchObject({ ledgerProof, nextCursor: first.nextCursor });
    url.searchParams.set("ledgerGeneration", generation);
    url.searchParams.set("cursor", first.nextCursor!);
    expect(await (await handleDepegEvents(db, url)).json()).toMatchObject({ ledgerProof, nextCursor: null });
    sqlite.prepare("UPDATE depeg_events SET peak_deviation_bps = -500 WHERE id = 1").run();
    expect(await readJsonResponse(await handleDepegEvents(db, url), 409)).toMatchObject({ reason: "ledger-page-changed" });
    sqlite.prepare("UPDATE cache SET value = ? WHERE key = ?").run(JSON.stringify({ ...manifest, coveredThroughSec: manifest.coveredThroughSec - 1 }), DEPEG_LEDGER_MANIFEST_KEY);
    expect(await readJsonResponse(await handleDepegEvents(db, url), 409)).toMatchObject({ reason: "ledger-generation-changed" });
  });

  it.each([
    { name: "first event", first: 101, current: 102, events: [102], links: [101, 102] },
    { name: "current event", first: 101, current: 102, events: [101], links: [101, 102] },
    { name: "singleton event", first: 101, current: 101, events: [], links: [101] },
    { name: "constituent event", first: 101, current: 102, events: [101, 102], links: [101, 102, 103] },
    { name: "first membership", first: 101, current: 102, events: [101, 102], links: [102] },
  ])("returns named 503 for dangling $name references in migrated SQLite", async ({ first, current, events, links }) => {
    const { db } = seedIncident(first, current, events, links);
    for (const query of ["?active=true", "?active=true&stablecoin=usdt-tether"]) {
      const res = await call(db, query);
      expect(await readJsonResponse(res, 503)).toEqual({ error: "Canonical incident history unavailable", reason: "incident-projection-dangling-reference" });
      expect(res.headers.get("Cache-Control")).toBe("no-store");
    }
  });

  it.each([101, 102])("publishes valid canonical cohorts with current event %s in migrated SQLite", async (current) => {
    const { db } = seedIncident(101, current, current === 101 ? [101] : [101, 102]);
    const body = await readJsonResponse(await call(db, "?active=true&stablecoin=usdt-tether"), 200) as { events: Array<Record<string, unknown>>; total: number };
    expect(body.total).toBe(1);
    expect(body.events).toEqual([expect.objectContaining({ id: current, startedAt: 1_700_000_000, startPrice: 0.97, constituentEventCount: current === 101 ? 1 : 2 })]);
  });

  it.each([
    { label: "live native heuristic", source: "live", quoteMode: null },
    { label: "backfilled native provenance", source: "backfill", quoteMode: "native-peg" },
  ])("keeps each observation in its own quote domain ($label)", async ({ source, quoteMode }) => {
    const { sqlite, db } = fixtures.open(), key = `ddr2:${"c".repeat(32)}`;
    const insertEvent = sqlite.prepare(`INSERT INTO depeg_events (id, stablecoin_id, symbol, peg_type, direction, peak_deviation_bps, started_at, start_price, peak_price, peg_reference, source)
      VALUES (?, 'pht-pht', 'PHT', 'peggedPHP', 'below', ?, ?, ?, ?, ?, ?)`);
    insertEvent.run(101, -400, 1_700_000_000, 0.0162, 0.01584, 0.016472576, "live");
    sqlite.prepare("UPDATE depeg_events SET peak_peg_reference = 0.0165, peak_quote_domain = 'usd' WHERE id = 101").run();
    insertEvent.run(102, -159, 1_700_001_000, 0.9844, 0.9841, 1, source);
    if (quoteMode != null) sqlite.prepare("INSERT INTO depeg_event_provenance (event_id, source_kind, quote_mode, public_json, created_at, updated_at) VALUES (102, 'backfill', ?, ?, 1700001000, 1700001000)").run(quoteMode, JSON.stringify({ quoteMode }));
    for (const id of [101, 102]) sqlite.prepare(LINK_SQL).run(key, id, 1700002000);
    sqlite.prepare(`INSERT INTO depeg_resolver_incidents (incident_key, stablecoin_id, peg_currency, direction, first_event_id, current_event_id,
      first_started_at, current_started_at, first_observed_peak_bucket_bps, source_fingerprint, created_at, updated_at)
      VALUES (?, 'pht-pht', 'PHP', 'below', 101, 102, 1700000000, 1700001000, 400, ?, 1700000000, 1700001000)`).run(key, "d".repeat(64));
    const body = await readJsonResponse(await call(db, "?active=true&stablecoin=pht-pht"), 200) as { events: Array<Record<string, unknown>>; total: number };
    expect(body.total).toBe(1);
    expect(body.events).toEqual([expect.objectContaining({
      id: 102, startedAt: 1_700_000_000, startPrice: 0.9844, pegReference: 1, peakDeviationBps: -400,
      peakPrice: 0.01584, peakPegReference: 0.0165, peakQuoteDomain: "usd", constituentEventCount: 2,
    })]);
  });

  it("keeps canonical active identity distinct from closed same-coin episodes", async () => {
    const { sqlite, db } = seedIncident(101, 102, [101, 102]);
    for (const [id, reason] of [[103, "recovered-primary"], [104, "coverage-lost-supply"], [105, "superseded-direction"]] as const) {
      sqlite.prepare(`INSERT INTO depeg_events (id, stablecoin_id, symbol, peg_type, direction, peak_deviation_bps, started_at, ended_at, start_price, peg_reference, recovery_price, close_reason, source)
        VALUES (?, 'usdt-tether', 'USDT', 'peggedUSD', 'below', 300, ?, 1699991000, .97, 1, ?, ?, 'live')`).run(id, 1_699_990_000 + id, reason === "recovered-primary" ? 1 : null, reason);
    }
    const body = DepegEventsResponseSchema.parse(await readJsonResponse(await call(db, "?active=true&includeTotal=false&limit=1"), 200));
    expect(body.events.map(({ id }) => id)).toEqual([102]);
    expect(body.events[0]).toMatchObject({ startedAt: 1_700_000_000, constituentEventCount: 2, endedAt: null });
    expect(body.events[0]).not.toHaveProperty("constituentEventIds");
    expect(body.nextCursor).toBeNull();
  });

  it("publishes a genuinely empty active cohort in migrated SQLite", async () => {
    expect(await readJsonResponse(await call(fixtures.open().db, "?active=true"), 200)).toMatchObject({ events: [], total: 0 });
  });

  it.each([true, false])("pages interleaved public onsets with stable ties and methodology asOf (includeTotal=%s)", async (includeTotal) => {
    const { sqlite, db } = seedIncident(101, 102, [101, 102]);
    for (const [id, onset] of [[103, 1_700_000_500], [104, 1_700_000_000], [105, 1_699_999_000]]) {
      sqlite.prepare(`INSERT INTO depeg_events (id, stablecoin_id, symbol, peg_type, direction, peak_deviation_bps, started_at, start_price, peg_reference, source)
        VALUES (?, 'usdt-tether', 'USDT', 'peggedUSD', 'below', 200, ?, .98, 1, ?)`).run(id, onset, id === 104 ? "backfill" : "live");
    }
    for (const filter of ["", "&stablecoin=usdt-tether&active=true"]) {
      let cursor: string | null = null;
      const ids: number[] = [];
      for (const [id, onset] of [[103, 1_700_000_500], [104, 1_700_000_000], [102, 1_700_000_000], [105, 1_699_999_000]]) {
        const body = DepegEventsResponseSchema.parse(await readJsonResponse(await call(db, `?limit=1&includeTotal=${includeTotal}${filter}${cursor ? `&cursor=${cursor}` : ""}`), 200));
        expect(body.events.map((event) => event.id)).toEqual([id]);
        expect(body.events[0]?.startedAt).toBe(onset);
        expect(body.methodology?.asOf).toBe(onset);
        expect(body.totalExact).toBe(includeTotal);
        expect(body.total).toBe(includeTotal ? 4 : id === 105 ? 1 : 2);
        if (body.nextCursor) expect(JSON.parse(atob(body.nextCursor))).toEqual({ v: 2, values: [onset, id] });
        if (id === 102) expect(body.events[0]?.constituentEventCount).toBe(2);
        ids.push(body.events[0]!.id);
        cursor = body.nextCursor ?? null;
        expect(cursor === null).toBe(id === 105);
      }
      expect(ids).toEqual([103, 104, 102, 105]);
      const offsetBody = DepegEventsResponseSchema.parse(await readJsonResponse(await call(db, `?limit=1&offset=2&includeTotal=${includeTotal}${filter}`), 200));
      expect(offsetBody.events[0]?.id).toBe(102);
      expect(offsetBody.total).toBe(4);
    }
  });

  it.each([
    { includeTotal: true, nextId: 103 }, { includeTotal: false, nextId: 103 },
    { includeTotal: true, nextId: 999 }, { includeTotal: false, nextId: 999 },
  ])("keeps pointer advance coherent or fails closed (includeTotal=$includeTotal, current=$nextId)", async ({ includeTotal, nextId }) => {
    const { sqlite, key } = seedIncident(101, 102, [101, 102, 103], [101, 102, 103]);
    let advanced = false;
    const advance = () => {
      if (advanced) return;
      sqlite.exec("BEGIN IMMEDIATE");
      sqlite.prepare("INSERT OR IGNORE INTO depeg_resolver_incident_event_links (incident_key, event_id, relation, linked_at) VALUES (?, ?, 'observed', 1700002000)").run(key, nextId);
      sqlite.prepare("UPDATE depeg_resolver_incidents SET current_event_id = ?, current_started_at = 1700002000 WHERE incident_key = ?").run(nextId, key);
      sqlite.exec("COMMIT");
      advanced = true;
    };
    const executed: string[] = [];
    const db = createSqliteD1(sqlite, { onAll: (sql) => { if (sql.includes("pharos:depeg-event-projection:active-incidents")) advance(); }, onRun: (sql) => { executed.push(sql); } });
    const batch = db.batch.bind(db);
    const batchSpy = vi.spyOn(db, "batch").mockImplementation((statements) => { expect(statements).toHaveLength(includeTotal ? 4 : 2); advance(); return batch(statements); });
    const res = await call(db, `?active=true&includeTotal=${includeTotal}`);
    expect(batchSpy).toHaveBeenCalledTimes(1);
    expect(executed.map((sql) => sql.match(/pharos:[\w:-]+/)?.[0])).toEqual([
      "pharos:depeg-event-projection:active-incidents",
      ...(includeTotal ? ["pharos:depeg-events:count-summary", "pharos:depeg-events:count"] : []),
      "pharos:depeg-events:page",
    ]);
    expect(advanced).toBe(true);
    if (nextId === 999) {
      expect(await readJsonResponse(res, 503)).toEqual({ error: "Canonical incident history unavailable", reason: "incident-projection-dangling-reference" });
      expect(res.headers.get("Cache-Control")).toBe("no-store");
    } else {
      const body = DepegEventsResponseSchema.parse(await readJsonResponse(res, 200));
      expect(body.events).toEqual([expect.objectContaining({ id: 103, startedAt: 1_700_000_000, startPrice: .97, constituentEventCount: 3 })]);
      expect(body.total).toBe(1);
      expect(body.methodology?.asOf).toBe(1_700_000_000);
    }
  });

  it("exposes closeReason for terminal depeg rows", async () => {
    const db = mockEvents([makeDepegRow({ ended_at: 1_800_000_000, recovery_price: null, close_reason: "coverage-lost-supply" })], 1);
    expect(DepegEventsResponseSchema.parse(await (await call(db)).json()).events[0]?.closeReason).toBe("coverage-lost-supply");
  });

  it("maps optional provenance JSON while preserving legacy rows", async () => {
    const db = mockEvents([
      { ...row, provenance_json: JSON.stringify({ sourceKind: "market", replayRunId: "run-1", confidenceTier: "medium", auditVerdict: "confirmed" }) },
      { ...row, id: 2 },
    ], 2);
    const body = (await (await call(db)).json()) as { events: Array<Record<string, unknown>> };
    expect(body.events[0]?.provenance).toMatchObject({ sourceKind: "market", replayRunId: "run-1", confidenceTier: "medium", auditVerdict: "confirmed" });
    expect(body.events[1]?.provenance).toBeNull();
  });

  it("returns 200 with empty results when no data", async () => {
    const body = (await readJsonResponse(await call(mockEvents([], 0)), 200)) as { events: unknown[]; total: number };
    expect(body.events).toHaveLength(0);
    expect(body.total).toBe(0);
  });

  registerStablecoinParameterContract({ name: "depeg events", path: "/api/depeg-events", invoke: handleDepegEvents, cases: [{ kind: "unknown", stablecoin: "<script>" }] });

  it("filters active events", async () => {
    const db = mockEvents([makeDepegRow({ ended_at: null })], 1);
    const body = (await readJsonResponse(await call(db, "?active=true"), 200)) as { events: unknown[]; total: number };
    expect(body.events).toHaveLength(1);
    expect(body.total).toBe(1);
    expect(db.getHistory().find((entry) => entry.sql.includes("pharos:depeg-events:page"))?.sql).toContain("ended_at IS NULL");
  });

  it("rejects malformed active booleans instead of silently treating them as false", async () => {
    const res = await call(mockD1([]), "?active=yes");
    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toEqual({ error: "Invalid active: must be true or false" });
  });

  it("counts a superseded alias's linked rows in the projected public incident", async () => {
    const { sqlite, db } = fixtures.open(), canonicalKey = `ddr2:${"a".repeat(32)}`, aliasKey = `ddr2:${"b".repeat(32)}`;
    const insertEvent = sqlite.prepare("INSERT INTO depeg_events (id, stablecoin_id, symbol, peg_type, direction, peak_deviation_bps, started_at, ended_at, start_price, peg_reference, source) VALUES (?, 'apxusd-apyx', 'apxUSD', 'peggedUSD', 'below', 635, ?, ?, ?, 1, 'live')");
    insertEvent.run(90089, 1_780_671_044, 1_781_624_981, 0.9365);
    insertEvent.run(90203, 1_781_632_159, null, 0.94);
    const insertLink = sqlite.prepare(LINK_SQL);
    insertLink.run(canonicalKey, 90089, 1781632160);
    insertLink.run(aliasKey, 90203, 1781632160);
    const insertIncident = sqlite.prepare(ALIAS_INC_SQL);
    insertIncident.run(canonicalKey, "apxusd-apyx", "USD", "below", 90089, 90089, 1_780_671_044, 1_780_671_044, 635, "active", null, "a".repeat(64), 1781632160, 1781632160);
    insertIncident.run(aliasKey, "apxusd-apyx", "USD", "below", 90203, 90203, 1_781_632_159, 1_781_632_159, 635, "superseded", canonicalKey, "b".repeat(64), 1781632160, 1781632160);
    const body = await readJsonResponse(await call(db, "?stablecoin=apxusd-apyx&includeTotal=false"), 200) as { events: Array<Record<string, unknown>> };
    expect(body.events).toEqual([expect.objectContaining({ id: 90203, startedAt: 1_780_671_044, constituentEventCount: 2 })]);
  });

  it("excludes a superseded alias's non-current links from the public incident page", async () => {
    const { sqlite, db } = fixtures.open(), canonicalKey = `ddr2:${"a".repeat(32)}`, aliasKey = `ddr2:${"b".repeat(32)}`;
    const insertEvent = sqlite.prepare("INSERT INTO depeg_events (id, stablecoin_id, symbol, peg_type, direction, peak_deviation_bps, started_at, ended_at, start_price, peak_price, peg_reference, source) VALUES (?, 'apxusd-apyx', 'apxUSD', 'peggedUSD', 'below', ?, ?, ?, ?, ?, 1, 'live')");
    insertEvent.run(91001, 635, 1_780_671_044, 1_781_000_000, 0.9365, 0.9201);
    insertEvent.run(91002, 612, 1_781_000_001, null, 0.9391, 0.9385);
    insertEvent.run(91003, 540, 1_782_000_000, 1_782_500_000, 0.9458, 0.9461);
    insertEvent.run(91004, 588, 1_782_500_001, null, 0.9412, 0.9408);
    const insertLink = sqlite.prepare(LINK_SQL);
    for (const eventId of [91001, 91002]) insertLink.run(canonicalKey, eventId, 1782600000);
    for (const eventId of [91003, 91004]) insertLink.run(aliasKey, eventId, 1782600000);
    const insertIncident = sqlite.prepare(ALIAS_INC_SQL);
    insertIncident.run(canonicalKey, "apxusd-apyx", "USD", "below", 91001, 91002, 1_780_671_044, 1_781_000_001, 635, "active", null, "a".repeat(64), 1782600000, 1782600000);
    insertIncident.run(aliasKey, "apxusd-apyx", "USD", "below", 91003, 91004, 1_782_000_000, 1_782_500_001, 540, "superseded", canonicalKey, "b".repeat(64), 1782600000, 1782600000);
    const body = await readJsonResponse(await call(db, "?stablecoin=apxusd-apyx"), 200) as { total: number; events: Array<{ id: number; startedAt: number; constituentEventCount: number }> };
    expect({ total: body.total, events: body.events.map(({ id, startedAt, constituentEventCount }) => ({ id, startedAt, constituentEventCount })) })
      .toEqual({ total: 1, events: [{ id: 91004, startedAt: 1_780_671_044, constituentEventCount: 4 }] });
  });

  it("collapses every link of multiple superseded aliases into one canonical public incident", async () => {
    const { sqlite, db } = fixtures.open(), canonicalKey = `ddr2:${"a".repeat(32)}`, aliasKeys = [`ddr2:${"b".repeat(32)}`, `ddr2:${"c".repeat(32)}`];
    const insertEvent = sqlite.prepare("INSERT INTO depeg_events (id, stablecoin_id, symbol, peg_type, direction, peak_deviation_bps, started_at, ended_at, start_price, peg_reference, source) VALUES (?, 'apxusd-apyx', 'apxUSD', 'peggedUSD', 'below', 635, ?, ?, ?, 1, 'live')");
    insertEvent.run(101, 1_780_671_044, 1_781_000_000, 0.9365);
    insertEvent.run(102, 1_781_000_001, null, 0.9391);
    insertEvent.run(201, 1_782_000_000, 1_782_500_000, 0.9458);
    insertEvent.run(301, 1_782_600_000, null, 0.9412);
    const insertLink = sqlite.prepare(LINK_SQL);
    for (const eventId of [101, 102]) insertLink.run(canonicalKey, eventId, 1782600000);
    insertLink.run(aliasKeys[0], 201, 1782600000);
    insertLink.run(aliasKeys[1], 301, 1782600000);
    const insertIncident = sqlite.prepare(ALIAS_INC_SQL);
    insertIncident.run(canonicalKey, "apxusd-apyx", "USD", "below", 101, 102, 1_780_671_044, 1_781_000_001, 635, "active", null, "a".repeat(64), 1782600000, 1782600000);
    insertIncident.run(aliasKeys[0], "apxusd-apyx", "USD", "below", 201, 201, 1_782_000_000, 1_782_000_000, 635, "superseded", canonicalKey, "b".repeat(64), 1782600000, 1782600000);
    insertIncident.run(aliasKeys[1], "apxusd-apyx", "USD", "below", 301, 301, 1_782_600_000, 1_782_600_000, 635, "superseded", canonicalKey, "c".repeat(64), 1782600000, 1782600000);
    const body = await readJsonResponse(await call(db, "?stablecoin=apxusd-apyx"), 200) as { total: number; events: Array<{ id: number; startedAt: number; constituentEventCount: number }> };
    expect({ total: body.total, events: body.events.map(({ id, startedAt, constituentEventCount }) => ({ id, startedAt, constituentEventCount })) })
      .toEqual({ total: 1, events: [{ id: 301, startedAt: 1_780_671_044, constituentEventCount: 4 }] });
  });

  it.each([960, -960])("keeps the newer effective row and publishes an older alias's %s bps peak", async (peak) => {
    const { sqlite, db } = fixtures.open(), direction = peak < 0 ? "below" : "above";
    const currentPeak = Math.sign(peak) * 437, peakPrice = peak < 0 ? 0.60568 : 0.73432, onsetPeak = Math.sign(peak) * 400;
    const canonicalKey = `ddr2:${"a".repeat(32)}`, aliasKey = `ddr2:${"b".repeat(32)}`;
    const insertEvent = sqlite.prepare("INSERT INTO depeg_events (id, stablecoin_id, symbol, peg_type, direction, peak_deviation_bps, started_at, ended_at, start_price, peg_reference, source) VALUES (?, 'audd-novatti', 'AUDD', 'peggedAUD', ?, ?, ?, ?, ?, 0.67, 'live')");
    insertEvent.run(101, direction, onsetPeak, 1_780_671_044, 1_781_000_000, 0.65);
    insertEvent.run(103, direction, Math.abs(peak), 1_782_000_000, 1_782_500_000, 0.65);
    insertEvent.run(104, direction, currentPeak, 1_783_000_000, null, 0.65);
    const insertLink = sqlite.prepare(LINK_SQL);
    for (const eventId of [101, 104]) insertLink.run(canonicalKey, eventId, 1783000000);
    insertLink.run(aliasKey, 103, 1783000000);
    const insertIncident = sqlite.prepare(ALIAS_INC_SQL);
    insertIncident.run(canonicalKey, "audd-novatti", "AUD", direction, 101, 104, 1_780_671_044, 1_783_000_000, 400, "active", null, "a".repeat(64), 1783000000, 1783000000);
    insertIncident.run(aliasKey, "audd-novatti", "AUD", direction, 103, 103, 1_782_000_000, 1_782_000_000, 400, "superseded", canonicalKey, "b".repeat(64), 1783000000, 1783000000);
    sqlite.prepare("UPDATE depeg_events SET peak_price = ?, peg_reference = 0, peak_peg_reference = 0.67, peak_quote_domain = 'usd' WHERE id = 103").run(peakPrice);
    const body = DepegEventsResponseSchema.parse(await readJsonResponse(await call(db, "?stablecoin=audd-novatti&active=true"), 200));
    expect({ total: body.total, events: body.events }).toEqual({ total: 1, events: [expect.objectContaining({
      id: 104, startedAt: 1_780_671_044, endedAt: null, constituentEventCount: 3, peakDeviationBps: peak,
      peakPrice, peakPegReference: 0.67, peakQuoteDomain: "usd", onsetFragmentPeakBps: onsetPeak, currentFragmentPeakBps: currentPeak,
    })] });
    sqlite.exec(`UPDATE depeg_events SET peak_price = -1, peak_peg_reference = 1, peak_quote_domain = 'usd' WHERE id = 103;
      INSERT INTO depeg_events (id, stablecoin_id, symbol, peg_type, direction, peak_deviation_bps, started_at, start_price, peg_reference)
      VALUES (105, 'usdt-tether', 'USDT', 'peggedUSD', 'below', -300, 1783000000, 0.97, 1)`);
    const readLedger = async () => DepegEventsResponseSchema.parse(await readJsonResponse(await call(db), 200));
    const invalidQuote = await readLedger();
    expect(invalidQuote.events.map(({ id }) => id)).toEqual([105, 104]);
    expect(invalidQuote.events[1]).toMatchObject({ peakDeviationBps: peak, peakPrice: null });
    expect(invalidQuote.events[1]).not.toHaveProperty("peakPegReference");

    const sample = { basis: "peer-relative", observedAt: 1_782_100_000, price: peakPrice, pegReference: 0.67, bps: peak };
    sqlite.prepare(`UPDATE depeg_events SET peak_price = ?, peak_peg_reference = 0.67, peer_basis_json = ?,
      admitted_coverage_json = '[{"fromSec":1782000000,"toSec":1782100000}]' WHERE id = 103`)
      .run(peakPrice, JSON.stringify({ onset: sample, peak: sample }));
    expect((await readLedger()).events[1]).toMatchObject({
      peakPeerMedianUsd: 0.67, admittedCoverage: [{ fromSec: 1_782_000_000, toSec: 1_782_100_000 }],
    });
    for (const endedAt of ["x'61'", "'invalid close'"]) {
      sqlite.exec(`UPDATE depeg_events SET ended_at = ${endedAt} WHERE id = 103`);
      const events = (await readLedger()).events;
      expect(events).toMatchObject([{ id: 105 }, { id: 104, peakDeviationBps: peak, peakPrice, admittedCoverage: [] }]);
      expect(events[1]).not.toHaveProperty("peakBasis");
    }
    sqlite.exec(`UPDATE depeg_events SET ended_at = 1782500000, peer_basis_json = NULL,
      admitted_coverage_json = NULL WHERE id = 103`);

    for (const assignment of ["peak_price = x'61'", "peak_peg_reference = x'61', peak_quote_domain = NULL",
      "peak_quote_domain = x'61', peak_peg_reference = NULL", "peg_reference = x'61', peak_peg_reference = NULL, peak_quote_domain = NULL"]) {
      sqlite.prepare(`UPDATE depeg_events SET peak_price = ?, peg_reference = 0.67,
        peak_peg_reference = 0.67, peak_quote_domain = 'usd' WHERE id = 103`).run(peakPrice);
      sqlite.exec(`UPDATE depeg_events SET ${assignment} WHERE id = 103`);
      const malformedQuote = (await readLedger()).events[1];
      expect(malformedQuote).toMatchObject({ peakDeviationBps: peak, peakPrice: null });
      expect(malformedQuote).not.toHaveProperty("peakQuoteDomain");
    }
    sqlite.exec("UPDATE depeg_events SET peg_reference = 0, peak_peg_reference = 0.67, peak_quote_domain = 'usd' WHERE id = 103");
    sqlite.exec("UPDATE depeg_events SET peer_basis_json = x'61' WHERE id IN (101, 103)");
    expect((await readLedger()).events[1]).toMatchObject({ peakDeviationBps: peak, peakPrice, peakQuoteDomain: "usd" });

    sqlite.exec("UPDATE depeg_events SET pending_reason = x'61' WHERE id IN (101, 103)");
    expect((await readLedger()).events).toMatchObject([{ id: 105 }, { id: 104, peakDeviationBps: peak, peakPrice }]);

    sqlite.exec(`UPDATE depeg_events SET peg_type = x'61' WHERE id IN (101, 103);
      UPDATE depeg_events SET peg_reference = 1 WHERE id = 101`);
    expect((await readLedger()).events).toMatchObject([
      { id: 105 }, { id: 104, pegReference: 0.67, peakDeviationBps: peak, peakPrice, peakPegReference: 0.67, peakQuoteDomain: "usd" },
    ]);
    sqlite.exec("UPDATE depeg_events SET start_price = 0.64, pending_reason = 'peer-relative' WHERE id = 104");
    expect((await readLedger()).events[1]).toMatchObject({
      startPrice: 0.64, pegReference: 0.67, onsetBasis: "peer-relative",
    });
    sqlite.exec("UPDATE depeg_events SET start_price = 0.65, pending_reason = NULL WHERE id = 104");

    sqlite.exec(`UPDATE depeg_events SET peg_type = 'peggedAUD', peg_reference = 0.67 WHERE id = 101;
      UPDATE depeg_events SET peg_type = 'peggedAUD', peak_peg_reference = NULL,
      peak_quote_domain = NULL, peg_reference = 0.67 WHERE id = 103`);
    expect((await readLedger()).events[1]).toMatchObject({ peakDeviationBps: peak, peakPrice, peakQuoteDomain: "usd" });

    sqlite.exec("UPDATE depeg_events SET peak_peg_reference = 1, peak_quote_domain = 'native-peg' WHERE id = 103");
    const uncertainQuote = (await readLedger()).events[1];
    expect(uncertainQuote).toMatchObject({ peakDeviationBps: peak, peakPrice: null });
    expect(uncertainQuote).not.toHaveProperty("peakQuoteDomain");

    for (const value of ["'invalid bps'", "1e999", "-1e999", "-9223372036854775808", `${Number.MAX_VALUE}`]) {
      sqlite.exec(`UPDATE depeg_events SET peak_deviation_bps = ${value} WHERE id = 103`);
      expect((await readLedger()).events).toMatchObject([{ id: 105 }, { id: 104, peakDeviationBps: currentPeak }]);
    }

    sqlite.prepare("UPDATE depeg_events SET peak_deviation_bps = ? WHERE id = 103").run(peak);
    for (const value of ["'400 bps'", "1e100", "-1e100"]) {
      sqlite.exec(`UPDATE depeg_events SET peak_deviation_bps = ${value} WHERE id = 101`);
      const malformedOnset = await readLedger();
      expect(malformedOnset.events.map(({ id }) => id)).toEqual([105, 104]);
      expect(malformedOnset.events[1]).toMatchObject({ peakDeviationBps: peak, onsetFragmentPeakBps: null });
    }

    sqlite.exec(`INSERT INTO depeg_event_provenance (event_id, source_kind, audit_verdict, created_at, updated_at)
      VALUES (103, 'live', 'false_positive', 1783000000, 1783000000)`);
    expect((await readLedger()).events[1]).toMatchObject({ id: 104, peakDeviationBps: currentPeak });

    // Simulate an unknown verdict preserved from before the vocabulary migration.
    sqlite.exec(`DROP TRIGGER trg_depeg_provenance_audit_verdict_update_guard;
      UPDATE depeg_events SET peak_deviation_bps = ${Math.sign(peak) * 600} WHERE id = 101`);
    const updateVerdict = sqlite.prepare("UPDATE depeg_event_provenance SET audit_verdict = ?, public_json = ? WHERE event_id = 103");
    for (const verdict of [
      ["unknown", null],
      ["confirmed", '{"auditVerdict":"unknown"}'],
      ["confirmed", '{"auditVerdict":"confirmed","auditVerdict":"unknown"}'],
    ] as const) {
      updateVerdict.run(...verdict);
      expect((await readLedger()).events[1]).toMatchObject({ peakDeviationBps: Math.sign(peak) * 600 });
    }

    sqlite.exec(`UPDATE depeg_event_provenance SET audit_verdict = NULL, public_json = NULL, quote_mode = x'61' WHERE event_id = 103;
      UPDATE depeg_events SET peak_peg_reference = NULL, peak_quote_domain = NULL WHERE id = 103`);
    expect((await readLedger()).events[1]).toMatchObject({ peakDeviationBps: peak, peakPrice: null });

    const legacyPeakPrice = 1 + peak / 10_000;
    sqlite.prepare("UPDATE depeg_events SET peg_reference = 1, peak_price = ? WHERE id = 103").run(legacyPeakPrice);
    sqlite.exec(`UPDATE depeg_event_provenance SET quote_mode = NULL, public_json = '{"quoteMode":"usd"}' WHERE event_id = 103`);
    expect((await readLedger()).events[1]).toMatchObject({ peakDeviationBps: peak, peakPrice: legacyPeakPrice, peakQuoteDomain: "usd" });

    sqlite.exec(`UPDATE depeg_events SET peg_type = 'unknown' WHERE id = 103;
      UPDATE depeg_event_provenance SET public_json = NULL WHERE event_id = 103`);
    const unknownQuote = (await readLedger()).events[1];
    expect(unknownQuote).toMatchObject({ peakDeviationBps: peak, peakPrice: null });
    expect(unknownQuote).not.toHaveProperty("peakQuoteDomain");
  });

  it("uses the same validated opening quote provenance for both fragments", async () => {
    const start = 1_794_647_828;
    const { sqlite, db } = seedIncident(101, 102, [101, 102], undefined, ["audd-novatti", "AUDD", "AUD"], start);
    sqlite.exec(`UPDATE depeg_events SET source = 'live', start_price = CASE id WHEN 101 THEN 0.65 ELSE 0.9563 END;
      UPDATE depeg_events SET peak_deviation_bps = CASE id WHEN 101 THEN -960 ELSE -437 END;
      UPDATE depeg_events SET peak_price = 0.60568, peak_peg_reference = 0.67, peak_quote_domain = 'usd' WHERE id = 101;
      INSERT INTO depeg_event_provenance (event_id, source_kind, quote_mode, public_json, created_at, updated_at)
        VALUES (101, 'live', NULL, '{"quoteMode":"usd"}', 1700000000, 1700000000),
               (102, 'live', NULL, NULL, 1700001000, 1700001000)`);
    const readOpening = async () => DepegEventsResponseSchema.parse(await readJsonResponse(
      await handleDepegEvents(db, new URL("https://x/api/depeg-events?stablecoin=audd-novatti")), 200,
    )).events[0];
    const open = await readOpening();
    expect(open).toMatchObject({ startPrice: 0.9563, pegReference: 1, onsetQuoteFromLaterFragment: true });
    sqlite.exec(`UPDATE depeg_event_provenance SET quote_mode = 'native-peg', public_json = '{"quoteMode":"usd"}' WHERE event_id = 102`);
    expect(await readOpening()).toMatchObject({
      startPrice: 0.9563, pegReference: 1, onsetQuoteDomain: "native-peg", provenance: { quoteMode: "usd" },
    });
    sqlite.exec("UPDATE depeg_event_provenance SET quote_mode = CASE event_id WHEN 101 THEN x'61' ELSE 'unknown' END");
    expect(await readOpening()).toMatchObject({ startPrice: 0.65, pegReference: 1, onsetQuoteDomain: "usd", provenance: { quoteMode: "usd" } });
    sqlite.exec(`UPDATE depeg_event_provenance SET quote_mode = NULL, public_json = NULL WHERE event_id = 102;
      UPDATE depeg_events SET peg_reference = 0.67 WHERE id = 102`);
    const firstOpening = await readOpening();
    expect(firstOpening).toMatchObject({ startPrice: 0.65, pegReference: 1, onsetQuoteDomain: "usd", provenance: null });
    expect(firstOpening).not.toHaveProperty("onsetQuoteFromLaterFragment");

    sqlite.exec(`UPDATE depeg_events SET peg_type = 'unknown' WHERE id = 101;
      UPDATE depeg_events SET peg_reference = 1 WHERE id = 102;
      UPDATE depeg_event_provenance SET quote_mode = NULL, public_json = NULL WHERE event_id = 101;
      UPDATE depeg_event_provenance SET quote_mode = 'native-peg' WHERE event_id = 102`);
    expect.soft(await readOpening()).toMatchObject({
      startPrice: 0.9563, pegReference: 1, onsetQuoteDomain: "native-peg", onsetQuoteFromLaterFragment: true,
    });

    sqlite.prepare("UPDATE depeg_events SET ended_at = ?, recovery_price = 1 WHERE id = 102").run(start + 1200);
    const closed = await readOpening();
    expect.soft(closed).toMatchObject({ startedAt: start, endedAt: start + 1200, peakDeviationBps: -960,
      peakPrice: 0.60568, peakPegReference: 0.67, peakQuoteDomain: "usd" });
    const pages = execFileSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", `
      import { readFileSync } from "node:fs";
      import { buildNoindexDepegEventSlugs, selectStaticDepegEventPages } from "./src/lib/depeg-event-config.ts";
      import { buildDepegEventDescription } from "./src/lib/depeg-event-display.ts";
      const events = JSON.parse(readFileSync(0, "utf8"));
      console.log(JSON.stringify(events.map(event => [
        selectStaticDepegEventPages([event]).length === 1 && !buildNoindexDepegEventSlugs([event]).has(event.slug),
        buildDepegEventDescription(event, false, "AUDD").length,
      ])));
    `], { cwd: new NodeURL("../../../../", import.meta.url), input: JSON.stringify([open, closed].map(event => ({
      ...event, slug: "audd-2026-11-14-down",
    }))), encoding: "utf8" });
    const [[openIndexable, openDescriptionLength], [closedIndexable]] = JSON.parse(pages);
    expect.soft(openIndexable).toBe(true);
    expect.soft(openDescriptionLength).toBeGreaterThanOrEqual(110);
    expect.soft(openDescriptionLength).toBeLessThanOrEqual(180);
    expect(closedIndexable).toBe(true);
  });

  it("dates the detector start separately from a later peer-relative EURC quote", async () => {
    const { sqlite, db } = seedIncident(101, 102, [101, 102], undefined, ["eurc-circle", "EURC", "EUR"]);
    const peak = { basis: "peer-relative", observedAt: 1_700_001_500, price: 0.975996, pegReference: 1.08, bps: -963 };
    sqlite.exec("UPDATE depeg_events SET source = 'live' WHERE id = 101");
    sqlite.prepare(`UPDATE depeg_events SET start_price = 1.03, peg_reference = 1.08, pending_reason = 'peer-relative',
      peak_deviation_bps = -963, peak_price = ?, peak_peg_reference = 1.08, peak_quote_domain = 'usd', peer_basis_json = ?
      WHERE id = 102`).run(peak.price, JSON.stringify({ peak }));
    const { events: [event] } = DepegEventsResponseSchema.parse(await readJsonResponse(
      await handleDepegEvents(db, new URL("https://x/api/depeg-events?stablecoin=eurc-circle")), 200,
    ));
    expect(event).toMatchObject({ startedAt: 1_700_000_000, onsetBasis: "peer-relative", onsetQuoteFromLaterFragment: true,
      peakBasis: "peer-relative", peakDeviationBps: -963 });
    // Pass the API row to a Pages-side process across the JSON boundary.
    const copy = execFileSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", `
      import { readFileSync } from "node:fs";
      import { buildDepegEventSynopsis, buildDepegEventDescription } from "./src/lib/depeg-event-display.ts";
      const event = JSON.parse(readFileSync(0, "utf8"));
      console.log(JSON.stringify([buildDepegEventSynopsis(event), buildDepegEventDescription(event, true)]));
    `], { cwd: new NodeURL("../../../../", import.meta.url), input: JSON.stringify({ ...event, slug: "eurc-test" }), encoding: "utf8" });
    expect(JSON.parse(copy)).toEqual([
      expect.stringMatching(/Detector start recorded on November 14, 2023 at 22:13 UTC\. Recorded peak deviation was 9\.63% below the peer median/),
      expect.stringMatching(/EURC detector start recorded at 22:13 UTC on November 14, 2023\. The peak was 9\.63% below the peer median/),
    ]);
  });

  it.each([0, 0.9893])("projects observed first-event price %s without replacing zero", async (startPrice) => {
    const currentRow = makeDepegRow({ id: 90089, stablecoin_id: "apxusd-apyx", started_at: 1_780_671_044, start_price: 0.9365 });
    const db = mockD1([
      { match: "FROM depeg_resolver_incidents incidents", matchBinds: ["apxusd-apyx"], rows: [{
        current_event_id: 90089, first_started_at: 1_780_437_028, first_start_price: startPrice,
        first_peg_reference: 1, constituent_event_count: 4, references_valid: 1, incident_peak_json: null,
      }] },
      { match: "pharos:depeg-events:count", rows: [{ total: 1 }] },
      { match: "FROM depeg_events_with_provenance", rows: [currentRow] },
    ]) as MockD1Database;
    const body = (await readJsonResponse(await handleDepegEvents(db, new URL("https://x/api/depeg-events?stablecoin=apxusd-apyx")), 200)) as { events: Array<Record<string, unknown>> };
    expect(body.events[0]).toMatchObject({ id: 90089, startedAt: 1_780_437_028, startPrice, pegReference: 1, constituentEventCount: 4 });
  });

  it("uses latest successful sync timestamp for freshness headers", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-15T12:00:00Z"));
    const now = Math.floor(Date.now() / 1000);
    const db = mockEvents([makeDepegRow({ started_at: now - 7 * 86400 })], 1, [{ match: "cron_runs", rows: [], first: { started_at: now - 45 } }]);
    const res = await handleDepegEvents(db, new URL("https://x/api/depeg-events"));
    expect(res.headers.get("X-Data-Age")).toBe("45");
  });

  it("rejects oversized limits instead of coercing them and allows limit=5000 only on site-api", async () => {
    for (const lane of [undefined, "public-api"] as const) {
      const db = mockD1([{ match: "pharos:depeg-event-projection:active-incidents", rows: [] }]);
      const res = await handleDepegEvents(db, new URL("https://x/api/depeg-events?limit=1001"), lane);
      expect(res.status).toBe(400);
      await expect(res.json()).resolves.toEqual({ error: "Invalid limit: must be between 1 and 1000" });
      expect(db.getHistory()).toEqual([]);
    }
    const okDb = mockEvents([row], 1);
    expect((await handleDepegEvents(okDb, new URL("https://x/api/depeg-events?limit=5000"), "site-api")).status).toBe(200);
    const badSiteDb = mockD1([{ match: "pharos:depeg-event-projection:active-incidents", rows: [] }]);
    const over = await handleDepegEvents(badSiteDb, new URL("https://x/api/depeg-events?limit=5001"), "site-api");
    expect(over.status).toBe(400);
    await expect(over.json()).resolves.toEqual({ error: "Invalid limit: must be between 1 and 5000" });
    expect((await handleDepegEvents(badSiteDb, new URL("https://x/api/depeg-events?limit=5000&ledgerGeneration=latest"), "site-api")).status).toBe(400);
    expect(badSiteDb.getHistory()).toEqual([]);
  });

  it("rejects offsets above the endpoint cap", async () => {
    const db = mockD1([{ match: "pharos:depeg-event-projection:active-incidents", rows: [] }]);
    const res = await handleDepegEvents(db, new URL("https://x/api/depeg-events?offset=50001"));
    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toEqual({ error: "Invalid offset: must be between 0 and 50000" });
    expect(db.getHistory()).toEqual([]);
  });

  it.each([
    "active=yes", "includePending=yes", "includeTotal=yes", "limit=1001", "limit=abc", "offset=50001", "offset=-1", "cursor=invalid",
    `cursor=${btoa(JSON.stringify({ v: 1, values: [1_700_000_000, 1] }))}`,
    `cursor=${btoa(JSON.stringify({ v: 2, values: [1_700_000_000, 1] }))}&offset=1`,
  ])("rejects invalid query %s before reading an unavailable incident projection", async (query) => {
    const db = mockD1([{ match: "pharos:depeg-event-projection:active-incidents", rows: [], throwError: new Error("projection read timed out") }]);
    expect((await handleDepegEvents(db, new URL(`https://x/api/depeg-events?${query}`))).status).toBe(400);
    expect(db.getHistory()).toEqual([]);
  });

  it("can skip the exact total count for cursor-style callers", async () => {
    const db = mockEvents([row], null);
    const body = (await readJsonResponse(await handleDepegEvents(db, new URL("https://x/api/depeg-events?includeTotal=false")), 200)) as { events: unknown[]; total: number; totalExact: boolean };
    expect(body.events).toHaveLength(1);
    expect(body.total).toBe(1);
    expect(body.totalExact).toBe(false);
    expect(db.getHistory().some((entry) => entry.sql.includes("depeg-events:count") || entry.sql.includes("INSERT INTO cache"))).toBe(false);
  });

  it("does not query or emit derived incident counts", async () => {
    const db = mockEvents([row], null);
    const body = (await readJsonResponse(await handleDepegEvents(db, new URL("https://x/api/depeg-events?stablecoin=usdt-tether&includeTotal=false")), 200)) as Record<string, unknown>;
    expect(body).not.toHaveProperty("counts");
    expect(db.getHistory().some((entry) => entry.sql.includes("threshold-crossing-count"))).toBe(false);
  });

  describe("aggregate original-clock availability", () => {
    it.each([
      ["trusted pool evidence", 2, 5_000_000, 60, true],
      ["ticker-only price evidence", 1, 0, 60, false],
      ["absent TVL evidence", 1, null, 60, false],
      ["malformed TVL evidence", 1, "5000000", 60, false],
      ["six-hour original", 2, 5_000_000, 21_600, false],
      ["missing original", 2, 5_000_000, null, false],
      ["original age boundary", 2, 5_000_000, 4500, false],
      ["inside original budget", 2, 5_000_000, 4499, true],
      ["future original", 2, 5_000_000, -1, false],
      ["all families available", 2, 5_000_000, 60, true, true],
      ["severe unavailable families", 2, 5_000_000, null, false, false, true],
    ] as const)("derives pending confirmation categories from %s", async (_label, count, tvl, age, dexAvailable, pool: boolean = false, extreme: boolean = false) => {
      const nowSec = 1_800_000_000, reason = extreme ? "extreme-move" : "large-cap+low-confidence";
      vi.useFakeTimers();
      vi.setSystemTime(nowSec * 1000);
      const db = mockEvents([], null, [{ match: "FROM depeg_pending", rows: [{
          id: 10, stablecoin_id: "usdt-tether", symbol: "USDT", peg_type: "peggedUSD", direction: "below",
          first_seen_bps: -180, first_seen_at: nowSec - 600, first_price: 0.982,
          last_seen_bps: -240, last_seen_at: nowSec - 120, last_price: 0.976,
          peak_seen_bps: -310, peak_price: 0.969, peg_reference: 1,
          reason, updated_at: nowSec - 120,
        }] }, { match: "FROM dex_prices", rows: [{
          stablecoin_id: "usdt-tether", source_pool_count: count, source_total_tvl: tvl, updated_at: nowSec - 60,
          price_sources_json: JSON.stringify({ aggregateObservedAt: age == null ? null : nowSec - age, sources: [] }),
        }] }, { match: "FROM dex_price_challenger_snapshots", rows: [{
          stablecoin_id: "usdt-tether", snapshot_at: nowSec - 60, has_rows: pool ? 1 : 0,
        }] }]);
      for (const filter of ["", "&stablecoin=usdt-tether"]) {
        const res = await handleDepegEvents(db,
          new URL(`https://x/api/depeg-events?includeTotal=false&includePending=true${filter}`));
        const body = DepegEventsResponseSchema.parse(await readJsonResponse(res, 200));
        expect(db.getHistory().find(({ sql }) => sql.includes("pharos:depeg-events:dex-availability"))).toMatchObject({
          sql: expect.stringContaining("price_sources_json FROM dex_prices\n         WHERE stablecoin_id IN (SELECT value FROM json_each(?))"),
          binds: [JSON.stringify(["usdt-tether"])],
        });
        expect(body.pending).toEqual([{
          stablecoinId: "usdt-tether", symbol: "USDT", direction: "below",
          firstSeenAt: nowSec - 600, lastSeenAt: nowSec - 120, firstSeenBps: -180, lastSeenBps: -240,
          peakSeenBps: -310, reason, ageSec: 600,
          expiresAt: nowSec - 600 + (extreme ? DEPEG_PENDING_SEVERE_EXPIRY_SEC :
            dexAvailable && pool ? DEPEG_PENDING_EXPIRY_SEC : DEPEG_PENDING_EXTENDED_EXPIRY_SEC),
          availableConfirmationCategories: ["offchain", ...(dexAvailable ? ["dex"] : []), ...(pool ? ["pool"] : [])],
          missingConfirmationCategories: [...(dexAvailable ? [] : ["dex"]), ...(pool ? [] : ["pool"])],
        }]);
      }
    });
  });

  it("reports pending pool availability from accepted v2 membership, retaining v1 only before a head exists", async () => {
    const nowSec = 1_800_000_000;
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(nowSec * 1000);
    const { sqlite, db } = fixtures.open();
    sqlite.prepare(`INSERT INTO depeg_pending
      (stablecoin_id, symbol, peg_type, direction, first_seen_bps, first_seen_at, first_price, peg_reference)
      VALUES ('usdt-tether', 'USDT', 'peggedUSD', 'below', -200, ?, .98, 1)`).run(nowSec - 60);
    sqlite.prepare(`INSERT INTO dex_price_challenger_snapshots
      (stablecoin_id, snapshot_at, published_at, has_rows, source_coverage_complete)
      VALUES ('usdt-tether', ?, ?, 1, 1)`).run(nowSec - 60, nowSec - 60);
    const assertAvailability = async (available: boolean) => {
      for (const filter of ["", "&stablecoin=usdt-tether"]) {
        const res = await handleDepegEvents(db,
          new URL(`https://x/api/depeg-events?includeTotal=false&includePending=true${filter}`));
        const pending = DepegEventsResponseSchema.parse(await readJsonResponse(res, 200)).pending?.[0];
        expect(pending?.availableConfirmationCategories.includes("pool")).toBe(available);
        expect(pending?.missingConfirmationCategories.includes("pool")).toBe(!available);
      }
    };
    await assertAvailability(true);
    sqlite.prepare(`INSERT INTO dex_price_challenger_publications_v2
      (publication_id, generation_id, snapshot_at, published_at) VALUES (1, 'generation', ?, ?)`)
      .run(nowSec - 60, nowSec);
    await assertAvailability(true); // Staging is not a visibility authority.
    sqlite.exec(`UPDATE dex_price_challenger_publications_v2 SET sealed = 1;
      INSERT INTO dex_price_challenger_heads_v2 (stablecoin_id, publication_id, has_rows)
      VALUES ('usdt-tether', 1, 0);`);
    await assertAvailability(false); // Accepted empty overrides fresh legacy rows.
    sqlite.exec(`INSERT INTO dex_price_challenger_payloads_v2
      (publication_id, stablecoin_id, pool_id, chain, protocol, source_family, price_usd, tvl_usd)
      VALUES (1, 'usdt-tether', 'pool', 'Ethereum', 'curve', 'dl', .98, 100000);
      UPDATE dex_price_challenger_heads_v2 SET has_rows = 1;
      UPDATE dex_price_challenger_snapshots SET snapshot_at = 1;`);
    await assertAvailability(true); // Fresh v2 no longer depends on frozen v1.
    sqlite.exec("UPDATE dex_price_challenger_heads_v2 SET source_coverage_complete = 0");
    await assertAvailability(false);
    sqlite.exec(`UPDATE dex_price_challenger_heads_v2 SET source_coverage_complete = 1;
      UPDATE dex_price_challenger_publications_v2 SET snapshot_at = 1;`);
    await assertAvailability(false); // Source clock, not allocation clock, ages availability.
  });

  it("filters pending incidents by readable stablecoin ID", async () => {
    const db = mockEvents([], 0, [{
      match: "FROM depeg_pending",
      matchBinds: ["usdc-circle"],
      rows: [
        {
          id: 11,
          stablecoin_id: "usdc-circle",
          symbol: "USDC",
          peg_type: "peggedUSD",
          direction: "above",
          first_seen_bps: 140,
          first_seen_at: 1_800_000_000,
          first_price: 1.014,
          last_seen_bps: null,
          last_seen_at: null,
          last_price: null,
          peak_seen_bps: null,
          peak_price: null,
          peg_reference: 1,
          reason: "large-cap",
          updated_at: 1_800_000_000,
        },
      ],
    }, { match: "pharos:depeg-events:dex-availability", rows: [] }, { match: "pharos:depeg-events:pool-availability", rows: [] }]);

    const res = await handleDepegEvents(
      db,
      new URL("https://x/api/depeg-events?stablecoin=usdc-circle&includePending=true"),
    );

    const body = DepegEventsResponseSchema.parse(await readJsonResponse(res, 200));
    expect(body.pending?.map((pending) => pending.stablecoinId)).toEqual(["usdc-circle"]);
    const pendingQuery = db.getHistory().find((entry) => entry.sql.includes("FROM depeg_pending"));
    expect(pendingQuery?.binds).toEqual(["usdc-circle"]);
  });

  it("confines limit=5000 to direct offset=0 site-api calls and preflights missing ledger manifests", async () => {
    const db = mockEvents([], 0);
    const proxied = new Request("https://site-api.pharos.watch/api/depeg-events?limit=5000", { headers: { "X-Pharos-Client-IP": "1.2.3.4" } });
    expect((await handleDepegEvents(db, new URL(proxied.url), "site-api", proxied)).status).toBe(400);
    const offsetUrl = new URL("https://site-api.pharos.watch/api/depeg-events?limit=5000&offset=10");
    expect((await handleDepegEvents(db, offsetUrl, "site-api", new Request(offsetUrl))).status).toBe(400);
    const directUrl = new URL("https://site-api.pharos.watch/api/depeg-events?limit=5000");
    expect((await handleDepegEvents(db, directUrl, "site-api", new Request(directUrl))).status).toBe(200);
    const missingDb = mockEvents([], 0, [{ match: "FROM cache WHERE key = ?", rows: [] }]);
    const missingRes = await handleDepegEvents(missingDb, new URL("https://x/api/depeg-events?limit=1000&includeTotal=true&ledgerGeneration=latest"));
    expect(await readJsonResponse(missingRes, 503)).toMatchObject({ reason: "ledger-manifest-unavailable" });
    expect(missingDb.getHistory().some((entry) => entry.sql.includes("depeg_events_public"))).toBe(false);
  });
});
