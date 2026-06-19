/**
 * Portable watchlist token for the `/export` and `/import` commands (C129).
 *
 * A token is a base64url-encoded compact JSON body `{ v, c, t, p }`:
 *   v — schema version (currently 1)
 *   c — explicit coin ids
 *   t — the alert types to apply on import (dews/depeg/safety/launch/reserve)
 *   p — followed preset ids
 *
 * The codec never trusts ids: validity is checked by the importer against the
 * live registry. Decoding is defensive — copy/paste artifacts (a leading
 * `/import `, surrounding backticks, whitespace, newlines) are stripped, and
 * malformed / oversized / wrong-version tokens fail closed instead of throwing.
 *
 * Import applies the token through the existing bulk-confirm subscribe flow, so
 * the token deliberately carries a single uniform alert-type set rather than
 * per-coin granularity (no new write code).
 */

import { base64UrlToString, stringToBase64Url } from "./base64url";

const TOKEN_VERSION = 1;

/** Hard ceiling well under Telegram's 4096-char message limit. */
export const MAX_WATCHLIST_TOKEN_CHARS = 4000;

export interface WatchlistTokenState {
  coinIds: string[];
  alertTypes: string[];
  presetIds: string[];
}

export type WatchlistTokenDecodeError = "empty" | "too-large" | "malformed" | "unsupported-version";

export type WatchlistTokenDecodeResult =
  | { ok: true; state: WatchlistTokenState }
  | { ok: false; error: WatchlistTokenDecodeError };

export function encodeWatchlistToken(state: WatchlistTokenState): string {
  const body = {
    v: TOKEN_VERSION,
    c: state.coinIds,
    t: state.alertTypes,
    p: state.presetIds,
  };
  // Payloads are ASCII (kebab-case ids/types), so this matches the prior btoa codec byte-for-byte.
  return stringToBase64Url(JSON.stringify(body));
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
}

export function decodeWatchlistToken(raw: string): WatchlistTokenDecodeResult {
  // Tolerate copy-paste: drop a leading "/import ", code-block fences, and all whitespace.
  const cleaned = raw
    .trim()
    // eslint-disable-next-line security/detect-unsafe-regex -- bounded command-prefix strip before explicit max-length validation.
    .replace(/^\/import(@\S+)?\s+/i, "")
    .replace(/[`\s]/g, "");
  if (cleaned.length === 0) return { ok: false, error: "empty" };
  if (cleaned.length > MAX_WATCHLIST_TOKEN_CHARS) return { ok: false, error: "too-large" };

  let json: string;
  try {
    // Throws on invalid base64; copy/paste artifacts were already stripped above.
    json = base64UrlToString(cleaned);
  } catch {
    return { ok: false, error: "malformed" };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return { ok: false, error: "malformed" };
  }
  if (!parsed || typeof parsed !== "object") return { ok: false, error: "malformed" };

  const body = parsed as Record<string, unknown>;
  if (body.v !== TOKEN_VERSION) return { ok: false, error: "unsupported-version" };

  const coinIds = asStringArray(body.c);
  const alertTypes = asStringArray(body.t);
  const presetIds = asStringArray(body.p);
  if (coinIds.length === 0 && presetIds.length === 0) return { ok: false, error: "empty" };

  return { ok: true, state: { coinIds, alertTypes, presetIds } };
}
