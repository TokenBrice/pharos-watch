export function compareNullable(
  a: number | null | undefined,
  b: number | null | undefined,
): number | null {
  const aNull = a == null;
  const bNull = b == null;
  if (aNull && bNull) return 0;
  if (aNull) return 1;
  if (bNull) return -1;
  return null;
}
