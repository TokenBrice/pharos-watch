import { toErrorMessage } from "./error-utils";

/**
 * Returns a sanitized error message safe to emit in Workers logs.
 *
 * Strips obvious SQL fragments and likely-PII (email-like strings, URLs) from
 * the message, then truncates to `maxLength` characters as a defense-in-depth
 * measure against leaking raw `D1Error` SQL or user-supplied content.
 */
export function safeErrorMessage(error: unknown, maxLength: number = 200): string {
  if (error instanceof Error) {
    return `${error.name}: ${sanitize(toErrorMessage(error), maxLength)}`;
  }
  if (typeof error === "string") {
    return sanitize(toErrorMessage(error), maxLength);
  }
  return "Unknown error";
}

/**
 * Strips obvious SQL fragments and likely-PII (email-like strings, URLs) from
 * an error message without truncating. Exposed so structured logging can
 * sanitize every error it records, not just the few call-sites that use
 * {@link safeErrorMessage} directly.
 */
export function stripSensitive(message: string): string {
  return message
    // Strip common SQL DML keywords + trailing fragment up to the next sentence boundary.
    .replace(/\b(SELECT|INSERT\s+INTO|UPDATE|DELETE\s+FROM)\b[^.\n]*/gi, "[sql]")
    // Strip email-like patterns.
    .replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, "[email]")
    // Strip URLs.
    .replace(/https?:\/\/\S+/gi, "[url]")
    .trim();
}

function sanitize(message: string, maxLength: number): string {
  const stripped = stripSensitive(message);
  return stripped.length > maxLength ? `${stripped.slice(0, maxLength)}…` : stripped;
}
