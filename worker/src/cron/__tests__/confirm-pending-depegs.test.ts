import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mockFetchRetry } from "../../test-helpers/cron";
import { insertDexPrice, insertPendingDepeg, makePendingDepegRow } from "../../test-helpers/pending-depeg-fixtures";
import { makeAsset } from "../../test-helpers/__shared/fixtures";
import { createLatestSchemaFixtureTracker } from "@shared/test-utils/latest-schema-sqlite";
import { tradedPair } from "../depeg-detection/__tests__/reference-fixtures";
import { DEPEG_PENDING_MIN_AGE_SEC } from "@shared/lib/depeg-config";
import { MAX_OPEN_DEPEG_EVENTS } from "../../lib/depeg-threshold-policy";

vi.mock("../../lib/fetch-retry", () => mockFetchRetry({ fetchWithRetry: vi.fn(), passthroughNonResponse: true }));

const binanceOutcome = vi.hoisted(() => (kind: BinancePriceOutcome["kind"], status: number, prices: Array<[string, number]> = [], reason?: string): BinancePriceOutcome => ({
  kind, ...(reason ? { reason } : {}),
  value: { prices: new Map(prices), diagnostics: [{ source: "binance", stage: "primary", endpoint: "data-api.binance.vision/api/v3/ticker/price", status, ok: status === 200, success: prices.length > 0, ...(status === 200 ? { matchedCount: prices.length } : {}) }] },
}) as BinancePriceOutcome);
vi.mock("../../lib/cex-tickers", () => {
  const fetchBinancePricesDetailed = vi.fn(async () => binanceOutcome("no-data", 200));
  return { createBinanceFetchSession: vi.fn(() => ({})), fetchBinancePricesDetailed, fetchBinancePricesForRun: vi.fn(async () => fetchBinancePricesDetailed()) };
});
vi.mock("../../lib/circuit-breaker", () => ({ shouldAttemptFetch: vi.fn(async () => true), recordOutcomeSafe: vi.fn(async () => undefined) }));
vi.mock("../../lib/native-peg-quotes", () => ({
  fetchCurrentNativePegQuotes: vi.fn(async () => new Map()),
  normalizeSupportedPegCurrency: vi.fn((c: string | null | undefined) => { const n = c?.trim().toUpperCase(); return n && ["ARS", "BRL", "EUR", "JPY", "NGN"].includes(n) ? n : null; }),
}));

import { fetchBinancePricesDetailed, type BinancePriceOutcome } from "../../lib/cex-tickers";
import { shouldAttemptFetch } from "../../lib/circuit-breaker";
import { fetchWithRetry } from "../../lib/fetch-retry";
import { fetchCurrentNativePegQuotes } from "../../lib/native-peg-quotes";
import { confirmPendingDepegs } from "../confirm-pending-depegs";
import { decideDepegAsset } from "../depeg-detection/decision-engine";
import { buildUpsertPendingDepegStmt } from "../../lib/depeg-pending";
import { ensureCanonicalIncidents } from "../../lib/depeg-resolver-incident-store";
import { sealPublicFixture, type SqliteD1 } from "../../lib/__tests__/depeg-resolver-ddrv2-store.test-support";
import { PSI_ELIGIBLE_META_BY_ID } from "@shared/lib/psi-eligible";

const NOW_SEC = 1_700_000_000, sqliteFixtures = createLatestSchemaFixtureTracker(), openFixture = sqliteFixtures.open;
const makePendingRow = makePendingDepegRow, insertPending = insertPendingDepeg;
const insertOpenEvent = (s: DatabaseSync, id: string, sym: string) => s.prepare("INSERT INTO depeg_events (stablecoin_id, symbol, peg_type, direction, peak_deviation_bps, started_at, start_price, peak_price, peg_reference, source) VALUES (?, ?, 'peggedUSD', 'below', 100, ?, 0.99, 0.99, 1, 'live')").run(id, sym, NOW_SEC - 3_600);
function insertPoolChallenger(s: DatabaseSync, id: string, price: number, tvl: number) {
  s.prepare("INSERT INTO dex_price_challenger_publications_v2 (publication_id, generation_id, snapshot_at, published_at, sealed) VALUES (1, 'test-liquidity', ?, ?, 1)").run(NOW_SEC - 60, NOW_SEC - 60);
  s.prepare("INSERT INTO dex_price_challenger_payloads_v2 (publication_id, stablecoin_id, pool_id, chain, protocol, source_family, price_usd, tvl_usd, price_observed_at) VALUES (1, ?, ?, 'Ethereum', 'curve', 'curve', ?, ?, ?)").run(id, `${id}:curve`, price, tvl, NOW_SEC - 60);
  s.prepare("INSERT INTO dex_price_challenger_heads_v2 (stablecoin_id, publication_id, has_rows) VALUES (?, 1, 1)").run(id);
}
const makeLowConfidenceAsset = (p: ReturnType<typeof makePendingRow>, price: number, geckoId = "tether") => makeAsset({ id: p.stablecoin_id, symbol: p.symbol, geckoId, price, priceSource: "coingecko", priceConfidence: "low", agreeSources: ["coingecko"], priceObservedAt: NOW_SEC - 30, priceUpdatedAt: NOW_SEC - 30, priceSyncedAt: NOW_SEC - 30 });
const twoDex = (s: DatabaseSync, id: string, sym: string, price: number) => insertDexPrice(s, id, sym, price, [{ price, tvl: 3e6, protocol: "curve", sourceFamily: "curve", chain: "ethereum" }, { price: price - 0.001, tvl: 2e6, protocol: "uniswap", sourceFamily: "uniswap", chain: "ethereum" }]);
const oneDex = (s: DatabaseSync, id: string, sym: string, price: number) => { insertDexPrice(s, id, sym, price, [{ price, tvl: 3e6, protocol: "curve", sourceFamily: "curve", chain: "ethereum" }]); insertPoolChallenger(s, id, price, 3e6); };
const countOf = (s: DatabaseSync, tbl: string) => s.prepare(`SELECT COUNT(*) AS count FROM ${tbl}`).get();
const pendAsset = (p: ReturnType<typeof makePendingRow>, extra: Parameters<typeof makeAsset>[0] = {}) => makeAsset({ id: p.stablecoin_id, symbol: p.symbol, ...extra });
const NULL_ESC = { peak_escalated_at: null, peak_escalation_anchor_bps: null, peak_escalation_candidate_at: null };
const lifecycle = (s: DatabaseSync, id: string, pid: number) => ({
  pending: s.prepare("SELECT id FROM depeg_pending WHERE id = ?").get(pid) as { id: number } | undefined,
  events: s.prepare("SELECT stablecoin_id, symbol, peak_deviation_bps, started_at, start_price, peak_price, peg_reference, source, confirmation_sources, pending_reason FROM depeg_events WHERE stablecoin_id = ? ORDER BY id").all(id) as Array<Record<string, unknown>>,
  outcomes: s.prepare("SELECT pending_id, stablecoin_id, outcome, peak_seen_bps, peak_price, peg_reference, confirming_sources, opposing_sources, unavailable_sources, circuit_open_sources, final_decision_reason FROM depeg_pending_outcomes WHERE pending_id = ? ORDER BY id").all(pid) as Array<Record<string, unknown>>,
});
beforeEach(() => { vi.spyOn(Date, "now").mockReturnValue(NOW_SEC * 1000); });
afterEach(() => { vi.restoreAllMocks(); vi.clearAllMocks(); vi.mocked(fetchWithRetry).mockReset(); vi.mocked(fetchCurrentNativePegQuotes).mockReset().mockResolvedValue(new Map()); vi.mocked(shouldAttemptFetch).mockReset().mockResolvedValue(true); vi.mocked(fetchBinancePricesDetailed).mockReset().mockResolvedValue(binanceOutcome("no-data", 200)); sqliteFixtures.closeAll(); });

describe("confirmPendingDepegs", () => {
  it("withholds Binance confirmation when any qualifying pending quote used Binance", async () => {
    vi.mocked(fetchBinancePricesDetailed).mockResolvedValue({ ...binanceOutcome("ok", 200, [["USDT", 0.98]]), value: { prices: new Map([["USDT", 0.98]]), diagnostics: [] } });
    const id = "usdt-tether";
    const quote = (now: number, source: string, price = 0.98) => makeAsset({
      id, symbol: "USDT", price, priceSource: source, agreeSources: [source], circulating: { peggedUSD: 1e8 },
      priceConfidence: "single-source", priceObservedAtMode: "upstream", priceObservedAt: now, priceUpdatedAt: now,
    });
    for (const sources of [["kraken", "binance", "kraken"], ["kraken", "kraken", "kraken"]]) {
      const { db, sqlite } = openFixture();
      for (const [i, source] of sources.entries()) {
        const now = NOW_SEC - 2700 + i * 900;
        const cmd = decideDepegAsset({ now, asset: quote(now, source), meta: PSI_ELIGIBLE_META_BY_ID.get(id), pegRates: { peggedUSD: 1 }, pegRateSources: { peggedUSD: "median" }, pegRateCounts: { peggedUSD: 1 } })
          .commands.find((c) => c.type === "upsert-pending");
        if (!cmd) throw new Error("Expected a qualifying pending observation");
        await buildUpsertPendingDepegStmt(db, cmd.payload).run();
      }
      await confirmPendingDepegs(db, [quote(NOW_SEC, "coingecko", 1)]);
      expect(sqlite.prepare("SELECT peak_deviation_bps FROM depeg_events").all()).toEqual(sources.includes("binance") ? [] : [{ peak_deviation_bps: -200 }]);
    }
  });

  it.each([
    { id: "ust-terra", age: 1800, outcome: "promoted" },
    { id: "iron-iron-finance", age: 1800, outcome: "promoted" },
    { id: "ust-terra", age: 7 * 86400, outcome: "expired" },
    { id: "unknown-historical-id", age: 7 * 86400, outcome: "expired" },
  ])("records $outcome for $id after $age seconds", async ({ id, age, outcome }) => {
    vi.mocked(shouldAttemptFetch).mockResolvedValue(false);
    const { sqlite, db } = openFixture();
    const firstSeen = NOW_SEC - age;
    const lastSeen = firstSeen + 1800;
    const row = makePendingRow({ stablecoin_id: id, symbol: "HIST", first_seen_at: firstSeen, last_seen_at: lastSeen, updated_at: lastSeen });
    insertPending(sqlite, row);
    await confirmPendingDepegs(db, [makeAsset({
      id, price: 0.98, circulating: { peggedUSD: 10e6 }, priceConfidence: "high",
      priceSource: "pyth+binance", agreeSources: ["pyth", "binance"], priceUpdatedAt: lastSeen, priceObservedAt: lastSeen, priceObservedAtMode: "upstream",
    })]);
    const result = lifecycle(sqlite, id, row.id);
    expect(result.outcomes).toMatchObject([{ outcome }]);
    expect(result.pending).toBeUndefined();
    expect(result.events).toHaveLength(outcome === "promoted" ? 1 : 0);
  });

  it("handles empty queue, saturated open-event hold, too-young pending row, and provider failure", async () => {
    const { sqlite: s0, db: db0 } = openFixture();
    await expect(confirmPendingDepegs(db0, [])).resolves.toEqual({ status: "completed", providerDiagnostics: [] });
    expect(countOf(s0, "depeg_pending")).toEqual({ count: 0 }); expect(countOf(s0, "depeg_pending_outcomes")).toEqual({ count: 0 });
    const { sqlite: s1, db: db1 } = openFixture(), p1 = makePendingRow();
    insertPending(s1, p1);
    for (let i = 0; i < MAX_OPEN_DEPEG_EVENTS; i++) insertOpenEvent(s1, `open-${i}`, `OPEN${i}`);
    const before = s1.prepare("SELECT total_changes() AS count").get();
    await expect(confirmPendingDepegs(db1, [pendAsset(p1, { geckoId: undefined })])).resolves.toEqual({ status: "held", reason: "depeg-open-event-limit-reached", providerDiagnostics: [] });
    expect(s1.prepare("SELECT total_changes() AS count").get()).toEqual(before);
    expect(countOf(s1, "depeg_pending")).toEqual({ count: 1 }); expect(countOf(s1, "depeg_pending_outcomes")).toEqual({ count: 0 });
    const { sqlite: s2, db: db2 } = openFixture(), young = makePendingRow({ id: 12, first_seen_at: NOW_SEC - DEPEG_PENDING_MIN_AGE_SEC + 60, last_seen_at: NOW_SEC - 30 });
    insertPending(s2, young);
    await expect(confirmPendingDepegs(db2, [pendAsset(young, { geckoId: "tether", price: 0.94 })])).resolves.toMatchObject({ status: "completed" });
    expect(lifecycle(s2, young.stablecoin_id, young.id)).toMatchObject({ pending: { id: young.id }, events: [], outcomes: [] });
    const { sqlite: s3, db: db3 } = openFixture(), p3 = makePendingRow({ id: 91 });
    insertPending(s3, p3); vi.mocked(fetchWithRetry).mockRejectedValueOnce(new Error("timeout"));
    await confirmPendingDepegs(db3, [pendAsset(p3, { geckoId: "tether", price: 0.94 })]);
    expect(lifecycle(s3, p3.stablecoin_id, p3.id)).toMatchObject({ pending: { id: p3.id }, events: [], outcomes: [] });
  });

  it("promotes with independent DEX confirmations even when Binance throws", async () => {
    const { sqlite, db } = openFixture(), pending = makePendingRow({ id: 10, first_seen_bps: -220, first_price: 0.978 });
    insertPending(sqlite, pending); twoDex(sqlite, pending.stablecoin_id, pending.symbol, 0.97);
    vi.mocked(fetchBinancePricesDetailed).mockRejectedValueOnce(new Error("Binance transport failed"));
    await confirmPendingDepegs(db, [pendAsset(pending, { geckoId: undefined, price: 0.97, priceSource: "defillama", priceConfidence: "low", priceObservedAt: NOW_SEC - 30, priceUpdatedAt: NOW_SEC - 30, priceSyncedAt: NOW_SEC - 30 })]);
    const state = lifecycle(sqlite, pending.stablecoin_id, pending.id);
    expect(state.pending).toBeUndefined(); expect(state.events).toHaveLength(1);
    expect(state.events[0]).toMatchObject({ stablecoin_id: pending.stablecoin_id, source: "live", pending_reason: "large-cap" });
    expect(String(state.events[0]?.confirmation_sources)).toContain("dex:curve+dex:uniswap");
    expect(state.outcomes).toHaveLength(1);
    expect(state.outcomes[0]).toMatchObject({ pending_id: pending.id, outcome: "promoted", final_decision_reason: expect.stringContaining("confirmed-by:temporal:15m+dex:curve+dex:uniswap") });
  });

  it("clears a native-domain BRZ candidate from a fresh traded pair", async () => {
    const { sqlite, db } = openFixture();
    const pending = makePendingRow({ id: 21, stablecoin_id: "brz-transfero", symbol: "BRZ", peg_type: "peggedREAL", direction: "above", first_seen_bps: 180, first_price: 1.018, last_price: 1.018, peak_price: 1.018, peg_reference: 1, reason: "large-cap+native-origin" });
    insertPending(sqlite, pending);
    sqlite.prepare("UPDATE depeg_pending SET peer_basis_json = ? WHERE id = ?").run(JSON.stringify({ onset: { basis: "native-peg", observedAt: pending.first_seen_at, venue: "bitso", price: pending.first_price, bps: pending.first_seen_bps, pegReference: 1 } }), pending.id);
    vi.mocked(fetchCurrentNativePegQuotes).mockResolvedValue(new Map([[pending.stablecoin_id, { stablecoinId: pending.stablecoin_id, geckoId: "brz", pegCurrency: "BRL", price: 0.995, updatedAt: NOW_SEC - 60, derivation: tradedPair }]]));
    await confirmPendingDepegs(db, [pendAsset(pending, { geckoId: "brz", pegType: "peggedREAL", price: 0.190587 })]);
    const state = lifecycle(sqlite, pending.stablecoin_id, pending.id);
    expect(state.pending).toBeUndefined(); expect(state.events).toHaveLength(0);
    expect(state.outcomes[0]).toMatchObject({ outcome: "recovered", final_decision_reason: "native-peg-recovered" });
  });

  it("treats Binance 403 blocks, empty/partial batches, and non-Binance-market expiry consistently", async () => {
    const { sqlite: s0, db: db0 } = openFixture(), p0 = makePendingRow({ id: 24 });
    insertPending(s0, p0);
    vi.mocked(fetchBinancePricesDetailed).mockResolvedValueOnce({ kind: "blocked", value: { prices: new Map(), diagnostics: [{ source: "binance", stage: "primary", endpoint: "data-api.binance.vision/api/v3/ticker/price", status: 403, ok: false, success: false }, { source: "binance", stage: "primary", endpoint: "api.binance.com/api/v3/ticker/price", status: 403, ok: false, success: false }] } });
    const r0 = await confirmPendingDepegs(db0, [pendAsset(p0, { geckoId: undefined, price: 0.98 })]);
    expect(r0.providerDiagnostics).toHaveLength(2); expect(countOf(s0, "depeg_pending")).toEqual({ count: 1 });
    for (const [id, outcome] of [[41, binanceOutcome("upstream-error", 503, [], "HTTP 503")], [43, binanceOutcome("ok", 200, [["USDC", 1]])]] as const) {
      const { sqlite, db } = openFixture(), pending = makePendingRow({ id });
      insertPending(sqlite, pending); twoDex(sqlite, pending.stablecoin_id, pending.symbol, 0.998);
      vi.mocked(fetchBinancePricesDetailed).mockResolvedValueOnce(outcome);
      await confirmPendingDepegs(db, [makeLowConfidenceAsset(pending, 0.998)]);
      const state = lifecycle(sqlite, pending.stablecoin_id, pending.id);
      expect(state.pending).toBeUndefined(); expect(state.outcomes).toHaveLength(1);
      expect(state.outcomes[0]).toMatchObject({ outcome: "rejected", final_decision_reason: "secondary-evidence-opposes" });
      expect(String(state.outcomes[0]?.unavailable_sources).split("+")).toContain("cex:binance");
      expect(String(state.outcomes[0]?.confirming_sources)).not.toContain("cex:binance");
    }
    const { sqlite: s2, db: db2 } = openFixture(), p2 = makePendingRow({ id: 42, first_seen_at: NOW_SEC - 3_600, last_seen_at: NOW_SEC - 120 });
    insertPending(s2, p2); oneDex(s2, p2.stablecoin_id, p2.symbol, 0.978);
    vi.mocked(fetchBinancePricesDetailed).mockResolvedValueOnce(binanceOutcome("upstream-error", 503, [], "HTTP 503"));
    await confirmPendingDepegs(db2, [makeLowConfidenceAsset(p2, 0.978)]);
    expect(lifecycle(s2, p2.stablecoin_id, p2.id)).toMatchObject({ pending: { id: p2.id }, outcomes: [] });
    for (const outcome of [binanceOutcome("upstream-error", 503, [], "HTTP 503"), binanceOutcome("blocked", 403)]) {
      const { sqlite, db } = openFixture(), pending = makePendingRow({ id: 44, stablecoin_id: "dai-makerdao", symbol: "DAI", first_seen_at: NOW_SEC - 3_600, last_seen_at: NOW_SEC - 120 });
      insertPending(sqlite, pending); oneDex(sqlite, pending.stablecoin_id, pending.symbol, 0.978);
      vi.mocked(fetchBinancePricesDetailed).mockResolvedValueOnce(outcome);
      await confirmPendingDepegs(db, [makeLowConfidenceAsset(pending, 0.978, "dai")]);
      const state = lifecycle(sqlite, pending.stablecoin_id, pending.id);
      expect(state.pending).toBeUndefined(); expect(state.outcomes).toHaveLength(1);
      expect(state.outcomes[0]).toMatchObject({ outcome: "expired", final_decision_reason: "expired-after:3600s;limit:2700s" });
      expect(String(state.outcomes[0]?.unavailable_sources ?? "")).not.toContain("cex:binance");
    }
  });

  it("rethrows abort-related failures from secondary fetches", async () => {
    const { sqlite, db } = openFixture();
    const pending = makePendingRow({ id: 30 });
    insertPending(sqlite, pending);
    const controller = new AbortController();
    vi.mocked(fetchWithRetry).mockImplementationOnce(async () => { controller.abort(new Error("stop now")); throw new Error("network aborted"); });
    await expect(confirmPendingDepegs(db, [pendAsset(pending, { geckoId: "tether", price: 0.94 })], undefined, controller.signal)).rejects.toThrow("network aborted");
    expect(countOf(sqlite, "depeg_pending_outcomes")).toEqual({ count: 0 });
  });

  const promote = async (sqlite: DatabaseSync, db: D1Database, id: number, price = 0.978, bps = -220) => {
    const p = makePendingRow({ id, first_seen_at: NOW_SEC - 1_200, last_seen_at: NOW_SEC - 30, first_seen_bps: bps, last_seen_bps: bps, peak_seen_bps: bps, first_price: price, last_price: price, peak_price: price });
    insertPending(sqlite, p);
    twoDex(sqlite, "usdt-tether", "USDT", price);
    await confirmPendingDepegs(db, [makeLowConfidenceAsset(p, price)]);
    return sqlite.prepare("SELECT peak_escalated_at, peak_escalation_anchor_bps, peak_escalation_candidate_at FROM depeg_events WHERE ended_at IS NULL").get();
  };
  const seedPred = (sqlite: DatabaseSync, dir: string, start: number, end: number | null, disp: string | null, cov: string | null, escAt: number) =>
    sqlite.prepare("INSERT INTO depeg_events (id, stablecoin_id, symbol, peg_type, direction, peak_deviation_bps, started_at, ended_at, start_price, peak_price, recovery_price, peg_reference, source, disposition, admitted_coverage_json, peak_escalated_at, peak_escalation_anchor_bps) VALUES (1, 'usdt-tether', 'USDT', 'peggedUSD', ?, -400, ?, ?, 0.96, 0.96, 0.999, 1, 'live', ?, ?, ?, 480)").run(dir, start, end, disp, cov, escAt);

  it.each(["full-schema", "partial-schema"] as const)("carries forward escalation on full schema and fails closed on partial schema (%s)", async (schema) => {
    const { sqlite, db } = openFixture();
    const escAt = NOW_SEC - 2 * 86_400;
    seedPred(sqlite, "below", NOW_SEC - 40 * 86_400, NOW_SEC - 4_800, null, null, escAt);
    if (schema === "partial-schema") sqlite.exec("DROP TABLE depeg_resolver_public_predictions; DROP TABLE depeg_resolver_incidents;");
    expect(await promote(sqlite, db, 501)).toEqual(schema === "full-schema" ? { peak_escalated_at: escAt, peak_escalation_anchor_bps: 480, peak_escalation_candidate_at: null } : NULL_ESC);
  });

  it.each([
    [">6h gap", 6 * 3_600 + 60, "below", false, null], ["opposite direction", 1_800, "above", false, null],
    ["disputed predecessor", 1_800, "below", true, null], ["sealed split", 1_800, "below", false, "split"],
    ["sealed non-numeric peak", 1_800, "below", false, "bad-peak"], ["sealed missing peak", 1_800, "below", false, "missing-peak"],
    ["sealed boolean peak", 1_800, "below", false, "bool-peak"],
  ] as const)("withholds escalation carry-forward on promotion for %s", async (_l, gapSec, dir, disputed, sealed) => {
    const { sqlite, db } = openFixture();
    const prevEnd = NOW_SEC - 1_200 - gapSec;
    const prevStart = NOW_SEC - 40 * 86_400;
    seedPred(sqlite, dir, prevStart, sealed ? null : prevEnd, disputed ? "repaired" : null, disputed ? "[]" : null, NOW_SEC - 2 * 86_400);
    if (sealed) {
      const [inc] = await ensureCanonicalIncidents(db, [{
        eventId: 1, stablecoinId: "usdt-tether", pegCurrency: "USD", direction: "below", startedAt: prevStart, endedAt: null,
        peakDeviationBps: -400, source: "live", publicTrackedAtFirstSeen: true, registrySnapshot: { id: "usdt-tether", symbol: "USDT" },
      }], { nowSec: prevStart + 86_400, predictionPolicyVersion: "sticky-24h-v1", ddrV2EffectiveAt: prevStart - 1, createdBy: "vitest" });
      await sealPublicFixture(Object.assign(db, { sqlite, close: () => {} }) as SqliteD1, inc!.incidentKey, "prediction", {
        payload: { eventId: 1, stablecoinId: "usdt-tether", symbol: "USDT", name: "Tether", pegCurrency: "USD", direction: "below", startedAt: prevStart, lockTimePeakDeviationBps: -200, eligibleAt: prevStart + 86_400, lockedAt: prevStart + 86_400, eventAgeAtLockSec: 86_400 },
      });
      if (sealed !== "split") {
        sqlite.exec("DROP TRIGGER trg_ddr_public_predictions_no_update");
        const json = sealed === "bad-peak" ? '{"frozen":{"sourceRow":{"peakDeviationBps":"bad"}}}' : sealed === "bool-peak" ? '{"frozen":{"sourceRow":{"peakDeviationBps":true}}}' : "{}";
        sqlite.prepare("UPDATE depeg_resolver_public_predictions SET sealed_payload_json = ? WHERE event_id = 1").run(json);
      }
      sqlite.prepare("UPDATE depeg_events SET ended_at = ? WHERE id = 1").run(prevEnd);
    }
    expect(await promote(sqlite, db, 502, sealed === "split" ? 0.88 : 0.978, sealed === "split" ? -1_200 : -220)).toEqual(NULL_ESC);
  });

  it("logs a warning and still promotes without carry-forward when loading reopen escalation fails", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { sqlite, db } = openFixture();
    const origPrepare = db.prepare.bind(db);
    vi.spyOn(db, "prepare").mockImplementation((sql: string) => {
      if (sql.includes("prev.peak_escalation_anchor_bps")) throw new Error("D1 read timeout");
      return origPrepare(sql);
    });
    expect(await promote(sqlite, db, 503)).toEqual(NULL_ESC);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("[depeg-confirm] Failed to load reopen escalation carry-forward"));
  });
});
