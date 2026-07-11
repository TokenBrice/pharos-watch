import { parseTelegramAdoptionToken } from "./telegram-adoption-analytics";

/**
 * Telegram Mini App deep-link payload registry.
 *
 * Runtime-neutral (no Worker/D1 or browser-only imports). Consumed by:
 *   - `worker/src/api/telegram-webhook-parsing.ts` — to validate `?start=` payloads.
 *   - The Mini App client at `src/app/pharoswatchbot/app/client.tsx` — to map
 *     `?startapp=` payloads to a starting view.
 *
 * Two Telegram deep-link surfaces share this registry:
 *   - `https://t.me/PharosWatchBot?start=<payload>` — bot `/start <payload>`
 *     command. Telegram caps this at 64 chars, `[A-Za-z0-9_-]`. Private chats
 *     only (Telegram restriction).
 *   - `https://t.me/PharosWatchBot?startapp=<payload>` — opens the Mini App
 *     directly with `tgWebAppStartParam`. Telegram practical cap is 512 chars,
 *     same charset.
 *
 * Keep both surfaces consistent: changes to emitted tokens must be reflected
 * in both the worker parser and the frontend mapping.
 */

/**
 * Maximum payload length for the Telegram `?start=` parameter (the tightest of
 * the two surfaces). The Mini App `?startapp=` surface accepts more but stays
 * safely under this limit when we share the same registry.
 */
export const TELEGRAM_START_PAYLOAD_MAX_LENGTH = 64;

/**
 * Maximum payload length for the Telegram `?startapp=` parameter. Telegram's
 * documented limit is 512 chars. We keep it for completeness; in practice
 * every payload we issue fits well under the `?start=` cap so this is only a
 * defensive ceiling for inbound parsing.
 */
export const TELEGRAM_STARTAPP_PAYLOAD_MAX_LENGTH = 512;

/**
 * Allowed payload charset for both surfaces. Matches the `?start=` regex
 * already in use; the `?startapp=` field is treated as opaque by Telegram but
 * we keep parsers tolerant by reusing the same charset.
 */
export const TELEGRAM_MINI_APP_PAYLOAD_PATTERN = /^[A-Za-z0-9_-]+$/;

/**
 * Non-parametric Mini App payload tokens. Frozen so callers cannot mutate it.
 *
 * `setup_recommended` is preserved for backward compatibility with any older
 * deployments that may still emit it. New emit sites should prefer one of the
 * other tokens (e.g. `watchlist` after a recommended setup completes — see
 * `worker/src/api/telegram-webhook-setup.ts`).
 */
export const MINI_APP_PAYLOAD_NAMES = Object.freeze({
  home: "home",
  settings: "settings",
  watchlist: "watchlist",
  presets: "presets",
  quietHours: "quiet-hours",
  snooze: "snooze",
  health: "health",
  forget: "forget",
  setupRecommended: "setup_recommended",
} as const);

export type MiniAppPayloadName =
  (typeof MINI_APP_PAYLOAD_NAMES)[keyof typeof MINI_APP_PAYLOAD_NAMES];

const PAYLOAD_NAME_VALUES = new Set<string>(Object.values(MINI_APP_PAYLOAD_NAMES));

/**
 * Parametric payloads. Stablecoin IDs may contain hyphens (e.g.
 * `usdc-circle`, `isc-international-stable-currency`), which the shared
 * charset permits.
 */
const COIN_PAYLOAD_PREFIX = "coin_";
const WHY_PAYLOAD_PREFIX = "why_";
const COVERAGE_PAYLOAD_PREFIX = "coverage_";

/** Discriminated union of all recognized Mini App payloads. */
export type TelegramMiniAppPayload =
  | { kind: "named"; name: MiniAppPayloadName }
  | { kind: "adoption"; destination: "miniapp_home" | "miniapp_watchlist" }
  | { kind: "coin"; coinId: string }
  | { kind: "why"; coinId: string }
  | { kind: "coverage"; coinId: string };

/** Extracts the stablecoin id from a prefixed payload, or null. */
function parsePrefixedPayload(payload: string, prefix: string): string | null {
  if (!payload.startsWith(prefix) || payload.length <= prefix.length) return null;
  return payload.slice(prefix.length);
}

/** Constructs a `coin_<id>` payload. Does not validate `coinId`. */
export function formatCoinPayload(coinId: string): string {
  return `${COIN_PAYLOAD_PREFIX}${coinId}`;
}

/** Constructs a `why_<id>` payload. Does not validate `coinId`. */
export function formatWhyPayload(coinId: string): string {
  return `${WHY_PAYLOAD_PREFIX}${coinId}`;
}

/** Constructs a `coverage_<id>` payload. Does not validate `coinId`. */
export function formatCoveragePayload(coinId: string): string {
  return `${COVERAGE_PAYLOAD_PREFIX}${coinId}`;
}

/**
 * Parse a raw payload string into a `TelegramMiniAppPayload`, or null if the
 * payload is empty, too long, contains invalid characters, or is not a known
 * token. Uses the `?startapp=` charset/length limits so it accepts every
 * payload that may arrive via the Mini App surface.
 */
export function parseMiniAppPayload(raw: string | null | undefined): TelegramMiniAppPayload | null {
  if (raw == null) return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  if (trimmed.length > TELEGRAM_STARTAPP_PAYLOAD_MAX_LENGTH) return null;
  if (!TELEGRAM_MINI_APP_PAYLOAD_PATTERN.test(trimmed)) return null;

  const lower = trimmed.toLowerCase();
  if (lower.startsWith("pw1_")) {
    const adoption = parseTelegramAdoptionToken(lower);
    if (adoption?.destination === "miniapp_home" || adoption?.destination === "miniapp_watchlist") {
      return { kind: "adoption", destination: adoption.destination };
    }
    return null;
  }
  if (PAYLOAD_NAME_VALUES.has(lower)) {
    return { kind: "named", name: lower as MiniAppPayloadName };
  }
  const coinId = parsePrefixedPayload(lower, COIN_PAYLOAD_PREFIX);
  if (coinId) {
    return { kind: "coin", coinId };
  }
  const whyCoinId = parsePrefixedPayload(lower, WHY_PAYLOAD_PREFIX);
  if (whyCoinId) {
    return { kind: "why", coinId: whyCoinId };
  }
  const coverageCoinId = parsePrefixedPayload(lower, COVERAGE_PAYLOAD_PREFIX);
  if (coverageCoinId) {
    return { kind: "coverage", coinId: coverageCoinId };
  }
  return null;
}

/**
 * Intent derived from a parsed payload. The frontend maps this to its view
 * union, while worker callers use it as a coarse-grained "what did the user
 * ask for?" signal.
 */
export type TelegramMiniAppIntent =
  | "home"
  | "settings"
  | "watchlist"
  | "presets"
  | "quiet-hours"
  | "snooze"
  | "health"
  | "forget"
  | "coin"
  | "why"
  | "coverage";

/** Map a parsed payload to a worker-side intent label. */
export function miniAppPayloadIntent(payload: TelegramMiniAppPayload): TelegramMiniAppIntent {
  if (payload.kind === "adoption") {
    return payload.destination === "miniapp_watchlist" ? "watchlist" : "home";
  }
  if (payload.kind === "coin") return "coin";
  if (payload.kind === "why") return "why";
  if (payload.kind === "coverage") return "coverage";
  switch (payload.name) {
    case MINI_APP_PAYLOAD_NAMES.setupRecommended:
      // Legacy alias: setup_recommended is treated as a watchlist landing.
      return "watchlist";
    case MINI_APP_PAYLOAD_NAMES.quietHours:
      return "quiet-hours";
    case MINI_APP_PAYLOAD_NAMES.home:
      return "home";
    case MINI_APP_PAYLOAD_NAMES.settings:
      return "settings";
    case MINI_APP_PAYLOAD_NAMES.watchlist:
      return "watchlist";
    case MINI_APP_PAYLOAD_NAMES.presets:
      return "presets";
    case MINI_APP_PAYLOAD_NAMES.snooze:
      return "snooze";
    case MINI_APP_PAYLOAD_NAMES.health:
      return "health";
    case MINI_APP_PAYLOAD_NAMES.forget:
      return "forget";
  }
}
