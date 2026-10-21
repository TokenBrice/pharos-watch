import { CACHE_AVAILABILITY_MAX_AGE_SEC, API_FRESHNESS_MAX_AGE_SEC } from "./api-freshness";
import { getCacheFreshnessRatio, getCacheImpactStatus } from "./cache-health";
import { PUBLIC_COMPONENT_LABEL } from "./classification/operational-status";
import {
  countPublicImpactOpenCircuits,
  getCircuitImpactStatus,
  getPublicMintBurnStatus,
  isPublicImpactCircuitKey,
  MINT_BURN_PUBLIC_FRESHNESS_DEGRADED_RATIO,
  PUBLIC_COMPONENT_OUTAGE_GRACE_MULTIPLIER,
} from "./public-health";
import { formatRelativeAgeSeconds } from "./relative-time";
import {
  getActivePriceCoverageBreadthStatus,
  getBlacklistGapStatus,
  getCacheRatioThresholds,
  getStablecoinPublicationImpactStatus,
} from "./status-thresholds";
import {
  PUBLIC_COMPONENT_STATES,
  PUBLIC_STATUS_COMPONENT_IDS,
  type HealthResponse,
  type PublicComponentBudget,
  type PublicComponentState,
  type PublicStatusComponent,
  type PublicStatusComponentId,
  type PublicStatusHeadline,
  type PublicStatusTransitionComponent,
} from "../types/status";

/**
 * Public status projection (ADR-32: one authority). Maps the public health
 * inputs onto reader-facing components and derives the headline from those
 * components instead of from the worst raw input:
 *
 * - age-graded inputs (cache ages, scheduler delivery, mint/burn sync) are
 *   `delayed` past their first band, `degraded` past their stale band, and an
 *   `outage` only once the age reaches PUBLIC_COMPONENT_OUTAGE_GRACE_MULTIPLIER
 *   times the stale band (the stale state has persisted for a further full
 *   budget). Every age verdict carries its budget (R3).
 * - quality and coverage inputs are `degraded` at most: the data is served,
 *   some of it is incomplete.
 * - unreadable evidence is `degraded` with a named reason, never operational (R2).
 * - a failed database sentinel is the only outage that needs no grace.
 */

const PUBLIC_CORE_COMPONENT_IDS: readonly PublicStatusComponentId[] = ["website-api", "stablecoin-data"];

/**
 * Every cache lane in the availability registry belongs to exactly one
 * component; `public-status-components.test.ts` iterates the registry.
 */
export const PUBLIC_CACHE_COMPONENT: Readonly<Record<string, PublicStatusComponentId>> = {
  stablecoins: "stablecoin-data",
  "fx-rates": "stablecoin-data",
  "usds-status": "stablecoin-data",
  "stablecoin-charts": "charts",
  dews: "risk-signals",
  "bluechip-ratings": "risk-signals",
  "dex-liquidity": "liquidity",
  "yield-data": "yield",
};

/** Plain-language consequence per cache lane, used when that lane leads its component. */
const CACHE_IMPACT_SUMMARY: Readonly<Record<string, string>> = {
  stablecoins: "Market caps, rankings and listings",
  "fx-rates": "Non-USD peg conversions",
  "usds-status": "USDS status and reserve context",
  "stablecoin-charts": "Historical supply and price charts",
  dews: "Depeg early-warning and stress signals",
  "bluechip-ratings": "Third-party safety ratings",
  "dex-liquidity": "DEX liquidity scores and pool data",
  "yield-data": "Yield rankings and yield history",
};

const STATE_RANK: Record<PublicComponentState, number> = Object.fromEntries(
  PUBLIC_COMPONENT_STATES.map((state, index) => [state, index]),
) as Record<PublicComponentState, number>;

export function getPublicComponentStateRank(state: PublicComponentState): number {
  return STATE_RANK[state];
}

interface ComponentFinding {
  state: PublicComponentState;
  summary: string;
  reason: string;
  ageSeconds?: number | null;
  budget?: PublicComponentBudget | null;
}

function formatSpan(seconds: number): string {
  return formatRelativeAgeSeconds(seconds, { suffix: "", unitStyle: "short", invalidFallback: "unknown" });
}

function buildBudget(delayedAfterSec: number, degradedAfterSec: number): PublicComponentBudget {
  return {
    delayedAfterSec,
    degradedAfterSec,
    outageAfterSec: degradedAfterSec * PUBLIC_COMPONENT_OUTAGE_GRACE_MULTIPLIER,
  };
}

/** Grade an age against named bands; `subject` is the plain-language thing that went quiet. */
function gradeAge(
  subject: string,
  ageSeconds: number,
  budget: PublicComponentBudget,
  reasonPrefix: string,
): ComponentFinding | null {
  if (ageSeconds <= budget.delayedAfterSec) return null;
  const age = formatSpan(ageSeconds);
  if (ageSeconds > budget.outageAfterSec) {
    return {
      state: "outage",
      summary: `${subject} last updated ${age} ago. Outage declared after ${formatSpan(budget.outageAfterSec)} without an update.`,
      reason: `${reasonPrefix}:outage`,
      ageSeconds,
      budget,
    };
  }
  if (ageSeconds > budget.degradedAfterSec) {
    return {
      state: "degraded",
      summary: `${subject} last updated ${age} ago, past the ${formatSpan(budget.degradedAfterSec)} limit. The last good data is still served.`,
      reason: `${reasonPrefix}:stale`,
      ageSeconds,
      budget,
    };
  }
  return {
    state: "delayed",
    summary: `${subject} last updated ${age} ago, later than the usual ${formatSpan(budget.delayedAfterSec)}. The last good data is still served.`,
    reason: `${reasonPrefix}:delayed`,
    ageSeconds,
    budget,
  };
}

function cacheFindings(key: string, cache: HealthResponse["caches"][string]): ComponentFinding[] {
  const subject = CACHE_IMPACT_SUMMARY[key] ?? `The ${key} data`;
  const findings: ComponentFinding[] = [];
  const ratio = getCacheFreshnessRatio(cache);
  if (ratio == null || cache.ageSeconds == null) {
    findings.push({
      state: "degraded",
      summary: `${subject}: update time is unavailable, so freshness cannot be confirmed.`,
      reason: `cache:${key}:age-unavailable`,
    });
  } else {
    const thresholds = getCacheRatioThresholds(key);
    const graded = gradeAge(
      subject,
      cache.ageSeconds,
      buildBudget(cache.maxAge * thresholds.degraded, cache.maxAge * thresholds.stale),
      `cache:${key}`,
    );
    if (graded) findings.push(graded);
  }
  if (cache.mode === "cached-fallback") {
    findings.push({
      state: "degraded",
      summary: `${subject} are served from a fallback copy while the primary source recovers.`,
      reason: `cache:${key}:cached-fallback`,
    });
  }
  if (cache.degraded === true) {
    findings.push({
      state: "degraded",
      summary: `${subject}: the latest update reported incomplete inputs.`,
      reason: `cache:${key}:quality:${cache.degradedReason ?? "unknown"}`,
    });
  } else if (cache.degraded === null) {
    findings.push({
      state: "degraded",
      summary: `${subject}: input quality for the latest update could not be read.`,
      reason: `cache:${key}:quality-unknown`,
    });
  }
  return findings;
}

/** The sync warning texts that only restate freshness, which the age grade already covers. */
function isMintBurnFreshnessWarning(warning: string): boolean {
  return warning.startsWith("Mint/burn sync freshness is ");
}

function hasWarning(health: HealthResponse, predicate: (warning: string) => boolean): string | undefined {
  return health.warnings.find(predicate);
}

function collectFindings(health: HealthResponse): Map<PublicStatusComponentId, ComponentFinding[]> {
  const findings = new Map<PublicStatusComponentId, ComponentFinding[]>(
    PUBLIC_STATUS_COMPONENT_IDS.map((id) => [id, []]),
  );
  const add = (id: PublicStatusComponentId, finding: ComponentFinding | null) => {
    if (finding) findings.get(id)!.push(finding);
  };

  // A failed database sentinel means reads fail everywhere: no grace applies.
  if (health.warnings.includes("db-unhealthy")) {
    for (const id of PUBLIC_STATUS_COMPONENT_IDS) {
      add(id, {
        state: "outage",
        summary: id === "website-api"
          ? "The primary database is not answering. Pages and API responses may fail."
          : "Unavailable while the primary database is not answering.",
        reason: "db-unavailable",
      });
    }
    return findings;
  }

  // `d1-capacity-watch` is informational (the worker scores it healthy); only
  // warning/critical states and unreadable capacity evidence degrade (ADR-32).
  const d1Warning = hasWarning(health, (warning) =>
    warning.startsWith("d1-capacity-") && warning !== "d1-capacity-watch" && warning !== "d1-capacity-normal");
  if (d1Warning) {
    add("website-api", {
      state: "degraded",
      summary: d1Warning === "d1-capacity-critical" || d1Warning === "d1-capacity-warning"
        ? "Database storage is close to its limit. Reads continue; some writes may be deferred."
        : "Database capacity evidence is unavailable.",
      reason: d1Warning,
    });
  }

  for (const [key, cache] of Object.entries(health.caches)) {
    // Mirror the shared cache impact floor exactly; findings only explain it.
    if (getCacheImpactStatus(cache, key) === "healthy" && cache.degraded !== true && cache.degraded !== null) continue;
    for (const finding of cacheFindings(key, cache)) add(PUBLIC_CACHE_COMPONENT[key] ?? "stablecoin-data", finding);
  }

  const publication = health.stablecoinPublication;
  const coverage = health.activePriceCoverage;
  if (publication && publication.status !== "complete") {
    const impact = getStablecoinPublicationImpactStatus(publication);
    add("stablecoin-data", {
      state: impact !== "healthy" ? "degraded" : "operational",
      summary: publication.status === "unknown"
        ? "Listing coverage cannot be verified right now."
        : `${publication.missingActiveIds.length || "Some"} tracked stablecoin${publication.missingActiveIds.length === 1 ? " is" : "s are"} missing from published listings.`,
      reason: publication.status === "unknown" ? "publication-unknown"
        : impact === "healthy" ? "publication-incomplete:asset-scoped" : "publication-incomplete",
    });
  }
  if (coverage) {
    if (coverage.status === "unknown") {
      add("stablecoin-data", {
        state: "degraded",
        summary: "Live price coverage cannot be verified right now.",
        reason: "price-coverage-unknown",
      });
    } else if (getActivePriceCoverageBreadthStatus(coverage) !== "healthy") {
      add("stablecoin-data", {
        state: "degraded",
        summary: `${coverage.missingPriceCount} of ${coverage.expectedActiveCount} tracked stablecoins have no live price.`,
        reason: "price-coverage-breadth",
      });
    } else if (coverage.status === "incomplete") {
      add("stablecoin-data", {
        state: "operational",
        summary: `${coverage.missingPriceCount ?? "Some"} tracked assets have no live price. Other listings and prices remain available.`,
        reason: "price-coverage-incomplete:asset-scoped",
      });
    }
  }

  const safety = health.safetyScorePublication;
  if (!safety || health.safetyScorePublicationUnavailableReason) {
    add("safety-scores", {
      state: "degraded",
      summary: "Safety Score publication health is unavailable, so current scores cannot be confirmed.",
      reason: health.safetyScorePublicationUnavailableReason ?? "safety-score-publication-unavailable",
    });
  } else {
    const budget = buildBudget(API_FRESHNESS_MAX_AGE_SEC.reportCards, API_FRESHNESS_MAX_AGE_SEC.reportCards);
    const ageSeconds = safety.acceptedAtSec == null ? null : Math.max(0, health.timestamp - safety.acceptedAtSec);
    if (ageSeconds == null) {
      add("safety-scores", {
        state: "degraded",
        summary: "No accepted Safety Score publication is available.",
        reason: "safety-score-publication-missing",
        budget,
      });
    } else {
      add("safety-scores", gradeAge("Safety Scores", ageSeconds, budget, "safety-score-publication"));
    }
    if (safety.status === "held") {
      // Ratings-held disclosure lives here only; rating surfaces no longer carry a notice.
      const heldSince = safety.heldSinceSec != null
        ? ` since ${new Date(safety.heldSinceSec * 1000).toISOString().slice(0, 16).replace("T", " ")} UTC`
        : "";
      add("safety-scores", {
        state: "degraded",
        summary: `Ratings are held at the last verified snapshot${heldSince} while required inputs recover. The last accepted scores are still served when available.`,
        reason: "safety-score-publication-held",
        ageSeconds,
        budget,
      });
      for (const reason of safety.reasons) {
        add("safety-scores", {
          state: "degraded",
          summary: "Safety Score publication is held while required inputs recover.",
          reason: `safety-score-publication-held:${reason.code}`,
          ageSeconds,
          budget,
        });
      }
    }
  }

  const yieldWarning = hasWarning(health, (warning) =>
    warning.startsWith("yield-safety-unrated-serving") || warning === "yield-safety-availability-unknown");
  if (yieldWarning) {
    add("yield", {
      state: "degraded",
      summary: yieldWarning === "yield-safety-availability-unknown"
        ? "Safety ratings on yield rankings cannot be verified right now."
        : "Yield rankings are served without current safety ratings.",
      reason: yieldWarning,
    });
  }

  const mintBurnSync = health.mintBurn.sync;
  const mintBurnStatus = getPublicMintBurnStatus(mintBurnSync);
  if (mintBurnStatus !== "healthy") {
    const budgetSec = API_FRESHNESS_MAX_AGE_SEC.mintBurnFlows;
    const ageSeconds = mintBurnSync.lastSuccessfulSyncAt == null
      ? null
      : Math.max(0, health.timestamp - mintBurnSync.lastSuccessfulSyncAt);
    const aged = ageSeconds == null
      ? null
      : gradeAge("Mint and burn events", ageSeconds,
        buildBudget(budgetSec, budgetSec * MINT_BURN_PUBLIC_FRESHNESS_DEGRADED_RATIO), "mint-burn-sync");
    if (aged) add("mint-burn", aged);
    if (mintBurnSync.freshnessStatus == null || mintBurnSync.criticalLaneHealthy == null || ageSeconds == null) {
      add("mint-burn", {
        state: "degraded",
        summary: "Mint and burn sync evidence is unavailable.",
        reason: health.mintBurn.unavailableReason ?? "mint-burn-evidence-unavailable",
      });
    } else if (!mintBurnSync.criticalLaneHealthy || (mintBurnSync.warning != null && !isMintBurnFreshnessWarning(mintBurnSync.warning))) {
      add("mint-burn", {
        state: "degraded",
        summary: "The latest mint and burn update was partial. Recent events may be incomplete.",
        reason: mintBurnSync.criticalLaneHealthy ? "mint-burn-run-degraded" : "mint-burn-run-failed",
      });
    }
  } else if (mintBurnSync.warning != null) {
    add("mint-burn", {
      state: "operational",
      summary: "Critical mint and burn data is fresh. The latest run reported an execution notice.",
      reason: "mint-burn-run-degraded",
    });
  }

  const blacklistStatus = getBlacklistGapStatus({ missingRatio: health.blacklist.missingRatio });
  if (blacklistStatus !== "healthy") {
    add("blacklist", {
      state: "degraded",
      summary: health.blacklist.missingRatio == null
        ? "Freeze and blacklist event totals cannot be verified right now."
        : "Some freeze and blacklist events are missing amounts, so frozen totals are incomplete.",
      reason: health.blacklist.missingRatio == null
        ? health.blacklist.unavailableReason ?? "blacklist-evidence-unavailable"
        : "blacklist-amounts-missing",
    });
  }

  const scheduler = health.schedulerLiveness;
  if (scheduler) {
    const lanes = [
      {
        subject: "Scheduled data refresh",
        ageSeconds: scheduler.ageSeconds,
        status: scheduler.status,
        warningAfterSec: scheduler.warningAfterSec,
        staleAfterSec: scheduler.staleAfterSec,
        reason: "scheduler",
        unavailableReason: scheduler.unavailableReason,
      },
      {
        subject: "Background computation",
        ageSeconds: scheduler.heavy.ageSeconds,
        status: scheduler.heavy.status,
        warningAfterSec: scheduler.heavy.warningAfterSec,
        staleAfterSec: scheduler.heavy.staleAfterSec,
        reason: "heavy-scheduler",
        unavailableReason: scheduler.heavy.unavailableReason,
      },
    ];
    for (const lane of lanes) {
      if (lane.status === "unavailable" || lane.ageSeconds == null) {
        if (lane.status === "healthy") continue;
        add("data-refresh", {
          state: "degraded",
          summary: `${lane.subject} evidence is unavailable, so delivery cannot be confirmed.`,
          reason: `${lane.reason}:unavailable:${(lane.unavailableReason ?? "unknown").slice(0, 80)}`,
        });
        continue;
      }
      add("data-refresh", gradeAge(
        lane.subject, lane.ageSeconds, buildBudget(lane.warningAfterSec, lane.staleAfterSec), lane.reason,
      ));
    }
  }

  const openCircuits = health.circuits ? countPublicImpactOpenCircuits(health.circuits) : null;
  if (getCircuitImpactStatus(openCircuits) !== "healthy") {
    const sources = Object.entries(health.circuits ?? {})
      .filter(([key, circuit]) => isPublicImpactCircuitKey(key) && circuit.state === "open")
      .map(([key]) => key).sort().slice(0, 12).map((key) => key.slice(0, 80));
    add("data-refresh", {
      state: "degraded",
      summary: openCircuits == null
        ? "Upstream source health cannot be read right now."
        : `${openCircuits} upstream data sources are paused after repeated failures. Affected data keeps its last good value.`,
      reason: openCircuits == null ? `circuits-unavailable:${health.circuitsUnavailableReason ?? "unknown"}`
        : `upstream-circuits-open:${openCircuits}:${sources.join(",")}`,
    });
  }

  return findings;
}

/** Previous persisted state per component, used to carry `since` forward. */
export type PublicComponentSinceMap = Partial<Record<PublicStatusComponentId, { state: PublicComponentState; since: number | null }>>;

export interface PublicStatusProjection {
  headline: PublicStatusHeadline;
  components: PublicStatusComponent[];
}

export function buildPublicHeadline(
  components: readonly (Pick<PublicStatusComponent, "id" | "state"> & Partial<Pick<PublicStatusComponent, "reasons">>)[],
): PublicStatusHeadline {
  const affected = components
    .filter((component) => component.state !== "operational"
      && !(component.reasons?.length && component.reasons.every((reason) =>
        reason === "publication-incomplete:asset-scoped" || reason === "price-coverage-incomplete:asset-scoped")))
    .sort((a, b) => STATE_RANK[b.state] - STATE_RANK[a.state]
      || PUBLIC_STATUS_COMPONENT_IDS.indexOf(a.id) - PUBLIC_STATUS_COMPONENT_IDS.indexOf(b.id));
  const outages = affected.filter((component) => component.state === "outage");
  const names = (items: readonly { id: PublicStatusComponentId }[]) =>
    items.map((item) => PUBLIC_COMPONENT_LABEL[item.id]).join(", ");
  const ids = affected.map((component) => component.id);

  if (outages.length >= 2 || outages.some((component) => PUBLIC_CORE_COMPONENT_IDS.includes(component.id))) {
    return { state: "major-outage", title: `Major outage: ${names(outages)}`, affected: ids };
  }
  if (outages.length === 1) {
    return { state: "partial-outage", title: `Partial outage: ${names(outages)}`, affected: ids };
  }
  const degraded = affected.filter((component) => component.state === "degraded");
  if (degraded.length > 0) {
    return { state: "degraded", title: `Degraded: ${names(degraded)}`, affected: ids };
  }
  if (affected.length > 0) {
    return { state: "delayed", title: `Updates delayed: ${names(affected)}`, affected: ids };
  }
  const notices = components.filter((component) => component.reasons?.length);
  return {
    state: "operational",
    title: notices.length > 0 ? "Systems operational with notices" : "All systems operational",
    affected: notices.map((component) => component.id),
  };
}

/**
 * Project a public health payload onto components and a headline. `previous`
 * carries persisted `since` values forward while a component keeps its state.
 */
export function projectPublicStatus(
  health: HealthResponse,
  previous: PublicComponentSinceMap = {},
): PublicStatusProjection {
  const findings = collectFindings(health);

  // R2 fail-safe: surface a raw failure only when no non-operational finding
  // explains it. Asset-scoped findings still attribute the raw verdict; their
  // service-wide severity is decided separately by buildPublicHeadline.
  const anyFinding = [...findings.values()].some((list) => list.some((finding) =>
    finding.state !== "operational"));
  if (!anyFinding && health.status !== "healthy") {
    findings.get("website-api")!.push({
      state: "degraded",
      summary: "Some public health checks are not passing.",
      reason: `unattributed-public-health:${health.status}`,
    });
  }

  const components = PUBLIC_STATUS_COMPONENT_IDS.map((id): PublicStatusComponent => {
    const list = findings.get(id)!;
    const worst = list.reduce<ComponentFinding | null>(
      (lead, finding) => (lead == null || STATE_RANK[finding.state] > STATE_RANK[lead.state] ? finding : lead),
      null,
    );
    const state = worst?.state ?? "operational";
    const prior = previous[id];
    return {
      id,
      state,
      summary: worst?.summary ?? "",
      reasons: [...new Set(list.map((finding) => finding.reason))],
      ageSeconds: worst?.ageSeconds ?? null,
      budget: worst?.budget ?? null,
      since: prior && prior.state === state ? prior.since : null,
    };
  });

  return { headline: buildPublicHeadline(components), components };
}

/** Compact per-component record persisted with public transitions (non-operational only). */
export function toPublicTransitionComponents(
  components: readonly PublicStatusComponent[],
): PublicStatusTransitionComponent[] {
  return components
    .filter((component) => component.state !== "operational")
    .map((component) => ({ id: component.id, state: component.state, reasons: component.reasons }));
}

/** Legacy three-level projection of a headline, for the `status_transitions` level columns. */
export function headlineToStatusLevel(state: PublicStatusHeadline["state"]): "healthy" | "degraded" | "stale" {
  if (state === "operational") return "healthy";
  if (state === "partial-outage" || state === "major-outage") return "stale";
  return "degraded";
}

/** The registry the cache mapping must cover (exported for the completeness test). */
export const PUBLIC_STATUS_CACHE_REGISTRY_KEYS: readonly string[] = Object.keys(CACHE_AVAILABILITY_MAX_AGE_SEC);
