import type { HealthResponse } from "@shared/types/status/public-health";
import { applyPublicStatusHysteresis, projectPublicStatus } from "@shared/lib/public-status-components";

/**
 * Canonical healthy public-health payload shared by src and worker status
 * fixtures so their field defaults cannot drift apart.
 */
export function makeHealthyHealthResponse(): HealthResponse {
  return {
    status: "healthy",
    timestamp: 1_700_000_000,
    warnings: [],
    safetyScorePublication: {
      schemaVersion: 2,
      status: "current",
      acceptedPublicationGenerationId: "test-safety-publication",
      acceptedAtSec: 1_699_999_970,
      attemptedAtSec: 1_699_999_970,
      heldSinceSec: null,
      reasons: [],
    },
    safetyScorePublicationUnavailableReason: null,
    schedulerLiveness: {
      status: "healthy", observedAt: 1_700_000_000,
      lastAnyStartedAt: 1_699_999_970, lastFiveMinuteStartedAt: 1_699_999_970, ageSeconds: 30,
      warningAfterSec: 600, staleAfterSec: 1200,
      lanes: ["fiveMinuteReserveRecovery", "fiveMinuteTelegramAlerts", "digestTriggerPoll"].map((scheduleKey) => ({
        scheduleKey, lastStartedAt: 1_699_999_970,
      })),
      unavailableReason: null,
      heavy: {
        scheduleKey: "v9SupplyAttributionOffset", lastStartedAt: 1_699_999_970, ageSeconds: 30,
        warningAfterSec: 1800, staleAfterSec: 2700, status: "healthy", unavailableReason: null,
      },
    },
    caches: {},
    blacklist: {
      totalEvents: 0,
      missingAmounts: 0,
      recentMissingAmounts: 0,
      recentWindowSec: 86_400,
      missingRatio: 0,
    },
    mintBurn: {
      totalEvents: 0,
      latestEventTs: null,
      latestHourlyTs: null,
      freshnessAgeSec: null,
      majorStaleCount: 0,
      staleMajorSymbols: [],
      sync: {
        lastSuccessfulSyncAt: 1_699_999_970,
        freshnessStatus: "fresh",
        warning: null,
        criticalLaneHealthy: true,
      },
    },
    circuits: {},
  };
}

/** Healthy payload with two bounded asset-scoped listing and price gaps. */
export function assetScopedHealth(): HealthResponse {
  const health = makeHealthyHealthResponse();
  const missingActiveAssets = [
    { stablecoinId: "usdy-ondo-finance", symbol: "USDY", marketCapUsd: null,
      lastKnownMarketCapUsd: 2_344_462_796.3038855, lastKnownMarketCapObservedAt: 1_700_000_000 - 7 * 86400,
      consecutiveMissingGenerations: 10 },
    { stablecoinId: "frnt-wyoming", symbol: "FRNT", marketCapUsd: 967_947.92,
      consecutiveMissingGenerations: 9 * 96 },
  ].map((asset) => ({
    ...asset, currentPrice: null, currentSource: null, currentObservedAt: null, currentConfidence: null,
    lastAcceptedPrice: null, lastAcceptedSource: null, lastAcceptedObservedAt: null,
    rejectionReason: "missing", alertEligible: true,
  }));
  health.stablecoinPublication = {
    status: "incomplete", expectedActiveCount: 396, presentActiveCount: 395, waivedActiveCount: 0,
    missingActiveIds: ["usdy-ondo-finance"], waivedActiveIds: [], expiredWaiverIds: [], observedAt: 1_700_000_000,
  };
  health.activePriceCoverage = {
    status: "incomplete", expectedActiveCount: 396, presentActiveCount: 395, pricedActiveCount: 394,
    missingPriceCount: 2, pricedActiveIds: [], missingActiveIds: missingActiveAssets.map((asset) => asset.stablecoinId),
    affectedMarketCapUsd: null, missingActiveAssets, alertEligibleCount: 2,
    alertEligibleIds: missingActiveAssets.map((asset) => asset.stablecoinId),
    maxConsecutiveMissingGenerations: 9 * 96, observedAt: 1_700_000_000,
  };
  health.mintBurn.sync.warning = "Critical mint/burn lane is running in degraded mode; coverage may be partial.";
  return health;
}

/**
 * One public-health run of a hold sequence (ADR-42), from tokens: `open`
 * three open circuit providers; `late` a scheduler read 1,300 s old; `cx`,
 * `sx`, `bx` the circuits, scheduler and blacklist reads failed.
 */
export function makeHoldRunHealth(run: string): HealthResponse {
  const health = makeHealthyHealthResponse();
  const open = { state: "open" as const, consecutiveFailures: 3, lastFailureAt: 1, lastSuccessAt: null, openedAt: 1 };
  if (run.includes("open")) health.circuits = { "coingecko-prices": open, "defillama-coins": open, "dexscreener-prices": open };
  if (run.includes("late")) Object.assign(health.schedulerLiveness!, { status: "degraded", ageSeconds: 1300 });
  if (run.includes("cx")) Object.assign(health, { circuits: null, circuitsUnavailableReason: "circuits-read-failed" });
  if (run.includes("sx")) {
    Object.assign(health.schedulerLiveness!, { status: "unavailable", ageSeconds: null, unavailableReason: "slot-start-query-failed", readFailed: true });
  }
  if (run.includes("bx")) Object.assign(health.blacklist, { missingRatio: null, unavailableReason: "blacklist-read-failed" });
  return health;
}

type Published = Parameters<typeof applyPublicStatusHysteresis>[1];

/** One writer step: project, publish through the held hysteresis, carry the stored fields forward. */
export function stepPublicHold(prior: Published, health: HealthResponse, now: number, maxHoldSec = 1800) {
  const out = applyPublicStatusHysteresis(projectPublicStatus(health, {}, undefined, { holdable: (id) => prior.has(id) }), prior, now, maxHoldSec);
  const next: Published = new Map(out.projection.components.map((item) => [item.id,
    { ...item, pending: out.pending[item.id] ?? null, confirmedAt: out.confirmedAt[item.id] ?? null }]));
  return { ...out, next };
}
