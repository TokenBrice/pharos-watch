import { sendToChat, type TelegramCreds } from "../telegram/delivery/telegram";

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
 *   `detail-write-failure` (a fresh detail cache write-failure marker exists),
 *   `dependency-recovery-lag` (DEX liquidity recovered but DEWS is still stale),
 *   `safety-publication-held` (the Safety Score publication is held),
 *   `fx-source-stale` (the FX cache's worst per-peg source is stale),
 *   `fx-cached-fallback` (FX rates are republished from cache),
 *   `daily-lane-completion` (a daily cache lane missed its slot) and
 *   `bluechip-coverage` (a mapped Bluechip constituent is past its observation
 *   budget).
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
 *   `reserve-persistent-stale`, `reserve-sync-degraded` (a configured coin's
 *   latest reserve sync is `degraded` or `error`),
 *   `reserve-adapter-failure-sustained` (three consecutive failed cycles) and
 *   `reserve-source-clock-stalled` (successful verified attempts whose source
 *   clock is not advancing inside its source-age budget). Those two are
 *   transition-only and send no Telegram: they stay on `/status` and in this
 *   run metadata.
 * - `growth`: `mint-burn-row-growth` (event rows reach 2,300,000).
 * - `repair-debt`: `repair-debt-due`, `repair-debt-stale-claim`.
 */
export const CRON_SENTINEL_RULE_IDS: Record<CronSentinelRuleSource, readonly string[]> = {
  freshness: [
    "producer-stale",
    "detail-write-failure",
    "dependency-recovery-lag",
    "safety-publication-held",
    "fx-source-stale",
    "fx-cached-fallback",
    "daily-lane-completion",
    "bluechip-coverage",
  ],
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
    "reserve-sync-degraded",
    "reserve-adapter-failure-sustained",
    "reserve-source-clock-stalled",
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
