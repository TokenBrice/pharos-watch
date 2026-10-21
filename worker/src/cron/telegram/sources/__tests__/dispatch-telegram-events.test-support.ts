import type { DispatchSourceData, DispatchSnapshotState } from "../../dispatch/dispatch-telegram-state";
import { SAFETY_SCORE_V9_CONSUMER_MAX_AGE_SEC } from "../../../../lib/safety-score-v9/consumer-freshness";
import { createLatestSchemaSqlite } from "@shared/test-utils/latest-schema-sqlite";
import type { DepegSnapshot } from "../telegram-alert-snapshots";
import type { AlertSafetySourceRow } from "@shared/types/status/telegram";

export function makeAlertSafetySourceRow(overrides: Partial<AlertSafetySourceRow> = {}): AlertSafetySourceRow {
  return {
    grade: "A", score: 90, ratingStatus: "rated", partialEvidence: null, methodologyVersion: "v1",
    v9Explain: {
      reasons: [], bindingCap: null, weakestPillar: null,
      pillars: {
        backing: { score: 90, evidenceLevel: "adequate", freshness: "current" },
        exit: { score: 90, evidenceLevel: "adequate", freshness: "current" },
        control: { score: 90, evidenceLevel: "adequate", freshness: "current" },
      },
    },
    ...overrides,
  };
}

export function eventSources(overrides: Partial<DispatchSourceData> = {}): DispatchSourceData {
  return {
    chatsWithActiveSnooze: 0, dewsRows: [], activeDepegRows: [],
    dewsCache: null, dewsAlertableCache: null, depegCache: null, safetyCache: null,
    reserveCache: null, reserveDispatchedCache: null,
    ...overrides,
  };
}

export function eventSnapshots(overrides: Partial<DispatchSnapshotState> = {}): DispatchSnapshotState {
  return {
    nowSec: 1_800_000_000,
    previousDewsSnapshot: {}, previousDewsAlertableSnapshot: {}, previousDepegSnapshot: {},
    previousSafetySnapshot: null, currentSafetySnapshot: {}, safeSafetySnapshot: {},
    safeDewsAlertable: {}, safeDewsCandidates: {}, safeDewsSnapshot: {}, safeDepegSnapshot: {},
    safetySnapshotNeedsSeed: false, mustSeedSnapshots: false,
    safetySourceAssessment: {
      state: "missing", ageSeconds: null, generation: null, envelope: null,
      failureReason: "v9-snapshot-unavailable",
      sourcePublicationGenerationId: null, acceptedPublicationGenerationId: null,
      freshnessMaxAgeSec: SAFETY_SCORE_V9_CONSUMER_MAX_AGE_SEC, assessedAtSec: 1_800_000_000,
    },
    reserveSourceAssessment: {
      state: "missing", ageSeconds: null, generation: null, envelope: null,
    },
    currentSnapshots: { dews: {}, dewsAlertable: {}, depeg: {}, dewsCandidates: {}, dewsUnavailable: false, safety: null, reserveDispatched: null },
    previousReserveDriftIds: [], currentReserveDriftIds: [], reserveSourceUnavailable: true,
    ...overrides,
  };
}

export function priorDepeg(eventId: number | null = 1): DepegSnapshot {
  return {
    "coin-depeg": {
      stablecoinId: "coin-depeg", symbol: "DPG", direction: "below",
      deviationBps: 310, price: 0.969, pegReference: 1, eventId: eventId ?? undefined,
    },
  };
}

export function activeDepeg(
  peak = 280,
  direction: "above" | "below" = "below",
  eventId = 2,
): DispatchSourceData["activeDepegRows"][number] {
  const price = 1 + (direction === "above" ? peak : -peak) / 10_000;
  return {
    stablecoin_id: "coin-depeg", symbol: "DPG", direction,
    peak_deviation_bps: peak, start_price: price, peak_price: price,
    peg_reference: 1, event_id: eventId, started_at: 1_900,
  };
}

export function createClosedDepegFixture(closeReason: string | null, recoveryPrice: number | null = 1) {
  const { sqlite, db } = createLatestSchemaSqlite();
  const insertClosed = sqlite.prepare(
    `INSERT INTO depeg_events (
       id, stablecoin_id, symbol, peg_type, direction, peak_deviation_bps,
       started_at, ended_at, start_price, peak_price, recovery_price, peg_reference, close_reason
     ) VALUES (?, 'coin-depeg', 'DPG', 'peggedUSD', 'below', 310,
               ?, ?, 0.969, 0.969, ?, 1, ?)`,
  );
  insertClosed.run(1, 1_000, 1_600, recoveryPrice, closeReason);
  return { sqlite, db, insertClosed };
}
