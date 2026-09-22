/** Locale-independent lexicographic ordering by UTF-16 code units. */
export function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

/** Return a record whose entries are ordered by locale-independent key comparison. */
export function sortedRecord<T>(record: Record<string, T>): Record<string, T> {
  return Object.fromEntries(
    Object.entries(record).sort(([left], [right]) => compareCodeUnits(left, right)),
  );
}
