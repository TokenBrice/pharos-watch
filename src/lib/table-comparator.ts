interface SortState<K extends string> {
  key: K;
  direction: "asc" | "desc";
}

/**
 * Creates a type-safe table row comparator from a field extractor map.
 * Each extractor returns a number or string for comparison.
 */
export function createTableComparator<Row, K extends string>(
  extractors: Record<K, (row: Row) => number | string>,
): (a: Row, b: Row, sort: SortState<K>) => number {
  return (a, b, sort) => {
    const extractor = extractors[sort.key];
    if (!extractor) return 0;
    const aVal = extractor(a);
    const bVal = extractor(b);
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
