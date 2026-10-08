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
    return `${error.name}: ${sanitize(toErrorMessage(error, stripSensitive), maxLength)}`;
  }
  if (typeof error === "string") {
    return sanitize(error, maxLength);
  }
  return "Unknown error";
}

// The unanchored email pattern /[\w.+-]+@[\w-]+\.[\w.-]+/g backtracks
// quadratically on long runs of local-part characters (an 80,000-character
// run took ~3s), because every start position inside the run re-scans to its
// end looking for "@". Anchoring each match at its run start with a negative
// lookbehind makes those mid-run starts fail in O(1); only the run's first
// position pays the O(run) scan, so the whole pass is linear. A match can
// also end on a "+" — the one local-part character the domain tail never
// consumes — and the unanchored scan would start the next match exactly
// there, so a sticky follow-up match preserves that glued-continuation
// behaviour (and the redaction it provides) instead of leaving a second
// glued address unredacted.
const EMAIL_RUN_START_PATTERN = /(?<![\w.+-])[\w.+-]+@[\w-]+\.[\w.-]+/g;
const EMAIL_GLUE_CONTINUATION_PATTERN = /[\w.+-]+@[\w-]+\.[\w.-]+/y;

function redactEmails(message: string): string {
  let redacted = "";
  let cursor = 0;
  EMAIL_RUN_START_PATTERN.lastIndex = 0;
  for (
    let match = EMAIL_RUN_START_PATTERN.exec(message);
    match !== null;
    match = EMAIL_RUN_START_PATTERN.exec(message)
  ) {
    redacted += message.slice(cursor, match.index) + "[email]";
    cursor = match.index + match[0].length;
    EMAIL_GLUE_CONTINUATION_PATTERN.lastIndex = cursor;
    for (
      let glued = EMAIL_GLUE_CONTINUATION_PATTERN.exec(message);
      glued !== null;
      glued = EMAIL_GLUE_CONTINUATION_PATTERN.exec(message)
    ) {
      cursor = EMAIL_GLUE_CONTINUATION_PATTERN.lastIndex;
      redacted += "[email]";
      EMAIL_GLUE_CONTINUATION_PATTERN.lastIndex = cursor;
    }
    // Skip past any glued continuations so the anchored scan never re-matches
    // inside text a continuation already consumed.
    EMAIL_RUN_START_PATTERN.lastIndex = cursor;
  }
  EMAIL_RUN_START_PATTERN.lastIndex = 0;
  return redacted + message.slice(cursor);
}

/**
 * Strips obvious SQL fragments and likely-PII (email-like strings, URLs) from
 * an error message without truncating. Exposed so structured logging can
 * sanitize every error it records, not just the few call-sites that use
 * {@link safeErrorMessage} directly.
 */
export function stripSensitive(message: string): string {
  const withoutSqlOrCredentials = message
    // Strip authorization headers and common credential-shaped key/value pairs.
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [redacted]")
    .replace(
      /\b((?:api[_-]?key|apikey|app[_-]?id|access[_-]?token|auth(?:orization)?|token|secret|password|cookie)\s*[=:]\s*)(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi,
      "$1[redacted]",
    )
    // Strip common SQL DML keywords + trailing fragment up to the next sentence boundary.
    .replace(/\b(SELECT|INSERT\s+INTO|UPDATE|DELETE\s+FROM)\b[^.\n]*/gi, "[sql]");
  // Strip email-like patterns (linear-time; see redactEmails), then URLs after
  // provider-specific URL redaction has had a chance to preserve non-sensitive
  // host context for operational labels.
  return redactEmails(withoutSqlOrCredentials)
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
  /(?:^|\.)n\.dwellir\.com$/i,
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
