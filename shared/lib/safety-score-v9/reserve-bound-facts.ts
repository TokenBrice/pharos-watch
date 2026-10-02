import type { ReserveBoundedFact, V9ReserveBoundedFact } from "../../types/reserve-bounded-facts";
import type { V9ReserveExposureFactV2 } from "../../types/safety-score-v9-facts";
import type { V9BackingSemanticPolicy } from "./backing-primitives";
import { stableJsonStringifyV1 } from "../stable-json";

export function reserveBoundScopeKey(scope: ReserveBoundedFact["scope"]): string {
  return stableJsonStringifyV1(scope.kind === "reserve-envelope" ? [scope.kind] : scope.kind === "exposure" ? [scope.kind, scope.exposureKey] : [scope.kind, scope.exposureKey, scope.instrumentId]);
}

export function reserveBoundTermDays(term: { value: number; unit: "days" | "calendar-months" }): number {
  // Maximum calendar duration over the complete Gregorian cycle, not 30 days/month.
  if (term.unit === "days") return term.value;
  const cycles = Math.floor(term.value / 4800);
  const months = term.value % 4800;
  let maximum = 0;
  for (let year = 2000; year < 2400; year++) for (let month = 0; month < 12; month++) {
    maximum = Math.max(maximum, (Date.UTC(year, month + months, 1) - Date.UTC(year, month, 1)) / 86400000);
  }
  return cycles * 146097 + maximum;
}
function maturityQuality(days: number, policy: V9BackingSemanticPolicy): number {
  let maximum = Infinity;
  let quality = policy.boundedUnknownQuality;
  for (const band of policy.reserve.maturityBands) {
    const bound = band.maxDaysInclusive ?? Infinity;
    if (days <= bound && bound <= maximum) { maximum = bound; quality = band.score; }
  }
  return quality;
}
function coherentFacts(rows: readonly V9ReserveBoundedFact[], clockSec: number): V9ReserveBoundedFact[] {
  const groups = new Map<string, V9ReserveBoundedFact[]>();
  for (const row of rows) {
    if (row.status.observationState !== "known" || row.status.evidenceRefIds.length === 0 || row.rejectionReason !== null || row.fact.asOfSec > clockSec || clockSec - row.fact.asOfSec > row.freshnessMaxAgeSec) continue;
    const key = `${row.fact.kind}:${reserveBoundScopeKey(row.fact.scope)}`;
    const group = groups.get(key) ?? [];
    group.push(row); groups.set(key, group);
  }
  return [...groups.values()].flatMap((group) => {
    const latest = Math.max(...group.map((row) => row.fact.asOfSec));
    const current = group.filter((row) => row.fact.asOfSec === latest);
    // Equal-generation disagreement is not a best-of choice.
    const payloads = new Set(current.map((row) => stableJsonStringifyV1({ ...row.fact, factKey: "", provenance: null })));
    return payloads.size === 1 ? [current[0]!] : [];
  });
}
function coverage(fact: ReserveBoundedFact): number {
  const scopeShare = fact.scope.kind === "sub-instrument" ? fact.scope.coveredShare ?? 0 : 1;
  if (fact.kind === "observed-portfolio-maturity" || fact.kind === "stressed-realization-bound") {
    return scopeShare * (fact.coveredGrossValue !== null && fact.totalGrossValue !== null ? fact.coveredGrossValue / fact.totalGrossValue : 0);
  }
  return scopeShare;
}
function observedDays(fact: Extract<ReserveBoundedFact, { kind: "observed-portfolio-maturity" }>): number | null {
  if (fact.instruments.length === 0 || fact.instruments.some((row) => row.maturityAtSec === null || row.maturityAtSec <= fact.asOfSec)) return null;
  return Math.max(fact.observedMaximumDays ?? 0, ...fact.instruments.map((row) => Math.ceil((row.maturityAtSec! - fact.asOfSec) / 86400)));
}
export function resolveV9ReserveFactorBounds(exposure: V9ReserveExposureFactV2, rows: readonly V9ReserveBoundedFact[], policy: V9BackingSemanticPolicy, clockSec: number, baseline: { liquidity: number; maturity: number }): { liquidity: number; maturity: number; evidenceRefIds: string[]; contradiction: boolean } {
  if (rows.length === 0) return { ...baseline, evidenceRefIds: [], contradiction: false };
  const facts = coherentFacts(rows, clockSec).filter((row) => row.fact.scope.kind !== "reserve-envelope" && row.fact.scope.exposureKey === exposure.exposureKey);
  const contracts = facts.filter((row) => row.fact.kind === "contractual-maturity-maximum" && row.fact.legallyBinding && row.fact.allInScope);
  const observations = facts.filter((row) => row.fact.kind === "observed-portfolio-maturity");
  const contradiction = contracts.some((contract) => observations.some((observation) => {
    if (contract.fact.kind !== "contractual-maturity-maximum" || observation.fact.kind !== "observed-portfolio-maturity") return false;
    if (reserveBoundScopeKey(contract.fact.scope) !== reserveBoundScopeKey(observation.fact.scope)) return false;
    const days = observedDays(observation.fact);
    return days !== null && days > reserveBoundTermDays(contract.fact.maximumTerm);
  }));
  const liquidity: number[] = [], maturity: number[] = [], refs: string[] = [];
  for (const row of facts) {
    const fact = row.fact, share = coverage(fact);
    if (share === 0) continue;
    let quality: number | null = null, factor: "liquidity" | "maturity" = "maturity";
    if (fact.kind === "contractual-maturity-maximum" && fact.legallyBinding && fact.allInScope && !contradiction) quality = maturityQuality(reserveBoundTermDays(fact.maximumTerm), policy);
    if (fact.kind === "observed-portfolio-maturity") {
      const days = observedDays(fact);
      if (days !== null && (exposure.maturityDaysMax === null || days > exposure.maturityDaysMax)) {
        quality = exposure.maturityDaysMax === null
          ? Math.min(maturityQuality(days, policy), policy.componentQuality[policy.reserve.boundedFacts.observedMaturityQualityLevel])
          : maturityQuality(days, policy);
      }
    }
    if (fact.kind === "maturity-applicability" && fact.allInScope) quality = 100;
    if (fact.kind === "currently-liquid-fraction") {
      factor = "liquidity";
      if (exposure.liquidityHorizon === null || exposure.liquidityHorizon === "unknown") quality = baseline.liquidity + fact.currentlyWithdrawable / fact.totalHeld * (policy.componentQuality[policy.reserve.boundedFacts.currentAvailabilityQualityLevel] - baseline.liquidity);
    }
    if (fact.kind === "stressed-realization-bound" && fact.realizationStage === "final-cash-settlement" && fact.settlementAsset === "fiat:USD") {
      factor = "liquidity";
      quality = policy.reserve.liquidityQuality[fact.elapsedTimeSec <= 86400 ? "one-day" : fact.elapsedTimeSec <= 604800 ? "seven-days" : "over-seven-days"];
    }
    if (quality === null) continue;
    // Known classification survives favorable incomplete snapshots. Adverse tenor is retained.
    if (factor === "maturity" && exposure.assetClass !== null && policy.reserve.maturityNotApplicableClasses.includes(exposure.assetClass)) continue;
    if (factor === "maturity" && exposure.maturityDaysMax !== null && quality > baseline.maturity) continue;
    if (factor === "liquidity" && exposure.liquidityHorizon !== null && exposure.liquidityHorizon !== "unknown" && quality > baseline.liquidity) continue;
    (factor === "liquidity" ? liquidity : maturity).push(baseline[factor] + share * (quality - baseline[factor]));
    refs.push(...row.status.evidenceRefIds);
  }
  // Independent positive bounds establish at least the strongest lower bound,
  // never the sum of possibly overlapping coverage. Any adverse bound still binds.
  return {
    liquidity: liquidity.some((quality) => quality < baseline.liquidity) ? Math.min(...liquidity) : Math.max(baseline.liquidity, ...liquidity),
    maturity: maturity.some((quality) => quality < baseline.maturity) ? Math.min(...maturity) : Math.max(baseline.maturity, ...maturity),
    evidenceRefIds: [...new Set(refs)].sort(),
    contradiction,
  };
}
export function evaluateV9ReserveEligibilityEnvelope(rows: readonly V9ReserveBoundedFact[], policy: V9BackingSemanticPolicy, clockSec: number): { quality: number; evidenceRefIds: string[] } | null {
  if (rows.length === 0) return null;
  const candidates = coherentFacts(rows, clockSec).filter((row) => row.fact.scope.kind === "reserve-envelope" && row.fact.kind === "eligibility-envelope");
  const results = candidates.flatMap((row) => {
    const fact = row.fact;
    if (fact.kind !== "eligibility-envelope" || !fact.legallyBinding || !fact.exhaustive) return [];
    const weights = policy.reserve.factorWeights, total = weights.assetQuality + weights.liquidity + weights.maturity;
    const allocations = fact.allocations.map((entry) => ({ ...entry, quality: (policy.reserve.assetClassQuality[entry.assetClass] * weights.assetQuality + policy.boundedUnknownQuality * weights.liquidity + (policy.reserve.maturityNotApplicableClasses.includes(entry.assetClass) ? 100 : entry.maximumTerm === null ? policy.boundedUnknownQuality : maturityQuality(reserveBoundTermDays(entry.maximumTerm), policy)) * weights.maturity) / total })).sort((a, b) => a.quality - b.quality || a.assetClass.localeCompare(b.assetClass));
    let remaining = 1 - allocations.reduce((sum, entry) => sum + entry.minShare, 0);
    let quality = allocations.reduce((sum, entry) => sum + entry.minShare * entry.quality, 0);
    for (const entry of allocations) { const share = Math.min(remaining, entry.maxShare - entry.minShare); quality += share * entry.quality; remaining -= share; }
    if (remaining > 1e-9 || remaining < -1e-9) return [];
    return [{ quality: Math.max(policy.boundedUnknownQuality, quality), evidenceRefIds: row.status.evidenceRefIds }];
  });
  return results.length ? results.reduce((worst, result) => result.quality < worst.quality ? result : worst) : null;
}
