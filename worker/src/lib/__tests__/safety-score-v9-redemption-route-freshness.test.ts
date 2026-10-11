import { describe, expect, it } from "vitest";
import { getRedemptionBackstopConfig } from "@shared/lib/redemption-backstops";
import { computeLiveReserveConfigFingerprint } from "@shared/lib/live-reserve-adapters";
import { WORKER_TRACKED_META_BY_ID } from "@shared/lib/stablecoins/worker-runtime-registry";
import { buildRedemptionExitRouteObservation } from "../redemption-exit-route-observations";
import { buildRoutes } from "../safety-score-v9/fact-set-exit";
import { buildSupply } from "../safety-score-v9/fact-set-peg-supply";
import { buildSafetyScoreV9RouteReviews } from "../safety-score-v9/extension-routes";
import { reserveBackedRedemptionRouteMaxAgeSec } from "../safety-score-v9/redemption-route-freshness";
import { makeV9Extension, makeV9FixedInput } from "../../test-helpers/v9-fixed-input";
import { factBuilderContext } from "./safety-score-v9-fact-builders.test-support";
import { rebuildFixed } from "./safety-score-v9-fact-set.test-support";
import { makeSupplyFullRedemption } from "./redemption-backstops-store.test-support";

const assetId = "usdf-falcon";
const sourceTimestamp = 1791538382;
const fetchedAt = 1791663137;
const runClockSec = 1791663719;
const producerBudgetSec = 8 * 3600;

function fixture(clockSec = 1791672421) {
  const row = makeSupplyFullRedemption({
    stablecoinId: assetId, routeFamily: "queue-redeem", sourceMode: "dynamic",
    settlementModel: "queued", accessModel: "whitelisted-onchain", outputAssetType: "stable-basket",
    capacityKind: "live-queue", freshnessKind: "verified-source-timestamp", sourceTimestamp,
    capacityConfidence: "live-proxy", feeBps: 0, updatedAt: runClockSec,
    capacityProfile: { scoringUsd: 10_000_000, scoringHorizon: "queued", capacityProfileConfidence: "live-proxy", modeledExitSizeUsd: 1_000_000 },
    reserveInput: {
      generationId: "reserve:fixture", contentSha256: "a".repeat(64), stablecoinId: assetId,
      attemptId: "falcon:fixture", configFingerprint: computeLiveReserveConfigFingerprint(WORKER_TRACKED_META_BY_ID.get(assetId)!.liveReservesConfig!),
      freshness: {
        stale: false, staleReasons: [], assessedAt: runClockSec, fetchedAt, attemptId: "falcon:fixture",
        fetchAgeSec: runClockSec - fetchedAt, fetchBudgetSec: 172800, freshnessMode: "verified",
        sourceFreshnessInvalid: false, sourceTimestamp, sourceAgeSec: runClockSec - sourceTimestamp,
        sourceAgeBudgetSec: 259200, sourceAgeBudgetCap: "adapter",
      },
    },
  });
  const observation = buildRedemptionExitRouteObservation({
    stablecoinId: assetId, config: getRedemptionBackstopConfig(assetId)!, capacityProfile: row.capacityProfile,
    scoringCapacityUsd: 10_000_000, supplyUsd: 100_000_000, routeStatus: "open", resolutionState: "resolved",
    sourceMode: "dynamic", capacityConfidence: "live-proxy", capacityKind: "live-queue",
    freshnessKind: "verified-source-timestamp", evidenceObservedAt: sourceTimestamp,
    resolvedFeeBps: 0, settlementDelaySec: 7 * 86400, now: runClockSec,
  })!;
  row.capacityProfile!.exitRouteObservations = [observation];
  const draft = makeV9FixedInput({ assetId, clockSec });
  draft.redemptionBackstopMap = { [assetId]: row };
  draft.redemptionStale = false;
  draft.redemptionGenerationId = "redemption:clock-fixture";
  draft.inputFreshness.redemptionBackstops = { updatedAt: runClockSec, ageSeconds: clockSec - runClockSec, stale: false };
  const fixed = rebuildFixed(draft);
  const extension = makeV9Extension({ assetId, clockSec, registryFingerprint: fixed.registryFingerprint });
  extension.assets[0]!.routeReviews = buildSafetyScoreV9RouteReviews(fixed, assetId);
  extension.routeFreshness.redemptionMaxAgeSec = producerBudgetSec;
  return { row, observation, fixed, extension };
}

describe("reserve-backed redemption route clock admission", () => {
  it("keeps a current consumed disclosure without mistaking its date for the redemption cron clock", () => {
    const { fixed, extension, observation } = fixture();
    const context = factBuilderContext(fixed, extension);
    const route = buildRoutes(context, buildSupply(context)).exitRoutes.find((candidate) => candidate.lane === "redemption")!;
    expect(route.status.observationState).toBe("known");
    expect(route.status.gapIds).toEqual([]);
    expect(context.evidence.get(route.status.evidenceRefIds[0]!)?.observedAtSec).toBe(sourceTimestamp);
    expect(observation.observedAt).toBe(sourceTimestamp);
    // This fix does not turn the seven-day queue into an atomic exit.
    expect(observation.scoreEligible).toBe(false);
    expect(observation.settlementHorizonSec).toBe(7 * 86400);
  });

  it("expires at the original redemption-run budget, including its exact boundary", () => {
    const { observation, row } = fixture();
    const budget = reserveBackedRedemptionRouteMaxAgeSec(observation, row, producerBudgetSec);
    expect(sourceTimestamp + budget).toBe(runClockSec + producerBudgetSec);
    for (const offset of [0, 1]) {
      const { fixed, extension } = fixture(runClockSec + producerBudgetSec + offset);
      const context = factBuilderContext(fixed, extension);
      const route = buildRoutes(context, buildSupply(context)).exitRoutes.find((candidate) => candidate.lane === "redemption")!;
      expect(route.status.observationState).toBe(offset === 0 ? "known" : "stale");
    }
  });

  it("never renews source or fetch expiry when the redemption producer runs again", () => {
    const { observation, row } = fixture();
    row.updatedAt = sourceTimestamp + 259200 - 1;
    row.reserveInput!.freshness.assessedAt = row.updatedAt;
    row.reserveInput!.freshness.fetchedAt = row.updatedAt;
    expect(sourceTimestamp + reserveBackedRedemptionRouteMaxAgeSec(observation, row, producerBudgetSec)).toBe(sourceTimestamp + 259200);
    row.reserveInput!.freshness.fetchedAt = sourceTimestamp;
    expect(sourceTimestamp + reserveBackedRedemptionRouteMaxAgeSec(observation, row, producerBudgetSec)).toBe(sourceTimestamp + 172800);
  });

  it("rejects mismatched source bindings and does not widen retained or unverified evidence", () => {
    const { observation, row } = fixture();
    row.reserveInput!.freshness.sourceTimestamp = sourceTimestamp + 1;
    expect(reserveBackedRedemptionRouteMaxAgeSec(observation, row, producerBudgetSec)).toBe(0);
    row.reserveInput!.freshness.sourceTimestamp = sourceTimestamp;
    row.reserveInput!.freshness.freshnessMode = "unverified";
    expect(reserveBackedRedemptionRouteMaxAgeSec(observation, row, producerBudgetSec)).toBe(0);
    delete row.reserveInput;
    expect(reserveBackedRedemptionRouteMaxAgeSec(observation, row, producerBudgetSec)).toBe(producerBudgetSec);
  });
});
