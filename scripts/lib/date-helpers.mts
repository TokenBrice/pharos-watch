export const DATE_ONLY_RE: RegExp = /^\d{4}-\d{2}-\d{2}$/;

export function isValidDateOnly(value: unknown): boolean {
  if (typeof value !== "string" || !DATE_ONLY_RE.test(value)) {
    return false;
  }
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(date.valueOf()) && date.toISOString().slice(0, 10) === value;
}
