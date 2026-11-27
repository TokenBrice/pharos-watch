import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DatabaseSync } from "node:sqlite";
import { createLatestSchemaFixtureTracker } from "@shared/test-utils/latest-schema-sqlite";
import { createSqliteD1 } from "@shared/test-utils/sqlite-d1";
import { DEPEG_PRIMARY_PRICE_MAX_AGE_SEC } from "@shared/lib/depeg-config";
import { getReferenceSessionState } from "@shared/lib/reference-market-hours";
import { deriveDepegSignal } from "@shared/lib/depeg-signals";
import type { FxReferenceObservation } from "@shared/types/fx-reference";
import { makeAsset } from "../../../test-helpers/__shared/fixtures";
import { MAX_OPEN_DEPEG_EVENTS } from "../../../lib/depeg-threshold-policy";
import { PSI_ELIGIBLE_META_BY_ID, PSI_HISTORICAL_IDS } from "@shared/lib/psi-eligible";
import { seedDexEvidence, seedOpenEvent } from "../../__tests__/detect-depegs.test-support";
import { hydrateDepegDetection } from "../hydration";
import { loadReopenEscalationCandidate, resolvePromotionEscalationCarryForward } from "../escalation";
import { loadFreshFxRates } from "../../sync-stablecoins/shared";
import { detectDepegEvents } from "../../detect-depegs";
import { decideDepegAsset } from "../decision-engine";
import { loadFxRateState, persistFxRateState, type FxRatesMeta } from "../../../lib/fx-rate-state";
import { makePendingDepegRow } from "../../../test-helpers/pending-depeg-fixtures";
import { buildConfirmationPlan } from "../../pending-depeg-confirmation";
import { normalizePendingDepegRow, SELECT_PENDING_DEPEGS_SQL } from "../../../lib/depeg-pending";
import { referenceState, tradedPair } from "./reference-fixtures";
import { resolveDirectRecovery, resolvePeakUpdateCommand } from "../native-quote-policy";
import { persistDepegCommands } from "../persistence";
import { deriveDetectionPegRates } from "../reference-policy";
import { FxSyncRunState } from "../../sync-fx-rates-helpers";
import { isValidFxRate } from "../../../lib/fx-config";
import { ensureCanonicalIncidents } from "../../../lib/depeg-resolver-incident-store";
import { loadSealedIncidentFingerprint } from "../../../lib/depeg-resolver-publication-store";
import { sealPublicFixture, type SqliteD1 } from "../../../lib/__tests__/depeg-resolver-ddrv2-store.test-support";

const fixtures = createLatestSchemaFixtureTracker();
const NOW = 1_780_358_400, MAX_OPEN = MAX_OPEN_DEPEG_EVENTS;
const BRZ = "brz-transfero", REAL = "peggedREAL", EUR = "peggedEUR", GBP = "peggedGBP", GOLD = "peggedGOLD", USD = "peggedUSD", OXR = "openExchangeRates";
const hyd = hydrateDepegDetection, persistFx = persistFxRateState;
const asset = makeAsset({ id: BRZ, symbol: "BRZ", pegType: REAL, price: 0.18 });
const obsBrz = { ...asset, priceObservedAt: NOW - 30, priceObservedAtMode: "upstream" as const };
beforeEach(() => { vi.spyOn(Date, "now").mockReturnValue(NOW * 1000 + 999); });
afterEach(() => { fixtures.closeAll(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

const seedEvents = (s: DatabaseSync, count = 1) => { for (let id = 1; id <= count; id++) seedOpenEvent(s, { id, stablecoin_id: BRZ, symbol: "BRZ", peg_type: REAL, started_at: NOW - 3600 - id }); };
const quoteResponse = (updatedAt = NOW - 60) => { vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ brz: { brl: 0.98, last_updated_at: updatedAt } }), { status: 200 }))); };
const hydrateWithSelectedFx = async (db: D1Database, assets: Parameters<typeof hyd>[1]) => {
  const fx = await loadFreshFxRates(db);
  return hyd(db, assets, fx.fxFallbackRates, undefined, undefined, undefined, fx.detectionFxState);
};

type ConfIn = Omit<Parameters<typeof buildConfirmationPlan>[0], "db" | "row" | "pendingState" | "openSet" | "nativePegQuote">;
const confirmationFor = (db: D1Database, input: ConfIn, pegType: string, pegReference = 1) => {
  const row = makePendingDepegRow({ stablecoin_id: input.asset!.id, peg_type: pegType, first_seen_at: NOW - 1000, peg_reference: pegReference });
  return buildConfirmationPlan({ ...input, db, row, pendingState: normalizePendingDepegRow(row), openSet: new Set(), nativePegQuote: undefined });
};

const metaOf = (id: string) => PSI_ELIGIBLE_META_BY_ID.get(id);
const obsCoin = (id: string, pegType: string, price: number, at: number, extra: Parameters<typeof makeAsset>[0] = {}) =>
  makeAsset({ id, pegType, price, priceSource: "coingecko", priceConfidence: "single-source", priceUpdatedAt: at, priceObservedAt: at, priceObservedAtMode: "upstream", ...extra });
const qGet = (s: DatabaseSync, sql: string) => s.prepare(sql).get();
const qAll = (s: DatabaseSync, sql: string) => s.prepare(sql).all();
const cacheVal = (s: DatabaseSync, key: string) => qGet(s, `SELECT value FROM cache WHERE key = '${key}'`);
const countOf = (s: DatabaseSync, from: string) => qGet(s, `SELECT COUNT(*) AS count FROM ${from}`);
const seedE = (s: DatabaseSync, id: number, coin: string, sym: string, start: number, end: number | null, bps: number, extra: Record<string, unknown> = {}) =>
  seedOpenEvent(s, { id, stablecoin_id: coin, symbol: sym, started_at: start, ended_at: end, peak_deviation_bps: bps, ...extra });

async function decideWithSelectedReference(db: D1Database, now: number, coin: ReturnType<typeof makeAsset>, rates: Parameters<typeof deriveDetectionPegRates>[4], state: Parameters<typeof deriveDetectionPegRates>[5]) {
  const { rates: pegRates, sources: pegRateSources, counts: pegRateCounts, referenceContext, observations } =
    await deriveDetectionPegRates(db, [coin], PSI_ELIGIBLE_META_BY_ID, new Set(), rates, state, now);
  return { commands: decideDepegAsset({ now, asset: coin, meta: metaOf(coin.id), pegRates, pegRateSources, pegRateCounts, referenceContext }).commands, observations };
}

async function sealPredecessor(db: D1Database, sqlite: DatabaseSync, id: number, coin: string, sym: string, name: string, start: number, end: number, anchor: number, esc: number) {
  seedE(sqlite, id, coin, sym, start, null, -220, { peak_escalation_anchor_bps: anchor, peak_escalated_at: esc });
  const [inc] = await ensureCanonicalIncidents(db, [{
    eventId: id, stablecoinId: coin, pegCurrency: "USD", direction: "below", startedAt: start, endedAt: null,
    peakDeviationBps: -220, source: "live", publicTrackedAtFirstSeen: true, registrySnapshot: { id: coin, symbol: sym },
  }], { nowSec: start + 86_400, predictionPolicyVersion: "sticky-24h-v1", ddrV2EffectiveAt: start - 1, createdBy: "vitest" });
  await sealPublicFixture(Object.assign(db, { sqlite, close: () => {} }) as SqliteD1, inc!.incidentKey, "prediction", {
    payload: { eventId: id, stablecoinId: coin, symbol: sym, name, pegCurrency: "USD", direction: "below", startedAt: start, lockTimePeakDeviationBps: -200, eligibleAt: start + 86_400, lockedAt: start + 86_400, eventAgeAtLockSec: 86_400 },
  });
  sqlite.prepare("UPDATE depeg_events SET ended_at = ? WHERE id = ?").run(end, id);
  return inc!.incidentKey;
}

describe("hydrateDepegDetection", () => {
  it("detects severe moves against the retained direct close when a later FX selection cannot qualify", async () => {
    const now = Date.UTC(2026, 10, 21, 0, 20) / 1000;
    vi.spyOn(Date, "now").mockReturnValue(now * 1000);
    for (const { id, peg, market, close, selected, moves } of [
      { id: "cngn-compliant-naira", peg: "peggedNGN", market: "fx", close: { usdPerUnit: 0.000625, source: "fawazahmed0", cadence: "calendar-daily", observedAtSec: Date.UTC(2026, 10, 20) / 1000 }, selected: { usdPerUnit: 0.000575, source: "fawazahmed0", cadence: "calendar-daily", observedAtSec: now - 1200 }, moves: [-3000, 3000, -400] },
      { id: "paxg-paxos", peg: GOLD, market: "metal", close: { usdPerUnit: 4100, source: "gold-api.com", cadence: "intraday", observedAtSec: Date.UTC(2026, 10, 20, 21, 50) / 1000 }, selected: { usdPerUnit: 3800, source: "peer-median", cadence: "intraday", observedAtSec: Date.UTC(2026, 10, 20, 21, 57, 30) / 1000 }, moves: [-3000, -200] },
    ] as const) {
      const { db } = fixtures.open(), rates = { [peg]: selected.usdPerUnit }, obs: FxReferenceObservation = { pegKey: peg, ...close };
      const session = getReferenceSessionState(market, close.observedAtSec);
      if (!session.open) throw new Error("Expected the retained sample to precede the close");
      await persistFx(db, rates, {
        ...referenceState(rates, selected.observedAtSec), usableSyncAt: now - 60, sourceCadenceByPeg: { [peg]: selected.cadence },
        observations: { [peg]: { pegKey: peg, ...selected } },
        referenceSourceSamples: { [`${peg}:${close.source}`]: { observation: obs, evidence: { sessionOpenedAtSec: session.sessionOpenedAtSec, firstInSessionObservedAtSec: close.observedAtSec, preCloseUsdPerUnit: null } } },
      }, now - 60);
      const state = await loadFxRateState(db);
      for (const bps of moves) {
        const res = await decideWithSelectedReference(db, now, obsCoin(id, peg, close.usdPerUnit * (1 + bps / 10_000), now - 60, { symbol: metaOf(id)!.symbol, circulating: { [peg]: 60e6 } }), rates, state);
        expect(res.observations?.[peg]).toEqual(obs);
        expect(res.commands).toMatchObject(Math.abs(bps) === 3000 ? [{ type: "upsert-pending", payload: { bps, pegReference: close.usdPerUnit, referenceAdmission: { referenceObservedAtSec: close.observedAtSec, generation: String(now - 60) } } }] : []);
      }
    }
  });

  it("carries a verified EUR close across omissions until a rejected replacement", async () => {
    const { db } = fixtures.open(), friday = Date.UTC(2026, 10, 20, 21, 50) / 1_000, saturday = Date.UTC(2026, 10, 21, 12, 2) / 1_000;
    const pairs = { GBP, EUR };
    const start = (syncStartSec: number, prevState: Awaited<ReturnType<typeof loadFxRateState>>) =>
      new FxSyncRunState({ prevState, syncStartSec, expectedPegKeys: Object.values(pairs), initialSources: {}, validateRate: isValidFxRate });
    const eurQ = (updatedAt: number) => new Map([[EUR, { pegKey: EUR, price: 1.1, updatedAt, chainId: "base", proxyAddress: "0xfeed" }]]);
    const close = start(friday, null);
    close.applyChainlinkQuotes(eurQ(friday));
    await persistFx(db, close.usableRates, close.buildPersistedMeta(), friday);
    for (const [i, step] of ["omit", "omit", "reject", "omit", "heartbeat"].entries()) {
      const now = saturday + i * 60;
      vi.mocked(Date.now).mockReturnValue(now * 1000);
      const run = start(now, await loadFxRateState(db));
      run.applyFrankfurterRates(step === "reject" ? { GBP: 0.8, EUR: 0.01 } : { GBP: 0.8 }, "2026-11-20", pairs);
      if (step === "heartbeat") run.applyChainlinkQuotes(eurQ(now - 60));
      run.enforcePublicationOrder();
      await persistFx(db, run.usableRates, run.buildPersistedMeta(), now);
      const { fxFallbackRates, detectionFxState } = await loadFreshFxRates(db);
      if (step !== "heartbeat") expect(detectionFxState?.rates[EUR]).toBeUndefined();
      for (const bps of [-3000, 3000, -300]) {
        const { commands } = await decideWithSelectedReference(db, now, obsCoin("eurc-circle", EUR, 1.1 * (1 + bps / 10_000), now - 30, { circulating: { [EUR]: 60e6 } }), fxFallbackRates, detectionFxState);
        expect(commands).toMatchObject(Math.abs(bps) === 3000 && (i < 2 || step === "heartbeat") ? [{ type: "upsert-pending", payload: { bps, pegReference: 1.1, referenceAdmission: { referenceObservedAtSec: friday } } }] : []);
      }
    }
  });

  it("returns open events, derived FX fallback and native quotes while persisting the upstream observation clock", async () => {
    const { db, sqlite } = fixtures.open();
    seedEvents(sqlite);
    seedDexEvidence(sqlite, 0.97, [{ protocol: "curve", price: 0.97, tvl: 3e6 }]);
    quoteResponse();
    const h = await hyd(db, [asset], { peggedREAL: 0.19 });
    expect(h).toMatchObject({ now: NOW, syncStart: NOW, openRowsLimitReached: false });
    expect(h.openRows).toMatchObject([{ id: 1, stablecoin_id: BRZ, ended_at: null }]);
    expect(h.pegRates.peggedREAL).toBe(0.19);
    expect(h.pegRateSources.peggedREAL).toBe("fx");
    expect(h.dexPriceRows.get("usdt-tether")).toMatchObject({ dex_price_usd: 0.97, source_pool_count: 1, updated_at: NOW - 60 });
    expect(h.dexPriceSources.get("usdt-tether")).toMatchObject([{ protocol: "curve", price: 0.97, tvl: 3e6 }]);
    const derivation = { kind: "conversion", lineage: { fxSource: OXR } };
    expect(h.nativePegQuotes.get(BRZ)).toMatchObject({ price: 0.98, updatedAt: NOW - 60, pegCurrency: "BRL", derivation });
    expect(cacheVal(sqlite, "depeg-native-quote:1")).toBeUndefined();
    const cached = qGet(sqlite, "SELECT value, updated_at FROM cache WHERE key = 'depeg-native-indicative:v1:1'");
    expect(cached?.updated_at).toBe(NOW - 60);
    expect(JSON.parse(String(cached?.value))).toEqual({ value: 0.98, observedAt: NOW - 60, source: "coingecko", derivation });
  });

  it.each(["matching", "other-provider", "missing", "provider-keyed"] as const)("uses a persisted OXR generation with %s repricing evidence", async (evidence) => {
    const { db } = fixtures.open(), fx = referenceState({ [REAL]: 0.193 }, NOW - 60);
    if (evidence === "other-provider") fx.repricingByPeg![REAL].source = "chainlink";
    await persistFx(db, fx.rates, { ...fx, ...(evidence === "missing" || evidence === "provider-keyed" ? { repricingByPeg: undefined } : {}), ...(evidence === "provider-keyed" ? { sources: { [OXR]: "ok" } } : {}) }, NOW - 60);
    quoteResponse();
    const { pegRates, pegRateSources, pegRateCounts } = await hydrateWithSelectedFx(db, [obsBrz]);
    const inputs = { asset: obsBrz, meta: metaOf(BRZ), now: NOW, pegRates, pegRateSources, pegRateCounts };
    expect(decideDepegAsset(inputs).commands).toMatchObject(evidence === "other-provider" ? [] : [{ type: "upsert-pending", payload: { bps: -674 } }]);
    expect(confirmationFor(db, inputs, REAL, 0.193).kind).toBe(evidence === "other-provider" ? "wait" : "ready");
  });

  it.each(["selected", "first-sample", "first-after-deploy", "empty", "empty-with-marker", "carried", "mixed-carry", "other-session"] as const)(
    "uses %s canonical observations from the same FX generation",
    async (mode) => {
      const { db } = fixtures.open(), rates: Record<string, number> = { [REAL]: 0.193, ...(mode === "mixed-carry" ? { [EUR]: 1.08 } : {}) };
      const fx = { ...referenceState(rates, NOW - 60), repricingByPeg: undefined, sources: { [OXR]: "ok" } };
      const obs: FxReferenceObservation = { pegKey: REAL, usdPerUnit: 0.193, observedAtSec: NOW - 60, source: OXR, cadence: "intraday" };
      const observations: FxRatesMeta["observations"] = mode === "empty" || mode === "empty-with-marker" ? {} : mode === "carried" ? undefined
        : mode === "mixed-carry" ? { [EUR]: { ...obs, pegKey: EUR, usdPerUnit: rates[EUR] } } : { [REAL]: obs };
      const session = getReferenceSessionState("fx", NOW);
      if (!session.open) throw new Error("Expected an open BRL reference session");
      await persistFx(db, fx.rates, {
        ...fx, observations,
        legacyDetectionPegs: ["carried", "mixed-carry", "first-after-deploy", "empty-with-marker"].includes(mode) ? [REAL] : undefined,
        referenceSourceSamples: { [`${REAL}:${OXR}`]: { observation: obs, evidence: { sessionOpenedAtSec: session.sessionOpenedAtSec - (mode === "other-session" ? 604800 : 0), firstInSessionObservedAtSec: NOW - 60, preCloseUsdPerUnit: mode === "first-sample" || mode === "first-after-deploy" ? null : 0.190 } } },
      }, NOW - 60);
      quoteResponse();
      const h = await hydrateWithSelectedFx(db, [obsBrz]);
      const input = { ...h, pegRates: { ...h.pegRates }, asset: obsBrz, meta: metaOf(BRZ) };
      const admitted = mode === "selected" || mode === "first-after-deploy" || mode === "carried" || mode === "mixed-carry";
      expect(decideDepegAsset(input).commands.map(({ type }) => type)).toEqual(admitted ? ["upsert-pending"] : []);
      expect(confirmationFor(db, input, REAL).kind).toBe(admitted ? "ready" : "wait");
    },
  );

  it.each([null, "invalid-rate"] as const)("isolates GBP repricing anchor %s from persisted EUR admission", async (siblingAnchor) => {
    const { db } = fixtures.open(), fx = referenceState({ [EUR]: 1.10, [GBP]: 1.25 }, NOW - 60);
    const fxMeta = { ...fx, repricingByPeg: { ...fx.repricingByPeg, [GBP]: { source: OXR, preCloseUsdPerUnit: siblingAnchor } } };
    await persistFx(db, fx.rates, fxMeta, NOW - 60);
    quoteResponse();
    const eurc = makeAsset({ id: "eurc-circle", pegType: EUR, price: 1.05, priceObservedAt: NOW - 30, priceObservedAtMode: "upstream" });
    const inputs = { ...(await hyd(db, [eurc])), asset: eurc, meta: metaOf(eurc.id) };
    expect(decideDepegAsset(inputs).commands).toMatchObject([{ type: "upsert-pending" }]);
    expect(confirmationFor(db, inputs, EUR).kind).toBe("ready");
  });

  it("uses the legacy gold median when only GBP has source-clocked evidence", async () => {
    const { db } = fixtures.open(), rates = { [GOLD]: 4100, [GBP]: 1.27 }, at = NOW - 60;
    await persistFx(db, rates, { ...referenceState(rates, at, false), legacyDetectionPegs: [GOLD], observations: { [GBP]: { pegKey: GBP, usdPerUnit: 1.27, source: OXR, cadence: "intraday", observedAtSec: at } } }, at);
    const peers = ["paxg-paxos", "xaut-tether", "xaum-matrixdock"].map((id, i) =>
      obsCoin(id, GOLD, 4165.6, at, { priceSource: i < 2 ? "coingecko" : "dexscreener-exact", priceObservedAtMode: i < 2 ? "upstream" : "local_fetch" }));
    quoteResponse();
    const h = await hydrateWithSelectedFx(db, peers);
    expect([h.pegRates[GOLD], h.pegRateCounts[GOLD]]).toEqual([4165.6, 3]);
    expect(decideDepegAsset({ ...h, asset: peers[0], meta: metaOf(peers[0].id) })).toMatchObject({ observation: { kind: "observed" }, commands: [] });
  });

  it.each(["dex", "native"] as const)("repeated %s observation leaves persisted recovery and coverage unchanged", async (source) => {
    const { db, sqlite } = fixtures.open(), native = source === "native", observedAt = NOW - 60;
    const coin = native ? asset : makeAsset({ id: "usdt-tether", pegType: USD, price: 1, priceSource: "coingecko" });
    seedOpenEvent(sqlite, { stablecoin_id: coin.id, peg_type: coin.pegType!, peg_reference: 1, pending_reason: native ? "native-origin" : "confirmation-window", started_at: NOW - 3_600 });
    const protocolSources = ["curve", "uniswap"].map((p) => ({ protocol: p, chain: "ethereum", sourceFamily: p, price: 1, tvl: 2_500_000, updatedAt: NOW - 30, observedAt }));
    const nativePegQuote = native ? { stablecoinId: coin.id, geckoId: "brz", pegCurrency: "BRL", price: 1, updatedAt: observedAt, derivation: tradedPair } : undefined;
    const dexRow = native ? undefined : { stablecoin_id: coin.id, dex_price_usd: 1, deviation_from_primary_bps: null, source_pool_count: 2, source_total_tvl: 5e6, updated_at: NOW, aggregateObservedAt: observedAt };
    for (const now of [NOW, NOW + 900]) {
      const { openRows: [existing] } = await hyd(db, []);
      const d = decideDepegAsset({ now, asset: coin, meta: metaOf(coin.id), existing, pegRates: { [USD]: 1 }, pegRateSources: {}, pegRateCounts: {}, protocolSources, nativePegQuote, dexRow });
      await persistDepegCommands(db, [...d.commands, { type: "record-price-coverage", id: existing.id, coverage: d.priceCoverage! }]);
      expect(qGet(sqlite, "SELECT ended_at, recovery_first_seen_at, recovery_last_seen_at, last_trusted_price_at FROM depeg_events"))
        .toEqual({ ended_at: null, recovery_first_seen_at: observedAt, recovery_last_seen_at: observedAt, last_trusted_price_at: observedAt });
      expect(JSON.parse(String(qGet(sqlite, "SELECT price_coverage_json FROM depeg_events")?.price_coverage_json)).atParIntervals).toEqual([[observedAt, observedAt]]);
    }
    expect(qAll(sqlite, SELECT_PENDING_DEPEGS_SQL)).toHaveLength(0);
  });

  it.each([
    { label: "native backfill provenance", source: "backfill", quoteMode: "native-peg", native: true },
    { label: "USD backfill provenance", source: "backfill", quoteMode: "usd", native: false },
    { label: "legacy live native event", source: "live", quoteMode: null, native: true },
  ])("preserves the hydrated quote domain for $label through peak and recovery persistence", async ({ source, quoteMode, native }) => {
    const { db, sqlite } = fixtures.open();
    seedOpenEvent(sqlite, { id: 1, stablecoin_id: BRZ, symbol: "BRZ", peg_type: REAL, source, peg_reference: native ? 1 : 0.193, start_price: native ? 0.98 : 0.18914, peak_price: native ? 0.98 : 0.18914, peak_deviation_bps: -200 });
    if (quoteMode != null) sqlite.prepare("INSERT INTO depeg_event_provenance (event_id, source_kind, quote_mode, created_at, updated_at) VALUES (1, 'coingecko', ?, ?, ?)").run(quoteMode, NOW, NOW);
    quoteResponse();
    const existing = (await hyd(db, [asset], { peggedREAL: 0.193 })).openRows[0];
    expect(existing.quote_mode).toBe(quoteMode);
    await persistDepegCommands(db, [resolvePeakUpdateCommand({ existing, nativeSignal: deriveDepegSignal(0.96, 1), nativePegPrice: 0.96, primarySignal: deriveDepegSignal(0.186, 0.193)!, primaryPrice: 0.186, primaryTrust: "authoritative", dexSupportsDirection: false })!]);
    expect(qGet(sqlite, "SELECT peak_deviation_bps, peak_price FROM depeg_events WHERE id = 1")).toEqual({ peak_deviation_bps: native ? -400 : -363, peak_price: native ? 0.96 : 0.186 });
    const rec = resolveDirectRecovery({ existing, nativeSignal: deriveDepegSignal(0.999, 1), nativePegPrice: 0.999, primarySignal: deriveDepegSignal(0.193, 0.193)!, primaryPrice: 0.193, recoveryThreshold: 50, primarySupportsRecovery: true, primaryRecoveryContradicted: false });
    await persistDepegCommands(db, [{ type: "close-event", id: existing.id, endedAt: NOW, ...rec! }]);
    expect(qGet(sqlite, "SELECT recovery_price, close_reason FROM depeg_events WHERE id = 1")).toEqual({ recovery_price: native ? 0.999 : 0.193, close_reason: native ? "recovered-native" : "recovered-primary" });
  });

  it.each([MAX_OPEN, MAX_OPEN + 1])("fails closed at %s open events and leaves native cache evidence unchanged", async (count) => {
    const { db, sqlite } = fixtures.open();
    seedEvents(sqlite, count);
    sqlite.prepare("INSERT INTO cache (key, value, updated_at) VALUES ('depeg-native-quote:1', ?, ?)").run(JSON.stringify({ value: 0.97, observedAt: NOW - 120, source: "coingecko" }), NOW - 120);
    quoteResponse();
    const sat = await hyd(db, [asset]);
    expect(sat).toMatchObject({ openRowsLimitReached: true, openRows: [] });
    expect(sat.nativePegQuotes.get(BRZ)?.price).toBe(0.98);
    expect(qGet(sqlite, "SELECT updated_at FROM cache WHERE key = 'depeg-native-quote:1'")).toEqual({ updated_at: NOW - 120 });
    expect(countOf(sqlite, "cache WHERE key LIKE 'depeg-native-quote:%'")).toEqual({ count: 1 });
  });

  it("handles detector open-event cap holds, near-cap admission, and stale native quote withholding", async () => {
    const { db, sqlite } = fixtures.open();
    seedEvents(sqlite, MAX_OPEN);
    quoteResponse();
    const allEv = "SELECT * FROM depeg_events ORDER BY id", chg = "SELECT total_changes() AS count";
    const before = qAll(sqlite, allEv), changes = qGet(sqlite, chg);
    await expect(detectDepegEvents(db, [asset])).resolves.toEqual({ status: "held", reason: "depeg-open-event-limit-reached", census: null });
    expect(qAll(sqlite, allEv)).toEqual(before);
    expect(qGet(sqlite, chg)).toEqual(changes);

    const { sqlite: s2 } = fixtures.open();
    let seededChanges: unknown;
    const raceDb = createSqliteD1(s2, { onAll(sql) { if (sql.includes("AS open_event")) { seedEvents(s2, MAX_OPEN); seededChanges = qGet(s2, chg); } } });
    const eligibleCount = [...PSI_ELIGIBLE_META_BY_ID.values()].filter((m) => !m.flags.navToken && !PSI_HISTORICAL_IDS.has(m.id)).length;
    await expect(detectDepegEvents(raceDb, [])).resolves.toEqual({
      status: "held", reason: "depeg-open-event-limit-reached",
      census: { scope: "psi-non-nav-before-supply-floor", evaluatedAt: NOW, eligibleCount, observedCount: 0, unavailableCount: eligibleCount, belowFloorCount: 0, reasonCounts: { "asset-absent": eligibleCount } },
    });
    expect(qGet(s2, chg)).toEqual(seededChanges);
    expect(countOf(s2, "depeg_events WHERE ended_at IS NULL")).toEqual({ count: MAX_OPEN });

    const { db: db3, sqlite: s3 } = fixtures.open();
    seedEvents(s3, MAX_OPEN - 1);
    quoteResponse();
    const nearCap = await hyd(db3, [asset]);
    expect(nearCap.openRowsLimitReached).toBe(false);
    expect(nearCap.openRows).toHaveLength(MAX_OPEN - 1);
    expect(countOf(s3, "cache WHERE key LIKE 'depeg-native-indicative:v1:%'")).toEqual({ count: MAX_OPEN - 1 });

    const { db: db4, sqlite: s4 } = fixtures.open();
    seedEvents(s4);
    quoteResponse(NOW - DEPEG_PRIMARY_PRICE_MAX_AGE_SEC - 1);
    const stale = await hyd(db4, [asset]);
    expect(stale.nativePegQuotes.size).toBe(0);
    expect(stale.openRows).toHaveLength(1);
    expect(cacheVal(s4, "depeg-native-quote:1")).toBeUndefined();
  });

  it("resolves canonical onset and carry-forward across linked incidents, <=6h reopens, sealed splits, indeterminate seals, BLOBs, and fallbacks", async () => {
    const { db, sqlite } = fixtures.open(), old = NOW - 40 * 86_400, esc = NOW - 2 * 86_400;
    seedE(sqlite, 1, "usdt-tether", "USDT", old, NOW - 3_600, -400, { peak_escalation_anchor_bps: 420, peak_escalated_at: esc });
    seedE(sqlite, 2, "usdt-tether", "USDT", NOW - 1_800, null, -300);
    const k = "ddr2:00000000000000000000000000000011";
    sqlite.prepare("INSERT INTO depeg_resolver_incident_event_links (incident_key, event_id, relation, linked_at) VALUES (?, 1, 'observed', ?), (?, 2, 'observed', ?)").run(k, NOW - 1_800, k, NOW - 1_800);
    sqlite.prepare("INSERT INTO depeg_resolver_incidents (incident_key, stablecoin_id, peg_currency, direction, first_event_id, current_event_id, first_started_at, current_started_at, first_observed_peak_bucket_bps, source_fingerprint, created_at, updated_at) VALUES (?, 'usdt-tether', 'USD', 'below', 1, 2, ?, ?, 400, ?, ?, ?)").run(k, old, NOW - 1_800, "a".repeat(64), old, NOW - 1_800);

    seedE(sqlite, 3, "usdc-circle", "USDC", old, NOW - 5_400, -350, { peak_escalation_anchor_bps: 380, peak_escalated_at: esc - 3_600 });
    seedE(sqlite, 4, "usdc-circle", "USDC", NOW - 4_000, NOW - 3_000, -250, { disposition: "repaired", admitted_coverage_json: "[]" });
    seedE(sqlite, 5, "usdc-circle", "USDC", NOW - 1_200, null, -260, { peak_escalation_anchor_bps: 380, peak_escalated_at: esc - 3_600 });

    await sealPredecessor(db, sqlite, 6, "dai-makerdao", "DAI", "Dai", old, NOW - 2_400, 300, esc);
    seedE(sqlite, 7, "dai-makerdao", "DAI", NOW - 1_200, null, -1_200);

    const fraxKey = await sealPredecessor(db, sqlite, 8, "frax-frax", "FRAX", "Frax", old, NOW - 2_400, 310, esc);
    sqlite.exec("DROP TRIGGER trg_ddr_public_predictions_no_update");
    const setSeal = sqlite.prepare("UPDATE depeg_resolver_public_predictions SET sealed_payload_json = ? WHERE event_id = 8");
    setSeal.run('{"frozen":{"sourceRow":{"peakDeviationBps":"bad"}}}');
    seedE(sqlite, 9, "frax-frax", "FRAX", NOW - 1_200, null, -260);

    seedE(sqlite, 10, "lusd-liquity", "LUSD", old, NOW - 3_600, -280);
    sqlite.exec("UPDATE depeg_events SET peak_escalation_anchor_bps = X'FFFF' WHERE id = 10");
    seedE(sqlite, 11, "lusd-liquity", "LUSD", NOW - 1_200, null, -250);
    // Unarmed 3-hop unlinked reopen (null escalation columns) must fail closed as indeterminate.
    seedE(sqlite, 12, "pyusd-paypal", "PYUSD", old, NOW - 15 * 86_400, -250);
    seedE(sqlite, 13, "pyusd-paypal", "PYUSD", NOW - 15 * 86_400 + 1_200, NOW - 2_400, -250);
    seedE(sqlite, 14, "pyusd-paypal", "PYUSD", NOW - 1_200, null, -250);
    sqlite.prepare("UPDATE depeg_events SET peak_escalation_anchor_bps = 310, peak_escalated_at = ? WHERE id = 9").run(esc);

    const byId = new Map((await hyd(db, [])).openRows.map((r) => [r.id, r]));
    expect(byId.get(2)).toMatchObject({ incident_started_at: old, carry_forward_escalation_anchor_bps: 420, carry_forward_peak_escalated_at: esc });
    expect(byId.get(5)?.incident_started_at).toBeUndefined();
    expect(byId.get(5)).toMatchObject({ carry_forward_escalation_anchor_bps: 380, carry_forward_peak_escalated_at: esc - 3_600 });
    expect(byId.get(11)?.incident_started_at).toBe(old);
    expect(byId.get(11)?.carry_forward_escalation_anchor_bps).toBeUndefined();
    expect(byId.get(14)?.incident_started_at).toBeUndefined();
    expect(byId.get(7)?.incident_started_at).toBe(NOW - 1_200);
    expect(byId.get(7)?.carry_forward_escalation_anchor_bps).toBeUndefined();
    expect(byId.get(9)?.incident_started_at).toBeUndefined();
    expect(byId.get(9)?.carry_forward_escalation_anchor_bps).toBeUndefined();
    expect(decideDepegAsset({ now: NOW, meta: metaOf("frax-frax"), existing: byId.get(9)!, asset: obsCoin("frax-frax", USD, 0.97, NOW - 30, { symbol: "FRAX", priceSource: "pyth" }), pegRates: { [USD]: 1 }, pegRateSources: { [USD]: "median" }, pegRateCounts: { [USD]: 4 } }).commands.find((c) => c.type === "update-escalation")).toBeUndefined();

    for (const payload of ["{}", '{"frozen":{"sourceRow":{"peakDeviationBps":true}}}']) {
      setSeal.run(payload);
      const row = (await hyd(db, [])).openRows.find((r) => r.id === 9);
      expect(row?.incident_started_at).toBeUndefined();
      expect(row?.carry_forward_escalation_anchor_bps).toBeUndefined();
      const cand = await loadReopenEscalationCandidate(db, { stablecoinId: "frax-frax", direction: "below", startedAt: NOW - 1_200 });
      expect(cand?.sealedLockTimePeakBps).toBeNull();
      expect(resolvePromotionEscalationCarryForward(-260, cand)).toBeNull();
      expect(await loadSealedIncidentFingerprint(db, fraxKey)).toEqual({ outcome_kind: "prediction", lock_time_peak_deviation_bps: null });
    }
    sqlite.exec("DROP TRIGGER trg_ddr_incidents_identity_no_update");
    sqlite.prepare("UPDATE depeg_resolver_incidents SET first_started_at = ? WHERE incident_key = ?").run(NOW - 600, k);
    expect((await hyd(db, [])).openRows.find((r) => r.id === 2)?.incident_started_at).toBe(NOW - 1_800);
    sqlite.prepare("UPDATE depeg_resolver_incidents SET first_started_at = X'FFFF' WHERE incident_key = ?").run(k);
    expect((await hyd(db, [])).openRows.find((r) => r.id === 2)?.incident_started_at).toBeUndefined();
    // Fractional REAL ended_at must be rejected identically by hydration and promotion predecessor lookup.
    seedE(sqlite, 15, "tusd-trueusd", "TUSD", old, NOW - 1_800.5, -300, { peak_escalation_anchor_bps: 800, peak_escalated_at: esc });
    expect(await loadReopenEscalationCandidate(db, { stablecoinId: "tusd-trueusd", direction: "below", startedAt: NOW - 1_000 })).toBeNull();

    const noWipe = (row: NonNullable<ReturnType<typeof byId.get>>) => {
      expect(row.incident_started_at).toBeUndefined();
      expect(row.escalation_metadata_hydrated).toBe(false);
      const tick = decideDepegAsset({ now: NOW, meta: metaOf("usdc-circle"), existing: row, asset: obsCoin("usdc-circle", USD, 0.97, NOW - 30, { symbol: "USDC", priceSource: "pyth" }), pegRates: { [USD]: 1 }, pegRateSources: { [USD]: "median" }, pegRateCounts: { [USD]: 4 } });
      expect(tick.commands.find((c) => c.type === "update-escalation")).toBeUndefined();
    };
    const auxFail = createSqliteD1(sqlite, { onAll(sql) { if (sql.includes("reopen_predecessor_json")) throw new Error("DDR auxiliary query failed"); } });
    noWipe((await hyd(auxFail, [])).openRows.find((r) => r.id === 5)!);

    sqlite.exec("DROP TABLE depeg_resolver_public_predictions; DROP TABLE depeg_resolver_incidents;");
    const fb = new Map((await hyd(db, [])).openRows.map((r) => [r.id, r]));
    expect(fb.get(2)?.incident_started_at).toBeUndefined();
    expect(fb.get(2)?.escalation_metadata_hydrated).toBe(false);
    noWipe(fb.get(5)!);
    await expect(loadReopenEscalationCandidate(db, { stablecoinId: "usdc-circle", direction: "below", startedAt: NOW - 1_200 })).resolves.toBeNull();
  });

  it("propagates missing required tables, unexpected DEX errors, and cancellation", async () => {
    const { db, sqlite } = fixtures.open();
    sqlite.exec("DROP TABLE depeg_events");
    await expect(hyd(db, [])).rejects.toThrow("depeg_events");

    const { sqlite: s2 } = fixtures.open(), failure = new Error("DEX read unavailable");
    await expect(hyd(createSqliteD1(s2, { onAll(sql) { if (sql.includes("FROM dex_prices")) throw failure; } }), [])).rejects.toBe(failure);

    const { db: db3, sqlite: s3 } = fixtures.open();
    seedEvents(s3);
    const controller = new AbortController(), reason = new Error("detection cancelled");
    controller.abort(reason);
    await expect(hyd(db3, [asset], undefined, controller.signal)).rejects.toBe(reason);
    expect(countOf(s3, "cache")).toEqual({ count: 0 });
  });
});
