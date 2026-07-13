import type { StablecoinMeta } from "../../types";

type ImplementationDateMeta = Pick<StablecoinMeta, "id" | "implementationLaunchDate" | "launchDate" | "variantOf">;

export interface FuzzyDateRange {
  start: string;
  end: string;
}

export interface EffectiveImplementationLaunchDate {
  date: string | null;
  sourceAssetId: string | null;
  layers: readonly { assetId: string; authoredDate: string; conservativeDate: string }[];
  cycleDetected: boolean;
}

function isoDate(year: number, month: number, day: number): string {
  return `${year.toString().padStart(4, "0")}-${month.toString().padStart(2, "0")}-${day.toString().padStart(2, "0")}`;
}

function lastDayOfMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/** Convert a supported fuzzy date to its inclusive calendar range. */
export function fuzzyDateRange(value: string): FuzzyDateRange | null {
  let match = /^(\d{4})$/.exec(value);
  if (match) {
    const year = Number(match[1]);
    return { start: isoDate(year, 1, 1), end: isoDate(year, 12, 31) };
  }

  match = /^(\d{4})-(\d{2})$/.exec(value);
  if (match) {
    const year = Number(match[1]);
    const month = Number(match[2]);
    if (month < 1 || month > 12) return null;
    return { start: isoDate(year, month, 1), end: isoDate(year, month, lastDayOfMonth(year, month)) };
  }

  match = /^(\d{4})-Q([1-4])$/.exec(value);
  if (match) {
    const year = Number(match[1]);
    const quarter = Number(match[2]);
    const startMonth = (quarter - 1) * 3 + 1;
    const endMonth = startMonth + 2;
    return {
      start: isoDate(year, startMonth, 1),
      end: isoDate(year, endMonth, lastDayOfMonth(year, endMonth)),
    };
  }

  match = /^(\d{4})-H([1-2])$/.exec(value);
  if (match) {
    const year = Number(match[1]);
    const half = Number(match[2]);
    const startMonth = half === 1 ? 1 : 7;
    const endMonth = half === 1 ? 6 : 12;
    return {
      start: isoDate(year, startMonth, 1),
      end: isoDate(year, endMonth, lastDayOfMonth(year, endMonth)),
    };
  }

  match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (month < 1 || month > 12 || day < 1 || day > lastDayOfMonth(year, month)) return null;
  return { start: value, end: value };
}

/**
 * Track-record age uses the latest possible launch within a fuzzy period. If
 * that boundary is after the scoring clock, the clock itself is used, yielding
 * a conservative zero-age lower bound rather than claiming future history.
 */
export function conservativeImplementationDate(value: string, asOf: string): string | null {
  const range = fuzzyDateRange(value);
  const asOfRange = fuzzyDateRange(asOf);
  if (!range || !asOfRange || asOfRange.start !== asOfRange.end) return null;
  return range.end > asOf ? asOf : range.end;
}

/** Resolve the newest required implementation layer across a variant chain. */
export function resolveEffectiveImplementationLaunchDate(
  coin: ImplementationDateMeta,
  registry: ReadonlyMap<string, ImplementationDateMeta>,
  asOf: string,
): EffectiveImplementationLaunchDate {
  const layers: { assetId: string; authoredDate: string; conservativeDate: string }[] = [];
  const visited = new Set<string>();
  let current: ImplementationDateMeta | undefined = coin;
  let cycleDetected = false;

  while (current) {
    if (visited.has(current.id)) {
      cycleDetected = true;
      break;
    }
    visited.add(current.id);

    const authoredDate = current.implementationLaunchDate ?? current.launchDate;
    const conservativeDate = authoredDate ? conservativeImplementationDate(authoredDate, asOf) : null;
    if (authoredDate && conservativeDate) {
      layers.push({ assetId: current.id, authoredDate, conservativeDate });
    }

    current = current.variantOf ? registry.get(current.variantOf) : undefined;
  }

  layers.sort(
    (left, right) =>
      right.conservativeDate.localeCompare(left.conservativeDate) || left.assetId.localeCompare(right.assetId),
  );
  const newest = layers[0] ?? null;

  return {
    date: newest?.conservativeDate ?? null,
    sourceAssetId: newest?.assetId ?? null,
    layers,
    cycleDetected,
  };
}
