import type { FxReferenceObservation } from "../types/fx-reference";
import type { AdmittedDeviationBps, RawDeviationBps, ReferenceAdmission, ReferenceContributor } from "../types/reference-admission";
import { DEPEG_PRIMARY_PRICE_MAX_AGE_SEC, DEPEG_SEVERITY_BPS, PAR_ROUNDOFF_BPS, REFERENCE_CLOSURE_HOLD_BANDS_BPS } from "./depeg-config";
import { MIN_PEER_MEDIAN_CONTRIBUTORS } from "./peg-reference-trust";
import { getPegTaxonomyByType, PEG_TAXONOMY } from "./peg-taxonomy";
import { getReferenceMarket, getReferenceSessionState, isTargetFixingDay, type ReferenceMarket } from "./reference-market-hours";
import { DAY_SECONDS, HOUR_SECONDS } from "./time-constants";

export const REFERENCE_ADMISSION_POLICY_VERSION = 1;
export const REFERENCE_INTRADAY_BUDGET_SEC = 6 * HOUR_SECONDS;
export const OXR_POLL_INTERVAL_SEC = HOUR_SECONDS;
export const OXR_MAX_SNAPSHOT_AGE_SEC = 2 * OXR_POLL_INTERVAL_SEC;

/**
 * Capacity sizing only: a benchmark observed within the intraday budget before its market closed is held at
 * that close until the reopen. Returns the seconds elapsed since the close, by which a sizing budget widens,
 * or null when the market is open or the benchmark is not a close mark. Never renews the observation clock
 * and never admits a deviation.
 */
export function heldCloseBenchmarkExtensionSec(market: ReferenceMarket, observedAtSec: number, nowSec: number): number | null {
  if (!Number.isSafeInteger(observedAtSec) || observedAtSec <= 0 || !Number.isSafeInteger(nowSec) || observedAtSec > nowSec) return null;
  const session = getReferenceSessionState(market, nowSec);
  if (session.open || observedAtSec > session.closureStartSec ||
    session.closureStartSec - observedAtSec > REFERENCE_INTRADAY_BUDGET_SEC) return null;
  return nowSec - session.closureStartSec;
}

// Reviewed L18 calibration (receipt: scripts/maintenance/calibrate-reference-bands.ts): nearest-rank 99.5th
// percentile of 1-, 2- and >=3-business-day fixing moves over the ten years before 2024-04-01, rounded up
// to 25 bps; markets with fewer than 2,000 moves per horizon keep the 500 bps fallback.
type FixingAgeBucket = 1 | 2 | 3;
type DailyFixingBands = Readonly<Record<FixingAgeBucket, number>>;
const FALLBACK_FIXING_BANDS: DailyFixingBands = Object.freeze({ 1: 500, 2: 500, 3: 500 });
const CALIBRATED_FIXING_BANDS: Readonly<Partial<Record<string, DailyFixingBands>>> = {
  EUR: { 1: 200, 2: 275, 3: 300 },
  GBP: { 1: 250, 2: 325, 3: 450 },
  CHF: { 1: 200, 2: 275, 3: 350 },
  BRL: { 1: 375, 2: 500, 3: 600 },
  RUB: { 1: 500, 2: 500, 3: 500 },
  JPY: { 1: 250, 2: 325, 3: 375 },
  KRW: { 1: 225, 2: 275, 3: 300 },
  IDR: { 1: 200, 2: 300, 3: 375 },
  INR: { 1: 125, 2: 175, 3: 200 },
  MYR: { 1: 200, 2: 275, 3: 300 },
  SGD: { 1: 125, 2: 175, 3: 200 },
  HKD: { 1: 25, 2: 50, 3: 50 },
  TRY: { 1: 550, 2: 825, 3: 1150 },
  AUD: { 1: 250, 2: 325, 3: 375 },
  ZAR: { 1: 350, 2: 500, 3: 550 },
  CAD: { 1: 175, 2: 250, 3: 275 },
  CNY: { 1: 125, 2: 175, 3: 175 },
  CNH: { 1: 500, 2: 500, 3: 500 },
  PHP: { 1: 125, 2: 150, 3: 200 },
  MXN: { 1: 325, 2: 450, 3: 500 },
  VND: { 1: 500, 2: 500, 3: 500 },
  UAH: { 1: 500, 2: 500, 3: 500 },
  ARS: { 1: 500, 2: 500, 3: 500 },
  KGS: { 1: 500, 2: 500, 3: 500 },
  NGN: { 1: 500, 2: 500, 3: 500 },
  XOF: { 1: 500, 2: 500, 3: 500 },
  COP: { 1: 500, 2: 500, 3: 500 },
  CLP: { 1: 500, 2: 500, 3: 500 },
  GHS: { 1: 500, 2: 500, 3: 500 },
  KES: { 1: 500, 2: 500, 3: 500 },
  PEN: { 1: 500, 2: 500, 3: 500 },
  CZK: { 1: 225, 2: 325, 3: 350 },
  PLN: { 1: 225, 2: 350, 3: 425 },
  AED: { 1: 500, 2: 500, 3: 500 },
};
export const DAILY_FIXING_MOVE_BANDS_BPS: Readonly<Partial<Record<string, DailyFixingBands>>> =
  Object.freeze(Object.fromEntries(Object.values(PEG_TAXONOMY)
    .filter((entry) => entry.pegClass === "fiat_fx")
    .map((entry) => [entry.currency, Object.freeze(CALIBRATED_FIXING_BANDS[entry.currency] ?? FALLBACK_FIXING_BANDS)])));

type DirectReference = {
  kind: "fx" | "fallback";
  observation: Omit<FxReferenceObservation, "observedAtSec"> & { observedAtSec: number | null };
  /** Same peg unit and source; both inputs refer to the closure immediately preceding this session. */
  preCloseUsdPerUnit?: number | null;
  firstInSessionObservedAtSec?: number | null;
  /** Optional source-specific freshness budget for a dated fixing. Session and pairing checks still apply. */
  dailyFixingBudgetSec?: number;
};

/** A detector verified the corroborator is a traded, independent native market. */
export interface ClosureBenchmarkEvidence {
  cohort: "near-benchmark" | "shifted" | "missing";
  nativeObservedAtSec: number;
  nativeDeviationBps: number;
  triggerBps: number;
}

export type ReferenceAdmissionInput = {
  closureBenchmark?: ClosureBenchmarkEvidence;
  quoteObservedAtSec: number | null;
  decisionAtSec: number;
  rawDeviationBps: RawDeviationBps | null;
  generation?: string | null;
  pairingToleranceSec?: number;
  purpose?: "current" | "detection";
} & (DirectReference | { kind: "median"; pegKey: string; contributors: readonly ReferenceContributor[] } | { kind: "none" });

export function getClosureBenchmarkBandBps(currency: keyof typeof REFERENCE_CLOSURE_HOLD_BANDS_BPS, durationSec: number, hasCohort: boolean): number {
  if (!hasCohort || durationSec < DAY_SECONDS) return DEPEG_SEVERITY_BPS.severe;
  return REFERENCE_CLOSURE_HOLD_BANDS_BPS[currency][durationSec >= 3 * DAY_SECONDS ? "extended" : "weekend"];
}

function observationClock(sec: number | null, decisionAtSec: number): number | null {
  return sec != null && Number.isSafeInteger(sec) && sec > 0 && sec <= decisionAtSec ? sec : null;
}

function oldestContributorClock(contributors: readonly ReferenceContributor[], decisionAtSec: number): number | null {
  let oldest: number | null = null;
  for (const contributor of contributors) {
    const clock = observationClock(contributor.observedAtSec, decisionAtSec);
    if (clock === null) return null;
    oldest = oldest === null ? clock : Math.min(oldest, clock);
  }
  return oldest;
}

function hasClosureQuorum(contributors: readonly ReferenceContributor[], closureStartSec: number): boolean {
  const sources = new Set<string>();
  for (const { derivation, observedAtSec, provenanceKey } of contributors) {
    if (derivation === "traded-market" && observedAtSec !== null && observedAtSec >= closureStartSec && provenanceKey.trim()) {
      sources.add(provenanceKey.trim());
    }
  }
  return sources.size >= MIN_PEER_MEDIAN_CONTRIBUTORS;
}

export function isClosureBullionContributor(row: ReferenceContributor): boolean {
  return !!row.assetId && !!row.provenanceKey.trim() &&
    (row.observedAtMode === "upstream" || (row.observedAtMode === undefined && row.derivation === "traded-market")) &&
    (row.derivation === "traded-market" || row.derivation === "spot-derived");
}

function fixingAgeBucket(observedAtSec: number, decisionAtSec: number, businessDaily: boolean): FixingAgeBucket {
  const observedDay = Math.floor(observedAtSec / DAY_SECONDS);
  const decisionDay = Math.floor(decisionAtSec / DAY_SECONDS);
  let days = 0;
  for (let day = observedDay + 1; day <= decisionDay && days < 3; day++) {
    const sec = day * DAY_SECONDS;
    const weekday = new Date(sec * 1000).getUTCDay();
    if (businessDaily ? isTargetFixingDay(sec) : weekday !== 0 && weekday !== 6) days++;
  }
  return days < 2 ? 1 : days === 2 ? 2 : 3;
}

function hasRepriced(input: DirectReference, openedAtSec: number, observedAtSec: number): boolean {
  const { preCloseUsdPerUnit, firstInSessionObservedAtSec } = input;
  return (preCloseUsdPerUnit != null && Number.isFinite(preCloseUsdPerUnit) && preCloseUsdPerUnit > 0
      && input.observation.usdPerUnit !== preCloseUsdPerUnit)
    || (firstInSessionObservedAtSec != null && Number.isSafeInteger(firstInSessionObservedAtSec)
      && firstInSessionObservedAtSec >= openedAtSec && observedAtSec - firstInSessionObservedAtSec >= HOUR_SECONDS);
}

function validDirectReference(input: DirectReference, decisionAtSec: number): boolean {
  const { source, cadence, usdPerUnit, publishedAtSec, observedAtSec } = input.observation;
  if (!Number.isFinite(usdPerUnit) || usdPerUnit <= 0 || source === "peer-median") return false;
  if (publishedAtSec !== undefined && (observationClock(publishedAtSec, decisionAtSec) === null
    || (observedAtSec !== null && publishedAtSec < observedAtSec))) return false;
  if (source === "frankfurter") return cadence === "business-daily";
  if (source === "fawazahmed0" || source === "exchangeRateApi") return cadence === "calendar-daily";
  return cadence === "intraday";
}

/** Evaluate the clocks of the actual numerator and denominator against the decision's session. */
export function evaluateReferenceAdmission(input: ReferenceAdmissionInput): ReferenceAdmission {
  const { kind, decisionAtSec } = input;
  if (!Number.isSafeInteger(decisionAtSec) || decisionAtSec <= 0 || !Number.isFinite(new Date(decisionAtSec * 1000).getTime())) {
    throw new RangeError("decisionAtSec must be a positive, representable Unix second");
  }
  const observation = kind === "fx" || kind === "fallback" ? input.observation : null;
  const peg = getPegTaxonomyByType(kind === "median" ? input.pegKey : observation?.pegKey);
  const market = getReferenceMarket(peg?.currency);
  const session = market === null ? null : getReferenceSessionState(market, decisionAtSec);
  const cadence = kind === "median" ? "intraday" : observation?.cadence ?? null;
  const source = kind === "median" ? "peer-median" : observation?.source ?? null;
  const daily = cadence === "business-daily" || cadence === "calendar-daily";
  // OR-1b covers multi-day outages within the same FX session. A closed market has no
  // current session and can only use a daily fixing for a clocked severe detection exception.
  const fixingHorizonSec = session?.open ? decisionAtSec - session.sessionOpenedAtSec : DAY_SECONDS;
  const ageBudget = daily && (kind === "fx" || kind === "fallback")
    ? input.dailyFixingBudgetSec ?? fixingHorizonSec : REFERENCE_INTRADAY_BUDGET_SEC;
  const budgetSec = cadence !== null && Number.isSafeInteger(ageBudget) && ageBudget >= 0 ? ageBudget : null;
  // The oldest acceptable OXR snapshot can age by another poll before a replacement arrives.
  const intradayTolerance = source === "openExchangeRates" && input.purpose === "detection"
    ? OXR_MAX_SNAPSHOT_AGE_SEC + OXR_POLL_INTERVAL_SEC : 2 * HOUR_SECONDS;
  const againstClose = input.purpose === "detection" && session && !session.open && kind !== "median";
  const pairingTolerance = input.pairingToleranceSec ?? (againstClose ? decisionAtSec - session.closureStartSec + ageBudget
    : daily ? ageBudget : intradayTolerance);
  const quoteObservedAtSec = observationClock(input.quoteObservedAtSec, decisionAtSec);
  const referenceObservedAtSec = kind === "median"
    ? oldestContributorClock(input.contributors, decisionAtSec)
    : observationClock(observation?.observedAtSec ?? null, decisionAtSec);
  const evidence = {
    kind, source, cadence, referenceObservedAtSec, quoteObservedAtSec, decisionAtSec, budgetSec,
    sessionOpenedAtSec: session?.sessionOpenedAtSec ?? null,
    generation: input.generation && input.generation.trim() === input.generation ? input.generation : null,
    policyVersion: REFERENCE_ADMISSION_POLICY_VERSION,
  };
  const unavailable = (reason: Extract<ReferenceAdmission, { status: "unavailable" }>["reason"]): ReferenceAdmission =>
    ({ ...evidence, status: "unavailable", reason });
  const stale = (reason: Extract<ReferenceAdmission, { status: "stale-reference" }>["reason"], appliedBudget = budgetSec): ReferenceAdmission =>
    ({ ...evidence, status: "stale-reference", reason, budgetSec: appliedBudget });

  if (kind === "none") return unavailable("no-reference");
  if (session === null || source === null || cadence === null || budgetSec === null
    || !Number.isSafeInteger(pairingTolerance) || pairingTolerance < 0) return unavailable("invalid-reference");
  if (kind !== "median" && (!validDirectReference(input, decisionAtSec)
    || (kind === "fallback" && (market !== "metal" || daily))
    || (source === "gold-api.com" && market !== "metal"))) return unavailable("invalid-reference");
  if (kind === "median" && input.contributors.length < MIN_PEER_MEDIAN_CONTRIBUTORS) return unavailable("insufficient-contributors");
  if (referenceObservedAtSec === null) return unavailable("reference-clock-unavailable");
  if (quoteObservedAtSec === null) return unavailable("quote-clock-unavailable");

  if (Math.abs(quoteObservedAtSec - referenceObservedAtSec) > pairingTolerance) return stale("quote-reference-unpaired", pairingTolerance);
  if (cadence === "business-daily" && !isTargetFixingDay(referenceObservedAtSec)) return stale("daily-fixing-only");

  const admit = (reason: Extract<ReferenceAdmission, { status: "admitted" }>["reason"]): ReferenceAdmission =>
    ({ ...evidence, status: "admitted", reason, kind, source, cadence, referenceObservedAtSec, quoteObservedAtSec, budgetSec });
  const absMove = input.rawDeviationBps !== null && Number.isFinite(input.rawDeviationBps) ? Math.abs(input.rawDeviationBps) : null;
  const quoteOverBudget = decisionAtSec - quoteObservedAtSec > REFERENCE_INTRADAY_BUDGET_SEC;
  const quoteBudgetRejection = (input.purpose !== "detection" || daily) && quoteOverBudget
    ? stale("quote-over-budget", REFERENCE_INTRADAY_BUDGET_SEC) : null;
  if (!session.open) {
    const severeMove = absMove != null && absMove >= DEPEG_SEVERITY_BPS.severe - PAR_ROUNDOFF_BPS;
    const closureQuote = quoteObservedAtSec >= session.closureStartSec && !quoteOverBudget;
    const eligibleClose = referenceObservedAtSec <= session.closureStartSec && session.closureStartSec - referenceObservedAtSec <= budgetSec;
    if (input.purpose === "detection" && closureQuote && severeMove) {
      if (kind !== "median" && eligibleClose) return admit("severe-deviation");
      // The severe bullion comparison can use contemporaneous prices for distinct tokens from the same venue.
      if (kind === "median" && market === "metal" && referenceObservedAtSec >= session.closureStartSec &&
        decisionAtSec - referenceObservedAtSec <= budgetSec &&
        input.contributors.every(isClosureBullionContributor) &&
        new Set(input.contributors.map((row) => row.assetId)).size === input.contributors.length) {
        return admit("severe-deviation");
      }
    }
    const corroborator = input.purpose === "detection" ? input.closureBenchmark : undefined;
    if (corroborator && peg && kind !== "median" && absMove != null) {
      const duration = session.nextOpenSec - session.closureStartSec;
      const band = getClosureBenchmarkBandBps(peg.currency, duration, corroborator.cohort !== "missing");
      const nativeAt = observationClock(corroborator.nativeObservedAtSec, decisionAtSec);
      if (corroborator.cohort !== "shifted" && eligibleClose && closureQuote &&
        nativeAt != null && nativeAt >= session.closureStartSec && decisionAtSec - nativeAt <= DEPEG_PRIMARY_PRICE_MAX_AGE_SEC &&
        Number.isFinite(corroborator.nativeDeviationBps) && Math.sign(corroborator.nativeDeviationBps) === Math.sign(input.rawDeviationBps!) &&
        corroborator.triggerBps > 0 && Math.abs(corroborator.nativeDeviationBps) >= corroborator.triggerBps && absMove >= band) {
        return admit("closure-move-above-band");
      }
    }
    // Severe moves bypass the closure hold. Neither this nor a traded median supplies a missing clock.
    const severe = input.purpose !== "detection" && severeMove;
    if (!severe && (kind !== "median" || quoteObservedAtSec < session.closureStartSec
      || !hasClosureQuorum(input.contributors, session.closureStartSec))) {
      return { ...evidence, status: "held-closed-session", reason: "reference-market-closed" };
    }
    if (daily && input.purpose !== "detection") return stale("daily-fixing-only");
    if (decisionAtSec - referenceObservedAtSec > budgetSec) return stale("reference-over-budget");
    return quoteBudgetRejection ?? admit(severe ? "severe-deviation" : "closed-session-traded-median");
  }

  if (quoteObservedAtSec < session.sessionOpenedAtSec) return stale("quote-before-reopen");
  if (daily && input.purpose !== "detection") return stale("daily-fixing-only");
  if (referenceObservedAtSec <= session.sessionOpenedAtSec) return stale("reference-before-reopen");
  if (decisionAtSec - referenceObservedAtSec > budgetSec) return stale("reference-over-budget");
  if (daily) {
    const age = fixingAgeBucket(referenceObservedAtSec, decisionAtSec, cadence === "business-daily");
    const band = peg && DAILY_FIXING_MOVE_BANDS_BPS[peg.currency]?.[age];
    if (band === undefined || absMove === null || absMove <= band) return stale("daily-fixing-only");
  }
  if (quoteBudgetRejection) return quoteBudgetRejection;
  if (kind !== "median" && !hasRepriced(input, session.sessionOpenedAtSec, referenceObservedAtSec)) {
    return stale("reference-not-repriced");
  }
  return admit(daily ? "daily-fixing-above-band" : "live-reference");
}

/** Reuse a published current comparison only while both observations and its session are still valid. */
export function currentAdmissionUnavailableReason(
  admission: Extract<ReferenceAdmission, { status: "admitted" }>,
  pegCurrency: string, quoteObservedAtSec: number | null | undefined, now: number,
): ReferenceAdmission["reason"] | null {
  if (quoteObservedAtSec !== admission.quoteObservedAtSec || admission.decisionAtSec > now) return "quote-clock-unavailable";
  const market = getReferenceMarket(pegCurrency);
  if (!market || admission.reason === "closure-move-above-band" || admission.reason === "daily-fixing-above-band") return "invalid-reference";
  const previous = getReferenceSessionState(market, admission.decisionAtSec);
  const current = getReferenceSessionState(market, now);
  if (current.open !== previous.open || current.sessionOpenedAtSec !== previous.sessionOpenedAtSec ||
      current.closureStartSec !== previous.closureStartSec) {
    return current.open ? "quote-before-reopen" : "reference-market-closed";
  }
  if (now - admission.referenceObservedAtSec > admission.budgetSec) return "reference-over-budget";
  if (now - quoteObservedAtSec > REFERENCE_INTRADAY_BUDGET_SEC) return "quote-over-budget";
  return null;
}

export function admittedDeviationBps(raw: RawDeviationBps | null, admission: ReferenceAdmission): AdmittedDeviationBps {
  return admission.status === "admitted" && raw !== null && Number.isFinite(raw) ? raw : null;
}
