import { sendToChat, type TelegramCreds } from "../lib/telegram";

export type CronSentinelRuleSource =
  | "freshness"
  | "digest-publication"
  | "duration"
  | "turnover"
  | "reserve-post-sync"
  | "growth"
  | "repair-debt";

/**
 * Rule ids per watchdog source, published in `cron_runs.metadata` so an
 * operator can map a degraded sentinel run to the watchdog that raised it.
 *
 * The conditions are documentation, not configuration — each watchdog owns its
 * own thresholds, cooldowns and sustain windows in code:
 * - `freshness`: `producer-stale` (producer age exceeds its consumer policy),
 *   `detail-write-failure` (a fresh detail cache write-failure marker exists).
 * - `digest-publication`: `daily-row`, `daily-telegram`, `daily-twitter`,
 *   `weekly-row`, `weekly-telegram`, `weekly-twitter` (edition missing after
 *   its due time) and `map-producer-lag` (Safety Score map manifest missing).
 * - `duration`: `duration-average` (7-day average reaches 80% of timeout),
 *   `duration-cap-hits`, `duration-budget-truncations` and `slot-abandonment`
 *   (three recent occurrences).
 * - `turnover`: `dex-route-turnover` (published route-set Jaccard distance
 *   reaches the watchdog threshold).
 * - `reserve-post-sync`: `reserve-collateral-drift`, `reserve-curated-fallback`,
 *   `reserve-persistent-stale-warning`, `reserve-drift-cache-age`,
 *   `reserve-persistent-stale`.
 * - `growth`: `mint-burn-row-growth` (event rows reach 2,300,000).
 * - `repair-debt`: `repair-debt-due`, `repair-debt-stale-claim`.
 */
export const CRON_SENTINEL_RULE_IDS: Record<CronSentinelRuleSource, readonly string[]> = {
  freshness: ["producer-stale", "detail-write-failure"],
  "digest-publication": [
    "daily-row",
    "daily-telegram",
    "daily-twitter",
    "weekly-row",
    "weekly-telegram",
    "weekly-twitter",
    "map-producer-lag",
  ],
  duration: [
    "duration-average",
    "duration-cap-hits",
    "duration-budget-truncations",
    "slot-abandonment",
  ],
  turnover: ["dex-route-turnover"],
  "reserve-post-sync": [
    "reserve-collateral-drift",
    "reserve-curated-fallback",
    "reserve-persistent-stale-warning",
    "reserve-drift-cache-age",
    "reserve-persistent-stale",
  ],
  growth: ["mint-burn-row-growth"],
  "repair-debt": ["repair-debt-due", "repair-debt-stale-claim"],
};

export async function deliverOperatorAlert(
  creds: TelegramCreds,
  text: string,
  signal?: AbortSignal,
) {
  return sendToChat(creds.chatId, text, creds.botToken, {
    disableWebPagePreview: true,
    signal,
  });
}
