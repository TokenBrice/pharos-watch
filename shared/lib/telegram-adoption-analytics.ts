export const TELEGRAM_ADOPTION_CTA_ENDPOINT = "/pharoswatchbot-adoption";
export const TELEGRAM_ADOPTION_TOKEN_VERSION = "pw1";
export const TELEGRAM_ADOPTION_LOW_COUNT_THRESHOLD = 5;

export const TELEGRAM_ADOPTION_CAMPAIGNS = ["landing", "organic"] as const;
export type TelegramAdoptionCampaign = (typeof TELEGRAM_ADOPTION_CAMPAIGNS)[number];

export const TELEGRAM_ADOPTION_PLACEMENTS = [
  "hero",
  "setup",
  "miniapp_setup",
  "miniapp_home",
  "miniapp_watchlist",
  "menu",
  "unknown",
] as const;
export type TelegramAdoptionPlacement = (typeof TELEGRAM_ADOPTION_PLACEMENTS)[number];

export const TELEGRAM_ADOPTION_CTA_PLACEMENTS = [
  "hero",
  "setup",
  "miniapp_setup",
  "miniapp_home",
  "miniapp_watchlist",
] as const;

export const TELEGRAM_ADOPTION_FEATURES = [
  "",
  "direct",
  "preset",
  "global",
  "recommended_setup",
  "coin",
  "settings",
  "quiet_hours",
  "snooze",
  "timezone",
  "unsubscribe",
  "forget",
  "other",
] as const;
export type TelegramAdoptionFeature = (typeof TELEGRAM_ADOPTION_FEATURES)[number];

export type TelegramAdoptionDestination = "setup" | "miniapp_home" | "miniapp_watchlist";

export interface TelegramAdoptionCatalogEntry {
  campaign: "landing";
  placement: Exclude<TelegramAdoptionPlacement, "menu" | "unknown">;
  token: string;
  destination: TelegramAdoptionDestination;
}

export const TELEGRAM_ADOPTION_CATALOG = Object.freeze([
  { campaign: "landing", placement: "hero", token: "pw1_landing_hero", destination: "setup" },
  { campaign: "landing", placement: "setup", token: "pw1_landing_setup", destination: "setup" },
  {
    campaign: "landing",
    placement: "miniapp_setup",
    token: "pw1_landing_miniapp_setup",
    destination: "miniapp_home",
  },
  {
    campaign: "landing",
    placement: "miniapp_home",
    token: "pw1_landing_miniapp_home",
    destination: "miniapp_home",
  },
  {
    campaign: "landing",
    placement: "miniapp_watchlist",
    token: "pw1_landing_miniapp_watchlist",
    destination: "miniapp_watchlist",
  },
] as const satisfies readonly TelegramAdoptionCatalogEntry[]);

const CATALOG_BY_TOKEN = new Map<string, TelegramAdoptionCatalogEntry>(
  TELEGRAM_ADOPTION_CATALOG.map((entry) => [entry.token, entry]),
);
const CATALOG_BY_PLACEMENT = new Map<string, TelegramAdoptionCatalogEntry>(
  TELEGRAM_ADOPTION_CATALOG.map((entry) => [entry.placement, entry]),
);

export type TelegramAdoptionCatalogPlacement = (typeof TELEGRAM_ADOPTION_CATALOG)[number]["placement"];

export function parseTelegramAdoptionToken(raw: string | null | undefined): TelegramAdoptionCatalogEntry | null {
  if (!raw) return null;
  return CATALOG_BY_TOKEN.get(raw.trim().toLowerCase()) ?? null;
}

export function telegramAdoptionEntryForPlacement(
  placement: TelegramAdoptionCatalogPlacement,
): TelegramAdoptionCatalogEntry {
  const entry = CATALOG_BY_PLACEMENT.get(placement);
  if (!entry) throw new Error(`Unknown Telegram adoption placement: ${placement}`);
  return entry;
}

export function telegramAdoptionSource(
  raw: string | null | undefined,
): { campaign: TelegramAdoptionCampaign; placement: TelegramAdoptionPlacement } {
  const entry = parseTelegramAdoptionToken(raw);
  return entry
    ? { campaign: entry.campaign, placement: entry.placement }
    : { campaign: "organic", placement: "unknown" };
}
