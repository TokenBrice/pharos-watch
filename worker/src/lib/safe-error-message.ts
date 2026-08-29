import { toErrorMessage } from "@shared/lib/error-utils";

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
    // Strip authorization headers and common credential-shaped key/value pairs.
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [redacted]")
    .replace(
      /\b((?:api[_-]?key|apikey|app[_-]?id|access[_-]?token|auth(?:orization)?|token|secret|password|cookie)\s*[=:]\s*)(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi,
      "$1[redacted]",
    )
    // Strip common SQL DML keywords + trailing fragment up to the next sentence boundary.
    .replace(/\b(SELECT|INSERT\s+INTO|UPDATE|DELETE\s+FROM)\b[^.\n]*/gi, "[sql]")
    // Strip email-like patterns.
    .replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, "[email]")
    // Strip URLs after provider-specific URL redaction has had a chance to
    // preserve non-sensitive host context for operational labels.
    .replace(/https?:\/\/\S+/gi, "[url]")
    .trim();
}

function sanitize(message: string, maxLength: number): string {
  const stripped = stripSensitive(message);
  return stripped.length > maxLength ? `${stripped.slice(0, maxLength)}…` : stripped;
}

const PROVIDER_URL_HOST_PATTERNS = [
  /(?:^|\.)alchemy\.com$/i,
  /(?:^|\.)drpc\.org$/i,
  /(?:^|\.)etherscan\.io$/i,
  /(?:^|\.)telegram\.org$/i,
  /(?:^|\.)twitter\.com$/i,
  /(?:^|\.)x\.com$/i,
  /(?:^|\.)anthropic\.com$/i,
];

const SECRET_QUERY_PARAM_PATTERN =
  /([?&](?:api[_-]?key|apikey|app[_-]?id|key|token|access[_-]?token|auth|authorization|secret)=)[^&#\s]+/gi;

function isKnownProviderHost(hostname: string): boolean {
  return PROVIDER_URL_HOST_PATTERNS.some((pattern) => pattern.test(hostname));
}

function redactUrlToken(urlText: string): string {
  try {
    const url = new URL(urlText);
    const sanitizedQuery = url.search.replace(SECRET_QUERY_PARAM_PATTERN, "$1[redacted]");
    if (isKnownProviderHost(url.hostname)) {
      return `${url.protocol}//${url.hostname}/[redacted]`;
    }
    return `${url.protocol}//${url.hostname}${url.pathname}${sanitizedQuery}${url.hash}`;
  } catch {
    return "[url]";
  }
}

/**
 * Redacts provider URL paths/query strings while preserving enough host
 * context for operator logs. Use this before interpolating upstream URLs into
 * normal console logs; `safeErrorMessage` still strips all URLs for public or
 * error-string surfaces.
 */
export function redactProviderUrls(value: string): string {
  return value.replace(/https?:\/\/[^\s"'<>),]+/gi, (url) => redactUrlToken(url));
}
