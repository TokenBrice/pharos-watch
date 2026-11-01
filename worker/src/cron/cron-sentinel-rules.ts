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
 *   `daily-lane-completion` (a daily cache lane missed its slot),
 *   `bluechip-coverage` (a mapped Bluechip constituent is past its observation
 *   budget) and the supply-integrity family: `supply-value-drift`,
 *   `supply-availability`, `supply-carry`, `supply-snapshot-overdue`,
 *   `supply-snapshot-partial`, `supply-charts-history` (two-run confirmed
 *   findings on cached supply values, carry, the daily snapshot, and
 *   chart-history continuity), `blacklist-config-stale` (a blacklist config has
 *   not reached its safe head for two six-hourly producer intervals),
 *   `mint-burn-config-stuck` (an extended-lane config attempted twice without
 *   advancing its frontier), `yield-data-coverage` (two consecutive yield
 *   publications below the pre-event coverage baseline),
 *   `yield-supplemental-family-degraded` (a required supplemental family is
 *   retained, including count-drop holds) and
 *   `measured-execution-chain-coverage` (a chain with score-eligible targets
 *   published no measured quote for two generations).
 * - `digest-publication`: `daily-row`, `daily-telegram`, `daily-twitter`,
 *   `daily-inputs` (a regime-critical collector was degraded in the edition),
 *   `weekly-row`, `weekly-telegram`, `weekly-twitter`, `weekly-inputs` and
 *   `map-producer-lag` (Safety Score map manifest missing).
 * - `duration`: `duration-average` (7-day average reaches 80% of timeout),
 *   `duration-cap-hits`, `duration-budget-truncations` and `slot-abandonment`
 *   (three recent occurrences).
 * - `turnover`: `dex-route-turnover` (published route-set Jaccard distance
 *   reaches the watchdog threshold).
 * - `reserve-post-sync`: `reserve-collateral-drift`, `reserve-curated-fallback`,
 *   `reserve-persistent-stale-warning`, `reserve-drift-cache-age`,
 *   `reserve-persistent-stale`, `reserve-sync-degraded` (a configured coin's
 *   latest reserve sync is `degraded` or `error`),
 *   `reserve-adapter-failure-sustained` (three consecutive failed cycles),
 *   `reserve-score-ineligible-sustained` (three consecutive `degraded`
 *   successes whose snapshots never reach scoring) and
 *   `reserve-source-clock-stalled` (successful verified attempts whose source
 *   clock is not advancing inside its source-age budget),
 *   plus `reserve-composition-census-drift` (a fresh composition's slice census
 *   or share vector changed beyond its budget). The adapter rules are
 *   transition-only; none of these findings sends Telegram: they stay on
 *   `/status`, `metadata.quality` and this run metadata.
 * - `growth`: `mint-burn-row-growth` (event rows reach 2,300,000) and
 *   `mint-burn-activity-collapse` (an enabled leg with a 30-day baseline records
 *   no counted event for a full week).
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
    "supply-value-drift",
    "supply-availability",
    "supply-carry",
    "supply-snapshot-overdue",
    "supply-snapshot-partial",
    "supply-charts-history",
    "blacklist-config-stale",
    "mint-burn-config-stuck",
    "yield-data-coverage",
    "yield-supplemental-family-degraded",
    "measured-execution-chain-coverage",
  ],
  "digest-publication": [
    "daily-row",
    "daily-telegram",
    "daily-twitter",
    "daily-inputs",
    "weekly-row",
    "weekly-telegram",
    "weekly-twitter",
    "weekly-inputs",
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
    "reserve-score-ineligible-sustained",
    "reserve-source-clock-stalled",
    "reserve-composition-census-drift",
  ],
  growth: ["mint-burn-row-growth", "mint-burn-activity-collapse"],
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
