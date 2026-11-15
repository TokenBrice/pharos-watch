import type { PegCurrency } from "../types/core";
import { DEPEG_SEVERITY_BPS } from "./depeg-config";
import { isCommodityPeg } from "./filter-tags";
import { easterSundayUtcDaySec } from "./time-buckets";
import { DAY_SECONDS } from "./time-constants";

const HOUR_SECONDS = 3_600;

/**
 * Spot gold and silver trade 24/5. While that market is shut, every commodity reference
 * Pharos reads (gold-api.com spot, Chainlink XAU/USD and XAG/USD heartbeats, tokens priced
 * off those feeds inside the peer median) repeats the last close, yet XAUT, PAXG and other
 * tokens keep trading. Closed: Friday 21:00 to Sunday 23:00 UTC (the union of the US
 * daylight and standard-time sessions, so no DST arithmetic), from 21:00 UTC on the
 * Thursday before Good Friday, from 22:00 UTC on 24 and 31 December, and all of
 * 25 December and 1 January. Edges are start-inclusive and end-exclusive; substitute
 * holidays and the daily one-hour break are not modelled.
 */
export function isMetalMarketClosed(nowSec: number): boolean {
  const clock = new Date(nowSec * 1000);
  const day = clock.getUTCDay();
  const hour = clock.getUTCHours();
  const month = clock.getUTCMonth();
  const date = clock.getUTCDate();
  const dayStart = Date.UTC(clock.getUTCFullYear(), month, date) / 1000;
  const goodFriday = easterSundayUtcDaySec(clock.getUTCFullYear()) - 2 * DAY_SECONDS;
  return (day === 5 && hour >= 21) || day === 6 || (day === 0 && hour < 23)
    || dayStart === goodFriday || (dayStart === goodFriday - DAY_SECONDS && hour >= 21)
    || (month === 11 && (date === 25 || ((date === 24 || date === 31) && hour >= 22)))
    || (month === 0 && date === 1);
}

/** Start of the closure containing `nowSec`, or null while the market trades. Edges fall on UTC hours. */
export function getMetalMarketClosureStart(nowSec: number): number | null {
  if (!isMetalMarketClosed(nowSec)) return null;
  let start = Math.floor(nowSec / HOUR_SECONDS) * HOUR_SECONDS;
  // The longest closure (a holiday joined to a weekend) is under 80 hours.
  for (let hours = 0; hours < 24 * 8 && isMetalMarketClosed(start - HOUR_SECONDS); hours += 1) {
    start -= HOUR_SECONDS;
  }
  return start;
}

/**
 * A commodity deviation read while the metal market is closed compares a trading token with
 * a repeated close, so callers hold it rather than act on it. A move at the severe band or
 * beyond is not closed-session drift and stays live; an unknown deviation (NaN) is held.
 */
export function isCommodityDeviationHeld(
  pegCurrency: PegCurrency | null | undefined,
  nowSec: number,
  absBps: number,
): boolean {
  return pegCurrency != null && isCommodityPeg(pegCurrency)
    && !(absBps >= DEPEG_SEVERITY_BPS.severe) && isMetalMarketClosed(nowSec);
}
