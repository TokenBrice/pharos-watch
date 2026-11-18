import { describe, expect, it } from "vitest";
import { sha256Hex } from "@shared/lib/sha256";
import { evaluateReferenceAdmission } from "@shared/lib/reference-admission";
import { asRawDeviationBps } from "@shared/types/reference-admission";
import { isValidFxRate } from "../../lib/fx-config";
import { getFxReferenceTypeFromState, getFxSourceStatus, hydrateFxRateState, loadFxRateState, type FxRateState, type FxSourceCadence } from "../../lib/fx-rate-state";
import { FxSyncRunState, persistFxSyncResult } from "../sync-fx-rates-helpers";
import { createLatestSchemaSqlite } from "@shared/test-utils/latest-schema-sqlite";
import { buildPricingOperatorConditions } from "../operator-watch-pricing";

const syncStartSec = Math.floor(Date.parse("2025-06-15T12:00:00Z") / 1000);

function buildPrevState(rates: Record<string, number>): FxRateState {
  const updatedAt = syncStartSec - 3600;
  const keys = Object.keys(rates);
  return {
    rates,
    usableSyncAt: updatedAt,
    usableAgeSec: syncStartSec - updatedAt,
    mode: "live",
    sourceUpdatedAtByPeg: Object.fromEntries(keys.map((key) => [key, updatedAt])),
    sourceModeByPeg: Object.fromEntries(keys.map((key) => [key, "live"])),
    sourceCadenceByPeg: Object.fromEntries(keys.map((key) => [key, "intraday" as FxSourceCadence])),
    sourceDateByPeg: Object.fromEntries(keys.map((key) => [key, null])),
    sourceLastSuccessAtBySource: {},
    consecutiveFallbackRuns: 0,
    metadataIdentity: "verified",
  };
}

function createState(prevRates: Record<string, number> = {}): FxSyncRunState {
  const prevState = Object.keys(prevRates).length > 0 ? buildPrevState(prevRates) : null;
  return new FxSyncRunState({
    prevState,
    syncStartSec,
    expectedPegKeys: ["peggedMYR"],
    initialSources: {},
    validateRate: (pegKey, rate, prevRate) => isValidFxRate(pegKey, rate, prevRate, "[sync-fx-rates:test]"),
  });
}

describe("FxSyncRunState realtime overlays", () => {
  it("leaves an unanchored realtime rate provisional when there is no current or previous reference", () => {
    const state = createState();

    const applied = state.applyRealtimeOverlayRates({ observedAt: syncStartSec - 600, rates: new Map([["peggedMYR", 0.222222]]) });

    expect(applied).toBe(0);
    expect(state.usableRates.peggedMYR).toBeUndefined();
    expect(state.buildResultMetadata([])).toMatchObject({
      missing: ["peggedMYR"],
      provisionalRealtimeOverlayPegs: ["peggedMYR"],
    });
  });

  it("applies a realtime overlay when the current run already has a reference", () => {
    const state = createState();
    state.usableRates.peggedMYR = 0.222222;
    state.markLive("peggedMYR", syncStartSec - 1200, "calendar-daily", "2025-06-15");

    const applied = state.applyRealtimeOverlayRates({ observedAt: syncStartSec - 600, rates: new Map([["peggedMYR", 0.223333]]) });

    expect(applied).toBe(1);
    expect(state.usableRates.peggedMYR).toBe(0.223333);
    expect(state.buildResultMetadata([]).provisionalRealtimeOverlayPegs).toBeUndefined();
  });

  it("applies a realtime overlay when previous history can corroborate the peg", () => {
    const state = createState({ peggedMYR: 0.222222 });

    const applied = state.applyRealtimeOverlayRates({ observedAt: syncStartSec - 600, rates: new Map([["peggedMYR", 0.223333]]) });

    expect(applied).toBe(1);
    expect(state.usableRates.peggedMYR).toBe(0.223333);
    expect(state.buildResultMetadata([]).provisionalRealtimeOverlayPegs).toBeUndefined();
  });

  it("records the OXR snapshot time, not the run clock, as overlay provenance", () => {
    const state = createState({ peggedMYR: 0.222222 });
    const observedAt = syncStartSec - 40 * 60;

    state.applyRealtimeOverlayRates({ observedAt, rates: new Map([["peggedMYR", 0.223333]]) });

    expect(state.sourceUpdatedAtByPeg.peggedMYR).toBe(observedAt);
    expect(state.sourceModeByPeg.peggedMYR).toBe("live");
  });

  it("does not let an older OXR overlay suppress a genuinely fresher Chainlink quote", () => {
    const state = createState();
    const ecbUpdatedAt = syncStartSec - 20 * 3600;
    state.usableRates.peggedEUR = 1.08;
    state.markLive("peggedEUR", ecbUpdatedAt, "business-daily", "2025-06-14");
    const oxrObservedAt = syncStartSec - 50 * 60;
    state.applyRealtimeOverlayRates({ observedAt: oxrObservedAt, rates: new Map([["peggedEUR", 1.081]]) });
    expect(state.sourceUpdatedAtByPeg.peggedEUR).toBe(oxrObservedAt);

    const chainlinkUpdatedAt = syncStartSec - 10 * 60;
    const accepted = state.applyChainlinkQuotes(new Map([
      ["peggedEUR", { pegKey: "peggedEUR", price: 1.0812, updatedAt: chainlinkUpdatedAt, chainId: "base", proxyAddress: "0xfeed" }],
    ]));

    expect(accepted).toBe(1);
    expect(state.usableRates.peggedEUR).toBe(1.0812);
    expect(state.sourceUpdatedAtByPeg.peggedEUR).toBe(chainlinkUpdatedAt);
  });

  it("still skips a Chainlink quote older than the OXR observation", () => {
    const state = createState();
    state.usableRates.peggedEUR = 1.08;
    state.markLive("peggedEUR", syncStartSec - 20 * 3600, "business-daily", "2025-06-14");
    const oxrObservedAt = syncStartSec - 10 * 60;
    state.applyRealtimeOverlayRates({ observedAt: oxrObservedAt, rates: new Map([["peggedEUR", 1.081]]) });

    const accepted = state.applyChainlinkQuotes(new Map([
      ["peggedEUR", { pegKey: "peggedEUR", price: 1.0812, updatedAt: syncStartSec - 50 * 60, chainId: "base", proxyAddress: "0xfeed" }],
    ]));

    expect(accepted).toBe(0);
    expect(state.usableRates.peggedEUR).toBe(1.081);
    expect(state.sourceUpdatedAtByPeg.peggedEUR).toBe(oxrObservedAt);
  });
});

describe("FxSyncRunState metal references", () => {
  const createMetalState = (prevState: FxRateState | null) => new FxSyncRunState({
    prevState,
    syncStartSec,
    expectedPegKeys: ["peggedSILVER"],
    initialSources: {},
    validateRate: (pegKey, rate, prevRate) => isValidFxRate(pegKey, rate, prevRate, "[sync-fx-rates:test]"),
  });

  const applyCachedSilver = (state: FxSyncRunState, rate = 40.448374) => {
    state.applyResolvedMetals({
      resolvedByPeg: { peggedSILVER: { rate, source: "cached", updatedAt: null } },
      sources: { "gold-api.com": "error", "commodity-peer-median": "unavailable" },
    });
  };

  it("keeps a cached metal fallback's original observation clock", () => {
    const observedAt = syncStartSec - 26 * 3600;
    const prevState = buildPrevState({ peggedSILVER: 40.448374 });
    prevState.sourceUpdatedAtByPeg.peggedSILVER = observedAt;
    const state = createMetalState(prevState);

    applyCachedSilver(state);

    expect(state.usableRates.peggedSILVER).toBe(40.448374);
    expect(state.sourceUpdatedAtByPeg.peggedSILVER).toBe(observedAt);
    expect(state.sourceModeByPeg.peggedSILVER).toBe("live");
    expect(getFxSourceStatus(observedAt, "live", syncStartSec, { pegKey: "peggedSILVER", cadence: "intraday" }))
      .toBe("stale");
  });

  it("lets a fresh Chainlink metal round replace a stale spot reference within the delta bound", () => {
    const observedAt = syncStartSec - 26 * 3600;
    const prevState = buildPrevState({ peggedSILVER: 40.448374 });
    prevState.sourceUpdatedAtByPeg.peggedSILVER = observedAt;
    const state = createMetalState(prevState);
    applyCachedSilver(state);

    const chainlinkUpdatedAt = syncStartSec - 600;
    const accepted = state.applyChainlinkQuotes(new Map([
      ["peggedSILVER", { pegKey: "peggedSILVER", price: 45, updatedAt: chainlinkUpdatedAt, chainId: "ethereum", proxyAddress: "0xfeed" }],
    ]));

    expect(accepted).toBe(1);
    expect(state.usableRates.peggedSILVER).toBe(45);
    expect(state.sourceUpdatedAtByPeg.peggedSILVER).toBe(chainlinkUpdatedAt);
  });

  it("keeps a stale incumbent when a fresh Chainlink round jumps it by more than 20% without corroboration", () => {
    const observedAt = syncStartSec - 26 * 3600;
    const prevState = buildPrevState({ peggedSILVER: 40.448374 });
    prevState.sourceUpdatedAtByPeg.peggedSILVER = observedAt;
    const state = createMetalState(prevState);
    applyCachedSilver(state);

    const accepted = state.applyChainlinkQuotes(new Map([
      ["peggedSILVER", { pegKey: "peggedSILVER", price: 50.378, updatedAt: syncStartSec - 600, chainId: "ethereum", proxyAddress: "0xfeed" }],
    ]));

    expect(accepted).toBe(0);
    expect(state.usableRates.peggedSILVER).toBe(40.448374);
    expect(state.sourceUpdatedAtByPeg.peggedSILVER).toBe(observedAt);
  });

  it("never moves a metal clock backwards to an older Chainlink round", () => {
    const observedAt = syncStartSec - 7 * 3600;
    const prevState = buildPrevState({ peggedSILVER: 50 });
    prevState.sourceUpdatedAtByPeg.peggedSILVER = observedAt;
    const state = createMetalState(prevState);
    applyCachedSilver(state, 50);

    const accepted = state.applyChainlinkQuotes(new Map([
      ["peggedSILVER", { pegKey: "peggedSILVER", price: 49, updatedAt: syncStartSec - 11 * 3600, chainId: "ethereum", proxyAddress: "0xfeed" }],
    ]));

    expect(accepted).toBe(0);
    expect(state.usableRates.peggedSILVER).toBe(50);
    expect(state.sourceUpdatedAtByPeg.peggedSILVER).toBe(observedAt);
  });

  it("lets an unknown-clock incumbent accept a fresh Chainlink round within the delta bound", () => {
    const prevState = buildPrevState({ peggedSILVER: 50 });
    prevState.sourceUpdatedAtByPeg.peggedSILVER = null;
    const state = createMetalState(prevState);
    applyCachedSilver(state, 50);

    const chainlinkUpdatedAt = syncStartSec - 600;
    const accepted = state.applyChainlinkQuotes(new Map([
      ["peggedSILVER", { pegKey: "peggedSILVER", price: 53, updatedAt: chainlinkUpdatedAt, chainId: "ethereum", proxyAddress: "0xfeed" }],
    ]));

    expect(accepted).toBe(1);
    expect(state.usableRates.peggedSILVER).toBe(53);
    expect(state.sourceUpdatedAtByPeg.peggedSILVER).toBe(chainlinkUpdatedAt);
  });

  it("still rejects a Chainlink metal round that diverges from a fresh spot", () => {
    const state = createMetalState(buildPrevState({ peggedSILVER: 40.448374 }));
    applyCachedSilver(state);

    const accepted = state.applyChainlinkQuotes(new Map([
      ["peggedSILVER", { pegKey: "peggedSILVER", price: 50.378, updatedAt: syncStartSec - 600, chainId: "ethereum", proxyAddress: "0xfeed" }],
    ]));

    expect(accepted).toBe(0);
    expect(state.usableRates.peggedSILVER).toBe(40.448374);
  });
});

describe("FxSyncRunState partial Frankfurter coverage", () => {
  it("recovers an omitted primary peg with its original cadence-valid provenance", () => {
    const state = createState({ peggedEUR: 1.08, peggedMYR: 0.22 });
    state.applyFrankfurterRates({ MYR: 1 / 0.22 }, "2025-06-13", { EUR: "peggedEUR", MYR: "peggedMYR" });
    expect(state.usableRates.peggedEUR).toBe(1.08);
    expect(state.usableRates.peggedMYR).toBeCloseTo(0.22);
    expect(state.sourceUpdatedAtByPeg.peggedEUR).toBe(syncStartSec - 3600);
    expect(state.sourceModeByPeg.peggedEUR).toBe("live");
    expect(state.sourceCadenceByPeg.peggedEUR).toBe("intraday");
    expect(state.sourceModeByPeg.peggedMYR).toBe("live");
  });

  it.each([false, true])("leaves an omitted primary unavailable with stale previous state=%s", (stalePrevious) => {
    const previous = stalePrevious ? buildPrevState({ peggedEUR: 1.08 }) : null;
    if (previous) previous.sourceUpdatedAtByPeg.peggedEUR = syncStartSec - 24 * 3600;
    const state = new FxSyncRunState({
      prevState: previous, syncStartSec, expectedPegKeys: ["peggedEUR", "peggedMYR"],
      initialSources: {}, validateRate: () => true,
    });
    state.applyFrankfurterRates({ MYR: 1 / 0.22 }, "2025-06-13", { EUR: "peggedEUR", MYR: "peggedMYR" });
    expect(Object.keys(state.usableRates)).toEqual(["peggedMYR"]);
    expect(state.usableRates.peggedMYR).toBeCloseTo(0.22);
    expect(state.getMissingPegKeys()).toEqual(["peggedEUR"]);
    expect(state.sourceUpdatedAtByPeg.peggedEUR).toBeUndefined();
  });
});

describe("FxSyncRunState source-day admission", () => {
  it.each(["2099-01-01", "2025-06-16", "2025-02-30", "2025-13-01"])(
    "does not apply primary or secondary rates dated %s", (date) => {
      const state = createState();
      state.applyFrankfurterRates({ MYR: 4.5 }, date, { MYR: "peggedMYR" });
      expect(state.usableRates).toEqual({});
      state.applySecondaryRates({ endpoint: "jsdelivr", payload: { date, usd: { myr: 4.5 } } }, [["myr", "peggedMYR"]]);
      expect(state.usableRates).toEqual({});
      expect(state.hasFreshFullFxCoverage()).toBe(false);
    },
  );

  it.each([
    ["2025-06-13T12:15:00Z", "2025-06-13"],
    ["2025-06-15T12:00:00Z", "2025-06-13"],
    ["2026-04-06T19:00:00Z", "2026-04-02"],
  ])("admits dated primary rates at %s with source day %s", (clock, date) => {
    const now = Date.parse(clock) / 1000;
    const state = new FxSyncRunState({
      prevState: null, syncStartSec: now, expectedPegKeys: ["peggedMYR"],
      initialSources: {}, validateRate: () => true,
    });
    state.applyFrankfurterRates({ MYR: 4.5 }, date, { MYR: "peggedMYR" });
    expect(state.usableRates.peggedMYR).toBeCloseTo(1 / 4.5);
    expect(state.sourceDateByPeg.peggedMYR).toBe(date);
    expect(state.hasFreshFullFxCoverage()).toBe(true);
  });

  it.each([60, 301, 86400])("keeps the dated reference after an ExchangeRate-API epoch %s seconds ahead", (ahead) => {
    const state = createState();
    state.applySecondaryRates({ endpoint: "jsdelivr", payload: { date: "2025-06-15", usd: { myr: 4.6 } } }, [["MYR", "peggedMYR"]]);
    state.applyExchangeRateApiRates({ time_last_update_unix: syncStartSec + ahead, rates: { MYR: 4.5 } }, [["MYR", "peggedMYR"]]);
    expect(published(state).observations?.peggedMYR).toMatchObject({
      source: "fawazahmed0", usdPerUnit: 1 / 4.6, observedAtSec: unix("2025-06-15T00:00:00Z"),
    });
  });

  it("preserves an admissible ExchangeRate-API epoch without clamping it", () => {
    const state = createState();
    state.applyExchangeRateApiRates({ time_last_update_unix: syncStartSec - 60, rates: { MYR: 4.5 } }, [["MYR", "peggedMYR"]]);
    expect(published(state).observations?.peggedMYR).toMatchObject({
      source: "exchangeRateApi", usdPerUnit: 1 / 4.5, observedAtSec: syncStartSec - 60,
    });
  });
});

const unix = (iso: string) => Date.parse(iso) / 1000;

function publicationAt(clock: string, prevState: FxRateState | null = null): FxSyncRunState {
  return new FxSyncRunState({
    prevState, syncStartSec: unix(clock), expectedPegKeys: ["peggedARS", "peggedTRY", "peggedREAL"],
    initialSources: {}, validateRate: isValidFxRate,
  });
}

function published(state: FxSyncRunState): FxRateState {
  state.enforcePublicationOrder();
  const value = JSON.stringify(state.usableRates);
  return hydrateFxRateState(
    { value, updatedAt: state.syncStartSec },
    { value: JSON.stringify({ ...state.buildPersistedMeta(), ratesSha256: sha256Hex(value) }), updatedAt: state.syncStartSec },
  )!;
}

const arsMappings = [["ars", "peggedARS"]] as const;
const tryBrlMappings = { TRY: "peggedTRY", BRL: "peggedREAL" };
const secondaryArs = (state: FxSyncRunState, date: string | undefined, ars: number) =>
  state.applySecondaryRates({ endpoint: "jsdelivr", payload: { date, usd: { ars } } }, arsMappings);
const oxrArs = (state: FxSyncRunState, observedAt: number, ars: number) =>
  state.applyRealtimeOverlayRates({ observedAt, rates: new Map([["peggedARS", 1 / ars]]) });

describe("FX references across publications", () => {
  it("retains the legacy status of a secondary FX rate only until its first clocked provider publication", () => {
    const legacy = buildPrevState({ peggedARS: 1 / 800 });
    const first = publicationAt("2026-11-17T15:30:00Z", legacy);
    first.usableRates = { ...legacy.rates };
    first.inheritPrevious("peggedARS");
    const carried = published(first);
    expect(carried.legacyDetectionPegs).toEqual(["peggedARS"]);
    expect(carried.observations).toBeUndefined();
    const next = publicationAt("2026-11-17T16:00:00Z", carried);
    next.usableRates = { ...carried.rates };
    next.inheritPrevious("peggedARS");
    expect(next.buildPersistedMeta().legacyDetectionPegs).toEqual(["peggedARS"]);
    secondaryArs(next, "2026-11-17", 801);
    expect(published(next)).toMatchObject({ observations: { peggedARS: { source: "fawazahmed0" } } });
    expect(next.buildPersistedMeta().legacyDetectionPegs).toBeUndefined();
  });

  it("retains a migrated OXR peg only through repeats of its first observation", () => {
    const firstAt = unix("2026-11-18T12:59:00Z");
    const peg = "peggedREAL";
    let prior = buildPrevState({ [peg]: 0.193 });
    for (const [delta, expected] of [[0, true], [900, true], [3600, false]] as const) {
      const observedAt = delta === 900 ? firstAt : firstAt + delta;
      const run = publicationAt(new Date((firstAt + 60 + delta) * 1000).toISOString(), prior);
      run.usableRates[peg] = prior.rates[peg];
      run.markLive(peg, observedAt, "intraday", null, "openExchangeRates");
      prior = published(run);
      expect(prior.observations?.[peg]?.observedAtSec).toBe(observedAt);
      expect(prior.legacyDetectionPegs?.includes(peg) ?? false).toBe(expected);
    }
  });

  it("preserves the newer dated ARS fixing through stale and undated mirror reads", () => {
    const tuesday = publicationAt("2026-11-17T15:30:00Z");
    secondaryArs(tuesday, "2026-11-17", 800);
    let previous = published(tuesday);
    for (const [clock, date, ars] of [
      ["2026-11-18T16:00:00Z", "2026-11-13", 810],
      ["2026-11-18T16:30:00Z", "2026-11-13", 810],
      ["2026-11-18T17:00:00Z", undefined, 820],
    ] as const) {
      const wednesday = publicationAt(clock, previous);
      expect(getFxReferenceTypeFromState(previous, "peggedARS", 21600, wednesday.syncStartSec)).toBe("fresh");
      secondaryArs(wednesday, date, ars);
      previous = published(wednesday);
      expect(previous.observations?.peggedARS).toEqual({
        pegKey: "peggedARS", usdPerUnit: 1 / 800, source: "fawazahmed0", cadence: "calendar-daily",
        observedAtSec: unix("2026-11-17T00:00:00Z"),
      });
      expect(previous.sourceDateByPeg.peggedARS).toBe("2026-11-17");
      expect(getFxReferenceTypeFromState(previous, "peggedARS", 21600, wednesday.syncStartSec)).toBe("fresh");
    }
    const rejected = publicationAt("2026-11-18T17:30:00Z", previous);
    rejected.applyFrankfurterRates({ BRL: 5.5 }, "2026-11-18", tryBrlMappings);
    secondaryArs(rejected, undefined, 1600);
    expect(published(rejected).observations?.peggedARS).toBeUndefined();
  });

  it("keeps the newer BRL observation and logs an attempted publication regression", async () => {
    const initial = publicationAt("2026-11-13T15:30:00Z");
    initial.applyFrankfurterRates({ BRL: 1 / 0.17803 }, "2026-11-13", tryBrlMappings);
    initial.applyRealtimeOverlayRates({ observedAt: initial.syncStartSec - 5400, rates: new Map([["peggedREAL", 0.17730]]) });
    initial.applyRealtimeOverlayRates({ observedAt: initial.syncStartSec - 1800, rates: new Map([["peggedREAL", 0.17729]]) });
    const next = publicationAt("2026-11-13T16:00:00Z", published(initial));
    next.applyFrankfurterRates({ BRL: 1 / 0.17803 }, "2026-11-13", tryBrlMappings);
    expect(next.usableRates.peggedREAL).toBe(0.17729);

    // Force the final boundary to catch a writer that bypasses source selection.
    next.usableRates.peggedREAL = 0.17803;
    next.markLive("peggedREAL", initial.syncStartSec - 3600);
    expect(published(next).observations?.peggedREAL).toMatchObject({ usdPerUnit: 0.17729, source: "openExchangeRates" });
    const { db, sqlite } = createLatestSchemaSqlite();
    try {
      await persistFxSyncResult(db, next, next.buildPersistedMeta(), next.syncStartSec, []);
      const selected = (await loadFxRateState(db))!.selectedReferenceEvidence!.peggedREAL;
      expect(evaluateReferenceAdmission({ kind: "fx", observation: selected, ...selected.repricing,
        quoteObservedAtSec: next.syncStartSec, decisionAtSec: next.syncStartSec, rawDeviationBps: asRawDeviationBps(0),
      })).toMatchObject({ status: "admitted", referenceObservedAtSec: initial.syncStartSec - 1800 });
      const alerts = await buildPricingOperatorConditions(db, { caches: {}, nowSec: next.syncStartSec });
      expect(alerts).toContainEqual(expect.objectContaining({ id: `fx-reference-regression:${next.syncStartSec}`, active: true }));

      const late = publicationAt("2026-11-13T15:45:00Z", published(initial));
      late.usableRates.peggedREAL = 0.17803;
      late.markLive("peggedREAL", initial.syncStartSec - 3600);
      late.enforcePublicationOrder();
      const skipped = await persistFxSyncResult(db, late, late.buildPersistedMeta(), late.syncStartSec, []);
      expect(JSON.parse(skipped.metadata!)).toMatchObject({ cacheWriteMode: "skipped-newer" });
      const afterSkip = await buildPricingOperatorConditions(db, { caches: {}, nowSec: next.syncStartSec });
      expect(afterSkip.filter((condition) => condition.id.startsWith("fx-reference-regression"))).toEqual(
        alerts.filter((condition) => condition.id.startsWith("fx-reference-regression")));
    } finally { sqlite.close(); }
  });

  it("keeps a rejected ECB regime anchored across omissions until independently confirmed", () => {
    const tuesday = publicationAt("2026-11-17T16:00:00Z");
    tuesday.applyFrankfurterRates({ TRY: 25, BRL: 5.5 }, "2026-11-17", tryBrlMappings);
    let prior = published(tuesday);
    for (const clock of ["2026-11-18T16:00:00Z", "2026-11-18T16:30:00Z"]) {
      const attempt = publicationAt(clock, prior);
      attempt.applyFrankfurterRates({ TRY: 40, BRL: 5.5 }, "2026-11-18", tryBrlMappings);
      prior = published(attempt);
      expect(prior.rates.peggedTRY).toBeUndefined();
      expect(prior.lastAcceptedBaselines?.peggedTRY).toEqual({ usdPerUnit: 1 / 25, observedAtSec: unix("2026-11-17T13:10:00Z") });
    }
    const confirmed = publicationAt("2026-11-18T17:00:00Z", prior);
    confirmed.applyRealtimeOverlayRates({ observedAt: confirmed.syncStartSec, rates: new Map([["peggedTRY", 1 / 40]]) });
    confirmed.confirmRegimeChanges({ time_last_update_unix: confirmed.syncStartSec - 60, rates: { TRY: 40 } }, [["TRY", "peggedTRY"]]);
    expect(published(confirmed).observations?.peggedTRY?.usdPerUnit).toBe(1 / 40);
  });

  it.each([175, 210])("holds a Chainlink JPY move to %s after omission until the fiat baseline is corroborated", (yenPerUsd) => {
    const mappings = { ...tryBrlMappings, JPY: "peggedJPY" };
    const tuesday = publicationAt("2026-11-17T16:00:00Z");
    tuesday.applyFrankfurterRates({ JPY: 150, BRL: 5.5 }, "2026-11-17", mappings);
    const omitted = publicationAt("2026-11-18T16:00:00Z", published(tuesday));
    omitted.applyFrankfurterRates({ BRL: 5.5 }, "2026-11-18", mappings);
    const wednesday = publicationAt("2026-11-18T16:30:00Z", published(omitted));
    const rounds = new Map([["peggedJPY", {
      pegKey: "peggedJPY", price: 1 / yenPerUsd, updatedAt: wednesday.syncStartSec, chainId: "ethereum", proxyAddress: "0xfeed",
    }]]);
    expect(wednesday.applyChainlinkQuotes(rounds)).toBe(0);
    expect(wednesday.usableRates.peggedJPY).toBeUndefined();
    expect(wednesday.buildPersistedMeta().lastAcceptedBaselines?.peggedJPY?.usdPerUnit).toBe(1 / 150);

    wednesday.applyRealtimeOverlayRates({ observedAt: wednesday.syncStartSec - 60, rates: new Map([["peggedJPY", 1 / yenPerUsd]]) });
    wednesday.confirmRegimeChanges({ time_last_update_unix: wednesday.syncStartSec - 120, rates: { JPY: yenPerUsd } }, [["JPY", "peggedJPY"]]);
    expect(wednesday.applyChainlinkQuotes(rounds)).toBe(1);
    const final = published(wednesday);
    expect(final.observations?.peggedJPY).toMatchObject({ source: "chainlink", usdPerUnit: Number((1 / yenPerUsd).toFixed(6)) });
    expect(final.referenceSourceSamples?.["peggedJPY:openExchangeRates"]?.observation.usdPerUnit).toBe(1 / yenPerUsd);
    expect(final.referenceSourceSamples?.["peggedJPY:exchangeRateApi"]?.observation.usdPerUnit).toBe(1 / yenPerUsd);
  });

  it.each([true, false])("corroborates a sub-20%% OXR move across publications with a dated incumbent=%s", (dated) => {
    const initial = publicationAt("2026-11-17T16:00:00Z");
    initial.applyFrankfurterRates({ BRL: 5.5 }, "2026-11-17", tryBrlMappings);
    initial.usableRates.peggedARS = 1 / 800;
    initial.markLive("peggedARS", dated ? initial.syncStartSec : null);
    const omitted = publicationAt("2026-11-18T16:00:00Z", published(initial));
    omitted.applyFrankfurterRates({ BRL: 5.5 }, "2026-11-18", tryBrlMappings);
    if (dated) expect(omitted.ensureCachedRate("peggedARS", "stale incumbent")).toBe(true);
    expect(oxrArs(omitted, omitted.syncStartSec, 900)).toBe(0);
    expect(omitted.hasRegimeCandidates()).toBe(true);
    const next = publicationAt("2026-11-18T17:00:00Z", published(omitted));
    expect(oxrArs(next, next.syncStartSec, 900)).toBe(0);
    next.confirmRegimeChanges({ time_last_update_unix: next.syncStartSec - 60, rates: { ARS: 900 } }, arsMappings);
    const final = published(next);
    expect(final.rates.peggedARS).toBe(1 / 900);
    expect(final.previousRegimeByPeg?.peggedARS?.previous.observedAtSec).toBe(dated ? initial.syncStartSec : null);
  });

  it.each([false, true])("recovers a daily fixing after OXR expiry with a secondary poll=%s", (poll) => {
    const initial = publicationAt("2026-11-18T00:30:00Z");
    const midnight = unix("2026-11-18T00:00:00Z");
    secondaryArs(initial, "2026-11-18", 780);
    expect(oxrArs(initial, midnight, 770)).toBe(1);
    secondaryArs(initial, "2026-11-18", 780);
    const next = publicationAt("2026-11-18T01:00:00Z", published(initial));
    secondaryArs(next, "2026-11-18", 780);
    const live = published(next);
    expect(live.observations?.peggedARS).toMatchObject({ source: "openExchangeRates", usdPerUnit: 1 / 770 });
    const expired = publicationAt("2026-11-18T06:30:00Z", live);
    if (poll) secondaryArs(expired, "2026-11-18", 780);
    else expired.ensureCachedRate("peggedARS", "secondary poll skipped");
    expect(published(expired).observations?.peggedARS).toMatchObject({
      source: "fawazahmed0", cadence: "calendar-daily", usdPerUnit: 1 / 780, observedAtSec: midnight,
    });
  });

  it("uses a still-current business-daily alternative after the newer calendar-daily one expires", () => {
    const friday = publicationAt("2026-11-13T16:00:00Z");
    friday.applyFrankfurterRates({ BRL: 5.5 }, "2026-11-13", tryBrlMappings);
    const sunday = publicationAt("2026-11-15T12:00:00Z", published(friday));
    sunday.applySecondaryRates({ endpoint: "jsdelivr", payload: { date: "2026-11-15", usd: { brl: 5.4 } } }, [["BRL", "peggedREAL"]]);
    const previous = published(sunday);
    expect(previous.observations?.peggedREAL?.source).toBe("fawazahmed0");
    const monday = publicationAt("2026-11-16T12:00:00Z", previous);
    expect(published(monday).observations?.peggedREAL).toMatchObject({ source: "frankfurter", usdPerUnit: 1 / 5.5 });
  });

  it("keeps the corrected Friday close and withholds Sunday's first unchanged OXR quote", () => {
    const friday = publicationAt("2026-11-13T19:00:00Z");
    friday.applyFrankfurterRates({ EUR: 1 / 1.10 }, "2026-11-13", { EUR: "peggedEUR" });
    const overlay = (state: FxSyncRunState, observedAt: number, price: number) =>
      state.applyRealtimeOverlayRates({ observedAt, rates: new Map([["peggedEUR", price]]) });
    overlay(friday, friday.syncStartSec, 1.10);
    const corrected = publicationAt("2026-11-13T20:00:00Z", published(friday));
    overlay(corrected, friday.syncStartSec, 1.11);
    const closed = published(corrected);
    expect(closed.rates.peggedEUR).toBe(1.11);
    expect(closed.referenceSourceSamples?.["peggedEUR:openExchangeRates"]).toMatchObject({
      observation: { usdPerUnit: closed.rates.peggedEUR, observedAtSec: friday.syncStartSec },
      evidence: { firstInSessionObservedAtSec: friday.syncStartSec },
    });
    const sunday = publicationAt("2026-11-15T22:30:00Z", closed);
    overlay(sunday, sunday.syncStartSec - 60, 1.11);
    const selected = published(sunday).selectedReferenceEvidence!.peggedEUR;
    expect(evaluateReferenceAdmission({
      kind: "fx", observation: selected, ...selected.repricing, decisionAtSec: sunday.syncStartSec,
      quoteObservedAtSec: sunday.syncStartSec, rawDeviationBps: asRawDeviationBps(0),
    }).reason).toBe("reference-not-repriced");
  });

  it.each([
    [false, false, false], [true, false, false], [false, true, false], [true, true, false], [false, true, true],
  ])("orders legacy ECB rereads with verified=%s, overlay=%s, ambiguous clock=%s", (verified, overlay, ambiguous) => {
    const legacy = publicationAt(ambiguous ? "2026-11-13T18:00:00Z" : "2026-11-13T16:00:00Z");
    legacy.usableRates.peggedREAL = 1 / 5.5;
    legacy.markLive("peggedREAL", legacy.syncStartSec, "business-daily", "2026-11-13", verified ? "frankfurter" : undefined);
    const next = publicationAt(ambiguous ? "2026-11-13T18:30:00Z"
      : overlay ? "2026-11-13T16:30:00Z" : "2026-11-15T12:00:00Z", published(legacy));
    next.applyFrankfurterRates({ BRL: 5.5 }, "2026-11-13", tryBrlMappings);
    const oxrClock = unix(ambiguous ? "2026-11-13T17:30:00Z" : "2026-11-13T15:00:00Z");
    if (overlay) next.applyRealtimeOverlayRates({ observedAt: oxrClock, rates: new Map([["peggedREAL", 1 / 5.6]]) });
    const selected = published(next);
    if (ambiguous) {
      expect(selected.rates.peggedREAL).toBe(1 / 5.5);
      expect(selected.sourceUpdatedAtByPeg.peggedREAL).toBe(legacy.syncStartSec);
      expect(selected.observations?.peggedREAL).toBeUndefined();
      return;
    }
    expect(selected.observations?.peggedREAL).toMatchObject({
      source: overlay && !verified ? "openExchangeRates" : "frankfurter",
      observedAtSec: verified ? legacy.syncStartSec : overlay ? oxrClock : unix("2026-11-13T13:10:00Z"),
    });
    expect(selected.lastAcceptedBaselines?.peggedREAL?.observedAtSec).toBe(selected.observations?.peggedREAL?.observedAtSec);
  });

  it("retains losing Friday metal spot evidence and holds the unchanged Sunday quote", () => {
    const spot = (state: FxSyncRunState, rate: number, observedAtSec: number) => state.applyResolvedMetals({
      sources: { "gold-api.com": "partial", "commodity-peer-median": "unavailable" },
      resolvedByPeg: { peggedGOLD: { rate, source: "gold-api.com", updatedAt: observedAtSec } },
    });
    const friday = publicationAt("2026-11-13T21:00:00Z");
    spot(friday, 2900, friday.syncStartSec - 3600);
    friday.applyChainlinkQuotes(new Map([["peggedGOLD", {
      pegKey: "peggedGOLD", price: 2901, updatedAt: friday.syncStartSec - 60, chainId: "arbitrum", proxyAddress: "0xfeed",
    }]]));
    const late = publicationAt("2026-11-13T21:30:00Z", published(friday));
    spot(late, 2910, late.syncStartSec - 3600);
    const closed = published(late);
    expect(closed.observations?.peggedGOLD?.source).toBe("chainlink");
    const sunday = publicationAt("2026-11-15T23:30:00Z", closed);
    spot(sunday, 2910, sunday.syncStartSec - 900);
    const reopened = published(sunday);
    const evidence = reopened.referenceSessionEvidenceByPeg?.peggedGOLD;
    expect(evidence?.preCloseUsdPerUnit).toBe(2910);
    expect(evaluateReferenceAdmission({
      kind: "fallback", observation: reopened.observations!.peggedGOLD, ...evidence,
      quoteObservedAtSec: sunday.syncStartSec, decisionAtSec: sunday.syncStartSec, rawDeviationBps: asRawDeviationBps(0),
    }).reason).toBe("reference-not-repriced");
  });

  it.each([
    [1.11, 1.11, "reference-not-repriced"],
    [1.20, 1.10, "live-reference"],
  ] as const)("keeps a losing OXR sample at %s only when its price is valid", (loser, preCloseUsdPerUnit, sundayReason) => {
    const mappings = { EUR: "peggedEUR" };
    const friday = publicationAt("2026-11-13T21:00:00Z");
    friday.applyFrankfurterRates({ EUR: 1 / 1.10 }, "2026-11-13", mappings);
    friday.applyRealtimeOverlayRates({ observedAt: friday.syncStartSec - 3600, rates: new Map([["peggedEUR", 1.10]]) });
    friday.applyChainlinkQuotes(new Map([["peggedEUR", {
      pegKey: "peggedEUR", price: 1.10, updatedAt: friday.syncStartSec - 300, chainId: "base", proxyAddress: "0xfeed",
    }]]));
    const late = publicationAt("2026-11-13T21:30:00Z", published(friday));
    expect(late.applyRealtimeOverlayRates({ observedAt: late.syncStartSec - 3600, rates: new Map([["peggedEUR", loser]]) })).toBe(0);
    const closed = published(late);
    expect(closed.observations?.peggedEUR?.source).toBe("chainlink");
    const sunday = publicationAt("2026-11-15T22:30:00Z", closed);
    sunday.applyRealtimeOverlayRates({ observedAt: sunday.syncStartSec - 900, rates: new Map([["peggedEUR", 1.11]]) });
    const reopened = published(sunday);
    const evidence = reopened.referenceSessionEvidenceByPeg?.peggedEUR;
    expect(evidence?.preCloseUsdPerUnit).toBe(preCloseUsdPerUnit);
    expect(evaluateReferenceAdmission({
      kind: "fx", observation: reopened.observations!.peggedEUR, ...evidence,
      quoteObservedAtSec: sunday.syncStartSec, decisionAtSec: sunday.syncStartSec, rawDeviationBps: asRawDeviationBps(0),
    }).reason).toBe(sundayReason);
  });

  it.each([
    ["2026-11-09T16:00:00Z", 600, null, "reference-not-repriced"],
    ["2026-11-13T20:00:00Z", 0, 1 / 770, "reference-before-reopen"],
  ] as const)("uses the first sample and budgets the prior close from %s", (priorClock, delay, preCloseUsdPerUnit, firstReason) => {
    const previous = publicationAt(priorClock);
    secondaryArs(previous, priorClock.slice(0, 10), 780);
    expect(oxrArs(previous, previous.syncStartSec, 770)).toBe(1);
    const clock = (hour: string) => `2026-11-15T${hour}:${delay === 0 ? "00" : "10"}:00Z`;
    const reopenedRate = delay === 0 ? 770 : 775;
    const opened = publicationAt(clock("22"), published(previous));
    const openingSec = unix("2026-11-15T22:00:00Z");
    expect(oxrArs(opened, openingSec + delay, reopenedRate)).toBe(1);
    const admit = (state: FxRateState) => evaluateReferenceAdmission({
      kind: "fx", observation: state.observations!.peggedARS,
      ...state.referenceSessionEvidenceByPeg?.peggedARS,
      quoteObservedAtSec: state.usableSyncAt, decisionAtSec: state.usableSyncAt, rawDeviationBps: asRawDeviationBps(0),
    });
    const first = published(opened);
    expect(admit(first).reason).toBe(firstReason);
    const again = publicationAt(clock("23"), first);
    expect(oxrArs(again, again.syncStartSec, reopenedRate)).toBe(1);
    const last = published(again);
    expect(last.referenceSessionEvidenceByPeg?.peggedARS).toEqual({
      sessionOpenedAtSec: openingSec, firstInSessionObservedAtSec: openingSec + delay, preCloseUsdPerUnit,
    });
    expect(admit(last).status).toBe("admitted");
  });
});
