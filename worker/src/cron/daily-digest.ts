import type { CronProgressReporter, CronResult } from "../lib/cron-logger";
import { postDigestTweet, type TwitterCreds } from "../lib/twitter";
import { postDigestToTelegram, type TelegramCreds } from "../lib/telegram";
import { SECONDS } from "../lib/time-constants";
import { formatIsoDate } from "@shared/lib/format";
import { CIRCUIT_SOURCE } from "../lib/constants";
import { getCache, setCache, deleteCache } from "../lib/db-cache";
import { prepareTelegramDigestAppendices, type PreparedTelegramDigestAppendices } from "../lib/telegram-digest-appendices";
import { buildDailyDigestInput } from "./daily-digest/input";
import { buildUserPrompt, SYSTEM_PROMPT } from "./daily-digest/prompt";
import { insertDigestRecord, requestDigestCopy, runDigestChannelDelivery } from "./digest/platform";
import { reportDigestProgress } from "./digest/progress";
import { formatQualityMetadata } from "./digest/quality-metadata";
import { logDailyDigestLlmCall } from "./daily-digest/runtime-helpers";
import { NON_WEEKLY_DIGEST_SQL_FILTER } from "./daily-digest/shared";
import { buildCriticalDailyLeadRequirements } from "./daily-digest/critical-lead-requirements";
import { attachDigestEditorialAudit } from "./daily-digest/digest-intelligence";

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
  reportProgress?: CronProgressReporter,
): Promise<CronResult> {
  await reportDigestProgress(reportProgress, {
    stage: "preflight",
    message: "Checking daily digest generation prerequisites",
    providerFamily: "digest",
    itemsDone: 0,
    itemsTotal: 1,
    metadata: {
      countTotals: {
        forceRun: force ? 1 : 0,
        configuredDeliveryChannels: Number(Boolean(twitterCreds)) + Number(Boolean(telegramCreds)),
      },
    },
  });
  if (!anthropicApiKey) {
    console.log("[daily-digest] No API key configured, skipping");
    await reportDigestProgress(reportProgress, {
      stage: "skipped",
      message: "Skipping daily digest because Anthropic credentials are missing",
      providerFamily: "anthropic",
      itemsDone: 0,
      itemsTotal: 1,
      metadata: {
        skipped: "missing-api-key",
      },
    });
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
      await reportDigestProgress(reportProgress, {
        stage: "skipped",
        message: "Skipping daily digest because a recent digest exists",
        providerFamily: "digest",
        itemsDone: 0,
        itemsTotal: 1,
        metadata: {
          skipped: "recent-digest",
          ageSec,
        },
      });
      return { metadata: "skipped: recent digest exists" };
    }
    if (isBroken) {
      console.log("[daily-digest] Latest digest is malformed (code-block response), regenerating");
    }
  }

  await reportDigestProgress(reportProgress, {
    stage: "input-collection",
    message: "Collecting daily digest market context",
    providerFamily: "pharos-d1",
    itemsDone: 0,
    itemsTotal: 1,
  });
  const digestInput = await buildDailyDigestInput(db);
  const { inputData, degradedReasons, recentMeta, llmSignals, stablecoinsCacheReason } = digestInput;
  if (stablecoinsCacheReason) {
    await reportDigestProgress(reportProgress, {
      stage: "input-unavailable",
      message: "Daily digest stablecoins cache is unavailable",
      providerFamily: "pharos-d1",
      itemsDone: 0,
      itemsTotal: 1,
      metadata: {
        stablecoinsCacheReason,
      },
    });
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
  const leadRequirements = buildCriticalDailyLeadRequirements(inputData);
  await reportDigestProgress(reportProgress, {
    stage: "input-collected",
    message: "Collected daily digest context",
    providerFamily: "pharos-d1",
    itemsDone: 1,
    itemsTotal: 1,
    metadata: {
      countTotals: {
        recentDigestMeta: recentMeta.length,
        activeDepegs: llmSignals.activeDepegCount,
        topDepegs: llmSignals.topDepegs.length,
        resolvedDepegs: llmSignals.resolvedDepegs.length,
        yieldAnomalies: llmSignals.yieldAnomalies.length,
        liquidityShifts: llmSignals.liquidityShifts.length,
        degradedReasons: degradedReasons.length,
      },
      leadRequirementCount: leadRequirements?.length ?? 0,
    },
  });

  logDailyDigestLlmCall({
    activeDepegCount: llmSignals.activeDepegCount,
    topDepegs: llmSignals.topDepegs,
    resolvedDepegs: llmSignals.resolvedDepegs,
    yieldAnomalies: llmSignals.yieldAnomalies,
    liquidityShifts: llmSignals.liquidityShifts,
    recentMeta,
    degradedReasons,
  });
  await reportDigestProgress(reportProgress, {
    stage: "llm-generation",
    message: "Requesting daily digest copy from Anthropic",
    providerFamily: "anthropic",
    itemsDone: 0,
    itemsTotal: 1,
    metadata: {
      countTotals: {
        promptChars: userPromptContent.length,
        maxTokens: 64000,
      },
    },
  });
  const digestCopy = await requestDigestCopy({
    db,
    anthropicApiKey,
    systemPrompt: SYSTEM_PROMPT,
    userPrompt: userPromptContent,
    // Opus 4.7 xhigh needs this floor; see digest/platform.ts for the effort rationale.
    maxTokens: 64000,
    signal,
    logPrefix: "daily-digest",
    validationProfile: {
      kind: "daily",
      recentMeta: recentMeta.map((entry) => ({
        meta: entry.meta as Record<string, unknown> | null,
        title: entry.title,
        rawText: entry.rawText,
      })),
      leadRequirements,
    },
  });
  if (digestCopy.kind === "circuit-open") {
    await reportDigestProgress(reportProgress, {
      stage: "skipped",
      message: "Skipping daily digest because Anthropic circuit is open",
      providerFamily: "anthropic",
      itemsDone: 0,
      itemsTotal: 1,
      metadata: {
        skipped: "anthropic-circuit-open",
      },
    });
    return { status: "degraded", itemCount: 0, metadata: "skipped: anthropic circuit open" };
  }
  await reportDigestProgress(reportProgress, {
    stage: "llm-generation-complete",
    message: "Received daily digest copy from Anthropic",
    providerFamily: "anthropic",
    itemsDone: 1,
    itemsTotal: 1,
    metadata: {
      countTotals: {
        textChars: digestCopy.digestText.length,
        extendedChars: digestCopy.digestExtended.length,
        qualityIssues: digestCopy.qualityIssues.length,
      },
      blockingQualityIssues: digestCopy.hasBlockingQualityIssues,
    },
  });

  const storedInputData = attachDigestEditorialAudit({ inputData, digestMeta: digestCopy.digestMeta, qualityIssues: digestCopy.qualityIssues, leadRequirements });
  const now = Math.floor(Date.now() / 1000);
  await reportDigestProgress(reportProgress, {
    stage: "persistence",
    message: "Persisting daily digest row",
    providerFamily: "d1",
    itemsDone: 0,
    itemsTotal: 1,
  });
  await insertDigestRecord({
    db,
    generatedAt: now,
    digestText: digestCopy.digestText,
    digestTitle: digestCopy.digestTitle || null,
    inputData: storedInputData,
    digestExtended: digestCopy.digestExtended || null,
    digestMeta: digestCopy.digestMeta,
  });
  // SAFETY: NON_WEEKLY_DIGEST_SQL_FILTER is a hardcoded SQL fragment, not derived from user input.
  const countResult = await db
    .prepare(`SELECT COUNT(*) as cnt FROM daily_digest WHERE ${NON_WEEKLY_DIGEST_SQL_FILTER}`)
    .all<{ cnt: number }>();
  const editionNumber = (countResult.results?.[0] as { cnt: number } | undefined)?.cnt ?? null;

  const qualityGateStatus = digestCopy.hasBlockingQualityIssues ? "skipped: quality-gate" : null;

  await reportDigestProgress(reportProgress, {
    stage: "twitter-delivery",
    message: "Delivering daily digest to Twitter/X",
    providerFamily: "twitter-api",
    itemsDone: 0,
    itemsTotal: 1,
    metadata: {
      qualityGateStatus,
    },
  });
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

  await reportDigestProgress(reportProgress, {
    stage: "telegram-delivery",
    message: "Delivering daily digest to Telegram",
    providerFamily: "telegram-api",
    itemsDone: 0,
    itemsTotal: 1,
    metadata: {
      qualityGateStatus,
      twitterStatus: tweetStatus,
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

      const date = formatIsoDate(now);
      const markerKey = getTelegramSentMarkerKey(date);
      const sentMarker = await getCache(db, markerKey);

      if (!sentMarker) {
        // Write the idempotency marker BEFORE sending so a marker-write
        // failure leaves the send unattempted (and surfaces as a hard cron
        // failure via the channel-delivery wrapper) rather than risking a
        // duplicate send on the next run. If the send itself fails, roll the
        // marker back so a genuine delivery failure can be retried.
        await setCache(
          db,
          markerKey,
          JSON.stringify({ sentAt: now, editionNumber }),
        );
        try {
          await postDigestToTelegram(
            digestCopy.digestTitle,
            digestCopy.digestExtended,
            date,
            creds,
            editionNumber,
            telegramAppendices?.appendixHtml ?? null,
          );
          if (telegramAppendices?.metadata.hasAppendix) {
            // Keep appendix pointer advancement coupled to an accepted
            // Telegram post; already-sent same-day retries must not consume
            // the next digest's pending notices.
            try {
              await telegramAppendices.commitSuccess();
            } catch (err) {
              degradedReasons.push("telegram-appendix-commit");
              console.error("[daily-digest] Failed to commit Telegram digest appendix state:", err);
            }
          }
        } catch (err) {
          try {
            await deleteCache(db, markerKey);
          } catch (rollbackErr) {
            degradedReasons.push("telegram-send-marker-rollback");
            console.error("[daily-digest] Failed to roll back Telegram send marker after delivery failure:", rollbackErr);
          }
          throw err;
        }
      }
      if (sentMarker) return "skipped: already-sent";
      const appendixSuffix = telegramAppendices?.metadata.hasAppendix
        ? `+appendix(cemetery=${telegramAppendices.metadata.cemeteryDetected},tracked=${telegramAppendices.metadata.trackedDetected},prelaunch=${telegramAppendices.metadata.preLaunchDetected})`
        : "";
      return `ok${appendixSuffix}`;
    },
  });

  const qualityMetadata = formatQualityMetadata(digestCopy.qualityIssues);

  await reportDigestProgress(reportProgress, {
    stage: "complete",
    message: "Completed daily digest generation",
    providerFamily: "digest",
    itemsDone: 1,
    itemsTotal: 1,
    metadata: {
      countTotals: {
        editionNumber,
        textChars: digestCopy.digestText.length,
        extendedChars: digestCopy.digestExtended.length,
        degradedReasons: degradedReasons.length,
        qualityIssues: digestCopy.qualityIssues.length,
      },
      twitterStatus: tweetStatus,
      telegramStatus,
    },
  });
  console.log(`[daily-digest] Generated and stored digest: "${digestCopy.digestTitle}" (${digestCopy.digestText.length} chars + ${digestCopy.digestExtended.length} extended), tweet: ${tweetStatus}, telegram: ${telegramStatus}${qualityMetadata}`);
  return {
    itemCount: 1,
    ...(degradedReasons.length > 0 || digestCopy.hasBlockingQualityIssues ? { status: "degraded" as const } : {}),
    metadata: `${digestCopy.digestText.length} chars, tweet: ${tweetStatus}, telegram: ${telegramStatus}${degradedReasons.length > 0 ? `, degraded: ${degradedReasons.join("|")}` : ""}${qualityMetadata}`,
  };
}
