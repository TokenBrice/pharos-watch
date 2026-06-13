/**
 * Shared runtime-neutral type guards.
 */

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === "object" && !Array.isArray(value);
}

export function stringValue(value: unknown, options: { trim?: boolean } = {}): string | null {
  if (typeof value !== "string") return null;
  const normalized = options.trim === false ? value : value.trim();
  return normalized.length > 0 ? normalized : null;
}

export function numberValue(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}
