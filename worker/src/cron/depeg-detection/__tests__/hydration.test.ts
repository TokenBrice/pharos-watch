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

const fixtures = createLatestSchemaFixtureTracker();
const NOW = 1_780_358_400;
const asset = makeAsset({ id: "brz-transfero", symbol: "BRZ", pegType: "peggedREAL", price: 0.18 });
beforeEach(() => { vi.spyOn(Date, "now").mockReturnValue(NOW * 1000 + 999); });
afterEach(() => {
  fixtures.closeAll();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
function seedEvents(sqlite: DatabaseSync, count = 1) {
  for (let id = 1; id <= count; id++) {
    seedOpenEvent(sqlite, { id, stablecoin_id: "brz-transfero", symbol: "BRZ", peg_type: "peggedREAL", started_at: NOW - 3600 - id });
  }
}
function quoteResponse(updatedAt = NOW - 60) {
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
    brz: { brl: 0.98, last_updated_at: updatedAt },
  }), { status: 200 })));
}

async function hydrateWithSelectedFx(db: D1Database, assets: Parameters<typeof hydrateDepegDetection>[1]) {
  const fx = await loadFreshFxRates(db);
  return hydrateDepegDetection(db, assets, fx.fxFallbackRates, undefined, undefined, undefined, fx.detectionFxState);
}

type ConfirmationInputs = Omit<Parameters<typeof buildConfirmationPlan>[0], "db" | "row" | "pendingState" | "openSet" | "nativePegQuote">;

function confirmationFor(db: D1Database, input: ConfirmationInputs, pegType: string, pegReference = 1) {
  const row = makePendingDepegRow({ stablecoin_id: input.asset!.id, peg_type: pegType,
    first_seen_at: NOW - 1000, peg_reference: pegReference });
  return buildConfirmationPlan({ ...input, db, row, pendingState: normalizePendingDepegRow(row),
    openSet: new Set(), nativePegQuote: undefined });
}

async function decideWithSelectedReference(
  db: D1Database, now: number, coin: ReturnType<typeof makeAsset>,
  rates: Parameters<typeof deriveDetectionPegRates>[4], state: Parameters<typeof deriveDetectionPegRates>[5],
) {
  const { rates: pegRates, sources: pegRateSources, counts: pegRateCounts, referenceContext, observations } =
    await deriveDetectionPegRates(db, [coin], PSI_ELIGIBLE_META_BY_ID, new Set(), rates, state, now);
  const decision = decideDepegAsset({ now, asset: coin, meta: PSI_ELIGIBLE_META_BY_ID.get(coin.id),
    pegRates, pegRateSources, pegRateCounts, referenceContext });
  return { commands: decision.commands, observations };
}

describe("hydrateDepegDetection", () => {
  it("detects severe moves against the retained direct close when a later FX selection cannot qualify", async () => {
    const now = Date.UTC(2026, 10, 21, 0, 20) / 1000;
    vi.spyOn(Date, "now").mockReturnValue(now * 1000);
    for (const { id, peg, market, close, selected, moves } of [
      {
        id: "cngn-compliant-naira", peg: "peggedNGN", market: "fx",
        close: { usdPerUnit: 0.000625, source: "fawazahmed0", cadence: "calendar-daily", observedAtSec: Date.UTC(2026, 10, 20) / 1000 },
        selected: { usdPerUnit: 0.000575, source: "fawazahmed0", cadence: "calendar-daily", observedAtSec: now - 1200 },
        moves: [-3000, 3000, -400],
      },
      {
        id: "paxg-paxos", peg: "peggedGOLD", market: "metal",
        close: { usdPerUnit: 4100, source: "gold-api.com", cadence: "intraday", observedAtSec: Date.UTC(2026, 10, 20, 21, 50) / 1000 },
        selected: { usdPerUnit: 3800, source: "peer-median", cadence: "intraday", observedAtSec: Date.UTC(2026, 10, 20, 21, 57, 30) / 1000 },
        moves: [-3000, -200],
      },
    ] as const) {
      const { db } = fixtures.open();
      const rates = { [peg]: selected.usdPerUnit };
      const observation: FxReferenceObservation = { pegKey: peg, ...close };
      const session = getReferenceSessionState(market, close.observedAtSec);
      if (!session.open) throw new Error("Expected the retained sample to precede the close");
      const fx = referenceState(rates, selected.observedAtSec);
      await persistFxRateState(db, rates, {
        ...fx, usableSyncAt: now - 60, sourceCadenceByPeg: { [peg]: selected.cadence },
        observations: { [peg]: { pegKey: peg, ...selected } },
        referenceSourceSamples: { [`${peg}:${close.source}`]: { observation,
          evidence: { sessionOpenedAtSec: session.sessionOpenedAtSec, firstInSessionObservedAtSec: close.observedAtSec, preCloseUsdPerUnit: null } } },
      }, now - 60);
      const state = await loadFxRateState(db);
      const meta = PSI_ELIGIBLE_META_BY_ID.get(id)!;
      for (const bps of moves) {
        const asset = makeAsset({
          id, symbol: meta.symbol, pegType: peg, price: close.usdPerUnit * (1 + bps / 10_000),
          priceSource: "coingecko", priceConfidence: "single-source", priceUpdatedAt: now - 60,
          priceObservedAt: now - 60, priceObservedAtMode: "upstream", circulating: { [peg]: 60_000_000 },
        });
        const result = await decideWithSelectedReference(db, now, asset, rates, state);
        expect(result.observations?.[peg]).toEqual(observation);
        expect(result.commands).toMatchObject(Math.abs(bps) === 3000
          ? [{ type: "upsert-pending", payload: { bps, pegReference: close.usdPerUnit,
            referenceAdmission: { referenceObservedAtSec: close.observedAtSec, generation: String(now - 60) } } }]
          : []);
      }
    }
  });

  it("carries a verified EUR close across omissions until a rejected replacement", async () => {
    const { db } = fixtures.open();
    const peg = "peggedEUR";
    const friday = Date.UTC(2026, 10, 20, 21, 50) / 1_000;
    const saturday = Date.UTC(2026, 10, 21, 12, 2) / 1_000;
    const pairs = { GBP: "peggedGBP", EUR: peg };
    const start = (syncStartSec: number, prevState: Awaited<ReturnType<typeof loadFxRateState>>) =>
      new FxSyncRunState({ prevState, syncStartSec, expectedPegKeys: Object.values(pairs), initialSources: {}, validateRate: isValidFxRate });
    const eurQuote = (updatedAt: number) => new Map([[peg, { pegKey: peg, price: 1.1, updatedAt, chainId: "base", proxyAddress: "0xfeed" }]]);
    const close = start(friday, null);
    close.applyChainlinkQuotes(eurQuote(friday));
    await persistFxRateState(db, close.usableRates, close.buildPersistedMeta(), friday);
    const id = "eurc-circle";
    for (const [index, step] of ["omit", "omit", "reject", "omit", "heartbeat"].entries()) {
      const now = saturday + index * 60;
      vi.mocked(Date.now).mockReturnValue(now * 1000);
      const refresh = start(now, await loadFxRateState(db));
      refresh.applyFrankfurterRates(step === "reject" ? { GBP: 0.8, EUR: 0.01 } : { GBP: 0.8 }, "2026-11-20", pairs);
      if (step === "heartbeat") refresh.applyChainlinkQuotes(eurQuote(now - 60));
      refresh.enforcePublicationOrder();
      await persistFxRateState(db, refresh.usableRates, refresh.buildPersistedMeta(), now);
      const { fxFallbackRates, detectionFxState } = await loadFreshFxRates(db);
      if (step !== "heartbeat") expect(detectionFxState?.rates[peg]).toBeUndefined();
      for (const bps of [-3000, 3000, -300]) {
        const asset = makeAsset({ id, pegType: peg, price: 1.1 * (1 + bps / 10_000), priceSource: "coingecko",
          priceConfidence: "single-source", priceObservedAtMode: "upstream", priceObservedAt: now - 30,
          priceUpdatedAt: now - 30, circulating: { [peg]: 60_000_000 } });
        const { commands } = await decideWithSelectedReference(db, now, asset, fxFallbackRates, detectionFxState);
        expect(commands).toMatchObject(Math.abs(bps) === 3000 && (index < 2 || step === "heartbeat")
          ? [{ type: "upsert-pending", payload: { bps, pegReference: 1.1, referenceAdmission: { referenceObservedAtSec: friday } } }]
          : []);
      }
    }
  });

  it("returns open events, derived FX fallback and native quotes while persisting the upstream observation clock", async () => {
    const { db, sqlite } = fixtures.open();
    seedEvents(sqlite);
    seedDexEvidence(sqlite, 0.97, [{ protocol: "curve", price: 0.97, tvl: 3_000_000 }]);
    quoteResponse();
    const hydrated = await hydrateDepegDetection(db, [asset], { peggedREAL: 0.19 });
    expect(hydrated).toMatchObject({ now: NOW, syncStart: NOW, openRowsLimitReached: false });
    expect(hydrated.openRows).toHaveLength(1);
    expect(hydrated.openRows[0]).toMatchObject({ id: 1, stablecoin_id: "brz-transfero", ended_at: null });
    expect(hydrated.pegRates.peggedREAL).toBe(0.19);
    expect(hydrated.pegRateSources.peggedREAL).toBe("fx");
    expect(hydrated.dexPriceRows.get("usdt-tether")).toMatchObject({ dex_price_usd: 0.97, source_pool_count: 1, updated_at: NOW - 60 });
    expect(hydrated.dexPriceSources.get("usdt-tether")).toMatchObject([{ protocol: "curve", price: 0.97, tvl: 3_000_000 }]);
    const derivation = { kind: "conversion", lineage: { fxSource: "openExchangeRates" } };
    expect(hydrated.nativePegQuotes.get("brz-transfero")).toMatchObject({
      price: 0.98, updatedAt: NOW - 60, pegCurrency: "BRL", derivation,
    });
    expect(sqlite.prepare("SELECT value FROM cache WHERE key = 'depeg-native-quote:1'").get()).toBeUndefined();
    const cached = sqlite.prepare("SELECT value, updated_at FROM cache WHERE key = 'depeg-native-indicative:v1:1'").get();
    expect(cached?.updated_at).toBe(NOW - 60);
    expect(JSON.parse(String(cached?.value))).toEqual({ value: 0.98, observedAt: NOW - 60, source: "coingecko", derivation });
  });

  it.each(["matching", "other-provider", "missing", "provider-keyed"] as const)("uses a persisted OXR generation with %s repricing evidence", async (evidence) => {
    const { db } = fixtures.open();
    const peg = "peggedREAL";
    const fx = referenceState({ [peg]: 0.193 }, NOW - 60);
    if (evidence === "other-provider") fx.repricingByPeg![peg].source = "chainlink";
    const fxMeta = { ...fx,
      ...(evidence === "missing" || evidence === "provider-keyed" ? { repricingByPeg: undefined } : {}),
      ...(evidence === "provider-keyed" ? { sources: { openExchangeRates: "ok" } } : {}),
    };
    await persistFxRateState(db, fx.rates, fxMeta, NOW - 60);
    quoteResponse();
    const observed = { ...asset, priceObservedAt: NOW - 30, priceObservedAtMode: "upstream" as const };
    const { pegRates, pegRateSources, pegRateCounts } = await hydrateWithSelectedFx(db, [observed]);
    const meta = PSI_ELIGIBLE_META_BY_ID.get(asset.id);
    const inputs = { asset: observed, meta, now: NOW, pegRates, pegRateSources, pegRateCounts };
    const detection = decideDepegAsset(inputs);
    expect(detection.commands).toMatchObject(evidence === "other-provider" ? [] : [{ type: "upsert-pending", payload: { bps: -674 } }]);
    const plan = confirmationFor(db, inputs, peg, 0.193);
    expect(plan.kind).toBe(evidence === "other-provider" ? "wait" : "ready");
  });

  it.each(["selected", "first-sample", "first-after-deploy", "empty", "empty-with-marker", "carried", "mixed-carry", "other-session"] as const)("uses %s canonical observations from the same FX generation", async (mode) => {
    const { db } = fixtures.open();
    const peg = "peggedREAL";
    const rates: Record<string, number> = { [peg]: 0.193 };
    if (mode === "mixed-carry") rates.peggedEUR = 1.08;
    const fx = referenceState(rates, NOW - 60);
    fx.repricingByPeg = undefined;
    fx.sources = { openExchangeRates: "ok" };
    const observation = { pegKey: peg, usdPerUnit: 0.193, observedAtSec: NOW - 60,
      source: "openExchangeRates" as const, cadence: "intraday" as const };
    const empty = mode === "empty" || mode === "empty-with-marker";
    const observations: FxRatesMeta["observations"] = empty ? {} : mode === "carried" ? undefined : mode === "mixed-carry"
      ? { peggedEUR: { ...observation, pegKey: "peggedEUR", usdPerUnit: rates.peggedEUR } } : { [peg]: observation };
    const session = getReferenceSessionState("fx", NOW);
    if (!session.open) throw new Error("Expected an open BRL reference session");
    await persistFxRateState(db, fx.rates, { ...fx,
      observations,
      legacyDetectionPegs: ["carried", "mixed-carry", "first-after-deploy", "empty-with-marker"].includes(mode) ? [peg] : undefined,
      referenceSourceSamples: { [`${peg}:openExchangeRates`]: { observation,
        evidence: { sessionOpenedAtSec: session.sessionOpenedAtSec - (mode === "other-session" ? 604800 : 0),
          firstInSessionObservedAtSec: NOW - 60, preCloseUsdPerUnit: mode === "first-sample" || mode === "first-after-deploy" ? null : 0.190 } } },
    }, NOW - 60);
    quoteResponse();
    const observed = { ...asset, priceObservedAt: NOW - 30, priceObservedAtMode: "upstream" as const };
    const hydrated = await hydrateWithSelectedFx(db, [observed]);
    const input = { ...hydrated, pegRates: { ...hydrated.pegRates }, asset: observed, meta: PSI_ELIGIBLE_META_BY_ID.get(asset.id) };
    const admitted = mode === "selected" || mode === "first-after-deploy" || mode === "carried" || mode === "mixed-carry";
    expect(decideDepegAsset(input).commands.map(({ type }) => type)).toEqual(admitted ? ["upsert-pending"] : []);
    expect(confirmationFor(db, input, peg).kind).toBe(admitted ? "ready" : "wait");
  });

  it.each([null, "invalid-rate"] as const)("isolates GBP repricing anchor %s from persisted EUR admission", async (siblingAnchor) => {
    const { db } = fixtures.open();
    const fx = referenceState({ peggedEUR: 1.10, peggedGBP: 1.25 }, NOW - 60);
    const repricingByPeg = { ...fx.repricingByPeg, peggedGBP: { source: "openExchangeRates", preCloseUsdPerUnit: siblingAnchor } };
    const fxMeta = { ...fx, repricingByPeg };
    await persistFxRateState(db, fx.rates, fxMeta, NOW - 60);
    quoteResponse();
    const eurc = makeAsset({ id: "eurc-circle", pegType: "peggedEUR", price: 1.05,
      priceObservedAt: NOW - 30, priceObservedAtMode: "upstream" });
    const hydrated = await hydrateDepegDetection(db, [eurc]);
    const inputs = { ...hydrated, asset: eurc, meta: PSI_ELIGIBLE_META_BY_ID.get(eurc.id) };
    expect(decideDepegAsset(inputs).commands).toMatchObject([{ type: "upsert-pending" }]);
    expect(confirmationFor(db, inputs, eurc.pegType!).kind).toBe("ready");
  });

  it("uses the legacy gold median when only GBP has source-clocked evidence", async () => {
    const { db } = fixtures.open();
    const rates = { peggedGOLD: 4100, peggedGBP: 1.27 };
    const observedAtSec = NOW - 60;
    await persistFxRateState(db, rates, {
      ...referenceState(rates, observedAtSec, false),
      legacyDetectionPegs: ["peggedGOLD"],
      observations: {
        peggedGBP: { pegKey: "peggedGBP", usdPerUnit: 1.27, source: "openExchangeRates", cadence: "intraday", observedAtSec },
      },
    }, observedAtSec);
    const peers = ["paxg-paxos", "xaut-tether", "xaum-matrixdock"].map((id, i) => makeAsset({
      id, pegType: "peggedGOLD", price: 4165.60, priceUpdatedAt: observedAtSec, priceObservedAt: observedAtSec,
      priceSource: i < 2 ? "coingecko" : "dexscreener-exact", priceObservedAtMode: i < 2 ? "upstream" : "local_fetch",
    }));
    quoteResponse();
    const hydrated = await hydrateWithSelectedFx(db, peers);
    expect([hydrated.pegRates.peggedGOLD, hydrated.pegRateCounts.peggedGOLD]).toEqual([4165.60, 3]);
    expect(decideDepegAsset({ ...hydrated, asset: peers[0], meta: PSI_ELIGIBLE_META_BY_ID.get(peers[0].id) }))
      .toMatchObject({ observation: { kind: "observed" }, commands: [] });
  });

  it.each(["dex", "native"] as const)("repeated %s observation leaves persisted recovery and coverage unchanged", async (source) => {
    const { db, sqlite } = fixtures.open();
    const native = source === "native";
    const coin = native ? asset : makeAsset({ id: "usdt-tether", pegType: "peggedUSD", price: 1, priceSource: "coingecko" });
    seedOpenEvent(sqlite, { stablecoin_id: coin.id, peg_type: coin.pegType!, peg_reference: 1,
      pending_reason: native ? "native-origin" : "confirmation-window", started_at: NOW - 3_600 });
    const observedAt = NOW - 60;
    const protocolSources = ["curve", "uniswap"].map((protocol) => ({ protocol, chain: "ethereum",
      sourceFamily: protocol, price: 1, tvl: 2_500_000, updatedAt: NOW - 30, observedAt }));
    const nativeQuote = { stablecoinId: coin.id, geckoId: "brz", pegCurrency: "BRL", price: 1,
      updatedAt: observedAt, derivation: tradedPair };
    for (const now of [NOW, NOW + 900]) {
      const { openRows: [existing] } = await hydrateDepegDetection(db, []);
      const decision = decideDepegAsset({ now, asset: coin, meta: PSI_ELIGIBLE_META_BY_ID.get(coin.id), existing,
        pegRates: { peggedUSD: 1 }, pegRateSources: {}, pegRateCounts: {}, protocolSources,
        nativePegQuote: native ? nativeQuote : undefined,
        dexRow: native ? undefined : { stablecoin_id: coin.id, dex_price_usd: 1, deviation_from_primary_bps: null,
          source_pool_count: 2, source_total_tvl: 5_000_000, updated_at: NOW, aggregateObservedAt: observedAt },
      });
      await persistDepegCommands(db, [...decision.commands, { type: "record-price-coverage", id: existing.id, coverage: decision.priceCoverage! }]);
      expect(sqlite.prepare("SELECT ended_at, recovery_first_seen_at, recovery_last_seen_at, last_trusted_price_at FROM depeg_events").get())
        .toEqual({ ended_at: null, recovery_first_seen_at: observedAt, recovery_last_seen_at: observedAt, last_trusted_price_at: observedAt });
      const raw = sqlite.prepare("SELECT price_coverage_json FROM depeg_events").get();
      expect(JSON.parse(String(raw?.price_coverage_json)).atParIntervals).toEqual([[observedAt, observedAt]]);
    }
    expect(sqlite.prepare(SELECT_PENDING_DEPEGS_SQL).all()).toHaveLength(0);
  });

  it.each([
    { label: "native backfill provenance", source: "backfill", quoteMode: "native-peg", native: true },
    { label: "USD backfill provenance", source: "backfill", quoteMode: "usd", native: false },
    { label: "legacy live native event", source: "live", quoteMode: null, native: true },
  ])("preserves the hydrated quote domain for $label through peak and recovery persistence", async ({ source, quoteMode, native }) => {
    const { db, sqlite } = fixtures.open();
    seedOpenEvent(sqlite, {
      id: 1, stablecoin_id: asset.id, symbol: "BRZ", peg_type: "peggedREAL",
      source, peg_reference: native ? 1 : 0.193, start_price: native ? 0.98 : 0.18914,
      peak_price: native ? 0.98 : 0.18914, peak_deviation_bps: -200,
    });
    if (quoteMode != null) {
      sqlite.prepare(`INSERT INTO depeg_event_provenance
        (event_id, source_kind, quote_mode, created_at, updated_at) VALUES (1, 'coingecko', ?, ?, ?)`)
        .run(quoteMode, NOW, NOW);
    }
    quoteResponse();
    const hydrated = await hydrateDepegDetection(db, [asset], { peggedREAL: 0.193 });
    const existing = hydrated.openRows[0];
    expect(existing.quote_mode).toBe(quoteMode);
    const peak = resolvePeakUpdateCommand({
      existing, nativeSignal: deriveDepegSignal(0.96, 1), nativePegPrice: 0.96,
      primarySignal: deriveDepegSignal(0.186, 0.193)!, primaryPrice: 0.186,
      primaryTrust: "authoritative", dexSupportsDirection: false,
    });
    expect(peak).not.toBeNull();
    await persistDepegCommands(db, [peak!]);
    expect(sqlite.prepare("SELECT peak_deviation_bps, peak_price FROM depeg_events WHERE id = 1").get())
      .toEqual({ peak_deviation_bps: native ? -400 : -363, peak_price: native ? 0.96 : 0.186 });
    const recovery = resolveDirectRecovery({
      existing, nativeSignal: deriveDepegSignal(0.999, 1), nativePegPrice: 0.999,
      primarySignal: deriveDepegSignal(0.193, 0.193)!,
      primaryPrice: 0.193, recoveryThreshold: 50, primarySupportsRecovery: true,
      primaryRecoveryContradicted: false,
    });
    expect(recovery).not.toBeNull();
    await persistDepegCommands(db, [{ type: "close-event", id: existing.id, endedAt: NOW, ...recovery! }]);
    expect(sqlite.prepare("SELECT recovery_price, close_reason FROM depeg_events WHERE id = 1").get())
      .toEqual({ recovery_price: native ? 0.999 : 0.193, close_reason: native ? "recovered-native" : "recovered-primary" });
  });

  it.each([MAX_OPEN_DEPEG_EVENTS, MAX_OPEN_DEPEG_EVENTS + 1])("fails closed at %s open events and leaves native cache evidence unchanged", async (count) => {
    const { db, sqlite } = fixtures.open();
    seedEvents(sqlite, count);
    sqlite.prepare("INSERT INTO cache (key, value, updated_at) VALUES ('depeg-native-quote:1', ?, ?)")
      .run(JSON.stringify({ value: 0.97, observedAt: NOW - 120, source: "coingecko" }), NOW - 120);
    quoteResponse();
    const saturated = await hydrateDepegDetection(db, [asset]);
    expect(saturated.openRowsLimitReached).toBe(true);
    expect(saturated.openRows).toEqual([]);
    expect(saturated.nativePegQuotes.get("brz-transfero")?.price).toBe(0.98);
    expect(sqlite.prepare("SELECT updated_at FROM cache WHERE key = 'depeg-native-quote:1'").get()).toEqual({ updated_at: NOW - 120 });
    expect(sqlite.prepare("SELECT COUNT(*) AS count FROM cache WHERE key LIKE 'depeg-native-quote:%'").get()).toEqual({ count: 1 });
  });

  it("returns a named detector hold without mutating the saturated event book", async () => {
    const { db, sqlite } = fixtures.open();
    seedEvents(sqlite, MAX_OPEN_DEPEG_EVENTS);
    quoteResponse();
    const before = sqlite.prepare("SELECT * FROM depeg_events ORDER BY id").all();
    const changes = sqlite.prepare("SELECT total_changes() AS count").get();
    await expect(detectDepegEvents(db, [asset])).resolves.toEqual({
      status: "held", reason: "depeg-open-event-limit-reached", census: null,
    });
    expect(sqlite.prepare("SELECT * FROM depeg_events ORDER BY id").all()).toEqual(before);
    expect(sqlite.prepare("SELECT total_changes() AS count").get()).toEqual(changes);
  });

  it("returns a named hold when the book fills between hydration and orphan cleanup", async () => {
    const { sqlite } = fixtures.open();
    let seededChanges: unknown;
    const db = createSqliteD1(sqlite, { onAll(sql) {
      if (sql.includes("AS open_event")) {
        seedEvents(sqlite, MAX_OPEN_DEPEG_EVENTS);
        seededChanges = sqlite.prepare("SELECT total_changes() AS count").get();
      }
    } });
    // Absent off-catalog historical members are not expected, so they stay outside the census.
    const eligibleCount = [...PSI_ELIGIBLE_META_BY_ID.values()]
      .filter((meta) => !meta.flags.navToken && !PSI_HISTORICAL_IDS.has(meta.id)).length;
    await expect(detectDepegEvents(db, [])).resolves.toEqual({
      status: "held",
      reason: "depeg-open-event-limit-reached",
      census: {
        scope: "psi-non-nav-before-supply-floor",
        evaluatedAt: NOW,
        eligibleCount,
        observedCount: 0,
        unavailableCount: eligibleCount,
        belowFloorCount: 0,
        reasonCounts: { "asset-absent": eligibleCount },
      },
    });
    expect(sqlite.prepare("SELECT total_changes() AS count").get()).toEqual(seededChanges);
    expect(sqlite.prepare("SELECT COUNT(*) AS count FROM depeg_events WHERE ended_at IS NULL").get())
      .toEqual({ count: MAX_OPEN_DEPEG_EVENTS });
  });

  it("admits one fewer event than the cap and persists its quote", async () => {
    const { db, sqlite } = fixtures.open();
    seedEvents(sqlite, MAX_OPEN_DEPEG_EVENTS - 1);
    quoteResponse();
    const hydrated = await hydrateDepegDetection(db, [asset]);
    expect(hydrated.openRowsLimitReached).toBe(false);
    expect(hydrated.openRows).toHaveLength(MAX_OPEN_DEPEG_EVENTS - 1);
    expect(sqlite.prepare("SELECT COUNT(*) AS count FROM cache WHERE key LIKE 'depeg-native-indicative:v1:%'").get())
      .toEqual({ count: MAX_OPEN_DEPEG_EVENTS - 1 });
  });

  it("keeps unavailable native quotes absent rather than fabricating recovery evidence", async () => {
    const { db, sqlite } = fixtures.open();
    seedEvents(sqlite);
    quoteResponse(NOW - DEPEG_PRIMARY_PRICE_MAX_AGE_SEC - 1);
    const hydrated = await hydrateDepegDetection(db, [asset]);
    expect(hydrated.nativePegQuotes.size).toBe(0);
    expect(hydrated.openRows).toHaveLength(1);
    expect(sqlite.prepare("SELECT value FROM cache WHERE key = 'depeg-native-quote:1'").get()).toBeUndefined();
  });

  it("propagates an unavailable required open-event read instead of returning an apparently empty book", async () => {
    const { db, sqlite } = fixtures.open();
    sqlite.exec("DROP TABLE depeg_events");
    await expect(hydrateDepegDetection(db, [])).rejects.toThrow("depeg_events");
  });

  it("does not hide unexpected DEX storage failures as missing corroboration", async () => {
    const { sqlite } = fixtures.open();
    const failure = new Error("DEX read unavailable");
    const db = createSqliteD1(sqlite, { onAll(sql) { if (sql.includes("FROM dex_prices")) throw failure; } });
    await expect(hydrateDepegDetection(db, [])).rejects.toBe(failure);
  });

  it("propagates cancellation before producing or persisting a hydrated result", async () => {
    const { db, sqlite } = fixtures.open();
    seedEvents(sqlite);
    const controller = new AbortController();
    const reason = new Error("detection cancelled");
    controller.abort(reason);
    await expect(hydrateDepegDetection(db, [asset], undefined, controller.signal)).rejects.toBe(reason);
    expect(sqlite.prepare("SELECT COUNT(*) AS count FROM cache").get()).toEqual({ count: 0 });
  });
});
