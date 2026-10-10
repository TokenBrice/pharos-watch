import { makeReportCardsV9PipelineGapCard } from "@shared/test-utils/report-cards-v9";
import { CRON_INTERVALS } from "@shared/lib/cron-jobs";
import { describe, expect, it } from "vitest";
import {
  ALERT_RESERVE_SOURCE_GENERATION,
  buildAlertReserveSourceEnvelope,
} from "../../lib/alert-reserve-source-cache";
import {
  assessActiveAlertSafetySource,
  buildActiveAlertSafetyV9SourceEnvelope,
  getAlertSafetyV9SourceGeneration,
} from "../../lib/alert-safety-source-cache";
import { mockD1 } from "@shared/test-utils/mock-d1";
import {
  makeWorkerReportCardsV9Response,
  makeWorkerV9Card,
} from "../../test-helpers/report-cards-v9";
import { buildDewsChanges, buildReserveTransitions, buildSafetyChanges } from "../telegram-alert-changes";
import {
  buildDispatchSnapshotState,
  loadDewsRows,
  type DispatchSourceData,
} from "../dispatch-telegram-state";

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
    observedSince: Object.fromEntries(driftIds.map((id) => [id, nowSec - 120])),
    unavailableIds: [],
    ...overrides,
  });
}

function sourceData(
  overrides: Partial<DispatchSourceData> = {},
): DispatchSourceData {
  return {
    chatsWithActiveSnooze: 0,
    dewsRows: [],
    activeDepegRows: [],
    dewsCache: cache({}),
    dewsAlertableCache: cache({}),
    depegCache: cache({}),
    safetyCache: null,
    launchCache: cache([]),
    reserveCache: reserveSource([]),
    reserveDispatchedCache: cache([]),
    ...overrides,
  };
}

function safetyBaseline(
  response: ReturnType<typeof makeWorkerReportCardsV9Response>,
  grade: string,
  score: number,
) {
  const source = buildActiveAlertSafetyV9SourceEnvelope(response);
  if (!source) throw new Error("Expected current V9 alert source");
  return cache({
    generation: getAlertSafetyV9SourceGeneration(
      response.safetyScoreIdentity.methodologyVersion,
    ),
    safetyScoreIdentity: response.safetyScoreIdentity,
    snapshot: {
      ...source.snapshot,
      "usdc-circle": {
        ...source.snapshot["usdc-circle"],
        grade,
        score,
      },
    },
  });
}

describe("loadDewsRows", () => {
  it("uses the published DEWS generation pointer as the reader cutoff", async () => {
    const row = {
      stablecoin_id: "usdt-tether",
      score: 12,
      band: "CALM",
      signals_json: signalsJson,
      computed_at: completedDewsAt,
    };
    const pointer = {
      key: "dews:published-generation",
      value: JSON.stringify({
        updatedAt: completedDewsAt,
        source: "compute-dews",
        publishStatus: "published",
      }),
      updated_at: completedDewsAt,
    };
    const db = mockD1([
      {
        match: "FROM cache WHERE key = ?",
        matchBinds: ["dews:published-generation"],
        rows: [pointer],
        first: pointer,
      },
      {
        match: "pharos:telegram-dispatch:dews-latest",
        matchBinds: [completedDewsAt],
        rows: [],
      },
      {
        match: "pharos:telegram-dispatch:dews-legacy",
        matchBinds: [completedDewsAt],
        rows: [row],
      },
    ]);

    await expect(loadDewsRows(db, nowSec)).resolves.toEqual([row]);
  });
});

describe("buildDispatchSnapshotState", () => {
  it("preserves the reserve baseline when the producer snapshot is invalid", () => {
    const state = buildDispatchSnapshotState(
      sourceData({
        reserveCache: { value: "{", updatedAt: nowSec - 60 },
        reserveDispatchedCache: cache(["usdc-circle"]),
      }),
      nowSec,
    );

    expect(state.reserveSourceUnavailable).toBe(true);
    expect(state.previousReserveDriftIds).toEqual(["usdc-circle"]);
    expect(state.currentReserveDriftIds).toEqual(["usdc-circle"]);
    expect(state.currentSnapshots.reserveDispatched).toEqual(["usdc-circle"]);
  });

  it("cold-seeds the first fresh reserve generation after a gap", () => {
    const envelope = buildAlertReserveSourceEnvelope(
      ["usdc-circle"],
      null,
      {
        nowSec,
        producerIntervalSec: CRON_INTERVALS["sync-live-reserves"],
        observedIds: ["usdc-circle"], unavailableIds: [],
      },
    );
    const state = buildDispatchSnapshotState(
      sourceData({
        reserveCache: cache(envelope, nowSec),
        reserveDispatchedCache: cache([]),
      }),
      nowSec,
    );

    expect(state.reserveSourceAssessment.state).toBe("recovering");
    expect(state.currentSnapshots.reserveDispatched).toEqual(["usdc-circle"]);
  });

  it.each([true, false])("cold-seeds per-asset recovery after prior drift=%s while peers keep alerting", (initialDrift) => {
    const interval = CRON_INTERVALS["sync-live-reserves"];
    const producerOptions = { producerIntervalSec: interval, observedIds: ["coin", "peer"], unavailableIds: [] };
    const first = buildAlertReserveSourceEnvelope(initialDrift ? ["coin"] : [], null, { ...producerOptions, nowSec: nowSec - 2 * interval });
    const baseline = buildDispatchSnapshotState(sourceData({ reserveCache: cache(first), reserveDispatchedCache: null }), nowSec - 2 * interval);
    const gap = buildAlertReserveSourceEnvelope([], cache(first), { ...producerOptions, nowSec: nowSec - interval, observedIds: ["peer"], unavailableIds: ["coin"] });
    const gapState = buildDispatchSnapshotState(sourceData({
      reserveCache: cache(gap), reserveDispatchedCache: cache(baseline.currentSnapshots.reserveDispatched),
      reserveObservedCache: cache(baseline.currentSnapshots.reserveObserved),
    }), nowSec - interval);
    const recovery = buildAlertReserveSourceEnvelope(["coin", "peer"], cache(gap), { ...producerOptions, nowSec });
    const recovered = buildDispatchSnapshotState(sourceData({
      reserveCache: cache(recovery), reserveDispatchedCache: cache(gapState.currentSnapshots.reserveDispatched),
      reserveObservedCache: cache(gapState.currentSnapshots.reserveObserved),
    }), nowSec);
    const transitions = buildReserveTransitions(new Set(recovered.previousReserveDriftIds), new Set(recovered.currentReserveDriftIds),
      new Map([["coin", { symbol: "COIN", name: "Coin" }], ["peer", { symbol: "PEER", name: "Peer" }]]));
    expect(transitions.map((entry) => entry.stablecoinId)).toEqual(["peer"]);
    // The continuity epoch also protects a dispatcher which missed the gap.
    const missedGap = buildDispatchSnapshotState(sourceData({
      reserveCache: cache(recovery), reserveDispatchedCache: cache(baseline.currentSnapshots.reserveDispatched),
      reserveObservedCache: cache(baseline.currentSnapshots.reserveObserved),
    }), nowSec);
    expect(missedGap.previousReserveDriftIds).toContain("coin");
  });

  it("alerts true observed clear to new drift and accepts a complete no-drift result", () => {
    const observedSince = { coin: nowSec - 120 };
    const state = buildDispatchSnapshotState(sourceData({
      reserveCache: cache({ generation: ALERT_RESERVE_SOURCE_GENERATION, publishedAt: nowSec, continuous: true, driftIds: ["coin"], observedSince, unavailableIds: [] }),
      reserveDispatchedCache: cache([]), reserveObservedCache: cache(observedSince),
    }), nowSec);
    expect(state.previousReserveDriftIds).toEqual([]);
    expect(state.currentReserveDriftIds).toEqual(["coin"]);
    const clear = buildDispatchSnapshotState(sourceData({ reserveCache: reserveSource([]) }), nowSec);
    expect(clear.reserveSourceAssessment.state).toBe("ok");
    expect(clear.currentReserveDriftIds).toEqual([]);
  });

  it("fails closed when canonical V9 is unavailable without blocking DEWS", () => {
    const state = buildDispatchSnapshotState(
      sourceData({
        safetySourceAssessment: assessActiveAlertSafetySource({
          kind: "error",
          reason: "v9-snapshot-unavailable",
          snapshot: null,
          detail: "publication unavailable",
        }, { nowSec }),
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
      state: "missing",
      failureReason: "v9-snapshot-unavailable",
    });
    expect(state.currentSafetySnapshot).toBeNull();
    expect(buildDewsChanges(
      sourceData().dewsRows.concat({
        stablecoin_id: "usdc-circle",
        score: 72,
        band: "ALERT",
        signals_json: signalsJson,
      }),
      state.safeDewsAlertable,
      state.safeDewsSnapshot,
      () => "USDC",
    )).toHaveLength(1);
  });

  it.each(["entering", "recovering"] as const)("suppresses %s pipeline-gap grade alerts", (transition) => {
    const rated = makeWorkerReportCardsV9Response({
      updatedAt: nowSec - 60, asOfSec: nowSec - 120,
      cards: [makeWorkerV9Card({ id: "usdc-circle", grade: "D", score: 44 })],
    });
    const gap = makeWorkerReportCardsV9Response({
      updatedAt: nowSec - 60, asOfSec: nowSec - 120,
      cards: [makeReportCardsV9PipelineGapCard("control", "A", { id: "usdc-circle" })],
    });
    const previous = buildActiveAlertSafetyV9SourceEnvelope(transition === "entering" ? rated : gap)!;
    const current = transition === "entering" ? gap : rated;
    const state = buildDispatchSnapshotState(sourceData({
      safetyCache: cache(previous),
      safetySourceAssessment: assessActiveAlertSafetySource({ kind: "v9", snapshot: current }, { nowSec }),
    }), nowSec);
    expect(state.safetySnapshotNeedsSeed).toBe(false);
    expect(state.currentSafetySnapshot?.["usdc-circle"]?.ratingStatus).toBe(transition === "entering" ? "pipeline-gap" : "rated");
    expect(buildSafetyChanges(state.currentSafetySnapshot, state.safeSafetySnapshot, () => "USDC").changes).toEqual([]);
  });

  it("compares consecutive canonical V9 publications", () => {
    const response = makeWorkerReportCardsV9Response({
      updatedAt: nowSec - 60,
      asOfSec: nowSec - 120,
      cards: [makeWorkerV9Card({ grade: "A+", score: 91 })],
    });
    const state = buildDispatchSnapshotState(
      sourceData({
        safetySourceAssessment: assessActiveAlertSafetySource({
          kind: "v9",
          snapshot: response,
        }, { nowSec }),
        safetyCache: safetyBaseline(response, "D", 44),
      }),
      nowSec,
    );

    expect(state.safetySnapshotNeedsSeed).toBe(false);
    expect(state.currentSafetySnapshot?.["usdc-circle"]).toMatchObject({
      grade: "A+",
      score: 91,
    });
    expect(
      buildSafetyChanges(
        state.currentSafetySnapshot,
        state.safeSafetySnapshot,
        () => "USDC",
      ).changes,
    ).toHaveLength(1);
  });

  it("marks affected rows from matching partial-publication metadata", () => {
    const response = makeWorkerReportCardsV9Response({
      updatedAt: nowSec - 60,
      asOfSec: nowSec - 120,
      cards: [makeWorkerV9Card({ grade: "NR", score: null })],
    });
    const state = buildDispatchSnapshotState(
      sourceData({
        safetySourceAssessment: assessActiveAlertSafetySource({
          kind: "v9",
          snapshot: response,
        }, { nowSec }),
        publicationAttempt: {
          schemaVersion: 1,
          attemptedAtSec: response.updatedAt,
          outcome: "published-partial",
          publicationGenerationId:
            response.safetyScoreIdentity.publicationGenerationId,
          quarantines: [
            {
              assetId: "usdc-circle",
              code: "fact-build-failed",
              message: "fixture quarantine",
            },
          ],
          affectedAssetIds: ["usdc-circle"],
        },
      }),
      nowSec,
    );

    expect(
      state.currentSafetySnapshot?.["usdc-circle"],
    ).toMatchObject({
      grade: "NR",
      operationallyAffected: true,
    });
  });
});
