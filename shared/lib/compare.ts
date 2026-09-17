/** Locale-independent lexicographic ordering by UTF-16 code units. */
export function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
