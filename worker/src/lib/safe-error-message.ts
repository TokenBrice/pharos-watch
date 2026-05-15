/**
 * Returns a sanitized error message safe to emit in Workers logs.
 *
 * Strips obvious SQL fragments and likely-PII (email-like strings, URLs) from
 * the message, then truncates to `maxLength` characters as a defense-in-depth
 * measure against leaking raw `D1Error` SQL or user-supplied content.
 */
export function safeErrorMessage(error: unknown, maxLength: number = 200): string {
  if (error instanceof Error) {
    return `${error.name}: ${sanitize(error.message, maxLength)}`;
  }
  if (typeof error === "string") {
    return sanitize(error, maxLength);
  }
  return "Unknown error";
}

function sanitize(message: string, maxLength: number): string {
  const stripped = message
    // Strip common SQL DML keywords + trailing fragment up to the next sentence boundary.
    .replace(/\b(SELECT|INSERT\s+INTO|UPDATE|DELETE\s+FROM)\b[^.\n]*/gi, "[sql]")
    // Strip email-like patterns.
    .replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, "[email]")
    // Strip URLs.
    .replace(/https?:\/\/\S+/gi, "[url]")
    .trim();
  return stripped.length > maxLength ? `${stripped.slice(0, maxLength)}…` : stripped;
}
