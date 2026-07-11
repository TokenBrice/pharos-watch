import { describe, expect, it } from "vitest";
import { mockD1 } from "../../test-helpers/__shared/mock-d1";
import {
  buildDispatchSnapshotState,
  loadDewsRows,
  type DispatchSourceData,
} from "../dispatch-telegram-state";
import {
  ALERT_RESERVE_SOURCE_GENERATION,
  buildAlertReserveSourceEnvelope,
} from "../../lib/alert-reserve-source-cache";
import { CRON_INTERVALS } from "@shared/lib/cron-jobs";

const nowSec = Math.floor(Date.now() / 1000);
const completedDewsAt = nowSec - 60;

const signalsJson = JSON.stringify({
  supply: { value: 10, available: true },
});

function cache(value: unknown, updatedAt = nowSec - 60) {
  return { value: JSON.stringify(value), updatedAt };
}

function reserveSource(
  driftIds: string[],
  overrides: Partial<{
    generation: string;
    publishedAt: number;
    continuous: boolean;
  }> = {},
) {
  return cache({
    generation: ALERT_RESERVE_SOURCE_GENERATION,
    publishedAt: nowSec - 60,
    continuous: true,
    driftIds,
    ...overrides,
  });
}

function sourceData(overrides: Partial<DispatchSourceData> = {}): DispatchSourceData {
  return {
    chatsWithActiveSnooze: 0,
    dewsRows: [],
    activeDepegRows: [],
    safetyRows: [],
    dewsCache: cache({}),
    dewsAlertableCache: cache({}),
    depegCache: cache({}),
    safetyCache: null,
    safetySourceCache: null,
    launchCache: cache([]),
    reserveCache: reserveSource([]),
    reserveDispatchedCache: cache([]),
    ...overrides,
  };
}

function freshnessRow(updatedAt: number) {
  return {
    key: "dews:published-generation",
    value: JSON.stringify({ updatedAt, source: "compute-dews", publishStatus: "published" }),
    updated_at: updatedAt,
  };
}

describe("loadDewsRows", () => {
  it("uses the published DEWS generation pointer as the reader cutoff", async () => {
    const db = mockD1([
      {
        match: "FROM cache WHERE key = ?",
        matchBinds: ["dews:published-generation"],
        rows: [freshnessRow(completedDewsAt)],
        first: freshnessRow(completedDewsAt),
      },
      {
        match: "pharos:telegram-dispatch:dews-latest",
        matchBinds: [completedDewsAt],
        rows: [],
      },
      {
        match: "pharos:telegram-dispatch:dews-legacy",
        matchBinds: [completedDewsAt],
        rows: [
          {
            stablecoin_id: "usdt-tether",
            score: 12,
            band: "CALM",
            signals_json: signalsJson,
            computed_at: completedDewsAt,
          },
        ],
      },
    ]);

    const rows = await loadDewsRows(db, nowSec);

    expect(rows).toEqual([
      {
        stablecoin_id: "usdt-tether",
        score: 12,
        band: "CALM",
        signals_json: signalsJson,
        computed_at: completedDewsAt,
      },
    ]);
    const history = db.getHistory();
    expect(history.some((entry) =>
      entry.sql.includes("pharos:telegram-dispatch:dews-latest") &&
      entry.sql.includes("computed_at <= ?") &&
      entry.binds[0] === completedDewsAt
    )).toBe(true);
    expect(history.some((entry) =>
      entry.sql.includes("pharos:telegram-dispatch:dews-legacy") &&
      entry.sql.includes("computed_at <= ?") &&
      entry.binds[0] === completedDewsAt
    )).toBe(true);
  });

  it("preserves legacy-only rows when latest rows are fresh but partial", async () => {
    const latestRow = {
      stablecoin_id: "usdc-circle",
      score: 8,
      band: "CALM",
      signals_json: signalsJson,
      computed_at: completedDewsAt,
    };
    const legacyOnlyRow = {
      stablecoin_id: "usdt-tether",
      score: 13,
      band: "WATCH",
      signals_json: signalsJson,
      computed_at: completedDewsAt - 30,
    };
    const db = mockD1([
      {
        match: "FROM cache WHERE key = ?",
        matchBinds: ["dews:published-generation"],
        rows: [freshnessRow(completedDewsAt)],
        first: freshnessRow(completedDewsAt),
      },
      {
        match: "pharos:telegram-dispatch:dews-latest",
        matchBinds: [completedDewsAt],
        rows: [latestRow],
      },
      {
        match: "pharos:telegram-dispatch:dews-legacy",
        matchBinds: [completedDewsAt],
        rows: [legacyOnlyRow],
      },
    ]);

    const rows = await loadDewsRows(db, nowSec);

    expect(rows).toEqual([legacyOnlyRow, latestRow]);
    const history = db.getHistory();
    expect(history.some((entry) =>
      entry.sql.includes("pharos:telegram-dispatch:dews-legacy")
    )).toBe(true);
  });
});

describe("buildDispatchSnapshotState reserve baseline handling", () => {
  it("preserves the reserve dispatch baseline when the producer snapshot is invalid", () => {
    const invalidRun = buildDispatchSnapshotState(
      sourceData({
        reserveCache: { value: "{", updatedAt: nowSec - 60 },
        reserveDispatchedCache: cache(["usdc-circle"]),
      }),
      nowSec,
    );

    expect(invalidRun.reserveSourceUnavailable).toBe(true);
    expect(invalidRun.previousReserveDriftIds).toEqual(["usdc-circle"]);
    expect(invalidRun.currentReserveDriftIds).toEqual(["usdc-circle"]);
    expect(invalidRun.currentSnapshots.reserveDispatched).toEqual(["usdc-circle"]);

    const nextGoodRun = buildDispatchSnapshotState(
      sourceData({
        reserveCache: reserveSource(["usdc-circle"]),
        reserveDispatchedCache: cache(invalidRun.currentSnapshots.reserveDispatched),
      }),
      nowSec,
    );

    expect(nextGoodRun.reserveSourceUnavailable).toBe(false);
    expect(nextGoodRun.previousReserveDriftIds).toEqual(["usdc-circle"]);
    expect(nextGoodRun.currentReserveDriftIds).toEqual(["usdc-circle"]);
  });

  it("keeps an invalid first reserve producer read from becoming an empty baseline", () => {
    const invalidFirstRun = buildDispatchSnapshotState(
      sourceData({
        reserveCache: null,
        reserveDispatchedCache: null,
      }),
      nowSec,
    );

    expect(invalidFirstRun.reserveSourceUnavailable).toBe(true);
    expect(invalidFirstRun.currentSnapshots.reserveDispatched).toBeNull();

    const nextGoodRun = buildDispatchSnapshotState(
      sourceData({
        reserveCache: reserveSource(["usdc-circle"]),
        reserveDispatchedCache: cache(invalidFirstRun.currentSnapshots.reserveDispatched),
      }),
      nowSec,
    );

    expect(nextGoodRun.previousReserveDriftIds).toEqual(["usdc-circle"]);
    expect(nextGoodRun.currentReserveDriftIds).toEqual(["usdc-circle"]);
  });

  it("suppresses a stale source without advancing the prior reserve baseline", () => {
    const state = buildDispatchSnapshotState(
      sourceData({
        reserveCache: reserveSource(["usdc-circle"], {
          publishedAt: nowSec - CRON_INTERVALS["sync-live-reserves"] * 2 - 1,
        }),
        reserveDispatchedCache: cache([]),
      }),
      nowSec,
    );

    expect(state.reserveSourceAssessment).toMatchObject({
      state: "stale",
      generation: ALERT_RESERVE_SOURCE_GENERATION,
    });
    expect(state.previousReserveDriftIds).toEqual([]);
    expect(state.currentReserveDriftIds).toEqual([]);
    expect(state.currentSnapshots.reserveDispatched).toEqual([]);
  });

  it("suppresses a wrong-generation source without advancing the prior reserve baseline", () => {
    const state = buildDispatchSnapshotState(
      sourceData({
        reserveCache: reserveSource(["usdc-circle"], { generation: "reserve-alert-source-v0" }),
        reserveDispatchedCache: cache([]),
      }),
      nowSec,
    );

    expect(state.reserveSourceAssessment.state).toBe("wrong-generation");
    expect(state.previousReserveDriftIds).toEqual([]);
    expect(state.currentReserveDriftIds).toEqual([]);
    expect(state.currentSnapshots.reserveDispatched).toEqual([]);
  });

  it("cold-seeds the first fresh generation after a gap and does not replay the gap", () => {
    const firstFreshEnvelope = buildAlertReserveSourceEnvelope(
      ["usdc-circle"],
      null,
      {
        nowSec,
        producerIntervalSec: CRON_INTERVALS["sync-live-reserves"],
      },
    );
    const recoveryRun = buildDispatchSnapshotState(
      sourceData({
        reserveCache: cache(firstFreshEnvelope, nowSec),
        reserveDispatchedCache: cache([]),
      }),
      nowSec,
    );

    expect(recoveryRun.reserveSourceAssessment.state).toBe("recovering");
    expect(recoveryRun.previousReserveDriftIds).toEqual(["usdc-circle"]);
    expect(recoveryRun.currentReserveDriftIds).toEqual(["usdc-circle"]);
    expect(recoveryRun.currentSnapshots.reserveDispatched).toEqual(["usdc-circle"]);

    const nextPublishedAt = nowSec + CRON_INTERVALS["sync-live-reserves"];
    const continuousEnvelope = buildAlertReserveSourceEnvelope(
      ["usdc-circle"],
      cache(firstFreshEnvelope, nowSec),
      {
        nowSec: nextPublishedAt,
        producerIntervalSec: CRON_INTERVALS["sync-live-reserves"],
      },
    );
    const healthyRun = buildDispatchSnapshotState(
      sourceData({
        reserveCache: cache(continuousEnvelope, nextPublishedAt),
        reserveDispatchedCache: cache(recoveryRun.currentSnapshots.reserveDispatched, nextPublishedAt),
      }),
      nextPublishedAt,
    );

    expect(healthyRun.reserveSourceAssessment.state).toBe("ok");
    expect(healthyRun.previousReserveDriftIds).toEqual(["usdc-circle"]);
    expect(healthyRun.currentReserveDriftIds).toEqual(["usdc-circle"]);
  });
});
