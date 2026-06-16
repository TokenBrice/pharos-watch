/**
 * Generic helper for reading typed alert markers stored as JSON in D1 cache.
 * Each watchdog defines its own marker shape; this handles the shared
 * parse-and-validate boilerplate.
 */
export function readAlertMarker<T extends object>(
  value: string | null | undefined,
  validate: (parsed: Partial<T>) => parsed is T,
): T | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as Partial<T>;
    if (validate(parsed)) return parsed;
  } catch {
    return null;
  }
  return null;
}
