import type { DeadStablecoin } from "../types";
import { compareCodeUnits } from "./compare";

export type CemeterySortMode = "newest" | "oldest";

export interface CemeteryDeathDateParts {
  year: number;
  /** 1-12; null for a year-precision date. */
  month: number | null;
  /** 1-31; null for a year- or month-precision date. */
  day: number | null;
}

function isAsciiDigits(value: string, length: number): boolean {
  if (value.length !== length) return false;
  for (let index = 0; index < length; index += 1) {
    const code = value.charCodeAt(index);
    if (code < 48 || code > 57) return false;
  }
  return true;
}

/**
 * Parses a `deathDate` of the form `YYYY`, `YYYY-MM` or `YYYY-MM-DD` (ASCII
 * digits, month 1-12, day 1-31). Null when the value has any other shape or
 * an out-of-range component; callers that require month precision reject a
 * null `month` themselves.
 */
export function parseCemeteryDeathDate(value: string): CemeteryDeathDateParts | null {
  const parts = value.split("-");
  if (parts.length > 3 || !isAsciiDigits(parts[0], 4)) return null;
  const year = Number(parts[0]);
  if (parts.length === 1) return { year, month: null, day: null };
  if (!isAsciiDigits(parts[1], 2)) return null;
  const month = Number(parts[1]);
  if (month < 1 || month > 12) return null;
  if (parts.length === 2) return { year, month, day: null };
  if (!isAsciiDigits(parts[2], 2)) return null;
  const day = Number(parts[2]);
  if (day < 1 || day > 31) return null;
  return { year, month, day };
}

/**
 * Chronological key for a `deathDate` (`YYYY`, `YYYY-MM` or `YYYY-MM-DD`),
 * comparing year, then month, then day. A coarser date sorts at the start of
 * its period, ahead of every recorded component: a month-precision date ranks
 * before day 1 of its month and a year-precision date before January. Null
 * when the date does not parse; the caller keeps that distinct from "old".
 */
function getDeathDateKey(deathDate: string): number | null {
  const parsed = parseCemeteryDeathDate(deathDate);
  if (!parsed) {
    return null;
  }
  return parsed.year * 10_000 + (parsed.month ?? 0) * 100 + (parsed.day ?? 0);
}

/**
 * The single cemetery order for the register, hero keyboard order, JSON-LD,
 * RSS and the dataset export (whose `recordsOrderedBy` text in
 * `scripts/maintenance/generate-cemetery-dataset.ts` must change with it).
 * Keys, in order:
 *
 * 1. `deathDate` by year, month, then day: descending for `newest`, ascending
 *    for `oldest`. A month-precision date sorts as the start of its month, so
 *    newest-first lists a month's day-precision rows before its
 *    month-precision rows and `oldest` lists them after. A `deathDate` that
 *    does not parse follows every dated row in both modes: unknown is not old.
 * 2. Peak market cap descending; rows with no recorded peak follow known
 *    peaks. (This already puts every $1B+ collapse first within a date.)
 * 3. Symbol ascending, then id ascending, both by UTF-16 code unit so the order
 *    is identical in every runtime and locale.
 *
 * Keys 2 and 3 are the same in both modes, and ids are unique, so identical
 * data always yields the same order regardless of input order.
 */
export function sortCemeteryCoins<T extends DeadStablecoin>(
  coins: T[],
  sortMode: CemeterySortMode = "newest",
): T[] {
  const direction = sortMode === "newest" ? -1 : 1;
  return coins
    .map((coin) => ({ coin, dateKey: getDeathDateKey(coin.deathDate) }))
    .sort((a, b) => {
      if (a.dateKey === null || b.dateKey === null) {
        const unknownDiff = Number(a.dateKey === null) - Number(b.dateKey === null);
        if (unknownDiff !== 0) {
          return unknownDiff;
        }
      } else if (a.dateKey !== b.dateKey) {
        return (a.dateKey - b.dateKey) * direction;
      }

      const aPeak = a.coin.peakMcap;
      const bPeak = b.coin.peakMcap;
      if (aPeak === undefined || bPeak === undefined) {
        const unknownPeakDiff = Number(aPeak === undefined) - Number(bPeak === undefined);
        if (unknownPeakDiff !== 0) {
          return unknownPeakDiff;
        }
      } else if (aPeak !== bPeak) {
        return bPeak - aPeak;
      }

      return compareCodeUnits(a.coin.symbol, b.coin.symbol) || compareCodeUnits(a.coin.id, b.coin.id);
    })
    .map(({ coin }) => coin);
}
