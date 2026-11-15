import { DEPEG_SEVERITY_BPS } from "./depeg-config";
import { getPegTaxonomyByCurrency } from "./peg-taxonomy";
import { easterSundayUtcDaySec } from "./time-buckets";
import { DAY_SECONDS } from "./time-constants";

const HOUR_SECONDS = 3_600;

/** The market whose price anchors a non-USD peg: FX for fiat pegs, metals for gold and silver. */
export type ReferenceMarket = "fx" | "metal";

export function getReferenceMarket(pegCurrency: string | null | undefined): ReferenceMarket | null {
  const pegClass = getPegTaxonomyByCurrency(pegCurrency ?? undefined)?.pegClass;
  return pegClass === "commodity" ? "metal" : pegClass === "fiat_fx" ? "fx" : null;
}

/**
 * FX and spot metals trade 24/5. While their market is shut, every reference Pharos reads
 * (ECB/OXR/FX feeds, gold-api.com spot, Chainlink FX and XAU/XAG heartbeats, tokens priced
 * off those feeds inside a peer median) repeats the last close, yet the stablecoins pegged to
 * them keep trading. FX closes Friday 21:00 to Sunday 23:00 UTC (the union of the US daylight
 * and standard-time sessions, so no DST arithmetic), from 22:00 UTC on 24 and 31 December, and
 * all of 25 December and 1 January. Edges are start-inclusive and end-exclusive; substitute
 * holidays and the daily one-hour break are not modelled.
 */
export function isFxMarketClosed(nowSec: number): boolean {
  const clock = new Date(nowSec * 1000);
  const day = clock.getUTCDay();
  const hour = clock.getUTCHours();
  const month = clock.getUTCMonth();
  const date = clock.getUTCDate();
  return (day === 5 && hour >= 21) || day === 6 || (day === 0 && hour < 23)
    || (month === 11 && (date === 25 || ((date === 24 || date === 31) && hour >= 22)))
    || (month === 0 && date === 1);
}

/** Metals follow FX hours and also close for Good Friday, from 21:00 UTC on the Thursday before. */
export function isMetalMarketClosed(nowSec: number): boolean {
  if (isFxMarketClosed(nowSec)) return true;
  const clock = new Date(nowSec * 1000);
  const dayStart = Date.UTC(clock.getUTCFullYear(), clock.getUTCMonth(), clock.getUTCDate()) / 1000;
  const goodFriday = easterSundayUtcDaySec(clock.getUTCFullYear()) - 2 * DAY_SECONDS;
  return dayStart === goodFriday || (dayStart === goodFriday - DAY_SECONDS && clock.getUTCHours() >= 21);
}

export function isReferenceMarketClosed(market: ReferenceMarket | null, nowSec: number): boolean {
  return market === "metal" ? isMetalMarketClosed(nowSec) : market === "fx" ? isFxMarketClosed(nowSec) : false;
}

/** Start of the closure containing `nowSec`, or null while the market trades. Edges fall on UTC hours. */
export function getReferenceMarketClosureStart(market: ReferenceMarket | null, nowSec: number): number | null {
  if (!isReferenceMarketClosed(market, nowSec)) return null;
  let start = Math.floor(nowSec / HOUR_SECONDS) * HOUR_SECONDS;
  // The longest closure (a holiday joined to a weekend) is under 80 hours.
  for (let hours = 0; hours < 24 * 8 && isReferenceMarketClosed(market, start - HOUR_SECONDS); hours += 1) {
    start -= HOUR_SECONDS;
  }
  return start;
}

/**
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
