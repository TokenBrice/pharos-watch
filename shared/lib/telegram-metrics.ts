/**
 * Semantic registry for public Telegram watcher/chat metrics (TGB-044).
 *
 * Companion to the pulse/status DTOs in `shared/types/status/telegram.ts`
 * (`TelegramPulse.activeWatchers`, `TelegramPulse.coinSubscriptions`,
 * `TelegramBotStats.totalChats`). Every public surface (homepage status bar,
 * /pharoswatchbot pulse board, /status service summary) labels these values
 * through this registry so the same metric always carries the same name and
 * definition, while distinct lifecycle concepts (active vs registered) stay
 * distinct instead of all being renamed to "watchers".
 */
export interface TelegramMetricSemantic {
  /** Canonical display label used verbatim (or lowercased inline) everywhere. */
  label: string;
  /** What the number actually counts; the definition surfaces share. */
  description: string;
}

export const TELEGRAM_METRIC_SEMANTICS = {
  /** `TelegramPulse.activeWatchers` / lifecycle snapshot `activeWatchers`. */
  activeWatchers: {
    label: "Active watchers",
    description:
      "Chats with at least one alert family enabled globally or at least one live coin/preset follow; the pulse refreshes every five minutes and history uses the daily lifecycle aggregate.",
  },
  /** `TelegramPulse.coinSubscriptions` (explicit + preset-implied follows). */
  coinFollows: {
    label: "Alert follows",
    description: "Coin-level alert routes: explicit follows plus current preset-implied members.",
  },
  /** `TelegramBotStats.totalChats` on the status page. */
  registeredChats: {
    label: "Registered chats",
    description:
      "Every chat with a subscriber row, including paused, muted, or empty chats, until inactivity cleanup removes them.",
  },
} as const satisfies Record<string, TelegramMetricSemantic>;

/**
 * Singular/plural noun selection for count phrases ("1 preset", "3 presets").
 * Returns the noun only; callers format the number themselves.
 */
export function pluralizeCount(count: number, singular: string, plural = `${singular}s`): string {
  return count === 1 ? singular : plural;
}
