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
import { SAFETY_SCORE_METHODOLOGY_VERSION } from "@shared/lib/safety-score-version";
import {
  getAlertSafetySourceGeneration,
  getAlertSafetyV9SourceGeneration,
} from "../../lib/alert-safety-source-cache";
import { makeWorkerReportCardsV9Response, makeWorkerV9Card } from "../../test-helpers/report-cards-v9";
import { buildDewsChanges, buildSafetyChanges } from "../telegram-alert-changes";

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

function v8Identity(publicationGenerationId: string) {
  return {
    model: "v8" as const,
    schemaVersion: 1 as const,
    methodologyVersion: SAFETY_SCORE_METHODOLOGY_VERSION,
    evaluationBuildDigest: "a".repeat(64),
    baseInputGenerationId: `report-cards-input:v1:${"b".repeat(64)}`,
    publicationGenerationId,
  };
}

function v8Source(
  grade: string,
  score: number,
  publicationGenerationId = "report-cards:v8:test",
) {
  return cache({
    generation: getAlertSafetySourceGeneration(SAFETY_SCORE_METHODOLOGY_VERSION),
    safetyScoreIdentity: v8Identity(publicationGenerationId),
    publicationGenerationId,
    methodologyVersion: SAFETY_SCORE_METHODOLOGY_VERSION,
    publishedAt: nowSec - 60,
    snapshot: {
      "usdc-circle": { grade, score, methodologyVersion: SAFETY_SCORE_METHODOLOGY_VERSION },
    },
  });
}

function safetyBaseline(
  generation: string,
  identity: ReturnType<typeof v8Identity> | ReturnType<typeof makeWorkerReportCardsV9Response>["safetyScoreIdentity"],
  grade: string,
  score: number,
) {
  return cache({
    generation,
    safetyScoreIdentity: identity,
    snapshot: {
      "usdc-circle": {
        grade,
        score,
        methodologyVersion: identity.methodologyVersion,
      },
    },
  });
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

describe("buildDispatchSnapshotState active safety model", () => {
  it("fails closed for an invalid V9 activation while unrelated DEWS changes remain alertable", () => {
    const state = buildDispatchSnapshotState(
      sourceData({
        activeSafetySource: {
          kind: "error",
          expectedModel: "v9",
          reason: "v9-identity-mismatch",
          activationUpdatedAt: nowSec - 30,
          marker: null,
          snapshot: null,
          detail: "mismatch",
        },
        safetySourceCache: v8Source("A", 91),
        dewsRows: [{
          stablecoin_id: "usdc-circle",
          score: 72,
          band: "ALERT",
          signals_json: signalsJson,
        }],
        dewsCache: cache({ "usdc-circle": "CALM" }),
        dewsAlertableCache: cache({ "usdc-circle": "CALM" }),
      }),
      nowSec,
    );

    expect(state.safetySourceAssessment).toMatchObject({
      state: "corrupt",
      expectedModel: "v9",
      failureReason: "v9-identity-mismatch",
    });
    expect(state.currentSafetySnapshot).toBeNull();
    expect(
      buildDewsChanges(
        sourceData().dewsRows.concat({
          stablecoin_id: "usdc-circle",
          score: 72,
          band: "ALERT",
          signals_json: signalsJson,
        }),
        state.safeDewsAlertable,
        state.safeDewsSnapshot,
        () => "USDC",
      ),
    ).toHaveLength(1);
  });

  it("cold-seeds V8 to V9 activation and suppresses the apparent grade fan-out", () => {
    const response = makeWorkerReportCardsV9Response({
      updatedAt: nowSec - 60,
      asOfSec: nowSec - 120,
      cards: [makeWorkerV9Card({ grade: "A", score: 91 })],
    });
    const state = buildDispatchSnapshotState(
      sourceData({
        activeSafetySource: {
          kind: "v9",
          expectedModel: "v9",
          marker: {
            policyId: response.safetyScoreIdentity.policyId,
            policyDigest: response.safetyScoreIdentity.policyDigest,
            evaluationBuildDigest: response.safetyScoreIdentity.evaluationBuildDigest,
            methodologyVersion: response.safetyScoreIdentity.methodologyVersion,
          },
          activationUpdatedAt: nowSec - 30,
          snapshot: response,
        },
        safetyCache: safetyBaseline(
          getAlertSafetySourceGeneration(SAFETY_SCORE_METHODOLOGY_VERSION),
          v8Identity("report-cards:v8:prior"),
          "D",
          44,
        ),
        safetySourceCache: v8Source("D", 44, "report-cards:v8:current"),
      }),
      nowSec,
    );

    expect(state.safetySourceAssessment.expectedModel).toBe("v9");
    expect(state.currentSafetySnapshot?.["usdc-circle"]).toMatchObject({ grade: "A", score: 91 });
    expect(state.currentSnapshots.safety?.generation).toBe(
      getAlertSafetyV9SourceGeneration(response.safetyScoreIdentity.methodologyVersion),
    );
    expect(state.safetySnapshotNeedsSeed).toBe(true);
    expect(state.safeSafetySnapshot).toEqual({});
    expect(buildSafetyChanges(state.currentSafetySnapshot, state.safeSafetySnapshot, () => "USDC").changes)
      .toEqual([]);
  });

  it("cold-seeds a V9 to V8 rollback, then restores ordinary V8 grade comparisons", () => {
    const response = makeWorkerReportCardsV9Response({
      updatedAt: nowSec - 60,
      asOfSec: nowSec - 120,
    });
    const rollback = buildDispatchSnapshotState(
      sourceData({
        activeSafetySource: {
          kind: "v8",
          expectedModel: "v8",
          reason: "activation-marker-missing",
          activationUpdatedAt: null,
        },
        safetyCache: safetyBaseline(
          getAlertSafetyV9SourceGeneration(response.safetyScoreIdentity.methodologyVersion),
          response.safetyScoreIdentity,
          "A",
          91,
        ),
        safetySourceCache: v8Source("B", 75, "report-cards:v8:rollback"),
      }),
      nowSec,
    );
    expect(rollback.safetySnapshotNeedsSeed).toBe(true);
    expect(rollback.currentSafetySnapshot?.["usdc-circle"].grade).toBe("B");
    expect(rollback.safeSafetySnapshot).toEqual({});

    const restored = buildDispatchSnapshotState(
      sourceData({
        activeSafetySource: {
          kind: "v8",
          expectedModel: "v8",
          reason: "activation-marker-missing",
          activationUpdatedAt: null,
        },
        safetyCache: safetyBaseline(
          getAlertSafetySourceGeneration(SAFETY_SCORE_METHODOLOGY_VERSION),
          v8Identity("report-cards:v8:baseline"),
          "C",
          64,
        ),
        safetySourceCache: v8Source("B", 75, "report-cards:v8:new-publication"),
      }),
      nowSec,
    );
    expect(restored.safetySnapshotNeedsSeed).toBe(false);
    expect(
      buildSafetyChanges(restored.currentSafetySnapshot, restored.safeSafetySnapshot, () => "USDC").changes,
    ).toHaveLength(1);
  });

  it("re-seeds after a missed safety baseline window instead of replaying blind-period changes", () => {
    const identity = v8Identity("report-cards:v8:continuity");
    const state = buildDispatchSnapshotState(
      sourceData({
        activeSafetySource: {
          kind: "v8",
          expectedModel: "v8",
          reason: "activation-marker-missing",
          activationUpdatedAt: null,
        },
        safetyCache: {
          ...safetyBaseline(
            getAlertSafetySourceGeneration(SAFETY_SCORE_METHODOLOGY_VERSION),
            identity,
            "C",
            58,
          ),
          updatedAt: nowSec - CRON_INTERVALS["dispatch-telegram-alerts"] * 2,
        },
        safetySourceCache: v8Source("A", 91, "report-cards:v8:continuity-next"),
      }),
      nowSec,
    );

    expect(state.safetySnapshotNeedsSeed).toBe(true);
    expect(state.safeSafetySnapshot).toEqual({});
    expect(buildSafetyChanges(
      state.currentSafetySnapshot,
      state.safeSafetySnapshot,
      () => "USDC",
    ).changes).toEqual([]);
  });
});
