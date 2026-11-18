import { DEPEG_SEVERITY_BPS } from "./depeg-config";
import { getPegTaxonomyByCurrency } from "./peg-taxonomy";
import { bucketUnixSecondsToUtcDay, easterSundayUtcDaySec } from "./time-buckets";
import { DAY_SECONDS, HOUR_SECONDS, SECONDS_PER_MINUTE } from "./time-constants";

export type ReferenceMarket = "fx" | "metal";
export type ReferenceSessionState =
  | { open: true; sessionOpenedAtSec: number; nextOpenSec: null; closureStartSec: null }
  | { open: false; sessionOpenedAtSec: null; nextOpenSec: number; closureStartSec: number };

export function getReferenceMarket(pegCurrency: string | null | undefined): ReferenceMarket | null {
  const pegClass = getPegTaxonomyByCurrency(pegCurrency ?? undefined)?.pegClass;
  return pegClass === "commodity" ? "metal" : pegClass === "fiat_fx" ? "fx" : null;
}

const newYorkHour = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/New_York", hour: "2-digit", hourCycle: "h23",
});

// GC/SI outright Globex sessions by New York daytime date. Values are ET close minutes;
// null suppresses the entire session, including the preceding evening.
// Reviewed 2026-11-18; next annual review by 2027-11-18. CME usually finalizes hours two weeks before.
// CME holiday calendar and product specs: https://www.cmegroup.com/trading-hours.html
// https://www.cmegroup.com/markets/metals/precious/gold-futures.contractSpecs.html
// 2025/26 New Year: https://www.ampfutures.com/news/new-year-holiday-trading-schedule
// 2026 Globex metals, holiday-specific customer notices (CT):
// https://iqhelp.dtn.com/martin-luther-kind-jr-holiday-hours-2026/
// https://iqhelp.dtn.com/presidents-day-holiday-hours-2026/
// https://iqhelp.dtn.com/memorial-day-holiday-service-hours-2026/
// Juneteenth, Independence Day and Labor Day (rows naming metals):
// https://support.ninjatrader.com/eu/s/article/2026-Holiday-Trading-Hours?language=en_US
// Thanksgiving and Friday after: https://edgeclear.com/exchange-holiday-hours/
// Christmas/New Year 2026 and 2027 Monday holidays (GC/SI, CT and ET):
// https://www.marketframework.com/tools/futures-holiday-hours
// 2027 Thanksgiving, Juneteenth and holiday eves (GC / metals, CT):
// https://crosstrade.io/blog/cme-trading-hours-2027
const metalHolidayCloseMinute: Readonly<Record<string, number | null | undefined>> = {
  "2025-12-31": 17 * 60, "2026-01-01": null, "2026-01-19": 14 * 60 + 30, "2026-02-16": 14 * 60 + 30,
  "2026-05-25": 14 * 60 + 30, "2026-06-19": 13 * 60, "2026-07-03": 13 * 60,
  "2026-09-07": 14 * 60 + 30, "2026-11-26": 14 * 60 + 30, "2026-11-27": 14 * 60 + 45,
  "2026-12-24": 13 * 60 + 45, "2026-12-25": null, "2026-12-31": 17 * 60,
  "2027-01-01": null, "2027-01-18": 14 * 60 + 30, "2027-02-15": 14 * 60 + 30,
  "2027-05-31": 14 * 60 + 30, "2027-06-18": 13 * 60, "2027-07-05": 14 * 60 + 30,
  "2027-09-06": 14 * 60 + 30, "2027-11-25": 14 * 60 + 30, "2027-11-26": 14 * 60 + 45,
  "2027-12-23": 17 * 60, "2027-12-24": null, "2027-12-31": 17 * 60,
  // 2028 dates reviewed against https://www.opm.gov/policy-data-oversight/pay-leave/federal-holidays/
  // GC/SI holiday times are unverified. Withhold these sessions pending exchange publication.
  "2028-01-17": null, "2028-02-21": null, "2028-05-29": null, "2028-06-19": null,
  "2028-07-04": null, "2028-09-04": null, "2028-11-23": null, "2028-11-24": null,
  "2028-12-22": null, "2028-12-25": null, "2028-12-29": null,
};

/** ECB business-daily fixing date. atSec identifies a UTC date label as in the FX producer. */
export function isTargetFixingDay(atSec: number): boolean {
  const label = new Date(atSec * 1000);
  if (!Number.isFinite(label.getTime())) return false;
  const weekday = label.getUTCDay();
  const monthDay = label.toISOString().slice(5, 10);
  const easter = easterSundayUtcDaySec(label.getUTCFullYear());
  const day = bucketUnixSecondsToUtcDay(atSec);
  return weekday !== 0 && weekday !== 6 && monthDay !== "01-01" && monthDay !== "05-01"
    && monthDay !== "12-25" && monthDay !== "12-26" && day !== easter - 2 * DAY_SECONDS && day !== easter + DAY_SECONDS;
}

// Outside the reviewed years, identify potentially affected US holiday dates only.
// A holiday never inherits the partial trading hours of another year.
function isUnreviewedMetalHoliday(date: Date): boolean {
  const month = date.getUTCMonth() + 1, day = date.getUTCDate(), weekday = date.getUTCDay();
  const observed = (dom: number) =>
    day === dom || (weekday === 5 && day === dom - 1) || (weekday === 1 && day === dom + 1);
  switch (month) {
    case 1: return observed(1) || (weekday === 1 && day >= 15 && day <= 21);
    case 2: return weekday === 1 && day >= 15 && day <= 21;
    case 5: return weekday === 1 && day >= 25;
    case 6: return date.getUTCFullYear() >= 2022 && observed(19);
    case 7: return observed(4);
    case 9: return weekday === 1 && day <= 7;
    case 11: return (weekday === 4 && day >= 22 && day <= 28) || (weekday === 5 && day >= 23 && day <= 29);
    case 12: return observed(25) || day === 24 || day === 31
      || (weekday === 5 && (day === 22 || day === 23 || day === 29 || day === 30)) || (weekday === 4 && day === 23);
    default: return false;
  }
}

type Interval = { start: number; end: number };

function intervalForDay(market: ReferenceMarket, day: number): Interval | null {
  const date = new Date(day * 1000);
  const weekday = date.getUTCDay();
  if (weekday === 6 || (market === "metal" && weekday === 0)) return null;
  const iso = date.toISOString().slice(0, 10);
  // All trading edges on DST-change Sundays occur in the evening, after the transition.
  const noonUtc = day + 12 * HOUR_SECONDS;
  const localOrigin = day + (12 - Number(newYorkHour.format(noonUtc * 1000))) * HOUR_SECONDS;
  if (market === "fx") {
    const monthDay = iso.slice(5);
    if (monthDay === "01-01" || monthDay === "12-25") return null;
    // https://www.forex.com/en-us/help-and-support/market-trading-hours/ (weekly session).
    // No common published spot-FX eve cutoff: retain the existing December 22:00 UTC rule.
    const start = localOrigin + (weekday === 0 ? 17 * HOUR_SECONDS : 0);
    const normalClose = localOrigin + (weekday === 5 ? 17 * HOUR_SECONDS : DAY_SECONDS);
    const end = monthDay === "12-24" || monthDay === "12-31" ? Math.min(normalClose, day + 22 * HOUR_SECONDS) : normalClose;
    return start < end ? { start, end } : null;
  }

  const year = date.getUTCFullYear();
  if (day === easterSundayUtcDaySec(year) - 2 * DAY_SECONDS) return null;
  const close = metalHolidayCloseMinute[iso];
  if (close === null || (close === undefined && (year < 2026 || year > 2028) && isUnreviewedMetalHoliday(date))) return null;
  return {
    start: localOrigin - 6 * HOUR_SECONDS, // 18:00 New York the preceding evening
    end: localOrigin + (close ?? 17 * 60) * SECONDS_PER_MINUTE,
  };
}

function sessionDay(market: ReferenceMarket, nowSec: number): number {
  const instant = new Date(nowSec * 1000);
  const localHour = Number(newYorkHour.format(instant));
  // A New York evening can already be tomorrow in UTC.
  const localDay = bucketUnixSecondsToUtcDay(nowSec) - (localHour > instant.getUTCHours() ? DAY_SECONDS : 0);
  return market === "metal" && localHour >= 18 ? localDay + DAY_SECONDS : localDay;
}

/** The current uninterrupted trading session, or both edges of the closure containing nowSec. */
export function getReferenceSessionState(market: ReferenceMarket, nowSec: number): ReferenceSessionState {
  const day = sessionDay(market, nowSec);
  const current = intervalForDay(market, day);
  if (current && current.start <= nowSec && nowSec < current.end) {
    let start = current.start;
    // FX trades across midnight; never treat a new civil date as a reopen.
    if (market === "fx") {
      for (let back = 1; back <= 5; back++) {
        const prior = intervalForDay(market, day - back * DAY_SECONDS);
        if (prior?.end !== start) break;
        start = prior.start;
      }
    }
    return { open: true, sessionOpenedAtSec: start, nextOpenSec: null, closureStartSec: null };
  }
  let closureStart = current && current.end <= nowSec ? current.end : null;
  let nextOpen = current && nowSec < current.start ? current.start : null;
  // Two adjacent holiday dates plus a weekend fit within a week in either direction.
  for (let distance = 1; distance <= 7 && (closureStart === null || nextOpen === null); distance++) {
    closureStart ??= intervalForDay(market, day - distance * DAY_SECONDS)?.end ?? null;
    nextOpen ??= intervalForDay(market, day + distance * DAY_SECONDS)?.start ?? null;
  }
  if (closureStart === null || nextOpen === null) throw new RangeError("Reference session calendar has no adjacent session");
  return { open: false, sessionOpenedAtSec: null, closureStartSec: closureStart, nextOpenSec: nextOpen };
}

export function isReferenceMarketClosed(market: ReferenceMarket | null, nowSec: number): boolean {
  if (market === null) return false;
  const interval = intervalForDay(market, sessionDay(market, nowSec));
  return !interval || nowSec < interval.start || nowSec >= interval.end;
}

export function isFxMarketClosed(nowSec: number): boolean {
  return isReferenceMarketClosed("fx", nowSec);
}

export function isMetalMarketClosed(nowSec: number): boolean {
  return isReferenceMarketClosed("metal", nowSec);
}

export function getReferenceMarketClosureStart(market: ReferenceMarket | null, nowSec: number): number | null {
  return market === null ? null : getReferenceSessionState(market, nowSec).closureStartSec;
}

export function getReferenceMarketReopen(market: ReferenceMarket | null, nowSec: number): number | null {
  return market === null ? null : getReferenceSessionState(market, nowSec).nextOpenSec;
}

/** How long references get to reprice after a reopen before a stored deviation counts as open-market evidence. */
export const REFERENCE_MARKET_REOPEN_GRACE_SEC = 6 * HOUR_SECONDS;

/**
 * The closure rule replayed over a stored event, for history built before the rule existed: a
 * sub-severe event that opened while its reference market was shut would not have opened then.
 * It counts from the reopen instead, or is dropped (null) when it ended within the reopen grace.
 * Other events keep their start. History keeps no closed-session deviation, so the stored peak
 * decides severity.
 */
export function replayReferenceMarketEventStart(
  pegCurrency: string | null | undefined,
  startedAt: number,
  endedAt: number | null,
  peakBps: number,
): number | null {
  if (!isReferenceDeviationHeld(pegCurrency, startedAt, peakBps)) return startedAt;
  const reopen = getReferenceMarketReopen(getReferenceMarket(pegCurrency), startedAt)!;
  return endedAt != null && endedAt <= reopen + REFERENCE_MARKET_REOPEN_GRACE_SEC ? null : reopen;
}

/**
 * @deprecated Use evaluateReferenceAdmission for a clocked, source-specific verdict.
 * A deviation read while the peg's reference market is closed compares a trading token with a
 * repeated close, so callers hold it rather than act on it. A move at the severe band or beyond
 * is not closed-session drift and stays live, in either direction; an unknown deviation (NaN) is
 * held. USD and other pegs without a reference market are never held.
 */
export function isReferenceDeviationHeld(
  pegCurrency: string | null | undefined,
  nowSec: number,
  deviationBps: number,
): boolean {
  return !(Math.abs(deviationBps) >= DEPEG_SEVERITY_BPS.severe)
    && isReferenceMarketClosed(getReferenceMarket(pegCurrency), nowSec);
}

export const CME_CALENDAR_REVIEW_DEADLINE_SEC = Date.UTC(2027, 10, 18) / 1000;
export const MENTO_CALENDAR_REVIEW_DEADLINE_SEC = Date.UTC(2027, 9, 29, 10, 35) / 1000;

/** Exact UTC rules verified at the registry's pinned MarketHoursBreaker commit. */
export function isMentoMarketClosed(nowSec: number): boolean {
  const clock = new Date(nowSec * 1000);
  const day = clock.getUTCDay();
  const hour = clock.getUTCHours();
  const month = clock.getUTCMonth();
  const date = clock.getUTCDate();
  return (day === 5 && hour >= 21) || day === 6 || (day === 0 && hour < 23)
    || (month === 11 && ((date === 24 || date === 31) && hour >= 22 || date === 25))
    || (month === 0 && date === 1);
}

/** End of the reviewed MarketHoursBreaker closure containing `nowSec`, or null while open.
 *  The checked calendar is the standing Mento FX source review above; callers defer
 *  settlement to this instant rather than treating the scheduled closure as impairment. */
export function resolveMentoFxMarketReopen(nowSec: number): number | null {
  if (!Number.isFinite(nowSec) || nowSec < 0 || !isMentoMarketClosed(nowSec)) return null;
  // Reviewed closure edges fall on UTC hour marks; walk to the first open hour.
  let candidate = Math.floor(nowSec / 3_600) * 3_600 + 3_600;
  for (let hours = 0; hours < 24 * 8; hours += 1, candidate += 3_600) {
    if (!isMentoMarketClosed(candidate)) return candidate;
  }
  return null;
}

export function mostRecentMentoClosureEnd(nowSec: number): number {
  const clock = new Date(nowSec * 1000);
  const year = clock.getUTCFullYear();
  const midnight = Date.UTC(year, clock.getUTCMonth(), clock.getUTCDate()) / 1000;
  let sundayReopen = midnight - clock.getUTCDay() * 86_400 + 23 * 3600;
  if (sundayReopen > nowSec) sundayReopen -= 7 * 86_400;
  // Reject nominal ends still inside another closure (for example Christmas on Sunday).
  return Math.max(...[
    sundayReopen,
    Date.UTC(year, 11, 26) / 1000,
    Date.UTC(year, 0, 2) / 1000,
    Date.UTC(year - 1, 11, 26) / 1000,
  ].filter((end) => end <= nowSec && isMentoMarketClosed(end - 1) && !isMentoMarketClosed(end)));
}
