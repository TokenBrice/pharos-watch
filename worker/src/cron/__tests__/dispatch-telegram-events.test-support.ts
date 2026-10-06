import type { DispatchSourceData, DispatchSnapshotState } from "../dispatch-telegram-state";
import { SAFETY_SCORE_V9_CONSUMER_MAX_AGE_SEC } from "../../lib/safety-score-v9/consumer-freshness";

export function eventSources(overrides: Partial<DispatchSourceData> = {}): DispatchSourceData {
  return {
    chatsWithActiveSnooze: 0, dewsRows: [], activeDepegRows: [],
    dewsCache: null, dewsAlertableCache: null, depegCache: null, safetyCache: null,
    launchCache: null, reserveCache: null, reserveDispatchedCache: null,
    ...overrides,
  };
}

export function eventSnapshots(overrides: Partial<DispatchSnapshotState> = {}): DispatchSnapshotState {
  return {
    nowSec: 1_800_000_000,
    previousDewsSnapshot: {}, previousDewsAlertableSnapshot: {}, previousDepegSnapshot: {},
    previousSafetySnapshot: null, currentSafetySnapshot: {}, safeSafetySnapshot: {},
    safeDewsAlertable: {}, safeDewsSnapshot: {}, safeDepegSnapshot: {},
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
    currentSnapshots: { dews: {}, dewsAlertable: {}, depeg: {}, safety: null, launch: [], reserveDispatched: null },
    previousReserveDriftIds: [], currentReserveDriftIds: [], reserveSourceUnavailable: true,
    ...overrides,
  };
}
