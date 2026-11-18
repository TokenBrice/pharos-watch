import { beforeEach, describe, expect, it, vi } from "vitest";
import { TELEGRAM_ALERT_POLICY } from "@shared/lib/telegram-delivery-policy";
import { buildTelegramDispatchEvents } from "../dispatch-telegram-events";
import { buildDepegSnapshot, type DepegSnapshot } from "../telegram-alert-snapshots";
import { buildDispatchSnapshotState } from "../../dispatch/dispatch-telegram-state";
import { formatConsolidatedMessage, formatDepegTriggeredLine, formatDepegWorseningLine } from "../../../../telegram/common/alerts-formatting";
import { makeNoopD1 } from "../../../../test-helpers/noop-d1";
import {
  activeDepeg,
  createClosedDepegFixture,
  eventSources,
  eventSnapshots,
  priorDepeg,
} from "./dispatch-telegram-events.test-support";

const mocks = vi.hoisted(() => ({
  buildAlertContextLines: vi.fn(),
  getCache: vi.fn(),
}));

vi.mock("../telegram-alert-context", () => ({
  buildAlertContextLines: mocks.buildAlertContextLines,
}));

vi.mock("../../../../lib/db-cache", () => ({
  getCache: mocks.getCache,
  prepareCacheUpsert: vi.fn(() => ({ kind: "cache-upsert" })),
}));

/** Prepares statements but never executes: event construction must not commit. */
function preparingD1() {
  return makeNoopD1({ prepare: vi.fn(() => ({ bind: vi.fn(() => ({ kind: "prepared" })) })) });
}

describe("buildTelegramDispatchEvents", () => {
  beforeEach(() => {
    mocks.buildAlertContextLines.mockResolvedValue(new Map([
      ["coin-dews", "Context: Safety C+ 61"],
      ["coin-depeg", "Context: Safety F 39"],
      ["coin-safe", "Context: Safety C+ 61"],
    ]));
    mocks.getCache.mockResolvedValue(null);
  });

  it("uses Reason lines for safety alerts while keeping Context lines on other alert families", async () => {
    const { events } = await buildTelegramDispatchEvents(
      preparingD1(),
      eventSources({ dewsRows: [{
        stablecoin_id: "coin-dews",
        score: 42,
        band: "WARNING",
        signals_json: null,
        computed_at: 1_799_999_000,
      }], activeDepegRows: [{
        stablecoin_id: "coin-depeg",
        symbol: "DPG",
        direction: "below",
        peak_deviation_bps: 260,
        start_price: 0.974,
        peak_price: 0.974,
        peg_reference: 1,
        event_id: 1,
      }] }),
      eventSnapshots({
        currentSafetySnapshot: {
          "coin-safe": {
            grade: "C+",
            score: 61,
            ratingStatus: "rated",
            partialEvidence: null,
            methodologyVersion: "9.0",
            v9Explain: {
              reasons: [],
              bindingCap: null,
              weakestPillar: { pillar: "exit", score: 61 },
              pillars: {
                backing: { score: 72, evidenceLevel: "adequate", freshness: "current" },
                exit: { score: 61, evidenceLevel: "adequate", freshness: "current" },
                control: { score: 72, evidenceLevel: "adequate", freshness: "current" },
              },
            },
          },
        },
        safeSafetySnapshot: {
          "coin-safe": {
            grade: "B",
            score: 72,
            ratingStatus: "rated",
            partialEvidence: null,
            methodologyVersion: "9.0",
            // The severe drop has already held for the full dwell.
            pendingKind: "severe-downgrade",
            pendingSinceSec: 1_800_000_000 - TELEGRAM_ALERT_POLICY.safety.dwellSec,
            v9Explain: {
              reasons: [],
              bindingCap: null,
              weakestPillar: { pillar: "exit", score: 72 },
              pillars: {
                backing: { score: 72, evidenceLevel: "adequate", freshness: "current" },
                exit: { score: 72, evidenceLevel: "adequate", freshness: "current" },
                control: { score: 72, evidenceLevel: "adequate", freshness: "current" },
              },
            },
          },
        },
        safeDewsAlertable: { "coin-dews": "WATCH" },
        safeDewsSnapshot: { "coin-dews": "WATCH" },
        safeDewsCandidates: { "coin-dews": { computedAt: 1_799_997_200, computations: 1 } },
        safeDepegSnapshot: {},
      }),
      (id) => ({ "coin-safe": "SAFE", "coin-dews": "DEWS", "coin-depeg": "DPG" })[id] ?? id,
    );

    expect(events.dewsChanges[0].contextLine).toBe("Context: Safety C+ 61");
    expect(events.depegTriggered[0].contextLine).toBe("Context: Safety F 39");
    expect(events.safetyChanges[0].contextLine).toContain("Reason: Exit score fell from 72 to 61.");
    expect(events.safetyChanges[0].contextLine).not.toContain("Context:");
  });

  it.each([280, 310, 501])(
    "emits a new trigger, not worsening, when a recovered depeg reopens at %i bps",
    async (peak) => {
      const { sqlite, db } = createClosedDepegFixture("recovered-primary");
      try {
        const { events } = await buildTelegramDispatchEvents(
          db,
          eventSources({ activeDepegRows: [activeDepeg(peak)] }),
          eventSnapshots({ safeDepegSnapshot: priorDepeg() }),
          () => "DPG",
        );
        expect(events.depegResolved).toEqual([]);
        expect(events.depegWorsening).toEqual([]);
        expect(events.depegTriggered).toEqual([
          expect.objectContaining({ stablecoinId: "coin-depeg", deviationBps: peak, reopenedAfterMinutes: 5 }),
        ]);
      } finally {
        sqlite.close();
      }
    },
  );

  it.each([
    { closeReason: "recovered-primary", recoveryPrice: 1, direction: "above", recovered: true },
    { closeReason: "recovered-native", recoveryPrice: null, direction: "below", recovered: true },
    { closeReason: null, recoveryPrice: 1, direction: "below", recovered: true },
    { closeReason: "coverage-lost-supply", recoveryPrice: null, direction: "below", recovered: false },
    { closeReason: "orphan-tracking-removed", recoveryPrice: null, direction: "below", recovered: false },
    { closeReason: "superseded-direction", recoveryPrice: null, direction: "above", recovered: false },
  ] as const)("frames a $direction replacement after $closeReason without a contradictory resolution", async ({
    closeReason, recoveryPrice, direction, recovered,
  }) => {
    const { sqlite, db } = createClosedDepegFixture(closeReason, recoveryPrice);
    try {
      const { events } = await buildTelegramDispatchEvents(
        db,
        eventSources({ activeDepegRows: [activeDepeg(280, direction)] }),
        eventSnapshots({ safeDepegSnapshot: priorDepeg() }),
        () => "DPG",
      );
      expect(events.depegResolved).toEqual([]);
      expect(events.depegWorsening).toEqual([]);
      expect(events.depegTriggered).toHaveLength(1);
      expect(events.depegTriggered[0]).toMatchObject({ stablecoinId: "coin-depeg", direction });
      expect(events.depegTriggered[0].reopenedAfterMinutes).toBe(recovered ? 5 : undefined);
    } finally {
      sqlite.close();
    }
  });

  it("uses only the exact snapshot event for recovery claims when newer closed rows exist", async () => {
    const { sqlite, db, insertClosed } = createClosedDepegFixture("coverage-lost-supply", null);
    try {
      insertClosed.run(3, 1_200, 1_800, 1, "recovered-primary");
      const { events } = await buildTelegramDispatchEvents(
        db,
        eventSources({ activeDepegRows: [activeDepeg()] }),
        eventSnapshots({ safeDepegSnapshot: priorDepeg() }),
        () => "DPG",
      );
      expect(events.depegTriggered).toHaveLength(1);
      expect(events.depegTriggered[0].reopenedAfterMinutes).toBeUndefined();
      expect(events.depegResolved).toEqual([]);
    } finally {
      sqlite.close();
    }
  });

  it("resolves the exact disappeared snapshot event rather than a newer closure", async () => {
    const { sqlite, db, insertClosed } = createClosedDepegFixture("recovered-primary");
    try {
      insertClosed.run(3, 1_200, 1_800, null, "coverage-lost-supply");
      const { events } = await buildTelegramDispatchEvents(
        db,
        eventSources(),
        eventSnapshots({ safeDepegSnapshot: priorDepeg() }),
        () => "DPG",
      );
      expect(events.depegResolved).toEqual([
        expect.objectContaining({ stablecoinId: "coin-depeg", durationMinutes: 10, recoveryPrice: 1 }),
      ]);
    } finally {
      sqlite.close();
    }
  });

  it("preserves stablecoin-only diffing for legacy snapshots without event IDs", async () => {
    const { events } = await buildTelegramDispatchEvents(
      preparingD1(),
      eventSources({ activeDepegRows: [activeDepeg(501)] }),
      eventSnapshots({ safeDepegSnapshot: priorDepeg(null) }),
      () => "DPG",
    );
    expect(events.depegTriggered).toEqual([]);
    expect(events.depegResolved).toEqual([]);
    expect(events.depegWorsening).toEqual([
      expect.objectContaining({ previousDeviationBps: 310, currentDeviationBps: 501 }),
    ]);
  });

  it("preserves the latest-closed-event resolution fallback for legacy snapshots", async () => {
    const { sqlite, db, insertClosed } = createClosedDepegFixture("coverage-lost-supply", null);
    try {
      insertClosed.run(3, 1_200, 1_800, 1, "recovered-primary");
      const { events } = await buildTelegramDispatchEvents(
        db,
        eventSources(),
        eventSnapshots({ safeDepegSnapshot: priorDepeg(null) }),
        () => "DPG",
      );
      expect(events.depegResolved).toEqual([
        expect.objectContaining({ stablecoinId: "coin-depeg", durationMinutes: 10, recoveryPrice: 1 }),
      ]);
    } finally {
      sqlite.close();
    }
  });

  it.each([
    ["peggedUSD", "recovered-dex", null, 1],
    ["peggedUSD", "recovered-dex", 1, null],
    ["peggedUSD", "recovered-primary", 1, 1],
    ["peggedEUR", "recovered-primary", null, 1],
  ] as const)("keeps a classified %s %s close on legacy coverage", async (pegType, reason, reference, price) => {
    const { sqlite, db } = createClosedDepegFixture(reason);
    try {
      sqlite.prepare(`UPDATE depeg_events SET ended_at = 3100, last_trusted_price_at = 1600,
        peg_type = ?, recovery_peg_reference = ?, recovery_price = ?, price_coverage_json = ? WHERE id = 1`).run(
        pegType, reference, price,
        JSON.stringify({ intervals: [[1000, 1600]], atParIntervals: reason === "recovered-dex" ? [] : [[1600, 1600]] }),
      );
      const result = await buildTelegramDispatchEvents(db, eventSources(),
        eventSnapshots({ safeDepegSnapshot: priorDepeg() }), () => "DPG");
      expect(result.events.depegResolved[0]?.durationMinutes).toBe(35);
      expect(result.nextDepegSnapshot).toEqual({});
    } finally {
      sqlite.close();
    }
  });

  it("uses the observed recovery to time a resolution and a later reopening", async () => {
    const { sqlite, db } = createClosedDepegFixture("recovered-primary");
    try {
      const setCoverage = sqlite.prepare(`UPDATE depeg_events SET last_trusted_price_at = 1300,
        recovery_peg_reference = 1, admitted_coverage_json = '[]', price_coverage_json = ? WHERE id = 1`);
      const dispatch = (reopened: boolean) => buildTelegramDispatchEvents(db,
        eventSources({ activeDepegRows: reopened ? [activeDepeg()] : [] }),
        eventSnapshots({ safeDepegSnapshot: priorDepeg() }), () => "DPG");
      setCoverage.run(JSON.stringify({ intervals: [[1000, 1300]] }));
      const held = await dispatch(false);
      expect(held.events.depegResolved).toEqual([]);
      expect(held.nextDepegSnapshot["coin-depeg"]).toMatchObject({ eventId: 1, recoveryPending: true });
      setCoverage.run(JSON.stringify({ intervals: [[1000, 1300]], atParIntervals: [[1300, 1300]] }));
      const retry = await buildTelegramDispatchEvents(db, eventSources(),
        eventSnapshots({ safeDepegSnapshot: held.nextDepegSnapshot }), () => "DPG");
      expect(retry.events.depegResolved[0]?.durationMinutes).toBe(5);
      expect(retry.nextDepegSnapshot).toEqual({});
      expect((await dispatch(true)).events.depegTriggered[0]?.reopenedAfterMinutes).toBe(10);
    } finally {
      sqlite.close();
    }
  });

  it("advances to the replacement event while the previous recovery lacks evidence", async () => {
    const { sqlite, db } = createClosedDepegFixture("recovered-dex");
    try {
      sqlite.exec(`UPDATE depeg_events SET peg_type = 'peggedEUR', recovery_peg_reference = 1.1,
        recovery_price = 1.1, last_trusted_price_at = 1300,
        price_coverage_json = '{"intervals":[[1000,1300]],"atParIntervals":[]}' WHERE id = 1`);
      let previous = priorDepeg();
      for (const peak of [280, 600, 1000]) {
        const rows = [activeDepeg(peak)];
        const state = eventSnapshots({ safeDepegSnapshot: previous });
        state.currentSnapshots.depeg = buildDepegSnapshot(rows);
        const { events, nextDepegSnapshot } = await buildTelegramDispatchEvents(
          db, eventSources({ activeDepegRows: rows }), state, () => "DPG",
        );
        expect(events.depegResolved).toEqual([]);
        expect(events.depegTriggered).toHaveLength(peak === 280 ? 1 : 0);
        expect(events.depegTriggered[0]?.reopenedAfterMinutes).toBeUndefined();
        expect(events.depegWorsening).toHaveLength(peak === 280 ? 0 : 1);
        expect(nextDepegSnapshot).toEqual(state.currentSnapshots.depeg);
        previous = nextDepegSnapshot;
      }
    } finally {
      sqlite.close();
    }
  });

  it.each(["trigger", "worsening"] as const)("pairs a %s alert with the stored peak reference only", async (kind) => {
    const row = {
      ...activeDepeg(341), stablecoin_id: "idrt-rupiah-token", symbol: "IDRT", peg_type: "peggedIDR",
      start_price: 0.000061, peg_reference: 0.000062, peak_price: 0.00005718,
      peak_peg_reference: 0.0000592, peak_quote_domain: "usd" as const,
    };
    const prior: DepegSnapshot = kind === "worsening" ? { "idrt-rupiah-token": {
      stablecoinId: row.stablecoin_id, symbol: row.symbol, direction: row.direction,
      deviationBps: 120, price: row.start_price, pegReference: row.peg_reference, eventId: row.event_id,
    } } : {};
    for (const reference of [row.peak_peg_reference, null]) {
      const { events } = await buildTelegramDispatchEvents(
        preparingD1(),
        eventSources({ activeDepegRows: [{ ...row, peak_peg_reference: reference }] }),
        eventSnapshots({ safeDepegSnapshot: prior }),
        () => row.symbol,
      );
      const payload = kind === "worsening" ? events.depegWorsening : events.depegTriggered;
      expect(payload).toEqual([expect.objectContaining({
        price: 0.00005718, pegReference: reference, priceCurrency: "USD",
      })]);
    }
  });

  it.each(["reason flag", "peak receipt"] as const)("labels the peer benchmark in dispatched full and compact alerts (%s)", async (marker) => {
    const row = {
      ...activeDepeg(340), peak_price: 0.966, peak_peg_reference: 1,
      ...(marker === "reason flag" ? { pending_reason: "confirmation-window+low-confidence+peer-relative" }
        : { peer_basis_json: JSON.stringify({ peak: { basis: "peer-relative" } }) }),
    };
    const sources = eventSources({ activeDepegRows: [row] });
    const { events } = await buildTelegramDispatchEvents(preparingD1(), sources, eventSnapshots(), () => "DPG");
    const { events: worsening } = await buildTelegramDispatchEvents(preparingD1(), sources, eventSnapshots({
      safeDepegSnapshot: { [row.stablecoin_id]: {
        stablecoinId: row.stablecoin_id, symbol: row.symbol, direction: row.direction,
        deviationBps: 120, price: 0.988, pegReference: 1, eventId: row.event_id, peakBasis: "peer-relative",
      } },
    }), () => "DPG");
    const [trigger] = events.depegTriggered;
    const [advance] = worsening.depegWorsening;
    expect(trigger.peakBasis).toBe("peer-relative");
    expect(formatDepegTriggeredLine(trigger)).toContain("3.4% below the peer median ($1.00) (lower confidence)");
    expect(formatDepegWorseningLine(advance)).toContain("3.4% below the peer median ($1.00) (lower confidence)");
    const compact = formatConsolidatedMessage({
      dews: [], safety: [], reserve: [], depegResolved: [],
      depegTriggered: [trigger, { ...trigger, stablecoinId: "another-coin" }], depegWorsening: [advance],
    });
    expect(compact).toContain("3.4% below the peer median (lower confidence)");
    expect(compact).not.toMatch(/lost its peg|depeg deepened/);
  });

  it.each([
    ["peer-relative", "benchmark"],
    ["benchmark", "peer-relative"],
    ["native-peg", "benchmark"],
    ["benchmark", "native-peg"],
  ] as const)("reseeds without worsening on a %s to %s peak change", async (before, after) => {
    const now = 1_800_000_000;
    const rowWithBasis = (peak: number, basis: string) => ({
      ...activeDepeg(peak),
      peer_basis_json: JSON.stringify({ peak: { basis } }),
    });
    const dispatch = async (peak: number, basis: string, previous: DepegSnapshot) => {
      const sources = eventSources({
        activeDepegRows: [rowWithBasis(peak, basis)],
        dewsCache: { value: "{}", updatedAt: now },
        depegCache: { value: JSON.stringify(previous), updatedAt: now },
      });
      const state = buildDispatchSnapshotState(sources, now);
      const { events } = await buildTelegramDispatchEvents(preparingD1(), sources, state, () => "DPG");
      return { events, baseline: state.currentSnapshots.depeg };
    };

    const changed = await dispatch(340, after, buildDepegSnapshot([rowWithBasis(120, before)]));
    expect(changed.events.depegWorsening).toEqual([]);
    expect(changed.events.depegTriggered).toEqual([]);
    expect(changed.baseline["coin-depeg"]).toMatchObject({ deviationBps: 340, eventId: 2 });
    expect(changed.baseline["coin-depeg"].peakBasis).toBe(after === "benchmark" ? undefined : after);

    const next = await dispatch(900, after, changed.baseline);
    expect(next.events.depegWorsening).toEqual([
      expect.objectContaining({ previousDeviationBps: 340, currentDeviationBps: 900 }),
    ]);
  });

  it("keeps widening a legacy native peak when its next row adds the native marker", async () => {
    const now = 1_800_000_000;
    const prior = {
      ...activeDepeg(160), stablecoin_id: "tryb-bilira", symbol: "TRYB",
      peg_type: "peggedTRY", source: "live", peg_reference: 1, peak_price: 1.016,
    };
    const baseline = buildDepegSnapshot([prior]);
    expect(baseline["tryb-bilira"]).toMatchObject({ peakBasis: "native-peg", priceCurrency: "TRY" });
    const sources = eventSources({
      activeDepegRows: [{ ...prior, peak_deviation_bps: 340, peak_price: 1.034, peak_quote_domain: "native-peg" }],
      dewsCache: { value: "{}", updatedAt: now },
      depegCache: { value: JSON.stringify(baseline), updatedAt: now },
    });
    const { events } = await buildTelegramDispatchEvents(
      preparingD1(), sources, buildDispatchSnapshotState(sources, now), () => "TRYB",
    );
    expect(events.depegWorsening).toEqual([
      expect.objectContaining({ previousDeviationBps: 160, currentDeviationBps: 340 }),
    ]);
  });

  it("emits depeg worsening only when a supported subscriber step is crossed", async () => {
    const { events } = await buildTelegramDispatchEvents(
      preparingD1(),
      eventSources({ dewsRows: [], activeDepegRows: [
        {
          stablecoin_id: "coin-no-step",
          symbol: "NO",
          direction: "below",
          peak_deviation_bps: 150,
          start_price: 0.985,
          peak_price: 0.985,
          peg_reference: 1,
          event_id: 1,
        },
        {
          stablecoin_id: "coin-step",
          symbol: "YES",
          direction: "below",
          peak_deviation_bps: 251,
          start_price: 0.9749,
          peak_price: 0.9749,
          peg_reference: 1,
          event_id: 2,
        },
      ] }),
      eventSnapshots({
        safeDepegSnapshot: {
          "coin-no-step": {
            stablecoinId: "coin-no-step",
            symbol: "NO",
            direction: "below",
            deviationBps: 101,
            price: 0.9899,
            pegReference: 1,
            eventId: 1,
          },
          "coin-step": {
            stablecoinId: "coin-step",
            symbol: "YES",
            direction: "below",
            deviationBps: 249,
            price: 0.9751,
            pegReference: 1,
            eventId: 2,
          },
        },
      }),
      (id) => id,
    );

    expect(events.depegWorsening).toEqual([
      expect.objectContaining({
        stablecoinId: "coin-step",
        previousDeviationBps: 249,
        currentDeviationBps: 251,
      }),
    ]);
  });

  it("uses peak_price for triggered and worsening depeg alert display prices", async () => {
    const { events } = await buildTelegramDispatchEvents(
      preparingD1(),
      eventSources({ dewsRows: [], activeDepegRows: [
        {
          stablecoin_id: "coin-new",
          symbol: "NEW",
          direction: "below",
          peak_deviation_bps: -6000,
          start_price: 0.9884,
          peak_price: 0.4,
          peg_reference: 1,
          event_id: 1,
        },
        {
          stablecoin_id: "coin-worse",
          symbol: "WORSE",
          direction: "below",
          peak_deviation_bps: -5940,
          start_price: 0.9884,
          peak_price: 0.406,
          peg_reference: 1,
          event_id: 2,
        },
      ] }),
      eventSnapshots({
        safeDepegSnapshot: {
          "coin-worse": {
            stablecoinId: "coin-worse",
            symbol: "WORSE",
            direction: "below",
            deviationBps: 3800,
            price: 0.62,
            pegReference: 1,
            eventId: 2,
          },
        },
      }),
      (id) => id,
    );

    expect(events.depegTriggered).toEqual([
      expect.objectContaining({ stablecoinId: "coin-new", deviationBps: 6000, price: 0.4 }),
    ]);
    expect(events.depegWorsening).toEqual([
      expect.objectContaining({
        stablecoinId: "coin-worse",
        currentDeviationBps: 5940,
        price: 0.406,
      }),
    ]);
  });

  it("does not emit resolved lines for coverage-loss closures", async () => {
    const db = makeNoopD1({
      prepare: vi.fn(() => ({
        bind: vi.fn(() => ({
          all: vi.fn(async () => ({
            results: [{
              stablecoin_id: "coin-depeg",
              symbol: "DPG",
              peak_deviation_bps: 310,
              started_at: 1_000,
              ended_at: 1_600,
              recovery_price: null,
              close_reason: "coverage-lost-supply",
            }],
          })),
        })),
      })),
    });

    const { events } = await buildTelegramDispatchEvents(
      db,
      eventSources({ dewsRows: [], activeDepegRows: [] }),
      eventSnapshots({
        safeDepegSnapshot: {
          "coin-depeg": {
            stablecoinId: "coin-depeg",
            symbol: "DPG",
            direction: "below",
            deviationBps: 310,
            price: 0.969,
            pegReference: 1,
          },
        },
      }),
      () => "DPG",
    );

    expect(events.depegResolved).toEqual([]);
    expect(events.depegTriggered).toEqual([]);
  });

  it("allows native-quote recoveries without fabricating a recovery price", async () => {
    const db = makeNoopD1({
      prepare: vi.fn(() => ({
        bind: vi.fn(() => ({
          all: vi.fn(async () => ({
            results: [{
              stablecoin_id: "coin-depeg",
              symbol: "DPG",
              peak_deviation_bps: 310,
              started_at: 1_000,
              ended_at: 1_600,
              recovery_price: null,
              close_reason: "recovered-native",
            }],
          })),
        })),
      })),
    });

    const { events } = await buildTelegramDispatchEvents(
      db,
      eventSources({ dewsRows: [], activeDepegRows: [] }),
      eventSnapshots({
        safeDepegSnapshot: {
          "coin-depeg": {
            stablecoinId: "coin-depeg",
            symbol: "DPG",
            direction: "below",
            deviationBps: 310,
            price: 0.969,
            pegReference: 1,
          },
        },
      }),
      () => "DPG",
    );

    expect(events.depegResolved).toHaveLength(1);
    expect(events.depegResolved[0].recoveryPrice).toBeNull();
  });

  it("returns roll-up change-log statements for the dispatcher to commit, executing none", async () => {
    const db = preparingD1();
    const { events, changeLogStatements } = await buildTelegramDispatchEvents(
      db,
      eventSources({ dewsRows: [{
        stablecoin_id: "coin-dews", score: 20, band: "WATCH", signals_json: null, computed_at: 1_799_999_000,
      }] }),
      eventSnapshots({
        safeDewsAlertable: { "coin-dews": "ALERT" },
        safeDewsSnapshot: { "coin-dews": "ALERT" },
      }),
      (id) => id,
    );

    // An unsent de-escalation is roll-up material only, and nothing was committed.
    expect(events.dewsChanges).toEqual([]);
    expect(changeLogStatements.length).toBeGreaterThan(0);
    expect(db.prepare).toHaveBeenCalledWith(expect.stringContaining("INSERT OR IGNORE INTO telegram_change_log"));
  });
});
