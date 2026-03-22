export function sanitizeRecordValues<T>(
  input: unknown,
  normalizeValue: (value: unknown, key: string) => T | undefined,
): Record<string, T> {
  if (!input || typeof input !== "object" || Array.isArray(input)) return {};

  const out: Record<string, T> = {};
  for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
    const normalized = normalizeValue(value, key);
    if (normalized !== undefined) {
      out[key] = normalized;
    }
  }
  return out;
}

export function normalizeStringSet(
  values: Iterable<string> | undefined,
  normalizeValue: (value: string) => string,
): Set<string> {
  const set = new Set<string>();
  if (!values) return set;

  for (const value of values) {
    const normalized = normalizeValue(value.trim());
    if (normalized.length > 0) {
      set.add(normalized);
    }
  }

  return set;
}
