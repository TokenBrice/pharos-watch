import { describe, expect, it } from "vitest";
import { API_FRESHNESS_MAX_AGE_SEC } from "../api-freshness";
import { makeHealthyHealthResponse } from "../../test-utils/health-fixtures";
import {
  buildPublicHeadline,
  headlineToStatusLevel,
  projectPublicStatus,
  PUBLIC_CACHE_COMPONENT,
  PUBLIC_STATUS_CACHE_REGISTRY_KEYS,
} from "../public-status-components";
import { PUBLIC_COMPONENT_LABEL } from "../classification/operational-status";
import { PUBLIC_STATUS_COMPONENT_IDS, type HealthResponse } from "../../types/status";

const NOW = 1_700_000_000;

function cache(ageSeconds: number | null, maxAge = 600): HealthResponse["caches"][string] {
  return { ageSeconds, maxAge, healthy: true };
}

function component(health: HealthResponse, id: string) {
  return projectPublicStatus(health).components.find((item) => item.id === id)!;
}

describe("public status components", () => {
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
    [30, false, "degraded", "mint-burn-run-failed"],
    [5401, true, "degraded", "mint-burn-sync:stale"],
    [10801, true, "outage", "mint-burn-sync:outage"],
  ] as const)("keeps mint/burn critical outcomes and age grace independent (%ss, healthy=%s)", (age, criticalLaneHealthy, state, reason) => {
    const health = makeHealthyHealthResponse();
    health.mintBurn.sync = { ...health.mintBurn.sync, lastSuccessfulSyncAt: NOW - age,
      freshnessStatus: age > 5400 ? "stale" : "fresh", criticalLaneHealthy };
    health.blacklist = { ...health.blacklist, missingAmounts: 200, missingRatio: 0.2 };
    expect(component(health, "mint-burn")).toMatchObject({ state, reasons: expect.arrayContaining([reason]) });
    expect(component(health, "blacklist")).toMatchObject({ state: "degraded", reasons: ["blacklist-amounts-missing"] });
  });


  it("degrades held Safety Scores with their machine reason without changing Risk signals", () => {
    const health = makeHealthyHealthResponse();
    health.safetyScorePublication = {
      ...health.safetyScorePublication!,
      status: "held",
      attemptedAtSec: NOW,
      heldSinceSec: NOW - 60,
      reasons: [{ code: "redemption-stale" }],
    };
    expect(component(health, "safety-scores")).toMatchObject({
      state: "degraded",
      reasons: ["safety-score-publication-held", "safety-score-publication-held:redemption-stale"],
      ageSeconds: 30,
    });
    expect(component(health, "risk-signals").state).toBe("operational");
    expect(projectPublicStatus(health).components.filter((item) => item.id !== "safety-scores")
      .every((item) => item.state === "operational")).toBe(true);
  });

  it("uses the accepted score clock and existing budget, with the standard outage grace", () => {
    const health = makeHealthyHealthResponse();
    const budget = API_FRESHNESS_MAX_AGE_SEC.reportCards;
    health.safetyScorePublication = { ...health.safetyScorePublication!, acceptedAtSec: NOW - budget, attemptedAtSec: NOW };
    expect(component(health, "safety-scores").state).toBe("operational");
    health.safetyScorePublication.acceptedAtSec -= 1;
    expect(component(health, "safety-scores")).toMatchObject({
      state: "degraded", reasons: ["safety-score-publication:stale"],
      budget: { delayedAfterSec: budget, degradedAfterSec: budget, outageAfterSec: budget * 2 },
    });
    health.safetyScorePublication.acceptedAtSec = NOW - budget * 2 - 1;
    expect(component(health, "safety-scores").state).toBe("outage");
  });

  it("grades publication ages at response time without renewing the assessment clock", () => {
    const health = makeHealthyHealthResponse();
    health.assessedAt = NOW;
    health.timestamp = NOW + 60;
    health.safetyScorePublication = {
      ...health.safetyScorePublication!, acceptedAtSec: NOW - API_FRESHNESS_MAX_AGE_SEC.reportCards,
    };
    expect(component(health, "safety-scores")).toMatchObject({
      state: "degraded", ageSeconds: API_FRESHNESS_MAX_AGE_SEC.reportCards + 60,
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

  it("surfaces a non-healthy raw verdict even when no component explains it", () => {
    const health = makeHealthyHealthResponse();
    health.status = "degraded";
    expect(component(health, "website-api")).toMatchObject({
      state: "degraded", reasons: ["unattributed-public-health:degraded"],
    });
  });

  it("keeps a D1 watch capacity state operational, matching the worker verdict", () => {
    const health = makeHealthyHealthResponse();
    health.warnings = ["d1-capacity-watch"];
    expect(projectPublicStatus(health).headline.state).toBe("operational");
    health.warnings = ["d1-capacity-warning"];
    expect(component(health, "website-api")).toMatchObject({ state: "degraded", reasons: ["d1-capacity-warning"] });
  });

  it("reports a degraded mint/burn run as degraded even while its sync is only delayed", () => {
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
    expect(component(health, "mint-burn")).toMatchObject({ state: "degraded", reasons: ["mint-burn-sync:delayed", "mint-burn-run-degraded"] });
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
