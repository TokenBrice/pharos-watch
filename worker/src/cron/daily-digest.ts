import { type CronResult } from "../lib/cron-logger";
import { postDigestTweet, type TwitterCreds } from "../lib/twitter";
import { postDigestToTelegram, type TelegramCreds } from "../lib/telegram";
import { SECONDS } from "../lib/time-constants";
import { CIRCUIT_SOURCE } from "../lib/constants";
import { getCache, setCache } from "../lib/db-cache";
import {
  prepareTelegramDigestAppendices,
  type PreparedTelegramDigestAppendices,
} from "../lib/telegram-digest-appendices";
import { buildDailyDigestInput } from "./daily-digest/input";
import { buildUserPrompt, SYSTEM_PROMPT } from "./daily-digest/prompt";
import {
  insertDigestRecord,
  requestDigestCopy,
  runDigestChannelDelivery,
} from "./digest/platform";
import { logDailyDigestLlmCall } from "./daily-digest/runtime-helpers";
import { NON_WEEKLY_DIGEST_SQL_FILTER } from "./daily-digest/shared";

export { classifyRegime } from "./daily-digest/prompt";

const TELEGRAM_SENT_MARKER_PREFIX = "daily-digest:telegram-sent:";

function getTelegramSentMarkerKey(date: string): string {
  return `${TELEGRAM_SENT_MARKER_PREFIX}${date}`;
}
export async function generateDailyDigest(
  db: D1Database,
  anthropicApiKey: string | null,
  twitterCreds: TwitterCreds | null = null,
  force = false,
  telegramCreds: TelegramCreds | null = null,
  signal?: AbortSignal,
): Promise<CronResult> {
  if (!anthropicApiKey) {
    console.log("[daily-digest] No API key configured, skipping");
    return { metadata: "skipped: no API key" };
  }

  // Check if latest digest is <1h old and valid (not a broken code-block response)
  const latest = await db
    .prepare(
      "SELECT generated_at, digest_text FROM daily_digest ORDER BY generated_at DESC LIMIT 1",
    )
    .first<{ generated_at: number; digest_text: string }>();

  if (latest) {
    const ageSec = Math.floor(Date.now() / 1000) - latest.generated_at;
    const isBroken = latest.digest_text.trimStart().startsWith("```");
    if (ageSec < SECONDS.ONE_HOUR && !isBroken && !force) {
      console.log(
        `[daily-digest] Latest digest is ${Math.round(ageSec / 60)}min old, skipping`,
      );
      return { metadata: "skipped: recent digest exists" };
    }
    if (isBroken) {
      console.log("[daily-digest] Latest digest is malformed (code-block response), regenerating");
    }
  }

  const digestInput = await buildDailyDigestInput(db);
  const { inputData, degradedReasons, recentMeta, llmSignals, stablecoinsCacheReason } = digestInput;
  if (stablecoinsCacheReason) {
    return {
      status: "degraded",
      itemCount: 0,
      metadata: JSON.stringify({
        reason: "stablecoins-cache-unavailable",
        stablecoinsCacheReason,
        skipped: true,
      }),
    };
  }
  const userPromptContent = buildUserPrompt(inputData, recentMeta);

  logDailyDigestLlmCall({
    activeDepegCount: llmSignals.activeDepegCount,
    topDepegs: llmSignals.topDepegs,
    resolvedDepegs: llmSignals.resolvedDepegs,
    yieldAnomalies: llmSignals.yieldAnomalies,
    liquidityShifts: llmSignals.liquidityShifts,
    recentMeta,
    degradedReasons,
  });
  const digestCopy = await requestDigestCopy({
    db,
    anthropicApiKey,
    systemPrompt: SYSTEM_PROMPT,
    userPrompt: userPromptContent,
    maxTokens: 16000,
    signal,
    logPrefix: "daily-digest",
    validationProfile: {
      kind: "daily",
      recentMeta: recentMeta.map((entry) => ({
        meta: entry.meta as Record<string, unknown> | null,
        title: entry.title,
      })),
    },
  });
  if (digestCopy.kind === "circuit-open") {
    throw new Error("Anthropic circuit open — skipping LLM call");
  }

  const now = Math.floor(Date.now() / 1000);
  await insertDigestRecord({
    db,
    generatedAt: now,
    digestText: digestCopy.digestText,
    digestTitle: digestCopy.digestTitle || null,
    inputData,
    digestExtended: digestCopy.digestExtended || null,
    digestMeta: digestCopy.digestMeta,
  });
  // SAFETY: NON_WEEKLY_DIGEST_SQL_FILTER is a hardcoded SQL fragment, not derived from user input.
  const countResult = await db
    .prepare(`SELECT COUNT(*) as cnt FROM daily_digest WHERE ${NON_WEEKLY_DIGEST_SQL_FILTER}`)
    .all<{ cnt: number }>();
  const editionNumber = (countResult.results?.[0] as { cnt: number } | undefined)?.cnt ?? null;

  const qualityGateStatus = digestCopy.hasBlockingQualityIssues ? "skipped: quality-gate" : null;

  const tweetStatus = qualityGateStatus ?? await runDigestChannelDelivery({
    db,
    circuitSource: CIRCUIT_SOURCE.TWITTER_API,
    creds: twitterCreds,
    logPrefix: "daily-digest",
    channelLabel: "Twitter",
    deliver: async (creds) => {
      await postDigestTweet(digestCopy.digestTitle, digestCopy.digestText, creds, editionNumber);
      return "ok";
    },
  });

  const telegramStatus = qualityGateStatus ?? await runDigestChannelDelivery({
    db,
    circuitSource: CIRCUIT_SOURCE.TELEGRAM_API,
    creds: telegramCreds,
    logPrefix: "daily-digest",
    channelLabel: "Telegram",
    deliver: async (creds) => {
      let telegramAppendices: PreparedTelegramDigestAppendices | null = null;
      try {
        telegramAppendices = await prepareTelegramDigestAppendices(db);
      } catch (err) {
        degradedReasons.push("telegram-appendix-state");
        console.error("[daily-digest] Failed to prepare Telegram digest appendices:", err);
      }

      const date = new Date(now * 1000).toISOString().slice(0, 10);
      const markerKey = getTelegramSentMarkerKey(date);
      const sentMarker = await getCache(db, markerKey);

      if (!sentMarker) {
        await postDigestToTelegram(
          digestCopy.digestTitle,
          digestCopy.digestExtended,
          date,
          creds,
          editionNumber,
          telegramAppendices?.appendixHtml ?? null,
        );
        try {
          await setCache(
            db,
            markerKey,
            JSON.stringify({ sentAt: now, editionNumber }),
          );
        } catch (err) {
          degradedReasons.push("telegram-send-marker");
          console.error("[daily-digest] Failed to persist Telegram send marker:", err);
        }
      }
      if (telegramAppendices?.metadata.hasAppendix) {
        try {
          await telegramAppendices.commitSuccess();
        } catch (err) {
          degradedReasons.push("telegram-appendix-commit");
          console.error("[daily-digest] Failed to commit Telegram digest appendix state:", err);
        }
      }
      if (sentMarker) return "skipped: already-sent";
      const appendixSuffix = telegramAppendices?.metadata.hasAppendix
        ? `+appendix(cemetery=${telegramAppendices.metadata.cemeteryDetected},tracked=${telegramAppendices.metadata.trackedDetected},prelaunch=${telegramAppendices.metadata.preLaunchDetected})`
        : "";
      return `ok${appendixSuffix}`;
    },
  });

  const qualityMetadata = digestCopy.qualityIssues.length > 0
    ? `, quality: ${digestCopy.qualityIssues.map((issue) => `${issue.code}:${issue.severity}`).join("|")}`
    : "";

  console.log(`[daily-digest] Generated and stored digest: "${digestCopy.digestTitle}" (${digestCopy.digestText.length} chars + ${digestCopy.digestExtended.length} extended), tweet: ${tweetStatus}, telegram: ${telegramStatus}${qualityMetadata}`);
  return {
    itemCount: 1,
    ...(degradedReasons.length > 0 || digestCopy.qualityIssues.length > 0 ? { status: "degraded" as const } : {}),
    metadata: `${digestCopy.digestText.length} chars, tweet: ${tweetStatus}, telegram: ${telegramStatus}${degradedReasons.length > 0 ? `, degraded: ${degradedReasons.join("|")}` : ""}${qualityMetadata}`,
  };
}
