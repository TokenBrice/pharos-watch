/**
 * Client-safe rules for the Autopsy Register and the labels derived from its
 * rows: pure functions over the server-projected rows (type-only import from
 * the server builder). Every label here is locale- and timezone-independent
 * string arithmetic, so server and client render byte-identical text.
 */
import { CAUSE_META } from "@shared/lib/cause-of-death";
import { parseCemeteryDeathDate, sortCemeteryCoins } from "@shared/lib/cemetery";
import {
  peakBucketOf,
  type CemeteryRegisterFilters,
  type CemeteryRegisterSortDirection,
  type CemeteryRegisterSortKey,
} from "@/lib/cemetery-selection";
import type { CemeteryRegisterRow } from "@/lib/cemetery-register";

/** Rows shown before "Show all" while no filter is active. */
export const REGISTER_FOLD_COUNT = 25;

const SHORT_MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"] as const;

/**
 * The cemetery's death-date label at its recorded precision: "Aug 27, 2026"
 * (day) or "Jul 2026" (month). The one formatting authority for register and
 * hero date labels; an unparseable value prints verbatim.
 */
export function formatRegisterDeathDate(deathDate: string): string {
  const parsed = parseCemeteryDeathDate(deathDate);
  if (parsed?.month == null) return deathDate;
  const month = SHORT_MONTHS[parsed.month - 1];
  return parsed.day === null ? `${month} ${parsed.year}` : `${month} ${parsed.day}, ${parsed.year}`;
}

/** URL filters that narrow the rows; `sort` and `dir` only reorder them. */
const REGISTER_FILTER_KEYS = ["cause", "year", "peg", "mechanism", "record", "peak", "q"] as const;

export interface RegisterSort {
  key: CemeteryRegisterSortKey;
  dir: CemeteryRegisterSortDirection;
}

/** Direction a column sorts in when first selected; "Died, newest first" is the register default. */
const REGISTER_SORT_DEFAULT_DIRECTION: Readonly<Record<CemeteryRegisterSortKey, CemeteryRegisterSortDirection>> = {
  died: "desc",
  peak: "desc",
  name: "asc",
  cause: "asc",
};

export function hasActiveRegisterFilters(filters: CemeteryRegisterFilters): boolean {
  return REGISTER_FILTER_KEYS.some((key) => filters[key] !== undefined);
}

/** Drops every narrowing filter and keeps the sort. */
export function withoutRegisterFilters(filters: CemeteryRegisterFilters): CemeteryRegisterFilters {
  return { sort: filters.sort, dir: filters.dir };
}

/** Case- and accent-insensitive form used for both the search text and the query. */
function foldForSearch(value: string): string {
  return value.normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
}

/** Search covers name, ticker, id and epitaph; obituary text is not searchable client-side. */
export function registerSearchText(row: CemeteryRegisterRow): string {
  return foldForSearch([row.name, row.symbol, row.id, row.epitaph ?? ""].join("\n"));
}

export function matchesRegisterFilters(
  row: CemeteryRegisterRow,
  filters: CemeteryRegisterFilters,
  searchText: string,
): boolean {
  if (filters.cause && row.cause !== filters.cause) return false;
  if (filters.year && row.deathDate.slice(0, 4) !== filters.year) return false;
  if (filters.peg && row.pegCurrency !== filters.peg) return false;
  if (filters.mechanism && row.mechanismArchetype !== filters.mechanism) return false;
  if (filters.record === "tracked" && !row.tracked) return false;
  if (filters.record === "curated" && row.tracked) return false;
  if (filters.record === "case-study" && !row.caseStudy) return false;
  if (filters.peak && peakBucketOf(row.peak) !== filters.peak) return false;
  if (filters.q && !searchText.includes(foldForSearch(filters.q))) return false;
  return true;
}

export function resolveRegisterSort(filters: CemeteryRegisterFilters): RegisterSort {
  const key = filters.sort ?? "died";
  return { key, dir: filters.dir ?? REGISTER_SORT_DEFAULT_DIRECTION[key] };
}

/** The URL form of a sort: default key and default direction are omitted. */
export function registerSortParams(sort: RegisterSort): Pick<CemeteryRegisterFilters, "sort" | "dir"> {
  const dir = sort.dir === REGISTER_SORT_DEFAULT_DIRECTION[sort.key] ? undefined : sort.dir;
  return { sort: sort.key === "died" && dir === undefined ? undefined : sort.key, dir };
}

/** Header click: the active column flips direction, another column starts at its default direction. */
export function nextRegisterSort(current: RegisterSort, key: CemeteryRegisterSortKey): RegisterSort {
  if (current.key === key) return { key, dir: current.dir === "asc" ? "desc" : "asc" };
  return { key, dir: REGISTER_SORT_DEFAULT_DIRECTION[key] };
}

const TEXT_COLLATOR = new Intl.Collator("en", { sensitivity: "base", numeric: true });

/**
 * The rows in register order. `rows` must arrive in the default order
 * (`buildCemeteryRegisterRows`, newest first). "Died, oldest first" asks the
 * single cemetery order authority (`sortCemeteryCoins`) rather than reversing,
 * since its tie-breakers do not flip with the direction. Rows with no recorded
 * peak sort after every recorded peak in both directions. Every other tie keeps
 * the default order, so the result is deterministic.
 */
export function sortRegisterRows(rows: readonly CemeteryRegisterRow[], sort: RegisterSort): CemeteryRegisterRow[] {
  if (sort.key === "died") {
    if (sort.dir === "desc") return [...rows];
    const records = rows.map((row) => ({
      row,
      id: row.id,
      name: row.name,
      symbol: row.symbol,
      pegCurrency: row.pegCurrency,
      causeOfDeath: row.cause,
      deathDate: row.deathDate,
      peakMcap: row.peak ?? undefined,
      obituary: row.obituary,
      sourceUrl: row.sourceUrl,
      sourceLabel: row.sourceLabel,
    }));
    return sortCemeteryCoins(records, "oldest").map((record) => record.row);
  }

  const defaultRank = new Map(rows.map((row, index) => [row.id, index]));
  const sign = sort.dir === "asc" ? 1 : -1;
  const compare = (a: CemeteryRegisterRow, b: CemeteryRegisterRow): number => {
    switch (sort.key) {
      case "peak":
        if (a.peak === null || b.peak === null) return Number(a.peak === null) - Number(b.peak === null);
        return (a.peak - b.peak) * sign;
      case "name":
        return (TEXT_COLLATOR.compare(a.symbol, b.symbol) || TEXT_COLLATOR.compare(a.name, b.name)) * sign;
      case "cause":
        return TEXT_COLLATOR.compare(CAUSE_META[a.cause].label, CAUSE_META[b.cause].label) * sign;
      default:
        return 0;
    }
  };
  return [...rows].sort((a, b) => compare(a, b) || defaultRank.get(a.id)! - defaultRank.get(b.id)!);
}

const SORT_CAPTION: Readonly<Record<CemeteryRegisterSortKey, { column: string; asc: string; desc: string }>> = {
  died: { column: "death date", asc: "oldest first", desc: "newest first" },
  peak: { column: "peak market cap", asc: "smallest first", desc: "largest first" },
  name: { column: "ticker", asc: "A to Z", desc: "Z to A" },
  cause: { column: "cause", asc: "A to Z", desc: "Z to A" },
};

/** "113 documented stablecoin deaths, sorted by death date, newest first." */
export function registerCaption(count: number, sort: RegisterSort): string {
  const caption = SORT_CAPTION[sort.key];
  return `${count} documented stablecoin deaths, sorted by ${caption.column}, ${caption[sort.dir]}.`;
}
