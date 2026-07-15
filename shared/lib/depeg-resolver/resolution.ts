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
import { isTerminalStablecoinStatus } from "../stablecoin-lifecycle";
import type { DdrActiveEventInput, DdrCoinStructural, DdrLiveContext, DdrSupplyContext } from "./inputs";
import { depthBucket } from "./strata";

const RISKY_MINT_PATHS = new Set([
  "issuer-direct-mint",
  "offchain-attested-minter",
  "bridge-or-oft-synthetic",
  "amo-or-custodian-hybrid",
  "facilitator-bucket-mint",
]);
const RISKY_POSTURES = new Set(["concentrated-admin", "unbounded-or-compromised"]);
const SEVERE_VERY_HIGH_RISK_RESERVE_PCT = 30;
const ELEVATED_HIGH_RISK_RESERVE_PCT = 40;
const HARD_COLLATERAL_RESERVE_PCT = 80;
const DAY_SEC = 86400;
const RECENT_MINT_INCIDENT_WINDOW_SEC = 60 * DAY_SEC;

export const DDR_INSUFFICIENT_MINT_AUTHORITY_REASON = "No reviewed mint authority";
export const DDR_INSUFFICIENT_SUPPLY_HISTORY_REASON = "No usable supply history for this coin";
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

function parseMintIncidentDateSec(date: string): number | null {
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
  return (coin.mintIncidentDates ?? []).some((date) => {
    const incidentAt = parseMintIncidentDateSec(date);
    if (incidentAt == null || incidentAt > asOfSec) return false;
    return Math.abs(incidentAt - active.startedAt) <= RECENT_MINT_INCIDENT_WINDOW_SEC;
  });
}

function killSignals(
  active: DdrActiveEventInput,
  coin: DdrCoinStructural,
  supply: DdrSupplyContext,
  live: DdrLiveContext,
  asOfSec: number,
): RawFactor[] {
  const out: RawFactor[] = [];
  const below = active.direction === "below";
  const depth = depthBucket(active.peakDeviationBps);
  const deep = depth === "severe" || depth === "catastrophic";
  const riskyMinter =
    (coin.authorityPosture != null && RISKY_POSTURES.has(coin.authorityPosture)) ||
    (coin.mintPath != null && RISKY_MINT_PATHS.has(coin.mintPath));
  const supplyExpanding = supply.mintSurge === true || (supply.change7dPct != null && supply.change7dPct > 20);
  const recentMintIncident = hasRecentMintIncident(active, coin, asOfSec);

  // K1 — supply weaponization (below-peg only)
  if (below && riskyMinter && (supplyExpanding || recentMintIncident)) {
    const sev =
      (coin.authorityPosture === "unbounded-or-compromised" && supply.mintSurge === true) ||
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
  const veryHighReserveConcentration = veryHigh >= SEVERE_VERY_HIGH_RISK_RESERVE_PCT;
  const severeReserveImpairment = below && deep && veryHighReserveConcentration;
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
    coin.collateralQuality === "exotic" ||
    highish >= ELEVATED_HIGH_RISK_RESERVE_PCT ||
    veryHighReserveConcentration
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
  if ((liq != null && liq < 20 && live.tvlChange7d != null && live.tvlChange7d < -40) || (rcr != null && rcr < 0.005)) {
    out.push({
      code: "K5_exit_collapse",
      kind: "kill",
      severity: "severe",
      label: "Exit liquidity collapsing with no redemption path",
    });
  } else if ((liq != null && liq < 30) || live.bankRun === true || (rcr != null && rcr < 0.02)) {
    out.push({
      code: "K5_exit_collapse",
      kind: "kill",
      severity: "elevated",
      label: live.bankRun === true ? "Sustained one-sided outflow (bank-run signal)" : "Thin exit liquidity",
    });
  }

  return out;
}

function recoveryAnchors(coin: DdrCoinStructural, supply: DdrSupplyContext, live: DdrLiveContext): RawFactor[] {
  const out: RawFactor[] = [];

  // R1 — non-inflatable supply
  if (coin.authorityPosture === "none-resolved" || coin.mintPath === "immutable-user-collateralized") {
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
  }

  // R2 — hard collateral + redemption
  const veryLow = sumReserveRisk(coin, ["very-low", "low"]);
  const rcr = live.redemptionCapacityRatio;
  const hardCollateral = coin.collateralQuality === "native" || veryLow >= HARD_COLLATERAL_RESERVE_PCT;
  const liveRedemptionRoute = rcr != null && rcr >= 0.1 && live.redemptionRouteFamily != null;
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
  // These numeric thresholds are V8-only. Non-V8 or unverified score context
  // is retained as provenance, but cannot unlock a recovery anchor.
  if (live.safetyContext?.status === "v8-identified" && live.safetyScore != null && live.safetyScore >= 85) {
    out.push({
      code: "R5_proven_meanreversion",
      kind: "anchor",
      severity: "strong",
      label: "Strong safety/peg track record",
    });
  } else if (live.safetyContext?.status === "v8-identified" && live.safetyScore != null && live.safetyScore >= 70) {
    out.push({
      code: "R5_proven_meanreversion",
      kind: "anchor",
      severity: "weak",
      label: "Decent safety/peg track record",
    });
  }

  return out;
}

export function resolveOutlook(
  active: DdrActiveEventInput,
  coin: DdrCoinStructural,
  supply: DdrSupplyContext,
  live: DdrLiveContext,
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

  if (frozenTerminal) {
    // A terminal coin is recovery_unlikely irrespective of break direction;
    // an overpeg on a frozen/wound-down issuer is not a recovery signal.
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
