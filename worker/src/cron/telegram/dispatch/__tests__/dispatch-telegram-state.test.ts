import { makeReportCardsV9PipelineGapCard } from "@shared/test-utils/report-cards-v9";
import { CRON_INTERVALS } from "@shared/lib/cron-jobs";
import { describe, expect, it } from "vitest";
import {
  ALERT_RESERVE_SOURCE_GENERATION,
  buildAlertReserveSourceEnvelope,
} from "../../../../lib/alert-reserve-source-cache";
import {
  loadActiveAlertSafetySourceAssessment,
  buildAlertSafetyV9SourceEnvelopeFromParts,
  ALERT_SAFETY_V9_SOURCE_GENERATION,
} from "../../../../lib/alert-safety-source-cache";
import { mockD1 } from "@shared/test-utils/mock-d1";
import { createLatestSchemaSqlite } from "@shared/test-utils/latest-schema-sqlite";
import { stableJsonStringifyV1 } from "@shared/lib/stable-json";
import type { ReportCardsV9CurrentResponse } from "@shared/types/report-cards-v9";
import {
  makeWorkerReportCardsV9Response,
  makeWorkerV9Card,
} from "../../../../test-helpers/report-cards-v9";
import { TELEGRAM_ALERT_POLICY } from "@shared/lib/telegram-delivery-policy";
import { buildReserveTransitions, buildSafetyChanges, planDewsAlerts } from "../../sources/telegram-alert-changes";
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
    reserveCache: reserveSource([]),
    reserveDispatchedCache: cache([]),
    ...overrides,
  };
}

function safetyBaseline(
  response: ReportCardsV9CurrentResponse,
  grade: string,
  score: number,
  pending: Record<string, unknown> = {},
) {
  const source = buildAlertSafetyV9SourceEnvelopeFromParts({
    cards: response.cards, safetyScoreIdentity: response.safetyScoreIdentity, publishedAt: response.updatedAt,
  });
  return cache({
    generation: ALERT_SAFETY_V9_SOURCE_GENERATION,
    safetyScoreIdentity: response.safetyScoreIdentity,
    snapshot: {
      ...source.snapshot,
      "usdc-circle": {
        ...source.snapshot["usdc-circle"],
        grade,
        score,
        ...pending,
      },
    },
  });
}

async function safetyAssessment(response: ReportCardsV9CurrentResponse | null) {
  const { sqlite, db } = createLatestSchemaSqlite();
  try {
    if (response) {
      const insert = sqlite.prepare("INSERT INTO cache (key, value, updated_at) VALUES (?, ?, ?)");
      insert.run("alert-safety-v9-source", JSON.stringify(buildAlertSafetyV9SourceEnvelopeFromParts({
        cards: response.cards, safetyScoreIdentity: response.safetyScoreIdentity, publishedAt: response.updatedAt,
      })), response.updatedAt);
      insert.run("report-cards:v9:publication-health", stableJsonStringifyV1(response.publicationHealth), response.updatedAt);
    }
    return await loadActiveAlertSafetySourceAssessment(db, nowSec);
  } finally {
    sqlite.close();
  }
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

  it("fails closed when canonical V9 is unavailable without blocking DEWS", async () => {
    const state = buildDispatchSnapshotState(
      sourceData({
        safetySourceAssessment: await safetyAssessment(null),
        dewsRows: [{
          stablecoin_id: "usdc-circle",
          score: 72,
          band: "ALERT",
          signals_json: signalsJson,
          computed_at: completedDewsAt,
        }],
        dewsCache: cache({ "usdc-circle": "CALM" }),
        dewsAlertableCache: cache({ "usdc-circle": "CALM" }),
        dewsCandidatesCache: cache({ "usdc-circle": { computedAt: completedDewsAt - 1800, computations: 1 } }),
      }),
      nowSec,
    );

    expect(state.safetySourceAssessment).toMatchObject({
      state: "missing",
      failureReason: "v9-snapshot-unavailable",
    });
    expect(state.currentSafetySnapshot).toBeNull();
    expect(planDewsAlerts(
      sourceData().dewsRows.concat({
        stablecoin_id: "usdc-circle",
        score: 72,
        band: "ALERT",
        signals_json: signalsJson,
        computed_at: completedDewsAt,
      }),
      state.safeDewsAlertable,
      state.safeDewsSnapshot,
      state.safeDewsCandidates,
      () => "USDC",
      nowSec,
    ).changes).toHaveLength(1);
    expect(state.currentSnapshots.dewsAlertable["usdc-circle"]).toBe("ALERT");
    expect(state.currentSnapshots.dewsCandidates["usdc-circle"]).toBeUndefined();
  });

  it("holds a first-seen DEWS escalation and keeps the prior alertable band", () => {
    const row = {
      stablecoin_id: "usdc-circle",
      score: 60,
      band: "WARNING",
      signals_json: signalsJson,
      computed_at: completedDewsAt,
    };
    const state = buildDispatchSnapshotState(sourceData({
      dewsRows: [row],
      dewsCache: cache({ "usdc-circle": "ALERT" }),
      dewsAlertableCache: cache({ "usdc-circle": "ALERT" }),
    }), nowSec);
    expect(state.safeDewsCandidates).toEqual({});
    expect(state.currentSnapshots.dews["usdc-circle"]).toBe("WARNING");
    expect(state.currentSnapshots.dewsAlertable["usdc-circle"]).toBe("ALERT");
    expect(state.currentSnapshots.dewsCandidates["usdc-circle"]).toEqual({ computedAt: completedDewsAt, computations: 1, fromBand: "ALERT" });

    // The persisted candidate round-trips; the next distinct computation alerts.
    const next = buildDispatchSnapshotState(sourceData({
      dewsRows: [{ ...row, computed_at: completedDewsAt + 1800 }],
      dewsCache: cache(state.currentSnapshots.dews),
      dewsAlertableCache: cache(state.currentSnapshots.dewsAlertable),
      dewsCandidatesCache: cache(state.currentSnapshots.dewsCandidates),
    }), nowSec + 1800);
    expect(next.safeDewsCandidates).toEqual(state.currentSnapshots.dewsCandidates);
    expect(next.currentSnapshots.dewsAlertable["usdc-circle"]).toBe("WARNING");
    expect(next.currentSnapshots.dewsCandidates["usdc-circle"]).toBeUndefined();
  });

  it.each(["entering", "recovering"] as const)("suppresses %s pipeline-gap grade alerts", async (transition) => {
    const rated = makeWorkerReportCardsV9Response({
      updatedAt: nowSec - 60, asOfSec: nowSec - 120,
      cards: [makeWorkerV9Card({ id: "usdc-circle", grade: "D", score: 44 })],
    });
    const gap = makeWorkerReportCardsV9Response({
      updatedAt: nowSec - 60, asOfSec: nowSec - 120,
      cards: [makeReportCardsV9PipelineGapCard("control", "A", { id: "usdc-circle" })],
    });
    const priorResponse = transition === "entering" ? rated : gap;
    const previous = buildAlertSafetyV9SourceEnvelopeFromParts({
      cards: priorResponse.cards, safetyScoreIdentity: priorResponse.safetyScoreIdentity, publishedAt: priorResponse.updatedAt,
    });
    const current = transition === "entering" ? gap : rated;
    const state = buildDispatchSnapshotState(sourceData({
      safetyCache: cache(previous),
      safetySourceAssessment: await safetyAssessment(current),
    }), nowSec);
    expect(state.safetySnapshotNeedsSeed).toBe(false);
    expect(state.currentSafetySnapshot?.["usdc-circle"]?.ratingStatus).toBe(transition === "entering" ? "pipeline-gap" : "rated");
    expect(buildSafetyChanges(state.currentSafetySnapshot, state.safeSafetySnapshot, () => "USDC").changes).toEqual([]);
  });

  it("adopts current DEWS bands on a reseed so an existing condition never alerts afterwards", () => {
    const warning = { stablecoin_id: "usdc-circle", score: 60, band: "WARNING", signals_json: signalsJson, computed_at: completedDewsAt };
    const seeded = buildDispatchSnapshotState(sourceData({
      dewsRows: [warning],
      dewsCache: null,
      dewsAlertableCache: null,
    }), nowSec);
    expect(seeded.mustSeedSnapshots).toBe(true);
    expect(seeded.currentSnapshots).toMatchObject({
      dews: { "usdc-circle": "WARNING" },
      dewsAlertable: { "usdc-circle": "WARNING" },
      dewsCandidates: {},
    });
    const next = buildDispatchSnapshotState(sourceData({
      dewsRows: [{ ...warning, computed_at: completedDewsAt + 1800 }],
      dewsCache: cache(seeded.currentSnapshots.dews),
      dewsAlertableCache: cache(seeded.currentSnapshots.dewsAlertable),
      dewsCandidatesCache: cache(seeded.currentSnapshots.dewsCandidates),
    }), nowSec + 1800);
    expect(planDewsAlerts([{ ...warning, computed_at: completedDewsAt + 1800 }],
      next.safeDewsAlertable, next.safeDewsSnapshot, next.safeDewsCandidates, (id) => id, nowSec + 1800).changes).toEqual([]);
  });

  it("stays silent on the first run after deploy, before the DEWS candidate key exists", () => {
    // Production state before PR B: raw observed and alertable snapshots, no candidate key.
    const rows = [
      { stablecoin_id: "usdc-circle", score: 60, band: "WARNING", signals_json: signalsJson, computed_at: completedDewsAt },
      { stablecoin_id: "usdt-tether", score: 80, band: "DANGER", signals_json: signalsJson, computed_at: completedDewsAt },
      { stablecoin_id: "dai-makerdao", score: 40, band: "ALERT", signals_json: signalsJson, computed_at: completedDewsAt },
    ];
    const state = buildDispatchSnapshotState(sourceData({
      dewsRows: rows,
      dewsCache: cache({ "usdc-circle": "WARNING", "usdt-tether": "WARNING", "dai-makerdao": "WATCH" }),
      dewsAlertableCache: cache({ "usdc-circle": "WARNING", "usdt-tether": "WARNING", "dai-makerdao": "DANGER" }),
    }), nowSec);
    expect(state.mustSeedSnapshots).toBe(false);
    expect(state.safeDewsCandidates).toEqual({});
    const plan = planDewsAlerts(rows, state.safeDewsAlertable, state.safeDewsSnapshot, state.safeDewsCandidates, (id) => id, nowSec);
    expect(plan.changes).toEqual([]);
    expect(state.currentSnapshots.dewsCandidates).toEqual(plan.nextCandidates);
  });

  it("keeps DEWS baselines and does not block depeg when the DEWS read is unavailable", () => {
    const staleAt = nowSec - 2 * 24 * 3600;
    const state = buildDispatchSnapshotState(sourceData({
      dewsRows: [],
      dewsCache: cache({ "usdc-circle": "WARNING" }, staleAt),
      dewsAlertableCache: cache({ "usdc-circle": "WARNING" }, staleAt),
      dewsCandidatesCache: cache({ "usdc-circle": { computedAt: 1, computations: 1, fromBand: "ALERT" } }, staleAt),
    }), nowSec);
    expect(state.mustSeedSnapshots).toBe(false);
    expect(state.currentSnapshots).toMatchObject({
      dewsUnavailable: true,
      dews: { "usdc-circle": "WARNING" },
      dewsAlertable: { "usdc-circle": "WARNING" },
      dewsCandidates: { "usdc-circle": { computedAt: 1, computations: 1, fromBand: "ALERT" } },
    });
  });

  it.each([
    ["continuity loss (comparable identity)", false, "B"],
    ["a methodology identity change", true, "D"],
  ] as const)("reseeds the safety baseline across %s", async (_label, changeIdentity, expectedGrade) => {
    const response = makeWorkerReportCardsV9Response({
      updatedAt: nowSec - 60, asOfSec: nowSec - 120,
      cards: [makeWorkerV9Card({ grade: "D", score: 44 })],
    });
    const previous = JSON.parse(safetyBaseline(response, "B", 72, {
      pendingKind: "severe-downgrade", pendingSinceSec: nowSec - 3600, lastAlertedAtSec: nowSec - 2 * 24 * 3600,
    }).value);
    if (changeIdentity) previous.safetyScoreIdentity = { ...previous.safetyScoreIdentity, methodologyVersion: "10.25" };
    // Older than two dispatch intervals: continuity is lost either way.
    const state = buildDispatchSnapshotState(sourceData({
      safetyCache: cache(previous, nowSec - 3600),
      safetySourceAssessment: await safetyAssessment(response),
    }), nowSec);
    expect(state.safetySnapshotNeedsSeed).toBe(true);
    const row = state.currentSnapshots.safety?.snapshot["usdc-circle"];
    expect(row).toMatchObject({ grade: expectedGrade, lastAlertedAtSec: nowSec - 2 * 24 * 3600 });
    expect(row?.pendingKind).toBe(changeIdentity ? undefined : "severe-downgrade");
  });

  it("defers a due safety alert and a new depeg through a seed run that sends nothing", async () => {
    const response = makeWorkerReportCardsV9Response({
      updatedAt: nowSec - 60, asOfSec: nowSec - 120,
      cards: [makeWorkerV9Card({ grade: "D", score: 44 })],
    });
    const due = { pendingKind: "severe-downgrade", pendingSinceSec: nowSec - TELEGRAM_ALERT_POLICY.safety.dwellSec };
    const staleAt = nowSec - 2 * 24 * 3600;
    const depegRow = {
      event_id: 7, stablecoin_id: "usdc-circle", symbol: "USDC", direction: "below" as const,
      peak_deviation_bps: 150, start_price: 0.985, peak_price: 0.985, peg_reference: 1, started_at: nowSec - 120,
    };
    const state = buildDispatchSnapshotState(sourceData({
      // A DEWS cache older than 24 h forces a global seed run.
      dewsRows: [{ stablecoin_id: "usdc-circle", score: 10, band: "CALM", signals_json: signalsJson, computed_at: completedDewsAt }],
      dewsCache: cache({}, staleAt),
      dewsAlertableCache: cache({}, staleAt),
      activeDepegRows: [depegRow],
      safetySourceAssessment: await safetyAssessment(response),
      safetyCache: safetyBaseline(response, "B", 72, due),
    }), nowSec);
    expect(state.mustSeedSnapshots).toBe(true);
    expect(state.safetySnapshotNeedsSeed).toBe(false);
    expect(state.currentSnapshots.safety?.snapshot["usdc-circle"]).toMatchObject({ grade: "B", ...due });
    expect(state.currentSnapshots.safety?.snapshot["usdc-circle"]?.lastAlertedAtSec).toBeUndefined();
    expect(state.currentSnapshots.depeg).toEqual({});

    // The next normal run still sees both changes.
    const next = buildDispatchSnapshotState(sourceData({
      dewsRows: [{ stablecoin_id: "usdc-circle", score: 10, band: "CALM", signals_json: signalsJson, computed_at: completedDewsAt }],
      dewsCache: cache(state.currentSnapshots.dews),
      dewsAlertableCache: cache(state.currentSnapshots.dewsAlertable),
      activeDepegRows: [depegRow],
      depegCache: cache(state.currentSnapshots.depeg),
      safetySourceAssessment: await safetyAssessment(response),
      safetyCache: cache(state.currentSnapshots.safety),
    }), nowSec + 300);
    expect(next.mustSeedSnapshots).toBe(false);
    expect(buildSafetyChanges(next.currentSafetySnapshot, next.safeSafetySnapshot, () => "USDC", nowSec + 300).changes).toHaveLength(1);
    expect(next.safeDepegSnapshot).toEqual({});
  });

  it("compares consecutive canonical V9 publications", async () => {
    const response = makeWorkerReportCardsV9Response({
      updatedAt: nowSec - 60,
      asOfSec: nowSec - 120,
      cards: [makeWorkerV9Card({ grade: "D", score: 44 })],
    });
    const state = buildDispatchSnapshotState(
      sourceData({
        safetySourceAssessment: await safetyAssessment(response),
        safetyCache: safetyBaseline(response, "A+", 91, {
          pendingKind: "severe-downgrade",
          pendingSinceSec: nowSec - TELEGRAM_ALERT_POLICY.safety.dwellSec,
        }),
      }),
      nowSec,
    );

    expect(state.safetySnapshotNeedsSeed).toBe(false);
    expect(state.currentSafetySnapshot?.["usdc-circle"]).toMatchObject({
      grade: "D",
      score: 44,
    });
    expect(
      buildSafetyChanges(
        state.currentSafetySnapshot,
        state.safeSafetySnapshot,
        () => "USDC",
      ).changes,
    ).toHaveLength(1);
  });

  it("marks affected rows from matching partial-publication metadata", async () => {
    const response = makeWorkerReportCardsV9Response({
      updatedAt: nowSec - 60,
      asOfSec: nowSec - 120,
      cards: [makeWorkerV9Card({ grade: "NR", score: null })],
    });
    const state = buildDispatchSnapshotState(
      sourceData({
        safetySourceAssessment: await safetyAssessment(response),
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
