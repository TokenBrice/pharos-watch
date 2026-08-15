export type SortDirection = "asc" | "desc";

export interface SortState<K extends string> {
  key: K;
  direction: SortDirection;
}

interface ComparatorOptions {
  /** Where to place null/undefined values. Default: "last". */
  nullPosition?: "first" | "last";
}

/**
 * Creates a type-safe table row comparator from a field extractor map.
 * Each extractor returns a number, string, null, or undefined for comparison.
 * Null/undefined values sort to the end (or beginning with `nullPosition: "first"`)
 * regardless of sort direction.
 */
export function createTableComparator<K extends string, Row>(
  extractors: Record<K, (row: Row) => number | string | null | undefined>,
  options?: ComparatorOptions,
): (a: Row, b: Row, sort: SortState<K>) => number {
  const nullLast = (options?.nullPosition ?? "last") === "last";

  return (a, b, sort) => {
    const extractor = extractors[sort.key];
    if (!extractor) return 0;
    const aVal = extractor(a);
    const bVal = extractor(b);

    const aNull = aVal == null;
    const bNull = bVal == null;
    if (aNull && bNull) return 0;
    if (aNull) return nullLast ? 1 : -1;
    if (bNull) return nullLast ? -1 : 1;

    let cmp: number;
    if (typeof aVal === "string" && typeof bVal === "string") {
      cmp = aVal.localeCompare(bVal);
    } else {
      cmp = (aVal as number) - (bVal as number);
    }
    if (cmp === 0) return 0;
    return sort.direction === "asc" ? cmp : -cmp;
  };
}
