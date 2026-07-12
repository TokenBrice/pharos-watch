/**
 * Runtime-neutral policy for personalized Telegram recaps. Keep delivery and
 * formatting bounds here so the planner and load model share one contract.
 */
export const TELEGRAM_RECAP_FORMATTER_VERSION = 1;
export const TELEGRAM_RECAP_CADENCE = "daily" as const;
export const TELEGRAM_RECAP_DEFAULT_DELIVERY_HOUR_LOCAL = 9;
export const TELEGRAM_RECAP_LOOKBACK_SEC = 36 * 60 * 60;
export const TELEGRAM_RECAP_FIRST_LOOKBACK_SEC = 24 * 60 * 60;
export const TELEGRAM_RECAP_TTL_SEC = 6 * 60 * 60;
export const TELEGRAM_RECAP_PENDING_PRIORITY = 100;
export const TELEGRAM_RECAP_DUE_PAGE_SIZE = 90;
export const TELEGRAM_RECAP_MAX_PAGES_PER_RUN = 10;
export const TELEGRAM_RECAP_MAX_RECIPIENTS_PER_RUN =
  TELEGRAM_RECAP_DUE_PAGE_SIZE * TELEGRAM_RECAP_MAX_PAGES_PER_RUN;
/** Stop DB-only planning before it can crowd the shared five-minute cron slot. */
export const TELEGRAM_RECAP_PLANNER_SOFT_DEADLINE_MS = 3 * 60 * 1_000;
/** Shared Tape rows loaded per due page; planner reads one extra row to detect truncation. */
export const TELEGRAM_RECAP_TAPE_PAGE_LIMIT = 1_500;
export const TELEGRAM_RECAP_MAX_COINS = 8;
export const TELEGRAM_RECAP_MAX_FACT_LINES = 12;
export const TELEGRAM_RECAP_TARGET_BODY_CHARACTERS = 3_500;

export const TELEGRAM_RECAP_FACT_TYPES = [
  "depeg.opened",
  "depeg.peak_worsened",
  "depeg.resolved",
  "dews.escalated",
  "dews.deescalated",
  "score.upgraded",
  "score.downgraded",
  "freeze.blocked",
  "freeze.unblocked",
  "freeze.destroyed",
  "mint_burn.large_mint",
  "mint_burn.large_burn",
  "yield.warning_emitted",
  "yield.pys_dropped",
] as const;

export type TelegramRecapFactType = (typeof TELEGRAM_RECAP_FACT_TYPES)[number];

export const TELEGRAM_RECAP_FACT_FAMILIES = [
  "depeg",
  "dews",
  "score",
  "freeze",
  "mint_burn",
  "yield",
] as const;

export type TelegramRecapFactFamily = (typeof TELEGRAM_RECAP_FACT_FAMILIES)[number];

export function isTelegramRecapFactType(value: string): value is TelegramRecapFactType {
  return (TELEGRAM_RECAP_FACT_TYPES as readonly string[]).includes(value);
}
