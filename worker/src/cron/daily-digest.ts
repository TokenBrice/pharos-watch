import { logWorkerEventArgs } from "../lib/structured-log";
import { recordCronFailure, type CronProgressReporter, type CronResult } from "../lib/cron-logger";
import { throwIfAborted } from "../lib/abort";
import { postDigestTweet, type TwitterCreds } from "../lib/twitter";
import type { TelegramCreds } from "../lib/telegram";
import { SECONDS } from "../lib/time-constants";
import { formatIsoDate } from "@shared/lib/format";
import { CIRCUIT_SOURCE } from "../lib/constants";
import { setCache } from "../lib/db-cache";
import { DEPEG_LIFECYCLE_FLAGS_CACHE_KEY } from "../lib/depeg-lifecycle";
import { prepareTelegramDigestAppendices, type PreparedTelegramDigestAppendices } from "../lib/telegram-digest-appendices";
import {
  deliverTelegramDigestEdition,
  enqueueTelegramDigestEdition,
} from "../lib/telegram-digest-outbox";
import { buildDailyDigestInput } from "./daily-digest/input";
import { formatStandingConditionsLine } from "./daily-digest/cause-context";
import { buildUserPrompt, SYSTEM_PROMPT } from "./daily-digest/prompt";
import { insertDigestRecord, markDigestMetaBlocked, requestDigestCopy, runDigestChannelDelivery } from "./digest/platform";
import {
  runTelegramDigestDeliveryWithPermit,
  mapTelegramDigestPermittedDelivery,
  type TelegramDigestPermittedDelivery,
} from "./telegram-digest-transport";
import { reportCronProgress } from "../lib/cron-progress";
import { formatQualityMetadata } from "./digest/quality-metadata";
import { logDailyDigestLlmCall } from "./daily-digest/runtime-helpers";
import { NON_WEEKLY_DIGEST_SQL_FILTER } from "../lib/digest-sql-filters";
import { buildCriticalDailyLeadRequirements } from "./daily-digest/critical-lead-requirements";
import { attachDigestEditorialAudit } from "./daily-digest/digest-intelligence";
import type { DigestValidationIssue } from "./daily-digest/response";
import { logWorkerEvent } from "../lib/structured-log";
import {
  checkDigestSafetyContextForDelivery,
  findUnboundDigestSafetyClaimMarkers,
} from "../lib/digest-safety-context";
import { resolveDigestSafetyMap, type DigestSafetyMapResolution } from "../lib/digest-safety-map";
import {
  deliverTwitterDigestWithLedger,
  TwitterDigestLedgerPersistenceError,
} from "../lib/twitter-digest-ledger";

export { classifyRegime } from "./daily-digest/prompt";

const TWITTER_SENT_MARKER_PREFIX = "daily-digest:twitter-sent:";

function getTwitterSentMarkerKey(date: string): string {
  return `${TWITTER_SENT_MARKER_PREFIX}${date}`;
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
  await reportCronProgress(reportProgress, {
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
    logWorkerEventArgs("handler", "info", "[daily-digest] No API key configured, skipping");
    await reportCronProgress(reportProgress, {
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
      logWorkerEventArgs("handler", "info",
        `[daily-digest] Latest digest is ${Math.round(ageSec / 60)}min old, skipping`,
      );
      await reportCronProgress(reportProgress, {
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
      logWorkerEventArgs("handler", "info", "[daily-digest] Latest digest is malformed (code-block response), regenerating");
    }
  }

  await reportCronProgress(reportProgress, {
    stage: "input-collection",
    message: "Collecting daily digest market context",
    providerFamily: "pharos-d1",
    itemsDone: 0,
    itemsTotal: 1,
  });
  const digestInput = await buildDailyDigestInput(db);
  const { inputData, degradedReasons, recentMeta, previousInputData, recentLeadSignalIds, lifecycleFlags, recentTitles, llmSignals, stablecoinsCacheReason } = digestInput;
  if (stablecoinsCacheReason) {
    await reportCronProgress(reportProgress, {
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
  await reportCronProgress(reportProgress, {
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
  await reportCronProgress(reportProgress, {
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
      forbidSafetyClaims: inputData.safetyContext?.status !== "available",
      suppressedCandidateIds: (inputData.editorialCandidates ?? [])
        .filter((candidate) => candidate.suppressReason)
        .map((candidate) => candidate.id),
    },
  });
  if (digestCopy.kind === "circuit-open") {
    await reportCronProgress(reportProgress, {
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
  const unboundSafetyClaimMarkers = findUnboundDigestSafetyClaimMarkers(
    inputData.safetyContext,
    {
      title: digestCopy.digestTitle,
      text: digestCopy.digestText,
      extended: digestCopy.digestExtended,
    },
  );
  const safetyCopyIssues: DigestValidationIssue[] = unboundSafetyClaimMarkers.length > 0
    ? [{
        code: "unbound-safety-copy",
        severity: "hard",
        message: `Safety Score copy requires an identified publication (${unboundSafetyClaimMarkers.join(", ")})`,
      }]
    : [];
  const qualityIssues = [...digestCopy.qualityIssues, ...safetyCopyIssues];
  const hasBlockingQualityIssues =
    digestCopy.hasBlockingQualityIssues || safetyCopyIssues.length > 0;
  if (safetyCopyIssues.length > 0) {
    degradedReasons.push("unbound-safety-copy");
  }
  await reportCronProgress(reportProgress, {
    stage: "llm-generation-complete",
    message: "Received daily digest copy from Anthropic",
    providerFamily: "anthropic",
    itemsDone: 1,
    itemsTotal: 1,
    metadata: {
      countTotals: {
        textChars: digestCopy.digestText.length,
        extendedChars: digestCopy.digestExtended.length,
        qualityIssues: qualityIssues.length,
      },
      blockingQualityIssues: hasBlockingQualityIssues,
    },
  });

  const storedInputData = attachDigestEditorialAudit({
    inputData,
    digestMeta: digestCopy.digestMeta,
    qualityIssues,
    leadRequirements,
  });
  const now = Math.floor(Date.now() / 1000);
  const digestDate = formatIsoDate(now);
  await reportCronProgress(reportProgress, {
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
    digestMeta: hasBlockingQualityIssues
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
  const qualityGateStatus = hasBlockingQualityIssues ? "skipped: quality-gate" : null;
  let safetyMap: DigestSafetyMapResolution | null = null;
  if (!qualityGateStatus && (twitterCreds || telegramCreds)) {
    safetyMap = await resolveDigestSafetyMap(digestDate, now, signal);
    if (safetyMap.kind === "unavailable") {
      degradedReasons.push(`safety-map-${safetyMap.reason}`);
      logWorkerEvent({
        scope: "handler",
        level: "warn",
        event: "daily_digest_safety_map_omitted",
        job: "daily-digest",
        message: "Daily digest omitted the Safety Score map",
        metadata: { reason: safetyMap.reason, date: digestDate },
      });
    }
  }
  const safetyMapImageUrl = safetyMap?.kind === "available" ? safetyMap.imageUrl : null;
  throwIfAborted(signal);
  await reportCronProgress(reportProgress, {
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
      if (inputData.safetyContext) {
        const safetyCheck = await checkDigestSafetyContextForDelivery(db, inputData.safetyContext, signal);
        if (safetyCheck.kind !== "ok") {
          const reason = safetyCheck.kind === "stale"
            ? "stale-safety-identity"
            : "safety-identity-unavailable";
          degradedReasons.push(reason);
          return `skipped: ${reason}`;
        }
      }
      const markerKey = getTwitterSentMarkerKey(digestDate);
      try {
        const delivery = await deliverTwitterDigestWithLedger(
          db,
          markerKey,
          editionNumber,
          now,
          () => postDigestTweet(
            digestCopy.digestTitle,
            digestCopy.digestText,
            creds,
            editionNumber,
            safetyMapImageUrl,
          ),
          signal,
        );
        if (delivery.status === "skipped") return `skipped: ${delivery.reason}`;
        if (safetyMapImageUrl && !delivery.post.mediaAttached) {
          degradedReasons.push("safety-map-twitter-attachment");
        }
      } catch (err) {
        if (err instanceof TwitterDigestLedgerPersistenceError) {
          degradedReasons.push("twitter-send-marker-write");
          recordCronFailure("daily-digest", err, { metadata: { stage: "twitter-send-marker-write" } });
        }
        throw err;
      }
      return "ok";
    },
  });
  throwIfAborted(signal);
  await reportCronProgress(reportProgress, {
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
        logWorkerEventArgs("handler", "error", "[daily-digest] Failed to prepare Telegram digest appendices:", err);
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
        imageUrl: safetyMapImageUrl,
        successActions: telegramAppendices?.successActions ?? [],
        safetyContext: inputData.safetyContext ?? {
          status: "unavailable",
          expectedModel: "v9",
          identity: null,
          publishedAt: null,
          reason: "source-load-failed",
        },
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
  const telegramStatus = qualityGateStatus ?? await runTelegramDigestDeliveryWithPermit({
    db,
    creds: telegramCreds,
    owner: "daily-digest",
    editionKey: telegramEditionKey,
    signal,
    deliver: async (creds): Promise<TelegramDigestPermittedDelivery> => {
      if (!telegramOutboxReady) throw new Error("Telegram digest outbox was not persisted");
      const delivery = await deliverTelegramDigestEdition(db, creds, telegramEditionKey, signal);
      const appendixSuffix = telegramAppendices?.metadata.hasAppendix
        ? `+appendix(cemetery=${telegramAppendices.metadata.cemeteryDetected},tracked=${telegramAppendices.metadata.trackedDetected},prelaunch=${telegramAppendices.metadata.preLaunchDetected})`
        : "";
      return mapTelegramDigestPermittedDelivery(delivery, {
        success: `ok${appendixSuffix}`,
        alreadySent: "skipped: already-sent",
      });
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
  const qualityMetadata = formatQualityMetadata(qualityIssues);
  await reportCronProgress(reportProgress, {
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
        qualityIssues: qualityIssues.length,
        lifecycleFlags: lifecycleFlags.length,
      },
      twitterStatus: tweetStatus,
      telegramStatus,
    },
  });
  logWorkerEventArgs("handler", "info", `[daily-digest] Generated and stored digest: "${digestCopy.digestTitle}" (${digestCopy.digestText.length} chars + ${digestCopy.digestExtended.length} extended), tweet: ${tweetStatus}, telegram: ${telegramStatus}${qualityMetadata}`);
  const lifecycleMetadata = lifecycleFlags.length > 0
    ? `, lifecycle-review: ${lifecycleFlags.map((flag) => `${flag.symbol}:${flag.kind}`).join("|")}`
    : "";
  return {
    itemCount: 1,
    ...(degradedReasons.length > 0 || hasBlockingQualityIssues ? { status: "degraded" as const } : {}),
    metadata: `${digestCopy.digestText.length} chars, tweet: ${tweetStatus}, telegram: ${telegramStatus}${degradedReasons.length > 0 ? `, degraded: ${degradedReasons.join("|")}` : ""}${qualityMetadata}${lifecycleMetadata}`,
  };
}
