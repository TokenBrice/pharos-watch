/**
 * Runtime-neutral environment binding resolution utilities.
 * Shared between worker (env.ts) and Pages Functions (ops-env.ts).
 */

/** Type guard: value is a non-empty string after trimming. */
export function hasConfiguredValue(value: string | undefined): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

/** Returns the trimmed value if non-empty, otherwise null. */
export function getConfiguredValue(value: string | undefined): string | null {
  return hasConfiguredValue(value) ? value.trim() : null;
}
