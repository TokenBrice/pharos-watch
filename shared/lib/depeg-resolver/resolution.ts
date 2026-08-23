/**
 * Stage 1 — Resolution Outlook (terminal vs recoverable).
 *
 * Mechanistic, transparent, and calibrated rather than fitted (the death-label
 * corpus is too small for ML; see docs/depeg-resolver.md). Combines structural
 * fragility (can supply be weaponized? can backing fail? can it be frozen?) with
 * the live depeg fingerprint (depth, supply behaviour, stress) into an ordinal
 * verdict plus the factors that drove it.
 */

import type { DdrFactor, DdrResolution, DdrResolutionTier } from "../../types/depeg-resolver";
import {
  isFragileMintPosture,
  isNoPrivilegedMintChainPosture,
  isNoPrivilegedMintPosture,
  isUnboundedMintPosture,
} from "../safety-score-v9/mint-posture";
import { isTerminalStablecoinStatus } from "../stablecoin-lifecycle";
import type {
  DdrActiveEventInput,
  DdrCoinStructural,
  DdrLiveContext,
  DdrSupplyContext,
  DdrV9ExitContext,
} from "./inputs";
import { depthBucket } from "./strata";

const RISKY_MINT_PATHS = new Set([
  "issuer-direct-mint",
  "offchain-attested-minter",
  "bridge-or-oft-synthetic",
  "amo-or-custodian-hybrid",
  "facilitator-bucket-mint",
]);
// Mint-posture set membership lives in `safety-score-v9/mint-posture`:
// K1's risky-minter leg is exactly the fragile set (so the finer curated
// `unbounded-reconciled` rung cannot silently relax a depeg verdict), and the
// severe surge rung is exactly the economically unbounded subset (a merely
// concentrated admin surges at the elevated rung instead).
const SEVERE_VERY_HIGH_RISK_RESERVE_PCT = 30;
const ELEVATED_HIGH_RISK_RESERVE_PCT = 40;
const HARD_COLLATERAL_RESERVE_PCT = 80;
const DAY_SEC = 86400;
const RECENT_MINT_INCIDENT_WINDOW_SEC = 60 * DAY_SEC;
const POST_BREAK_MINT_INCIDENT_WINDOW_SEC = 7 * DAY_SEC;
const STATIC_K2_EXEMPT_ARCHETYPES = new Set(["cdp", "synthetic-delta-neutral"]);
const K6_WIND_DOWN_SUPPLY_CHANGE_30D_PCT = -40;
const K6_WIND_DOWN_EXIT_TREND_PCT = -40;
const K6_CALM_CATASTROPHIC_DEPTH_BPS = 1_000;
const K6_CALM_CATASTROPHIC_SUPPLY_CHANGE_30D_ABS_PCT = 5;
const K6_CALM_CATASTROPHIC_VOLUME_24H_USD = 100;
const V9_EXIT_SEVERE_COMPLETION_RATIO = 0.01;
const V9_EXIT_ELEVATED_COMPLETION_RATIO = 0.05;
const V9_EXIT_R2_STRONG_COMPLETION_RATIO = 0.1;
const V9_EXIT_MIN_EXECUTABLE_USD = 100_000;

export interface DdrWindDownFingerprintContext {
  tvlChange30d?: number | null;
  volumeChange30d?: number | null;
  totalVolume24hUsd?: number | null;
}

type DdrResolutionLiveContext = DdrLiveContext & DdrWindDownFingerprintContext;

const DDR_R5_GRADE_MAPPING_VERSION = "r5-grade-v1";
const DDR_R5_GRADE_MAPPING = {
  version: DDR_R5_GRADE_MAPPING_VERSION,
  strong: ["A+", "A", "A-"],
  weak: ["B+", "B", "B-"],
} as const;
const DDR_R5_STRONG_GRADES: ReadonlySet<string> = new Set(DDR_R5_GRADE_MAPPING.strong);
const DDR_R5_WEAK_GRADES: ReadonlySet<string> = new Set(DDR_R5_GRADE_MAPPING.weak);

const DDR_K1_MAS_RISKY_BAND_MAPPING_VERSION = "mas-band-v1";
const DDR_K1_MAS_RISKY_BAND_MAPPING = {
  version: DDR_K1_MAS_RISKY_BAND_MAPPING_VERSION,
  riskyBands: ["concentrated", "exposed"],
} as const;
const DDR_K1_RISKY_MAS_BANDS: ReadonlySet<string> = new Set(DDR_K1_MAS_RISKY_BAND_MAPPING.riskyBands);

const DDR_INSUFFICIENT_MINT_AUTHORITY_REASON = "No reviewed mint authority";
const DDR_INSUFFICIENT_SUPPLY_HISTORY_REASON = "No usable supply history for this coin";
export const DDR_INSUFFICIENT_LIVE_PRICE_REASON = "No live price deviation for this event";

function sumReserveRisk(coin: DdrCoinStructural, risks: string[]): number {
  if (!coin.reserves?.length) return 0;
  return coin.reserves.filter((r) => risks.includes(r.risk)).reduce((s, r) => s + (r.pct ?? 0), 0);
}

interface RawFactor {
  code: DdrFactor["code"];
  kind: DdrFactor["kind"];
  severity: DdrFactor["severity"];
  label: string;
}

function parseRegistryDateSec(date: string): number | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const millis = Date.UTC(year, month - 1, day);
  if (!Number.isFinite(millis)) return null;
  const parsed = new Date(millis);
  if (parsed.getUTCFullYear() !== year || parsed.getUTCMonth() !== month - 1 || parsed.getUTCDate() !== day) {
    return null;
  }
  return Math.floor(millis / 1000);
}

function hasRecentMintIncident(active: DdrActiveEventInput, coin: DdrCoinStructural, asOfSec: number): boolean {
  const windowStart = active.startedAt - RECENT_MINT_INCIDENT_WINDOW_SEC;
  const windowEnd = active.startedAt + POST_BREAK_MINT_INCIDENT_WINDOW_SEC;
  return (coin.mintIncidents ?? []).some((incident) => {
    if (incident.status !== "active") return false;
    const incidentAt = parseRegistryDateSec(incident.date);
    if (incidentAt == null || incidentAt > asOfSec || incidentAt < windowStart || incidentAt > windowEnd) return false;
    if (incident.resolvedAt == null) return true;
    const resolvedAt = parseRegistryDateSec(incident.resolvedAt);
    return resolvedAt != null && resolvedAt > asOfSec;
  });
}

function announcedWindDownDate(coin: DdrCoinStructural, asOfSec: number): string | null {
  const date = coin.windDownAnnouncedAt;
  if (date == null) return null;
  const announcedAt = parseRegistryDateSec(date);
  return announcedAt != null && announcedAt <= asOfSec ? date : null;
}

function windDownFingerprintEvidence(
  active: DdrActiveEventInput,
  supply: DdrSupplyContext,
  live: DdrResolutionLiveContext,
): string | null {
  const supplyChange30d = supply.change30dPct;
  if (supplyChange30d != null && Number.isFinite(supplyChange30d)) {
    if (supplyChange30d <= K6_WIND_DOWN_SUPPLY_CHANGE_30D_PCT) {
      const collapsedExitTrends = [
        { label: "7-day DEX TVL", changePct: live.tvlChange7d },
        { label: "30-day DEX TVL", changePct: live.tvlChange30d },
        { label: "30-day DEX volume", changePct: live.volumeChange30d },
      ]
        .filter(
          (trend): trend is { label: string; changePct: number } =>
            trend.changePct != null &&
            Number.isFinite(trend.changePct) &&
            trend.changePct <= K6_WIND_DOWN_EXIT_TREND_PCT,
        )
        .sort((a, b) => a.changePct - b.changePct);
      const strongestExitCollapse = collapsedExitTrends[0];
      if (strongestExitCollapse) {
        return (
          `supply contracted ${Math.round(Math.abs(supplyChange30d))}% over 30 days ` +
          `while ${strongestExitCollapse.label} fell ${Math.round(Math.abs(strongestExitCollapse.changePct))}%`
        );
      }
    }

    const depthBps = Math.abs(active.peakDeviationBps);
    const volume24hUsd = live.totalVolume24hUsd;
    if (
      depthBps >= K6_CALM_CATASTROPHIC_DEPTH_BPS &&
      Math.abs(supplyChange30d) < K6_CALM_CATASTROPHIC_SUPPLY_CHANGE_30D_ABS_PCT &&
      volume24hUsd != null &&
      Number.isFinite(volume24hUsd) &&
      volume24hUsd >= 0 &&
      volume24hUsd <= K6_CALM_CATASTROPHIC_VOLUME_24H_USD
    ) {
      return (
        `${Math.round(depthBps)}bps break with flat 30-day supply ` +
        `and only $${Math.round(volume24hUsd)} DEX volume / 24h`
      );
    }
  }

  return null;
}

function identifiedV9Exit(live: DdrLiveContext): DdrV9ExitContext | null {
  return live.safetyContext?.status === "v9-identified" ? live.v9Exit ?? null : null;
}

function measuredV9ExitCapacity(live: DdrLiveContext): NonNullable<DdrV9ExitContext["primaryRoute"]>["capacity"] | null {
  const exit = identifiedV9Exit(live);
  const capacity = exit?.primaryRoute?.capacity;
  if (
    exit == null ||
    capacity == null ||
    exit.stressRequest == null ||
    capacity.requestedNotionalUsd !== exit.stressRequest.requestedNotionalUsd
  ) {
    return null;
  }
  return capacity;
}

function measuredV9ExitCapacitySeverity(live: DdrLiveContext): "severe" | "elevated" | null {
  const capacity = measuredV9ExitCapacity(live);
  if (capacity == null) return null;
  if (capacity.completionRatio <= V9_EXIT_SEVERE_COMPLETION_RATIO) {
    return "severe";
  }
  if (
    capacity.completionRatio < V9_EXIT_ELEVATED_COMPLETION_RATIO ||
    (capacity.executableUsd < V9_EXIT_MIN_EXECUTABLE_USD && capacity.completionRatio < 0.25)
  ) {
    return "elevated";
  }
  return null;
}

function hasMeasuredV9ExitRoute(live: DdrLiveContext): boolean {
  const exit = identifiedV9Exit(live);
  const capacity = measuredV9ExitCapacity(live);
  return (
    exit?.primaryRoute != null &&
    exit.pillarScore != null &&
    exit.pillarScore > 0 &&
    exit.primaryRoute.score > 0 &&
    capacity != null &&
    capacity.completionRatio >= V9_EXIT_R2_STRONG_COMPLETION_RATIO &&
    capacity.executableUsd >= V9_EXIT_MIN_EXECUTABLE_USD
  );
}

function killSignals(
  active: DdrActiveEventInput,
  coin: DdrCoinStructural,
  supply: DdrSupplyContext,
  live: DdrResolutionLiveContext,
  asOfSec: number,
): RawFactor[] {
  const out: RawFactor[] = [];
  const below = active.direction === "below";
  const depth = depthBucket(active.peakDeviationBps);
  const deep = depth === "severe" || depth === "catastrophic";
  const riskyMinter =
    isFragileMintPosture(coin.authorityPosture) ||
    (coin.mintPath != null && RISKY_MINT_PATHS.has(coin.mintPath)) ||
    (coin.mintAuthorityScoreBand != null && DDR_K1_RISKY_MAS_BANDS.has(coin.mintAuthorityScoreBand));
  const supplyExpanding =
    supply.mintSurge === true ||
    (supply.mintSurgeCoverage !== "mint-burn-hourly" && supply.change7dPct != null && supply.change7dPct > 20);
  const recentMintIncident = hasRecentMintIncident(active, coin, asOfSec);

  // K1 — supply weaponization (below-peg only)
  if (below && riskyMinter && (supplyExpanding || recentMintIncident)) {
    const sev =
      (isUnboundedMintPosture(coin.authorityPosture) && supply.mintSurge === true) ||
      (recentMintIncident && deep)
        ? "severe"
        : "elevated";
    const pct = supply.change7dPct != null ? ` (+${Math.round(supply.change7dPct)}% supply / 7d)` : "";
    const label =
      recentMintIncident && !supplyExpanding
        ? "Recent compromised/unbacked mint incident into the break"
        : recentMintIncident
          ? `Privileged minter expanding supply after a recent mint incident${pct}`
          : `Privileged minter expanding supply into the break${pct}`;
    out.push({ code: "K1_supply_weaponization", kind: "kill", severity: sev, label });
  }

  // K2 — backing impairment
  const veryHigh = sumReserveRisk(coin, ["very-high"]);
  const highish = sumReserveRisk(coin, ["high", "very-high"]);
  const staticReserveRiskApplies = !STATIC_K2_EXEMPT_ARCHETYPES.has(coin.mechanismArchetype ?? "");
  const veryHighReserveConcentration = veryHigh >= SEVERE_VERY_HIGH_RISK_RESERVE_PCT;
  const severeReserveImpairment = staticReserveRiskApplies && below && deep && veryHighReserveConcentration;
  if (coin.dependencyImpaired === true || severeReserveImpairment) {
    out.push({
      code: "K2_backing_impairment",
      kind: "kill",
      severity: "severe",
      label: coin.dependencyImpaired
        ? "Depends on a frozen/dead collateral asset"
        : "Very-high-risk reserves paired with a severe below-peg break",
    });
  } else if (
    staticReserveRiskApplies &&
    (coin.collateralQuality === "exotic" ||
      highish >= ELEVATED_HIGH_RISK_RESERVE_PCT ||
      veryHighReserveConcentration)
  ) {
    out.push({
      code: "K2_backing_impairment",
      kind: "kill",
      severity: "elevated",
      label: "Exotic or high-risk collateral base",
    });
  }

  // K3 — freeze / seizure
  const freezable = coin.canBeBlacklisted === true || coin.canBeBlacklisted === "inherited";
  if ((freezable && live.blacklistSurge === true) || coin.custodyModel === "institutional-sanctioned") {
    out.push({
      code: "K3_freeze_seizure",
      kind: "kill",
      severity: "severe",
      label:
        coin.custodyModel === "institutional-sanctioned"
          ? "Custody under sanction/freeze"
          : "Freeze surge while holders are blacklistable",
    });
  } else if (coin.canBeBlacklisted === "possible" && live.blacklistSurge === true) {
    out.push({
      code: "K3_freeze_seizure",
      kind: "kill",
      severity: "elevated",
      label: "Possible freeze path during a blacklist surge",
    });
  } else if (coin.custodyModel === "cex") {
    out.push({ code: "K3_freeze_seizure", kind: "kill", severity: "elevated", label: "Reserves custodied on a CEX" });
  }

  // K4 — reflexive death-spiral
  if (coin.mechanismArchetype === "algorithmic" && below && supplyExpanding) {
    const sev = deep ? "severe" : "elevated";
    out.push({
      code: "K4_reflexive_spiral",
      kind: "kill",
      severity: sev,
      label: "Algorithmic supply expands into a below-peg break",
    });
  } else if (
    coin.mechanismArchetype === "synthetic-delta-neutral" &&
    below &&
    deep &&
    supply.change7dPct != null &&
    supply.change7dPct < -10
  ) {
    out.push({
      code: "K4_reflexive_spiral",
      kind: "kill",
      severity: "elevated",
      label: "Synthetic hedge under redemption/unwind pressure",
    });
  }

  // K5 — exit collapse
  const liq = live.liquidityScore;
  const rcr = live.redemptionCapacityRatio;
  const v9Exit = identifiedV9Exit(live);
  const noViableV9Exit = v9Exit?.reasonCodes.includes("no-viable-exit-path") === true;
  const correlatedV9ExitRoutes = v9Exit?.reasonCodes.includes("correlated-exit-routes") === true;
  const v9CapacitySeverity = measuredV9ExitCapacitySeverity(live);
  const legacySevereK5 =
    (liq != null && liq < 20 && live.tvlChange7d != null && live.tvlChange7d < -40) ||
    (rcr != null && rcr < 0.005);
  const legacyElevatedK5 = (liq != null && liq < 30) || live.bankRun === true || (rcr != null && rcr < 0.02);
  if (legacySevereK5 || noViableV9Exit || v9CapacitySeverity === "severe") {
    out.push({
      code: "K5_exit_collapse",
      kind: "kill",
      severity: "severe",
      label: noViableV9Exit
        ? "V9 identifies no viable exit path"
        : v9CapacitySeverity === "severe"
          ? "Measured V9 exit capacity is effectively exhausted"
          : "Exit liquidity collapsing with no redemption path",
    });
  } else if (legacyElevatedK5 || correlatedV9ExitRoutes || v9CapacitySeverity === "elevated") {
    out.push({
      code: "K5_exit_collapse",
      kind: "kill",
      severity: "elevated",
      label: correlatedV9ExitRoutes
        ? "V9 exit routes share correlated failure modes"
        : v9CapacitySeverity === "elevated"
          ? "Measured V9 exit capacity is thin for the stress request"
          : live.bankRun === true
            ? "Sustained one-sided outflow (bank-run signal)"
            : "Thin exit liquidity",
    });
  }

  // K6 — issuer wind-down
  const windDownDate = announcedWindDownDate(coin, asOfSec);
  const fingerprintEvidence = windDownFingerprintEvidence(active, supply, live);
  if (windDownDate != null) {
    out.push({
      code: "K6_wind_down",
      kind: "kill",
      severity: "severe",
      label:
        `Issuer announced wind-down on ${windDownDate}` +
        (fingerprintEvidence != null ? `; ${fingerprintEvidence} (wind-down fingerprint)` : ""),
    });
  } else if (fingerprintEvidence != null) {
    out.push({
      code: "K6_wind_down",
      kind: "kill",
      severity: "elevated",
      label: `${fingerprintEvidence} (wind-down fingerprint)`,
    });
  }

  return out;
}

function recoveryAnchors(coin: DdrCoinStructural, supply: DdrSupplyContext, live: DdrLiveContext): RawFactor[] {
  const out: RawFactor[] = [];

  // R1 — non-inflatable supply. Three rungs, by how far the non-inflatability
  // claim reaches:
  //   strong — whole-of-chain: nothing on the mint path can print.
  //   weak   — governance-bounded user collateral: printing is constrained.
  //   weak   — mint-scoped `none-resolved-mint`: this token has no minter of its
  //            own, but the wrapped parent still does, so the claim can grow
  //            indirectly. Real evidence, not a strong structural anchor; only
  //            strong anchors move the resolution tier.
  if (isNoPrivilegedMintChainPosture(coin.authorityPosture) || coin.mintPath === "immutable-user-collateralized") {
    out.push({
      code: "R1_noninflatable_supply",
      kind: "anchor",
      severity: "strong",
      label: "Immutable user-collateralized supply (cannot be inflated)",
    });
  } else if (coin.mintPath === "user-collateralized-governed") {
    out.push({
      code: "R1_noninflatable_supply",
      kind: "anchor",
      severity: "weak",
      label: "User-collateralized supply (governance-bounded)",
    });
  } else if (isNoPrivilegedMintPosture(coin.authorityPosture)) {
    out.push({
      code: "R1_noninflatable_supply",
      kind: "anchor",
      severity: "weak",
      label: "No privileged mint authority on this token (wrapped supply can still expand)",
    });
  }

  // R2 — hard collateral + redemption
  const veryLow = sumReserveRisk(coin, ["very-low", "low"]);
  const rcr = live.redemptionCapacityRatio;
  const hardCollateral = coin.collateralQuality === "native" || veryLow >= HARD_COLLATERAL_RESERVE_PCT;
  const liveRedemptionRoute =
    (rcr != null && rcr >= 0.1 && live.redemptionRouteFamily != null) || hasMeasuredV9ExitRoute(live);
  if (hardCollateral && liveRedemptionRoute) {
    out.push({
      code: "R2_hard_collateral_redemption",
      kind: "anchor",
      severity: "strong",
      label: "Hard collateral with a working redemption path",
    });
  } else if (
    hardCollateral ||
    coin.mechanismArchetype === "cdp" ||
    coin.collateralQuality === "rwa" ||
    coin.collateralQuality === "eth-lst"
  ) {
    out.push({
      code: "R2_hard_collateral_redemption",
      kind: "anchor",
      severity: "weak",
      label: "Overcollateralized / real-asset backing",
    });
  }

  // R3 — no supply anomaly
  if (supply.covered) {
    if (supply.mintSurge === false && (supply.change7dPct == null || Math.abs(supply.change7dPct) < 10)) {
      out.push({
        code: "R3_no_supply_anomaly",
        kind: "anchor",
        severity: "strong",
        label: "No supply anomaly — market dislocation, not structural",
      });
    } else if (supply.mintSurge !== true && (supply.change7dPct == null || Math.abs(supply.change7dPct) < 20)) {
      out.push({
        code: "R3_no_supply_anomaly",
        kind: "anchor",
        severity: "weak",
        label: "Supply roughly stable around the break",
      });
    }
  }

  // R4 — no single freeze point
  if (coin.governance === "decentralized" && coin.custodyModel === "onchain" && coin.canBeBlacklisted === false) {
    out.push({
      code: "R4_no_freeze_point",
      kind: "anchor",
      severity: "strong",
      label: "Decentralized, on-chain, non-freezable",
    });
  } else if (coin.governance === "decentralized" || coin.custodyModel === "onchain") {
    out.push({
      code: "R4_no_freeze_point",
      kind: "anchor",
      severity: "weak",
      label: "Limited single-point freeze risk",
    });
  }

  // R5 — proven mean-reversion
  // Only an identified canonical V9 publication may unlock this anchor.
  const safetyGrade = live.safetyGrade;
  if (live.safetyContext?.status === "v9-identified" && safetyGrade != null && DDR_R5_STRONG_GRADES.has(safetyGrade)) {
    out.push({
      code: "R5_proven_meanreversion",
      kind: "anchor",
      severity: "strong",
      label: `Strong V9 safety grade (${safetyGrade})`,
    });
  } else if (live.safetyContext?.status === "v9-identified" && safetyGrade != null && DDR_R5_WEAK_GRADES.has(safetyGrade)) {
    out.push({
      code: "R5_proven_meanreversion",
      kind: "anchor",
      severity: "weak",
      label: `Moderate V9 safety grade (${safetyGrade})`,
    });
  }

  return out;
}

export function resolveOutlook(
  active: DdrActiveEventInput,
  coin: DdrCoinStructural,
  supply: DdrSupplyContext,
  live: DdrResolutionLiveContext,
  asOfSec = active.startedAt,
): DdrResolution {
  const insufficientReasons: string[] = [];
  const missingMintAuthority = coin.authorityPosture == null || coin.authorityPosture === "unknown";
  if (missingMintAuthority) insufficientReasons.push(DDR_INSUFFICIENT_MINT_AUTHORITY_REASON);
  if (!supply.covered) insufficientReasons.push(DDR_INSUFFICIENT_SUPPLY_HISTORY_REASON);
  if (active.currentDeviationBps == null) insufficientReasons.push(DDR_INSUFFICIENT_LIVE_PRICE_REASON);

  // Frozen/dead coin sitting in an open event is terminal context by definition.
  // Use the canonical terminal-status helper so the prediction side and the
  // review side (depeg-resolver-review/outcomes.ts) share one definition.
  const frozenTerminal = isTerminalStablecoinStatus(coin.status);

  const kills = killSignals(active, coin, supply, live, asOfSec);
  const anchors = recoveryAnchors(coin, supply, live);
  const factors: DdrFactor[] = [...kills, ...anchors];

  if (insufficientReasons.length > 0 && !frozenTerminal) {
    return { tier: "insufficient_signal", factors, insufficientReasons };
  }

  let tier: DdrResolutionTier;

  if (frozenTerminal || kills.some((kill) => kill.code === "K6_wind_down" && kill.severity === "severe")) {
    // A terminal issuer or announced token wind-down is recovery_unlikely
    // irrespective of break direction.
    tier = "recovery_unlikely";
  } else if (active.direction === "above") {
    // Overpeg: recovery is quasi-certain; only a sticky-premium signal lifts to at_risk.
    const sticky = kills.some((k) => k.code === "K5_exit_collapse");
    tier = sticky ? "at_risk" : "recovery_likely";
  } else {
    const severeKills = kills.filter((k) => k.severity === "severe").length;
    const elevatedOrWorse = kills.length;
    const strongAnchors = anchors.filter((a) => a.severity === "strong");
    const hasStrongStructuralAnchor = strongAnchors.some(
      (a) => a.code === "R1_noninflatable_supply" || a.code === "R2_hard_collateral_redemption",
    );

    if (severeKills >= 1 || (elevatedOrWorse >= 2 && !hasStrongStructuralAnchor)) {
      tier = "recovery_unlikely";
    } else if (elevatedOrWorse === 0 && strongAnchors.length >= 2 && hasStrongStructuralAnchor) {
      tier = "recovery_likely";
    } else {
      tier = "at_risk";
    }
  }

  if (frozenTerminal && !factors.some((f) => f.kind === "kill")) {
    factors.unshift({
      code: "K3_freeze_seizure",
      kind: "kill",
      severity: "severe",
      label: "Issuer frozen / wound down",
    });
  }

  return { tier, factors };
}
