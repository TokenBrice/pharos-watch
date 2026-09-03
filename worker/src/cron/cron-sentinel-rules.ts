import { sendToChat, type TelegramCreds } from "../lib/telegram";

export type CronSentinelRuleSource =
  | "freshness"
  | "digest-publication"
  | "duration"
  | "turnover"
  | "reserve-post-sync"
  | "growth"
  | "repair-debt";

export interface CronSentinelRule {
  id: string;
  source: CronSentinelRuleSource;
  condition: string;
  severity: "warning" | "error";
  cooldownSec: number;
  sustainedSec: number;
}

export const CRON_SENTINEL_RULES = [
  { id: "producer-stale", source: "freshness", condition: "producer age exceeds its consumer policy", severity: "warning", cooldownSec: 1_800, sustainedSec: 0 },
  { id: "detail-write-failure", source: "freshness", condition: "fresh detail cache write-failure marker exists", severity: "warning", cooldownSec: 1_800, sustainedSec: 0 },
  { id: "daily-row", source: "digest-publication", condition: "daily digest row missing after due time", severity: "warning", cooldownSec: 1_800, sustainedSec: 0 },
  { id: "daily-telegram", source: "digest-publication", condition: "daily Telegram edition missing after due time", severity: "warning", cooldownSec: 1_800, sustainedSec: 0 },
  { id: "daily-twitter", source: "digest-publication", condition: "daily Twitter edition missing after due time", severity: "warning", cooldownSec: 1_800, sustainedSec: 0 },
  { id: "weekly-row", source: "digest-publication", condition: "weekly recap row missing after due time", severity: "warning", cooldownSec: 1_800, sustainedSec: 0 },
  { id: "weekly-telegram", source: "digest-publication", condition: "weekly Telegram edition missing after due time", severity: "warning", cooldownSec: 1_800, sustainedSec: 0 },
  { id: "weekly-twitter", source: "digest-publication", condition: "weekly Twitter edition missing after due time", severity: "warning", cooldownSec: 1_800, sustainedSec: 0 },
  { id: "map-producer-lag", source: "digest-publication", condition: "Safety Score map manifest missing after due time", severity: "warning", cooldownSec: 0, sustainedSec: 0 },
  { id: "duration-average", source: "duration", condition: "7-day average reaches 80% of timeout", severity: "warning", cooldownSec: 0, sustainedSec: 0 },
  { id: "duration-cap-hits", source: "duration", condition: "three recent timeout-cap hits", severity: "warning", cooldownSec: 0, sustainedSec: 86_400 },
  { id: "duration-budget-truncations", source: "duration", condition: "three recent unpersisted budget truncations", severity: "warning", cooldownSec: 0, sustainedSec: 86_400 },
  { id: "slot-abandonment", source: "duration", condition: "three recent abandoned slots at ten-percent ratio", severity: "warning", cooldownSec: 0, sustainedSec: 86_400 },
  { id: "dex-route-turnover", source: "turnover", condition: "published route-set Jaccard distance reaches 0.5", severity: "warning", cooldownSec: 0, sustainedSec: 0 },
  { id: "reserve-collateral-drift", source: "reserve-post-sync", condition: "one or more collateral scores drift from curated values", severity: "warning", cooldownSec: 0, sustainedSec: 0 },
  { id: "reserve-curated-fallback", source: "reserve-post-sync", condition: "more than five live-enabled coins use curated fallback", severity: "warning", cooldownSec: 0, sustainedSec: 0 },
  { id: "reserve-persistent-stale-warning", source: "reserve-post-sync", condition: "more than three independent sources are persistently stale or the oldest exceeds 21 days", severity: "warning", cooldownSec: 0, sustainedSec: 0 },
  { id: "reserve-drift-cache-age", source: "reserve-post-sync", condition: "reserve drift/cache-age evaluation fails", severity: "warning", cooldownSec: 0, sustainedSec: 0 },
  { id: "reserve-persistent-stale", source: "reserve-post-sync", condition: "persistent-stale reserve overview evaluation fails", severity: "warning", cooldownSec: 0, sustainedSec: 0 },
  { id: "mint-burn-row-growth", source: "growth", condition: "mint/burn event rows reach 2,300,000", severity: "warning", cooldownSec: 0, sustainedSec: 0 },
  { id: "repair-debt-due", source: "repair-debt", condition: "due repair debt is inspected and drained", severity: "warning", cooldownSec: 0, sustainedSec: 0 },
  { id: "repair-debt-stale-claim", source: "repair-debt", condition: "stale repair claims are inspected and reconciled", severity: "warning", cooldownSec: 0, sustainedSec: 0 },
] as const satisfies readonly CronSentinelRule[];

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
