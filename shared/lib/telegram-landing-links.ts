// Landing-page deep-link tokens. They only route `/start` and `startapp` to
// the right destination; no click or funnel telemetry is attached to them.
export type TelegramLandingDestination = "setup" | "miniapp_home" | "miniapp_watchlist";

export interface TelegramLandingLinkEntry {
  placement: "hero" | "setup" | "miniapp_setup" | "miniapp_home" | "miniapp_watchlist";
  token: string;
  destination: TelegramLandingDestination;
}

export const TELEGRAM_LANDING_LINK_CATALOG = Object.freeze([
  { placement: "hero", token: "pw1_landing_hero", destination: "setup" },
  { placement: "setup", token: "pw1_landing_setup", destination: "setup" },
  { placement: "miniapp_setup", token: "pw1_landing_miniapp_setup", destination: "miniapp_home" },
  { placement: "miniapp_home", token: "pw1_landing_miniapp_home", destination: "miniapp_home" },
  { placement: "miniapp_watchlist", token: "pw1_landing_miniapp_watchlist", destination: "miniapp_watchlist" },
] as const satisfies readonly TelegramLandingLinkEntry[]);

const CATALOG_BY_TOKEN = new Map<string, TelegramLandingLinkEntry>(
  TELEGRAM_LANDING_LINK_CATALOG.map((entry) => [entry.token, entry]),
);
const CATALOG_BY_PLACEMENT = new Map<string, TelegramLandingLinkEntry>(
  TELEGRAM_LANDING_LINK_CATALOG.map((entry) => [entry.placement, entry]),
);

export type TelegramLandingPlacement = (typeof TELEGRAM_LANDING_LINK_CATALOG)[number]["placement"];

export function parseTelegramLandingToken(raw: string | null | undefined): TelegramLandingLinkEntry | null {
  if (!raw) return null;
  return CATALOG_BY_TOKEN.get(raw.trim().toLowerCase()) ?? null;
}

export function telegramLandingEntryForPlacement(placement: TelegramLandingPlacement): TelegramLandingLinkEntry {
  const entry = CATALOG_BY_PLACEMENT.get(placement);
  if (!entry) throw new Error(`Unknown Telegram landing placement: ${placement}`);
  return entry;
}
