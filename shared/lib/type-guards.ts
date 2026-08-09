/**
 * Shared runtime-neutral type guards.
 */

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === "object" && !Array.isArray(value);
}

/** Narrow an unknown to a plain (non-array) record, or null. */
export function readRecord(value: unknown): Record<string, unknown> | null {
  return isRecord(value) ? value : null;
}

export function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

export function stringValue(value: unknown, options: { trim?: boolean } = {}): string | null {
  if (typeof value !== "string") return null;
  const normalized = options.trim === false ? value : value.trim();
  return normalized.length > 0 ? normalized : null;
}

export function numberValue(value: unknown): number | null {
  return isFiniteNumber(value) ? value : null;
}
