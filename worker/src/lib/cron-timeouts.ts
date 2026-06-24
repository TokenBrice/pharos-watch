import { PUBLIC_DATASET_CRON_TIMEOUT_MS } from "./public-dataset-snapshot-budget";

export const DEFAULT_CRON_TIMEOUT_MS = 5 * 60_000;

export const CRON_TIMEOUT_MS: Record<string, number> = {
  // Keep app-level timeout below the platform wall-clock limit so we can log
  // a controlled error instead of losing the invocation without a cron_runs row.
  "sync-stablecoins": 8 * 60_000,
  "sync-stablecoin-charts": DEFAULT_CRON_TIMEOUT_MS,
  "sync-fx-rates": DEFAULT_CRON_TIMEOUT_MS,
  "stability-index": DEFAULT_CRON_TIMEOUT_MS,
  "compute-dews": DEFAULT_CRON_TIMEOUT_MS,
  "project-tape": DEFAULT_CRON_TIMEOUT_MS,
  "cron-slot-sweeper": DEFAULT_CRON_TIMEOUT_MS,
  "status-self-check": DEFAULT_CRON_TIMEOUT_MS,
  "data-invariant-canary": DEFAULT_CRON_TIMEOUT_MS,
  "cron-staleness-watchdog": DEFAULT_CRON_TIMEOUT_MS,
  "telegram-degradation-watchdog": DEFAULT_CRON_TIMEOUT_MS,
  "telegram-disambiguation-cleanup": DEFAULT_CRON_TIMEOUT_MS,
  "telegram-pulse-snapshot": DEFAULT_CRON_TIMEOUT_MS,
  "sync-live-reserves": 12 * 60_000,
  "sync-dex-liquidity": 13 * 60_000,
  "sync-dex-discovery": 13 * 60_000,
  "sync-yield-data": 10 * 60_000,
  "sync-yield-supplemental": 12 * 60_000,
  "sync-blacklist": 12 * 60_000,
  "sync-mint-burn": 10 * 60_000,
  "sync-mint-burn-extended": 10 * 60_000,
  // Telegram alert fan-out targets a 15-minute normal SLO for 5k watchers.
  // Keep the app timeout under Cloudflare's scheduled-event ceiling while
  // leaving room for cron_runs logging and sidecar skips.
  "dispatch-telegram-alerts": 14 * 60_000,
  "snapshot-supply": DEFAULT_CRON_TIMEOUT_MS,
  "snapshot-chain-supply": DEFAULT_CRON_TIMEOUT_MS,
  "publish-report-card-cache": DEFAULT_CRON_TIMEOUT_MS,
  "compute-depeg-resolver": DEFAULT_CRON_TIMEOUT_MS,
  "snapshot-safety-grade-history": DEFAULT_CRON_TIMEOUT_MS,
  "fetch-tbill-rate": DEFAULT_CRON_TIMEOUT_MS,
  "snapshot-psi": DEFAULT_CRON_TIMEOUT_MS,
  "snapshot-public-dataset": PUBLIC_DATASET_CRON_TIMEOUT_MS,
  "sync-usds-status": DEFAULT_CRON_TIMEOUT_MS,
  "sync-redemption-backstops": DEFAULT_CRON_TIMEOUT_MS,
  "sync-kinesis-supply": DEFAULT_CRON_TIMEOUT_MS,
  "reserve-post-sync-watchdog": DEFAULT_CRON_TIMEOUT_MS,
  "sync-bluechip": DEFAULT_CRON_TIMEOUT_MS,
  // Daily digest: Anthropic budget is 12 min, wrapper caps at 14 min to leave
  // ~2 min for D1 persistence, Telegram/Twitter delivery, and cron_runs logging
  // before Cloudflare's 15-min scheduled-event ceiling.
  "daily-digest": 14 * 60_000,
  "weekly-recap": 12 * 60_000,
  "discovery-scan": DEFAULT_CRON_TIMEOUT_MS,
  "yield-coverage-audit": DEFAULT_CRON_TIMEOUT_MS,
  "prune-status-probe-runs": DEFAULT_CRON_TIMEOUT_MS,
  "prune-cron-history": DEFAULT_CRON_TIMEOUT_MS,
  "worker-repair-runner": DEFAULT_CRON_TIMEOUT_MS,
  "prune-detail-cache": DEFAULT_CRON_TIMEOUT_MS,
  "telegram-inactive-cleanup": DEFAULT_CRON_TIMEOUT_MS,
  "telegram-retention-cleanup": DEFAULT_CRON_TIMEOUT_MS,
  "mint-burn-growth-watchdog": DEFAULT_CRON_TIMEOUT_MS,
  "cron-duration-watchdog": DEFAULT_CRON_TIMEOUT_MS,
};
