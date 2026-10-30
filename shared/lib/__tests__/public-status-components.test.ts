import { describe, expect, it } from "vitest";
import { CRON_INTERVALS } from "../cron-jobs";
import { makeHealthyHealthResponse } from "../../test-utils/health-fixtures";
import {
  applyPublicStatusHysteresis,
  buildPublicHeadline,
  holdPublicStatusAtReadTime,
  headlineToStatusLevel,
  projectPublicStatus,
  PUBLIC_CACHE_COMPONENT,
  PUBLIC_STATUS_CACHE_REGISTRY_KEYS,
} from "../public-status-components";
import { countPublicImpactOpenCircuits, getPublicMintBurnStatus, getPublicProducerGraceBudget } from "../public-health";
import { getStablecoinPublicationImpactStatus } from "../status-thresholds";
import { PUBLIC_COMPONENT_LABEL } from "../classification/operational-status";
import { PUBLIC_STATUS_COMPONENT_IDS, type HealthResponse } from "../../types/status";

const NOW = 1_700_000_000;

function cache(ageSeconds: number | null, maxAge = 600): HealthResponse["caches"][string] {
  return { ageSeconds, maxAge, healthy: true };
}

function component(health: HealthResponse, id: string) {
  return projectPublicStatus(health).components.find((item) => item.id === id)!;
}

function assetScopedHealth(): HealthResponse {
  const health = makeHealthyHealthResponse();
  const missingActiveAssets = [
    { stablecoinId: "usdy-ondo-finance", symbol: "USDY", marketCapUsd: null,
      lastKnownMarketCapUsd: 2_344_462_796.3038855, lastKnownMarketCapObservedAt: NOW - 7 * 86400,
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
    missingActiveIds: ["usdy-ondo-finance"], waivedActiveIds: [], expiredWaiverIds: [], observedAt: NOW,
  };
  health.activePriceCoverage = {
    status: "incomplete", expectedActiveCount: 396, presentActiveCount: 395, pricedActiveCount: 394,
    missingPriceCount: 2, pricedActiveIds: [], missingActiveIds: missingActiveAssets.map((asset) => asset.stablecoinId),
    affectedMarketCapUsd: null, missingActiveAssets, alertEligibleCount: 2,
    alertEligibleIds: missingActiveAssets.map((asset) => asset.stablecoinId),
    maxConsecutiveMissingGenerations: 9 * 96, observedAt: NOW,
  };
  health.mintBurn.sync.warning = "Critical mint/burn lane is running in degraded mode; coverage may be partial.";
  return health;
}

describe("public status components", () => {
  it("retains classified blacklist components while public raw gaps include queued proofs", () => {
    const health = makeHealthyHealthResponse();
    health.blacklist = { ...health.blacklist, missingAmounts: 5, missingRatio: 0.05, recentMissingAmounts: 0 };
    const projection = projectPublicStatus(health, undefined, "healthy");
    expect(projection.components.find((entry) => entry.id === "blacklist")).toMatchObject({ state: "operational", reasons: [] });
    const projectedHealth = { ...health, ...projection };
    expect(component(projectedHealth, "blacklist")).toMatchObject({ state: "operational", reasons: [] });
    expect(projectPublicStatus(projectedHealth, undefined, "stale").components.find((entry) => entry.id === "blacklist"))
      .toMatchObject({ state: "degraded", reasons: ["blacklist-amounts-missing"] });
    expect(health.blacklist).toMatchObject({ missingAmounts: 5, missingRatio: 0.05, recentMissingAmounts: 0 });
    projectedHealth.blacklist = { ...health.blacklist, missingRatio: null, unavailableReason: "blacklist-read-failed" };
    expect(component(projectedHealth, "blacklist")).toMatchObject({ state: "degraded", reasons: ["blacklist-read-failed"] });
  });

  it("maps every registered cache lane to a component (ADR-32 completeness)", () => {
    for (const key of PUBLIC_STATUS_CACHE_REGISTRY_KEYS) {
      expect(PUBLIC_CACHE_COMPONENT[key], key).toBeDefined();
    }
    for (const id of PUBLIC_STATUS_COMPONENT_IDS) expect(PUBLIC_COMPONENT_LABEL[id]).toBeTruthy();
  });

  it("reports all systems operational for a healthy payload", () => {
    const projection = projectPublicStatus(makeHealthyHealthResponse());
    expect(projection.headline).toEqual({ state: "operational", title: "All systems operational", affected: [] });
    expect(projection.components.every((item) => item.state === "operational" && item.reasons.length === 0)).toBe(true);
  });
  it("keeps missing freshness unavailable and every affected cache named regardless of input order", () => {
    for (const caches of [
      { stablecoins: cache(null), "stablecoin-charts": cache(13 * 600) },
      { "stablecoin-charts": cache(13 * 600), stablecoins: cache(null) },
    ]) {
      const health = { ...makeHealthyHealthResponse(), caches };
      expect(component(health, "stablecoin-data")).toMatchObject({
        state: "degraded", ageSeconds: null, reasons: ["cache:stablecoins:age-unavailable"],
      });
      expect(component(health, "charts")).toMatchObject({ state: "degraded", reasons: ["cache:stablecoin-charts:stale"] });
    }
  });

  it("keeps source degradation informational while the FX cache remains fresh", () => {
    const health = makeHealthyHealthResponse();
    health.caches = { "fx-rates": { ...cache(120, 3600), sourceStatus: "degraded" } };
    expect(component(health, "stablecoin-data").state).toBe("operational");
  });

  it.each([
    [30, false, "operational", "mint-burn-run-failed"],
    [5400, true, "operational", null],
    [5401, true, "delayed", "mint-burn-sync:delayed"],
    [10801, true, "degraded", "mint-burn-sync:stale"],
    [21601, true, "outage", "mint-burn-sync:outage"],
  ] as const)("grades mint/burn by success age on the producer grace rule; run outcomes are notices (%ss, healthy=%s)", (age, criticalLaneHealthy, state, reason) => {
    const health = makeHealthyHealthResponse();
    health.mintBurn.sync = { ...health.mintBurn.sync, lastSuccessfulSyncAt: NOW - age,
      freshnessStatus: age > 5400 ? "stale" : "fresh", criticalLaneHealthy };
    health.blacklist = { ...health.blacklist, missingAmounts: 200, missingRatio: 0.2 };
    expect(component(health, "mint-burn")).toMatchObject({ state, reasons: reason == null ? [] : expect.arrayContaining([reason]) });
    expect(component(health, "blacklist")).toMatchObject({ state: "degraded", reasons: ["blacklist-amounts-missing"] });
  });

  it("keeps a USYC-sized ($2.4B) missing listing and a week-old price gap as operational notices", () => {
    const health = assetScopedHealth();
    expect(getStablecoinPublicationImpactStatus(health.stablecoinPublication!)).toBe("healthy");
    expect(getPublicMintBurnStatus(health.mintBurn.sync, health.timestamp)).toBe("healthy");
    const projection = projectPublicStatus(health);
    expect(projection.headline).toMatchObject({
      state: "operational", title: "Systems operational with notices", affected: ["stablecoin-data", "mint-burn"],
    });
    expect(component(health, "stablecoin-data")).toMatchObject({
      state: "operational",
      reasons: ["publication-incomplete:asset-scoped", "price-coverage-incomplete:asset-scoped"],
    });
    expect(component(health, "mint-burn")).toMatchObject({
      state: "operational", reasons: ["mint-burn-run-degraded"],
    });
    expect(headlineToStatusLevel(projection.headline.state)).toBe("healthy");
  });

  it.each([
    [4, "operational", "operational", ["publication-incomplete:asset-scoped", "price-coverage-incomplete:asset-scoped"]],
    [19, "operational", "operational", ["publication-incomplete:asset-scoped", "price-coverage-incomplete:asset-scoped"]],
    // Unpublished assets count once, as publication gaps, never again as price breadth.
    [20, "degraded", "degraded", ["publication-incomplete", "price-coverage-incomplete:asset-scoped"]],
  ] as const)("projects %s immaterial listing and price gaps of 396 by cohort breadth", (count, componentState, headlineState, reasons) => {
    const health = assetScopedHealth();
    const assets = Array.from({ length: count }, (_, index) => ({
      ...health.activePriceCoverage!.missingActiveAssets[0], stablecoinId: `missing-${index}`, symbol: `M${index}`,
      marketCapUsd: 5_000_000, lastKnownMarketCapUsd: 5_000_000, lastKnownMarketCapObservedAt: NOW,
    }));
    const ids = assets.map((asset) => asset.stablecoinId);
    health.stablecoinPublication = {
      ...health.stablecoinPublication!, presentActiveCount: 396 - count, missingActiveIds: ids,
    };
    health.activePriceCoverage = {
      ...health.activePriceCoverage!, presentActiveCount: 396 - count, pricedActiveCount: 396 - count,
      missingPriceCount: count, missingActiveIds: ids, missingActiveAssets: assets,
      alertEligibleCount: count, alertEligibleIds: ids, maxConsecutiveMissingGenerations: 10,
    };
    health.mintBurn.sync.warning = null;
    expect(component(health, "stablecoin-data")).toMatchObject({ state: componentState, reasons });
    expect(projectPublicStatus(health).headline.state).toBe(headlineState);
  });

  it.each([
    [19, "operational", "operational", "price-coverage-incomplete:asset-scoped"],
    [20, "degraded", "degraded", "price-coverage-breadth"],
  ] as const)("projects %s short immaterial price gaps of 396 by cohort breadth", (count, componentState, headlineState, reason) => {
    const health = assetScopedHealth();
    const assets = Array.from({ length: count }, (_, index) => ({
      ...health.activePriceCoverage!.missingActiveAssets[0], stablecoinId: `missing-${index}`, symbol: `M${index}`,
      marketCapUsd: 5_000_000, consecutiveMissingGenerations: 2, alertEligible: false,
    }));
    const ids = assets.map((asset) => asset.stablecoinId);
    health.stablecoinPublication = { ...health.stablecoinPublication!, status: "complete", presentActiveCount: 396, missingActiveIds: [] };
    health.activePriceCoverage = {
      ...health.activePriceCoverage!, presentActiveCount: 396, pricedActiveCount: 396 - count,
      missingPriceCount: count, missingActiveIds: ids, missingActiveAssets: assets,
      alertEligibleCount: 0, alertEligibleIds: [], maxConsecutiveMissingGenerations: 2,
    };
    health.mintBurn.sync.warning = null;
    expect(component(health, "stablecoin-data")).toMatchObject({ state: componentState, reasons: [reason] });
    expect(projectPublicStatus(health).headline.state).toBe(headlineState);
  });

  it.each(["broad", "unknown coverage", "stale cache", "missing clock", "unknown lane", "stale mint"] as const)(
    "does not let asset notices conceal %s failure", (failure) => {
      const health = assetScopedHealth();
      if (failure === "broad") health.stablecoinPublication!.expectedActiveCount = 10;
      if (failure === "unknown coverage") health.stablecoinPublication = { ...health.stablecoinPublication!, status: "unknown" };
      if (failure === "stale cache") health.caches.stablecoins = cache(13 * 600);
      if (failure === "missing clock") health.mintBurn.sync.lastSuccessfulSyncAt = null;
      if (failure === "unknown lane") health.mintBurn.sync.criticalLaneHealthy = null;
      if (failure === "stale mint") {
        health.mintBurn.sync.freshnessStatus = "stale";
        health.mintBurn.sync.lastSuccessfulSyncAt = NOW - 6000;
      }
      expect(projectPublicStatus(health).headline.state).not.toBe("operational");
    },
  );


  it("keeps held Safety Scores with accepted, in-budget scores as a notice with their machine reason", () => {
    const health = makeHealthyHealthResponse();
    health.safetyScorePublication = {
      ...health.safetyScorePublication!,
      status: "held",
      attemptedAtSec: NOW,
      heldSinceSec: NOW - 60,
      reasons: [{ code: "redemption-stale" }],
    };
    expect(component(health, "safety-scores")).toMatchObject({
      state: "operational",
      reasons: ["safety-score-publication-held", "safety-score-publication-held:redemption-stale"],
    });
    expect(projectPublicStatus(health).headline).toMatchObject({ state: "operational", affected: ["safety-scores"] });
    expect(component(health, "safety-scores").summary).toContain(
      `Ratings are held at the last verified snapshot since ${new Date((NOW - 60) * 1000).toISOString().slice(0, 16).replace("T", " ")} UTC`,
    );
    expect(component(health, "risk-signals").state).toBe("operational");
    expect(projectPublicStatus(health).components.filter((item) => item.id !== "safety-scores")
      .every((item) => item.state === "operational")).toBe(true);
  });

  it("grades the accepted score clock on the producer grace rule: delayed 3x, degraded 6x, outage 12x", () => {
    const health = makeHealthyHealthResponse();
    const interval = CRON_INTERVALS["compute-safety-score-v9"];
    const budget = { delayedAfterSec: 3 * interval, degradedAfterSec: 6 * interval, outageAfterSec: 12 * interval };
    expect(getPublicProducerGraceBudget(interval)).toEqual(budget);
    const at = (age: number, status: "current" | "held" = "current") => {
      health.safetyScorePublication = { ...health.safetyScorePublication!, status, acceptedAtSec: NOW - age, attemptedAtSec: NOW };
      return component(health, "safety-scores");
    };
    expect(at(budget.delayedAfterSec).state).toBe("operational");
    expect(at(budget.delayedAfterSec + 1)).toMatchObject({ state: "delayed", reasons: ["safety-score-publication:delayed"], budget });
    expect(at(budget.degradedAfterSec + 1)).toMatchObject({ state: "degraded", reasons: ["safety-score-publication:stale"] });
    expect(at(budget.outageAfterSec)).toMatchObject({ state: "degraded" });
    // A genuine outage still surfaces, held or not.
    expect(at(budget.outageAfterSec + 1)).toMatchObject({ state: "outage", reasons: ["safety-score-publication:outage"] });
    expect(at(budget.outageAfterSec + 1, "held")).toMatchObject({
      state: "outage", reasons: expect.arrayContaining(["safety-score-publication:outage", "safety-score-publication-held"]),
    });
  });

  it("grades publication ages at response time without renewing the assessment clock", () => {
    const health = makeHealthyHealthResponse();
    health.assessedAt = NOW;
    health.timestamp = NOW + 60;
    const delayedAfterSec = 3 * CRON_INTERVALS["compute-safety-score-v9"];
    health.safetyScorePublication = {
      ...health.safetyScorePublication!, acceptedAtSec: NOW - delayedAfterSec,
    };
    expect(component(health, "safety-scores")).toMatchObject({
      state: "delayed", ageSeconds: delayedAfterSec + 60,
    });
    expect(health.assessedAt).toBe(NOW);
  });

  it("never treats failed or absent Safety Score evidence as operational", () => {
    const health = makeHealthyHealthResponse();
    health.safetyScorePublication = null;
    health.safetyScorePublicationUnavailableReason = "safety-score-publication-read-failed";
    expect(component(health, "safety-scores")).toMatchObject({
      state: "degraded", reasons: ["safety-score-publication-read-failed"],
    });
    delete health.safetyScorePublication;
    delete health.safetyScorePublicationUnavailableReason;
    expect(component(health, "safety-scores").state).toBe("degraded");
  });

  it("grades a late scheduler as delayed, then degraded, and only an outage past the grace multiple", () => {
    const at = (ageSeconds: number, status: "healthy" | "degraded" | "stale") => {
      const health = makeHealthyHealthResponse();
      health.schedulerLiveness = { ...health.schedulerLiveness!, ageSeconds, status };
      return component(health, "data-refresh");
    };
    expect(at(300, "healthy").state).toBe("operational");
    expect(at(900, "degraded")).toMatchObject({
      state: "delayed",
      reasons: ["scheduler:delayed"],
      budget: { delayedAfterSec: 600, degradedAfterSec: 1200, outageAfterSec: 2400 },
    });
    expect(at(1500, "stale").state).toBe("degraded");
    expect(at(1500, "stale").summary).toContain("still served");
    expect(at(2500, "stale").state).toBe("outage");
  });

  it("never calls one late non-core lane a major outage", () => {
    const health = makeHealthyHealthResponse();
    health.caches = { "stablecoin-charts": cache(600 * 30) };
    health.status = "stale";
    const projection = projectPublicStatus(health);
    expect(projection.headline.state).toBe("partial-outage");
    expect(projection.headline.title).toBe("Partial outage: Historical charts");
    expect(headlineToStatusLevel(projection.headline.state)).toBe("stale");
  });

  it("treats a stale-but-served cache as degraded, not an outage", () => {
    const health = makeHealthyHealthResponse();
    health.caches = { stablecoins: cache(600 * 13) };
    health.status = "stale";
    expect(component(health, "stablecoin-data")).toMatchObject({ state: "degraded", reasons: ["cache:stablecoins:stale"] });
    expect(projectPublicStatus(health).headline.state).toBe("degraded");
  });

  it("declares a major outage when the database sentinel fails", () => {
    const health = makeHealthyHealthResponse();
    health.status = "stale";
    health.warnings = ["db-unhealthy"];
    const projection = projectPublicStatus(health);
    expect(projection.headline.state).toBe("major-outage");
    expect(projection.components.every((item) => item.state === "outage")).toBe(true);
  });

  it("names unreadable evidence instead of reporting it operational (R2)", () => {
    const health = makeHealthyHealthResponse();
    health.blacklist = { ...health.blacklist, missingRatio: null, unavailableReason: "blacklist-read-failed" };
    health.circuits = null;
    expect(component(health, "blacklist")).toMatchObject({ state: "degraded", reasons: ["blacklist-read-failed"] });
    expect(component(health, "data-refresh").reasons).toContain("circuits-unavailable:unknown");
  });

  it("bounds and sorts circuit source identity and retains unavailable subreasons", () => {
    const health = makeHealthyHealthResponse();
    const open = { state: "open" as const, consecutiveFailures: 3, lastFailureAt: NOW,
      lastSuccessAt: null, openedAt: NOW };
    health.circuits = Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`source-${String(i).padStart(2, "0")}`, open]));
    const reason = component(health, "data-refresh").reasons[0];
    expect(reason).toBe(`upstream-circuits-open:20:${Array.from({ length: 12 }, (_, i) => `source-${String(i).padStart(2, "0")}`).join(",")}`);
    health.schedulerLiveness = { ...health.schedulerLiveness!, status: "unavailable",
      ageSeconds: null, unavailableReason: "slot-start-query-failed" };
    expect(component(health, "data-refresh").reasons).toContain("scheduler:unavailable:slot-start-query-failed");
  });

  it("counts open circuits per upstream provider before the public quorum", () => {
    const health = makeHealthyHealthResponse();
    const open = { state: "open" as const, consecutiveFailures: 3, lastFailureAt: NOW, lastSuccessAt: null, openedAt: NOW };
    health.circuits = { "dexscreener-prices": open, "dexscreener-prices-refresh": open, "coingecko-prices": open };
    expect(countPublicImpactOpenCircuits(health.circuits)).toBe(2);
    expect(component(health, "data-refresh").state).toBe("operational");
    health.circuits["defillama-coins"] = open;
    expect(component(health, "data-refresh")).toMatchObject({
      state: "degraded",
      reasons: ["upstream-circuits-open:3:coingecko-prices,defillama-coins,dexscreener-prices,dexscreener-prices-refresh"],
    });
  });

  it("does not let operational listing and price notices explain a degraded raw verdict", () => {
    const health = assetScopedHealth();
    health.status = "degraded";
    health.mintBurn.sync.warning = null;
    const projection = projectPublicStatus(health);
    expect(projection.components.find(({ id }) => id === "stablecoin-data")).toMatchObject({
      state: "operational",
      reasons: ["publication-incomplete:asset-scoped", "price-coverage-incomplete:asset-scoped"],
    });
    expect(projection.components.find(({ id }) => id === "website-api")).toMatchObject({
      state: "degraded", reasons: ["unattributed-public-health:degraded"],
    });
  });

  it("surfaces a non-healthy raw verdict even when no component explains it", () => {
    const health = makeHealthyHealthResponse();
    health.status = "degraded";
    expect(component(health, "website-api")).toMatchObject({
      state: "degraded", reasons: ["unattributed-public-health:degraded"],
    });
    expect(projectPublicStatus(health).headline.state).toBe("degraded");
  });

  it.each(["d1-capacity-future-clock", "d1-capacity-missing", "d1-capacity-query-failed"])(
    "keeps the %s evidence-plane fault a named unknown-capacity notice, never orange", (warning) => {
      const health = makeHealthyHealthResponse();
      health.warnings = [warning];
      expect(component(health, "website-api")).toMatchObject({
        state: "operational", reasons: [warning], summary: expect.stringContaining("capacity is unknown"),
      });
      expect(projectPublicStatus(health).headline).toMatchObject({ state: "operational", affected: ["website-api"] });
    },
  );

  it("keeps unknown cache quality a notice while the age bands still grade real staleness", () => {
    const health = makeHealthyHealthResponse();
    health.caches = { "dex-liquidity": { ...cache(60, 3600), healthy: false, degraded: null, degradedReason: "producer-history-unreadable" } };
    expect(component(health, "liquidity")).toMatchObject({
      state: "operational", reasons: ["cache:dex-liquidity:quality-unknown"], summary: expect.stringContaining("unknown"),
    });
    health.caches["dex-liquidity"] = { ...health.caches["dex-liquidity"], ageSeconds: 3600 * 13 };
    expect(component(health, "liquidity")).toMatchObject({
      state: "degraded", reasons: expect.arrayContaining(["cache:dex-liquidity:stale", "cache:dex-liquidity:quality-unknown"]),
    });
  });

  it("publishes a change only after two agreeing evaluations, bypassing on outage", () => {
    const late = makeHealthyHealthResponse();
    late.caches = { "stablecoin-charts": cache(3600 * 9, 3600) };
    const raw = projectPublicStatus(late);
    const published = new Map(projectPublicStatus(makeHealthyHealthResponse()).components
      .map((item) => [item.id, { ...item, pending: null }]));
    const first = applyPublicStatusHysteresis(raw, published, NOW);
    expect(first.projection.components.find((item) => item.id === "charts")!.state).toBe("operational");
    expect(first.pending.charts).toEqual({ state: "delayed", count: 1, firstSeenAt: NOW });
    const withPending = new Map(first.projection.components.map((item) => [item.id, { ...item, pending: first.pending[item.id] ?? null }]));
    const second = applyPublicStatusHysteresis(raw, withPending, NOW + 900);
    expect(second.projection.components.find((item) => item.id === "charts")).toMatchObject({ state: "delayed", since: NOW });
    expect(second.projection.headline.state).toBe("delayed");

    late.caches = { "stablecoin-charts": cache(3600 * 25, 3600) };
    const outage = applyPublicStatusHysteresis(projectPublicStatus(late), published, NOW);
    expect(outage.projection.components.find((item) => item.id === "charts")).toMatchObject({ state: "outage", since: NOW });
  });

  it("holds unconfirmed read-time worsening but clears a read-time recovery at once", () => {
    const healthy = projectPublicStatus(makeHealthyHealthResponse());
    const late = makeHealthyHealthResponse();
    late.caches = { "stablecoin-charts": cache(3600 * 9, 3600) };
    const delayed = projectPublicStatus(late);
    // Snapshot published operational and its own inputs agreed: a read-time crossing is held.
    expect(holdPublicStatusAtReadTime(delayed, healthy.components, healthy).headline.state).toBe("operational");
    // Snapshot published delayed from its inputs; a producer published since: clear now.
    expect(holdPublicStatusAtReadTime(healthy, delayed.components, delayed).headline.state).toBe("operational");
    // Snapshot still confirming a clear (raw already operational): keep the published state.
    expect(holdPublicStatusAtReadTime(healthy, delayed.components, healthy).headline.state).toBe("delayed");
  });

  it("keeps a D1 watch capacity state operational, matching the worker verdict", () => {
    const health = makeHealthyHealthResponse();
    health.warnings = ["d1-capacity-watch"];
    expect(projectPublicStatus(health).headline.state).toBe("operational");
    health.warnings = ["d1-capacity-warning"];
    expect(component(health, "website-api")).toMatchObject({ state: "degraded", reasons: ["d1-capacity-warning"] });
  });

  it("keeps a partial mint/burn run inside budget a notice, never public orange", () => {
    const health = makeHealthyHealthResponse();
    health.mintBurn = {
      ...health.mintBurn,
      sync: {
        lastSuccessfulSyncAt: health.timestamp - 4_000,
        freshnessStatus: "degraded",
        criticalLaneHealthy: true,
        warning: "Critical mint/burn lane is running in degraded mode; coverage may be partial.",
      },
    };
    expect(component(health, "mint-burn")).toMatchObject({ state: "operational", reasons: ["mint-burn-run-degraded"] });
    health.mintBurn.sync.lastSuccessfulSyncAt = health.timestamp - 6_000;
    expect(component(health, "mint-burn")).toMatchObject({ state: "delayed", reasons: ["mint-burn-sync:delayed", "mint-burn-run-degraded"] });
  });

  it("carries since forward only while the state is unchanged", () => {
    const health = makeHealthyHealthResponse();
    health.caches = { "dex-liquidity": cache(600 * 9) };
    const same = projectPublicStatus(health, { liquidity: { state: "delayed", since: NOW - 120 } });
    expect(same.components.find((item) => item.id === "liquidity")!.since).toBe(NOW - 120);
    const changed = projectPublicStatus(health, { liquidity: { state: "degraded", since: NOW - 120 } });
    expect(changed.components.find((item) => item.id === "liquidity")!.since).toBeNull();
  });

  it("orders the headline worst first and keeps delayed-only days calm", () => {
    expect(buildPublicHeadline([
      { id: "yield", state: "delayed" },
      { id: "charts", state: "delayed" },
    ])).toMatchObject({ state: "delayed", title: "Updates delayed: Historical charts, Yield" });
    expect(buildPublicHeadline([
      { id: "yield", state: "delayed" },
      { id: "mint-burn", state: "degraded" },
    ])).toMatchObject({ state: "degraded", affected: ["mint-burn", "yield"] });
  });
});
