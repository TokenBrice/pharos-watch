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

/** Coerce a finite number or non-blank numeric string, rejecting boolean/null coercions. */
export function coerceFiniteNumber(value: unknown): number | null {
  if (value == null || typeof value === "boolean") return null;
  if (typeof value === "string" && value.trim().length === 0) return null;
  if (typeof value !== "number" && typeof value !== "string") return null;
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export function coerceNonNegativeNumber(value: unknown): number | null {
  const parsed = coerceFiniteNumber(value);
  return parsed != null && parsed >= 0 ? parsed : null;
}

export function stringValue(value: unknown, options: { trim?: boolean } = {}): string | null {
  if (typeof value !== "string") return null;
  const normalized = options.trim === false ? value : value.trim();
  return normalized.length > 0 ? normalized : null;
}

export function numberValue(value: unknown): number | null {
  return isFiniteNumber(value) ? value : null;
}
