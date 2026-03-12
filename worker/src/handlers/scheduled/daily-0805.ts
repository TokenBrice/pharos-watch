import { syncBluechip } from "../../cron/sync-bluechip";
import { generateDailyDigest } from "../../cron/daily-digest";
import { runDiscoveryScan } from "../../cron/discovery-scan";
import type { ScheduledRuntimeContext } from "./context";

export function runDaily0805Slot(runtime: ScheduledRuntimeContext): void {
  runtime.ctx.waitUntil(runtime.runLeasedCron("sync-bluechip", (signal) => syncBluechip(runtime.db, signal)));
  runtime.ctx.waitUntil(runtime.runLeasedCron("daily-digest", (signal) => {
    const twitterCreds =
      runtime.env.TWITTER_API_KEY &&
      runtime.env.TWITTER_API_SECRET &&
      runtime.env.TWITTER_ACCESS_TOKEN &&
      runtime.env.TWITTER_ACCESS_TOKEN_SECRET
        ? {
            apiKey: runtime.env.TWITTER_API_KEY,
            apiSecret: runtime.env.TWITTER_API_SECRET,
            accessToken: runtime.env.TWITTER_ACCESS_TOKEN,
            accessTokenSecret: runtime.env.TWITTER_ACCESS_TOKEN_SECRET,
          }
        : null;
    const telegramCreds =
      runtime.env.TELEGRAM_BOT_TOKEN && runtime.env.TELEGRAM_CHAT_ID
        ? { botToken: runtime.env.TELEGRAM_BOT_TOKEN, chatId: runtime.env.TELEGRAM_CHAT_ID }
        : null;
    return generateDailyDigest(
      runtime.db,
      runtime.env.ANTHROPIC_API_KEY ?? null,
      twitterCreds,
      false,
      telegramCreds,
      signal,
    );
  }));
  runtime.ctx.waitUntil(runtime.runLeasedCron("discovery-scan", (signal) => runDiscoveryScan(runtime.db, signal)));
}
