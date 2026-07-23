import { recordCronFailure, type CronProgressReporter, type CronResult } from "../lib/cron-logger";
import { throwIfAborted } from "../lib/abort";
import { postDigestTweet, type TwitterCreds } from "../lib/twitter";
import type { TelegramCreds } from "../lib/telegram";
import { SECONDS } from "../lib/time-constants";
import { formatIsoDate } from "@shared/lib/format";
import { CIRCUIT_SOURCE } from "../lib/constants";
import { deleteCache, setCache } from "../lib/db-cache";
import { DEPEG_LIFECYCLE_FLAGS_CACHE_KEY } from "../lib/depeg-lifecycle";
import { runWithOverloadRetry } from "../lib/cron-lease";
import { prepareTelegramDigestAppendices, type PreparedTelegramDigestAppendices } from "../lib/telegram-digest-appendices";
import {
  deliverTelegramDigestEdition,
  enqueueTelegramDigestEdition,
} from "../lib/telegram-digest-outbox";
import { buildDailyDigestInput } from "./daily-digest/input";
import { formatStandingConditionsLine } from "./daily-digest/cause-context";
import { buildUserPrompt, SYSTEM_PROMPT } from "./daily-digest/prompt";
import { insertDigestRecord, markDigestMetaBlocked, requestDigestCopy, runDigestChannelDelivery } from "./digest/platform";
import { reportDigestProgress } from "./digest/progress";
import { formatQualityMetadata } from "./digest/quality-metadata";
import { logDailyDigestLlmCall } from "./daily-digest/runtime-helpers";
import { NON_WEEKLY_DIGEST_SQL_FILTER } from "./daily-digest/shared";
import { buildCriticalDailyLeadRequirements } from "./daily-digest/critical-lead-requirements";
import { attachDigestEditorialAudit } from "./daily-digest/digest-intelligence";
import { logWorkerEvent } from "../lib/structured-log";

export { classifyRegime } from "./daily-digest/prompt";

const TWITTER_SENT_MARKER_PREFIX = "daily-digest:twitter-sent:";

function getTwitterSentMarkerKey(date: string): string {
  return `${TWITTER_SENT_MARKER_PREFIX}${date}`;
}

async function claimDigestSentMarker(
  db: D1Database,
  key: string,
  value: string,
  nowSec: number,
  signal?: AbortSignal,
): Promise<boolean> {
  const result = await runWithOverloadRetry(() =>
    db
      .prepare("INSERT OR IGNORE INTO cache (key, value, updated_at) VALUES (?, ?, ?)")
      .bind(key, value, nowSec)
      .run(),
    3,
    signal,
  );
  return Number(result.meta.changes ?? 0) > 0;
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
  const { inputData, degradedReasons, recentMeta, previousInputData, recentLeadSignalIds, lifecycleFlags, recentTitles, llmSignals, stablecoinsCacheReason } = digestInput;
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
  const leadRequirements = buildCriticalDailyLeadRequirements(inputData, {
    previousInputData,
    recentLeadSignalIds,
  });
  const userPromptContent = buildUserPrompt(inputData, recentMeta, { leadRequirements, recentLeadSignalIds });
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
    // Opus xhigh needs this floor; see digest/platform.ts for the effort rationale.
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
      depegFacts: llmSignals.topDepegs,
      prevDepegFacts: previousInputData?.topDepegs ?? [],
      recentTitles,
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
  const digestDate = formatIsoDate(now);
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
    // Hard quality failures are stored for inspection but never published:
    // the blocked flag keeps the row out of public reads and numbering.
    digestMeta: digestCopy.hasBlockingQualityIssues
      ? markDigestMetaBlocked(digestCopy.digestMeta)
      : digestCopy.digestMeta,
    signal,
  });
  throwIfAborted(signal);
  // SAFETY: NON_WEEKLY_DIGEST_SQL_FILTER is a hardcoded SQL fragment, not derived from user input.
  const countResult = await db
    .prepare(`SELECT COUNT(*) as cnt FROM daily_digest WHERE ${NON_WEEKLY_DIGEST_SQL_FILTER}`)
    .all<{ cnt: number }>();
  throwIfAborted(signal);
  const editionNumber = (countResult.results?.[0] as { cnt: number } | undefined)?.cnt ?? null;
  const qualityGateStatus = digestCopy.hasBlockingQualityIssues ? "skipped: quality-gate" : null;
  throwIfAborted(signal);
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
      const markerKey = getTwitterSentMarkerKey(digestDate);
      try {
        const markerClaimed = await claimDigestSentMarker(
          db,
          markerKey,
          JSON.stringify({ sentAt: now, editionNumber }),
          now,
          signal,
        );
        if (!markerClaimed) return "skipped: already-sent";
      } catch (err) {
        degradedReasons.push("twitter-send-marker-write");
        recordCronFailure("daily-digest", err, { metadata: { stage: "twitter-send-marker-write" } });
        throw err;
      }

      try {
        await postDigestTweet(digestCopy.digestTitle, digestCopy.digestText, creds, editionNumber);
      } catch (err) {
        try {
          await deleteCache(db, markerKey);
        } catch (rollbackErr) {
          degradedReasons.push("twitter-send-marker-rollback");
          console.error("[daily-digest] Failed to roll back Twitter send marker after delivery failure:", rollbackErr);
        }
        throw err;
      }
      return "ok";
    },
  });
  throwIfAborted(signal);
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
  const telegramEditionKey = `daily:${digestDate}`;
  let telegramAppendices: PreparedTelegramDigestAppendices | null = null;
  let telegramOutboxReady = false;
  if (!qualityGateStatus && telegramCreds) {
    try {
      try {
        telegramAppendices = await prepareTelegramDigestAppendices(db);
      } catch (err) {
        degradedReasons.push("telegram-appendix-state");
        console.error("[daily-digest] Failed to prepare Telegram digest appendices:", err);
      }
      const enqueueResult = await enqueueTelegramDigestEdition(db, {
        editionKey: telegramEditionKey,
        digestKind: "daily",
        digestGeneratedAt: now,
        targetChatId: telegramCreds.chatId,
        title: digestCopy.digestTitle,
        // The chronic ledger keeps demoted ongoing stories visible as one
        // deterministic line instead of another narrated day-count headline.
        extended: (() => {
          const standingLine = formatStandingConditionsLine(inputData.standingConditions);
          return standingLine ? `${digestCopy.digestExtended}\n\n${standingLine}` : digestCopy.digestExtended;
        })(),
        date: digestDate,
        editionNumber,
        appendixHtml: telegramAppendices?.appendixHtml ?? null,
        successActions: telegramAppendices?.successActions ?? [],
      }, signal);
      if (!enqueueResult.payloadMatched && enqueueResult.state !== "sent") {
        degradedReasons.push("telegram-outbox-payload-mismatch");
        recordCronFailure("daily-digest", new Error("Immutable Telegram digest edition differs"), {
          metadata: { stage: "telegram-outbox-payload-mismatch", editionKey: telegramEditionKey },
        });
      }
      telegramOutboxReady = true;
    } catch (err) {
      degradedReasons.push("telegram-outbox-write");
      recordCronFailure("daily-digest", err, { metadata: { stage: "telegram-outbox-write" } });
    }
  }
  const telegramStatus = qualityGateStatus ?? await runDigestChannelDelivery({
    db,
    circuitSource: CIRCUIT_SOURCE.TELEGRAM_API,
    creds: telegramCreds,
    logPrefix: "daily-digest",
    channelLabel: "Telegram",
    deliver: async (creds) => {
      if (!telegramOutboxReady) throw new Error("Telegram digest outbox was not persisted");
      const delivery = await deliverTelegramDigestEdition(db, creds, telegramEditionKey, signal);
      if (delivery.outcome === "sent") {
        const appendixSuffix = telegramAppendices?.metadata.hasAppendix
          ? `+appendix(cemetery=${telegramAppendices.metadata.cemeteryDetected},tracked=${telegramAppendices.metadata.trackedDetected},prelaunch=${telegramAppendices.metadata.preLaunchDetected})`
          : "";
        return `ok${appendixSuffix}`;
      }
      if (delivery.outcome === "skipped" && delivery.state === "sent") {
        return "skipped: already-sent";
      }
      if (delivery.outcome === "skipped") {
        return `queued: ${delivery.state}`;
      }
      throw new Error(
        `Telegram digest ${delivery.outcome}: ${delivery.errorClass ?? "unknown"}`,
      );
    },
  });
  if (degradedReasons.includes("twitter-send-marker-write")) {
    throw new Error("Twitter daily digest marker write failed");
  }
  if (degradedReasons.includes("telegram-outbox-write")) {
    throw new Error("Telegram daily digest outbox write failed");
  }
  // Persist owner-review lifecycle flags (stalled collapses / chronic shallow
  // pegs needing a manual freeze-or-close ruling). Best-effort: a cache write
  // failure must not degrade an otherwise successful digest run.
  try {
    await setCache(
      db,
      DEPEG_LIFECYCLE_FLAGS_CACHE_KEY,
      JSON.stringify({ updatedAt: now, flags: lifecycleFlags }),
      signal,
    );
  } catch (err) {
    logWorkerEvent({
      scope: "lib",
      level: "error",
      event: "depeg_lifecycle_flags_persist_failed",
      job: "daily-digest",
      message: "Failed to persist depeg lifecycle flags",
      error: err,
    });
  }
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
        lifecycleFlags: lifecycleFlags.length,
      },
      twitterStatus: tweetStatus,
      telegramStatus,
    },
  });
  console.log(`[daily-digest] Generated and stored digest: "${digestCopy.digestTitle}" (${digestCopy.digestText.length} chars + ${digestCopy.digestExtended.length} extended), tweet: ${tweetStatus}, telegram: ${telegramStatus}${qualityMetadata}`);
  const lifecycleMetadata = lifecycleFlags.length > 0
    ? `, lifecycle-review: ${lifecycleFlags.map((flag) => `${flag.symbol}:${flag.kind}`).join("|")}`
    : "";
  return {
    itemCount: 1,
    ...(degradedReasons.length > 0 || digestCopy.hasBlockingQualityIssues ? { status: "degraded" as const } : {}),
    metadata: `${digestCopy.digestText.length} chars, tweet: ${tweetStatus}, telegram: ${telegramStatus}${degradedReasons.length > 0 ? `, degraded: ${degradedReasons.join("|")}` : ""}${qualityMetadata}${lifecycleMetadata}`,
  };
}
