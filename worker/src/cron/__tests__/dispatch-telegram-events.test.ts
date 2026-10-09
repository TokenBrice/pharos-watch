import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildTelegramDispatchEvents } from "../dispatch-telegram-events";
import { makeNoopD1 } from "../../test-helpers/noop-d1";
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

vi.mock("../../lib/db-cache", () => ({
  getCache: mocks.getCache,
}));

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
    const events = await buildTelegramDispatchEvents(
      {} as D1Database,
      eventSources({ dewsRows: [{
        stablecoin_id: "coin-dews",
        score: 42,
        band: "WARNING",
        signals_json: null,
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
        safeDepegSnapshot: {},
      }),
      (id) => ({ "coin-safe": "SAFE", "coin-dews": "DEWS", "coin-depeg": "DPG" })[id] ?? id,
    );

    expect(events.dewsChanges[0].contextLine).toBe("Context: Safety C+ 61");
    expect(events.depegTriggered[0].contextLine).toBe("Context: Safety F 39");
    expect(events.safetyChanges[0].contextLine).toContain("Reason: Exit pillar fell from 72 to 61.");
    expect(events.safetyChanges[0].contextLine).not.toContain("Context:");
  });

  it.each([280, 310, 501])(
    "emits a new trigger, not worsening, when a recovered depeg reopens at %i bps",
    async (peak) => {
      const { sqlite, db } = createClosedDepegFixture("recovered-primary");
      try {
        const events = await buildTelegramDispatchEvents(
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
      const events = await buildTelegramDispatchEvents(
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
      const events = await buildTelegramDispatchEvents(
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
      const events = await buildTelegramDispatchEvents(
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
    const events = await buildTelegramDispatchEvents(
      {} as D1Database,
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
      const events = await buildTelegramDispatchEvents(
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

  it("emits depeg worsening only when a supported subscriber step is crossed", async () => {
    const events = await buildTelegramDispatchEvents(
      {} as D1Database,
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
    const events = await buildTelegramDispatchEvents(
      {} as D1Database,
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

    const events = await buildTelegramDispatchEvents(
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

    const events = await buildTelegramDispatchEvents(
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
});
