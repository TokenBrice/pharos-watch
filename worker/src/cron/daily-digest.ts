import type { DigestInputData } from "@shared/types/digest";
import type { StablecoinData } from "@shared/types/market";
import { getCirculatingRaw, getPrevWeekRaw } from "@shared/lib/supply";
import { ACTIVE_IDS } from "@shared/lib/stablecoins";
import { type CronResult } from "../lib/cron-logger";
import { postDigestTweet, type TwitterCreds } from "../lib/twitter";
import { postDigestToTelegram, type TelegramCreds } from "../lib/telegram";
import { fetchWithRetry } from "../lib/fetch-retry";
import { SECONDS } from "../lib/time-constants";
import { ANTHROPIC_MAX_RETRIES, ANTHROPIC_TIMEOUT_MS, CIRCUIT_SOURCE } from "../lib/constants";
import { recordOutcomeSafe, shouldAttemptFetch } from "../lib/circuit-breaker";
import { getConditionBand } from "../lib/stability-index";
import { getDisplayedPsi } from "@shared/lib/psi-view-model";
import { getCache, setCache } from "../lib/db-cache";
import { loadStablecoinsCache } from "../lib/stablecoins-cache";
import {
  prepareTelegramDigestAppendices,
  type PreparedTelegramDigestAppendices,
} from "../lib/telegram-digest-appendices";
import {
  collectActiveDepegs,
  collectBlacklistActivity,
  collectSupplyVelocity,
  collectSafetyScores,
  collectResolvedDepegs,
  collectMintBurnFlows,
  collectDewsStress,
  collectHistoricalContext,
  collectGradeTransitions,
  collectPsiContributors,
  collectYieldAnomalies,
  collectLiquidityShifts,
  collectCrossDayTrends,
  type CollectorResult,
  type CollectorContext,
} from "./daily-digest/collectors";
import { buildUserPrompt, SYSTEM_PROMPT } from "./daily-digest/prompt";
import { parseDigestModelResponse } from "./daily-digest/response";
import {
  buildRecentDigestMeta,
  logDailyDigestLlmCall,
} from "./daily-digest/runtime-helpers";

export { classifyRegime } from "./daily-digest/prompt";

const TELEGRAM_SENT_MARKER_PREFIX = "daily-digest:telegram-sent:";

function getTelegramSentMarkerKey(date: string): string {
  return `${TELEGRAM_SENT_MARKER_PREFIX}${date}`;
}

function consumeCollectorResult<T>(result: CollectorResult<T>, degradedReasons: string[]): T {
  if (result.degradedReason) {
    degradedReasons.push(result.degradedReason);
  }
  return result.value;
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

  const recentRows = await db
    .prepare("SELECT digest_title, digest_text, digest_extended, digest_meta FROM daily_digest ORDER BY generated_at DESC LIMIT 7")
    .all<{ digest_title: string | null; digest_text: string; digest_extended: string | null; digest_meta: string | null }>();
  const recentMeta = buildRecentDigestMeta(recentRows.results ?? []);
  const degradedReasons: string[] = [];

  const stablecoinsCacheResult = await loadStablecoinsCache(db, { mode: "lenient", allowLegacyArray: true });
  if (stablecoinsCacheResult.kind !== "ok") {
    console.warn(`[daily-digest] stablecoins cache unavailable (${stablecoinsCacheResult.reason}), skipping regeneration`);
    return {
      status: "degraded",
      itemCount: 0,
      metadata: JSON.stringify({
        reason: "stablecoins-cache-unavailable",
        stablecoinsCacheReason: stablecoinsCacheResult.reason,
        skipped: true,
      }),
    };
  }
  const stablecoinAssets = stablecoinsCacheResult.payload.peggedAssets as StablecoinData[];
  const trackedStablecoinAssets = stablecoinAssets.filter((coin) => ACTIVE_IDS.has(coin.id));
  const mcapById = new Map<string, number>();
  for (const coin of stablecoinAssets) {
    const raw = getCirculatingRaw(coin);
    if (raw > 0) mcapById.set(coin.id, raw);
  }

  let totalMcapUsd = 0;
  let totalPrevWeek = 0;
  let biggestSupplyChange: DigestInputData["biggestSupplyChange"] = null;
  let biggestAbsChange = 0;

  for (const coin of trackedStablecoinAssets) {
    const mcap = getCirculatingRaw(coin);
    const prevWeek = getPrevWeekRaw(coin);
    if (mcap <= 0) continue;
    totalMcapUsd += mcap;
    totalPrevWeek += prevWeek;

    if (mcap > 1_000_000) {
      const absChange = Math.abs(mcap - prevWeek);
      if (absChange > biggestAbsChange) {
        biggestAbsChange = absChange;
        biggestSupplyChange = {
          id: coin.id,
          symbol: coin.symbol,
          name: coin.name,
          changeUsd: mcap - prevWeek,
          currentMcap: mcap,
        };
      }
    }
  }

  const nowSec = Math.floor(Date.now() / 1000);
  const todayTs = nowSec - (nowSec % SECONDS.ONE_DAY);
  const yesterdayTs = todayTs - SECONDS.ONE_DAY;

  const ctx: CollectorContext = { db, trackedStablecoinAssets, mcapById, nowSec, todayTs, yesterdayTs };

  const { activeDepegCount, topDepegs } = consumeCollectorResult(await collectActiveDepegs(ctx), degradedReasons);

  const latestSample = await db
    .prepare("SELECT score, band, components FROM stability_index_samples ORDER BY stored_at DESC LIMIT 1")
    .first<{ score: number; band: string; components: string }>();
  const latestDaily = latestSample
    ? null
    : await db
      .prepare("SELECT score, band, components FROM stability_index ORDER BY computed_at DESC LIMIT 1")
      .first<{ score: number; band: string; components: string }>();
  const currentPsiSource = latestSample ?? latestDaily;

  const avg24hRow = await db
    .prepare("SELECT AVG(score) as avg FROM stability_index_samples WHERE stored_at > ?")
    .bind(nowSec - SECONDS.ONE_DAY)
    .first<{ avg: number | null }>();
  const avg24h = avg24hRow?.avg != null
    ? Math.round(avg24hRow.avg * 10) / 10
    : null;

  const displayPsi = currentPsiSource
    ? getDisplayedPsi({
      score: currentPsiSource.score,
      band: currentPsiSource.band,
      avg24h: avg24h ?? undefined,
      avg24hBand: avg24h != null ? getConditionBand(avg24h) : undefined,
      computedAt: nowSec,
    })
    : null;
  const displayScore = displayPsi?.score ?? null;
  const displayBand = displayPsi?.band ?? null;

  let parsedComponents: { severity: number; breadth: number; stressBreadth?: number; trend: number } | null = null;
  if (currentPsiSource) {
    try {
      parsedComponents = JSON.parse(currentPsiSource.components);
    } catch (err) {
      console.warn("[daily-digest] Failed to parse PSI components JSON:", err instanceof Error ? err.message : err);
      parsedComponents = null;
    }
  }
  const stabilityIndex = currentPsiSource && displayScore != null && displayBand && parsedComponents != null
    ? { score: displayScore, band: displayBand, components: parsedComponents }
    : null;

  const yesterdayRow = await db
    .prepare("SELECT score, band FROM stability_index WHERE computed_at = ?")
    .bind(yesterdayTs)
    .first<{ score: number; band: string }>();
  const yesterdayIndex = yesterdayRow
    ? { score: yesterdayRow.score, band: yesterdayRow.band }
    : null;

  const blacklistActivity = consumeCollectorResult(await collectBlacklistActivity(ctx), degradedReasons);
  const supplyVelocity = consumeCollectorResult(await collectSupplyVelocity(ctx), degradedReasons);

  const mentionedSymbols = new Set<string>();
  for (const d of topDepegs) mentionedSymbols.add(d.symbol);
  if (biggestSupplyChange) mentionedSymbols.add(biggestSupplyChange.symbol);
  if (supplyVelocity) for (const v of supplyVelocity) mentionedSymbols.add(v.coin);
  const { safetyScores, safetyGrades } = await collectSafetyScores(ctx, mentionedSymbols, degradedReasons);

  const resolvedDepegs = await collectResolvedDepegs(ctx);
  const mintBurnFlows = await collectMintBurnFlows(ctx);
  const dewsStress = await collectDewsStress(ctx, degradedReasons);
  const historicalContext = await collectHistoricalContext(ctx, displayScore, displayBand, biggestSupplyChange);
  const gradeTransitions = await collectGradeTransitions(ctx, safetyGrades);
  const psiContributors = await collectPsiContributors(ctx);
  const yieldAnomalies = await collectYieldAnomalies(ctx, degradedReasons);
  const liquidityShifts = await collectLiquidityShifts(ctx);
  const crossDayTrends = await collectCrossDayTrends(ctx, degradedReasons);

  const inputData: DigestInputData = {
    digestVersion: 2,
    totalMcapUsd,
    mcap7dDelta: totalMcapUsd - totalPrevWeek,
    ...(degradedReasons.length > 0 ? { degradedSources: [...degradedReasons] } : {}),
    activeDepegCount,
    topDepegs,
    biggestSupplyChange,
    stabilityIndex,
    yesterdayIndex,
    blacklistActivity,
    supplyVelocity,
    safetyScores,
    resolvedDepegs,
    mintBurnFlows,
    dewsStress,
    historicalContext,
    psiContributors,
    gradeTransitions,
    yieldAnomalies,
    liquidityShifts,
    crossDayTrends,
  };

  const userPromptContent = buildUserPrompt(inputData, recentMeta);

  if (!(await shouldAttemptFetch(db, CIRCUIT_SOURCE.ANTHROPIC))) {
    throw new Error("Anthropic circuit open — skipping LLM call");
  }
  logDailyDigestLlmCall({
    activeDepegCount,
    topDepegs,
    resolvedDepegs,
    yieldAnomalies,
    liquidityShifts,
    recentMeta,
    degradedReasons,
  });
  const response = await fetchWithRetry(
    "https://api.anthropic.com/v1/messages",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": anthropicApiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-opus-4-6",
        max_tokens: 1400,
        system: SYSTEM_PROMPT,
        messages: [{ role: "user", content: userPromptContent }],
      }),
      signal: signal
        ? AbortSignal.any([signal, AbortSignal.timeout(ANTHROPIC_TIMEOUT_MS)])
        : AbortSignal.timeout(ANTHROPIC_TIMEOUT_MS),
    },
    ANTHROPIC_MAX_RETRIES,
    { timeoutMs: ANTHROPIC_TIMEOUT_MS },
  );

  if (!response || !response.ok) {
    await recordOutcomeSafe(db, CIRCUIT_SOURCE.ANTHROPIC, false);
    const errorText = response ? await response.text() : "no response after retries";
    throw new Error(
      `Claude API error ${response?.status ?? "null"}: ${typeof errorText === "string" ? errorText.slice(0, 500) : errorText}`,
    );
  }
  await recordOutcomeSafe(db, CIRCUIT_SOURCE.ANTHROPIC, true);

  const result = (await response.json()) as {
    content?: { type: string; text: string }[];
  };
  const rawText = result.content?.[0]?.text ?? "";

  if (!rawText) {
    throw new Error("Claude API returned empty digest text");
  }

  const {
    digestTitle,
    digestText,
    digestExtended,
    digestMeta,
    strippedDashCount,
    strippedForbiddenCharCount,
    usedRawTextFallback,
  } = parseDigestModelResponse(rawText);

  if (usedRawTextFallback) {
    console.warn("[daily-digest] Failed to parse JSON response, using raw text");
  }

  if (strippedDashCount > 0) {
    console.log(`[daily-digest] Prompt compliance: ${strippedDashCount} forbidden dashes stripped`);
  }
  if (strippedForbiddenCharCount > 0) {
    console.warn(`[daily-digest] Prompt compliance: stripped ${strippedForbiddenCharCount} chars of forbidden phrases`);
  }

  const now = Math.floor(Date.now() / 1000);
  const DAILY_FILTER = "digest_meta IS NULL OR json_extract(digest_meta, '$.type') IS NULL OR json_extract(digest_meta, '$.type') != 'weekly'";
  const [, countResult] = await db.batch([
    db.prepare(
      "INSERT INTO daily_digest (generated_at, digest_text, digest_title, input_data, digest_extended, digest_meta) VALUES (?, ?, ?, ?, ?, ?)",
    ).bind(now, digestText, digestTitle || null, JSON.stringify(inputData), digestExtended || null, digestMeta),
    db.prepare(`SELECT COUNT(*) as cnt FROM daily_digest WHERE ${DAILY_FILTER}`),
  ]);
  const editionNumber = (countResult.results?.[0] as { cnt: number } | undefined)?.cnt ?? null;

  let tweetStatus = "no-creds";
  if (twitterCreds) {
    const twitterAllowed = await shouldAttemptFetch(db, CIRCUIT_SOURCE.TWITTER_API);
    if (!twitterAllowed) {
      tweetStatus = "skipped: circuit-open";
    } else {
      try {
        await postDigestTweet(digestTitle, digestText, twitterCreds, editionNumber);
        await recordOutcomeSafe(db, CIRCUIT_SOURCE.TWITTER_API, true);
        tweetStatus = "ok";
      } catch (err) {
        await recordOutcomeSafe(db, CIRCUIT_SOURCE.TWITTER_API, false);
        console.error("[daily-digest] Failed to post tweet (non-fatal):", err);
        tweetStatus = `failed: ${String(err).slice(0, 100)}`;
      }
    }
  }

  let telegramStatus = "no-creds";
  if (telegramCreds) {
    const telegramAllowed = await shouldAttemptFetch(db, CIRCUIT_SOURCE.TELEGRAM_API);
    if (!telegramAllowed) {
      telegramStatus = "skipped: circuit-open";
    } else {
      let telegramAppendices: PreparedTelegramDigestAppendices | null = null;
      try {
        telegramAppendices = await prepareTelegramDigestAppendices(db);
      } catch (err) {
        degradedReasons.push("telegram-appendix-state");
        console.error("[daily-digest] Failed to prepare Telegram digest appendices:", err);
      }

      try {
        const date = new Date(now * 1000).toISOString().slice(0, 10);
        const markerKey = getTelegramSentMarkerKey(date);
        const sentMarker = await getCache(db, markerKey);

        if (!sentMarker) {
          await postDigestToTelegram(
            digestTitle,
            digestExtended,
            date,
            telegramCreds,
            editionNumber,
            telegramAppendices?.appendixHtml ?? null,
          );
          await recordOutcomeSafe(db, CIRCUIT_SOURCE.TELEGRAM_API, true);
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
        } else {
          telegramStatus = "skipped: already-sent";
        }
        if (telegramAppendices?.metadata.hasAppendix) {
          try {
            await telegramAppendices.commitSuccess();
          } catch (err) {
            degradedReasons.push("telegram-appendix-commit");
            console.error("[daily-digest] Failed to commit Telegram digest appendix state:", err);
          }
        }
        if (telegramStatus !== "skipped: already-sent") {
          const appendixSuffix = telegramAppendices?.metadata.hasAppendix
            ? `+appendix(cemetery=${telegramAppendices.metadata.cemeteryDetected},tracked=${telegramAppendices.metadata.trackedDetected},prelaunch=${telegramAppendices.metadata.preLaunchDetected})`
            : "";
          telegramStatus = `ok${appendixSuffix}`;
        }
      } catch (err) {
        await recordOutcomeSafe(db, CIRCUIT_SOURCE.TELEGRAM_API, false);
        console.error("[daily-digest] Failed to post to Telegram (non-fatal):", err);
        telegramStatus = `failed: ${String(err).slice(0, 100)}`;
      }
    }
  }

  console.log(`[daily-digest] Generated and stored digest: "${digestTitle}" (${digestText.length} chars + ${digestExtended.length} extended), tweet: ${tweetStatus}, telegram: ${telegramStatus}`);
  return {
    itemCount: 1,
    ...(degradedReasons.length > 0 ? { status: "degraded" as const } : {}),
    metadata: `${digestText.length} chars, tweet: ${tweetStatus}, telegram: ${telegramStatus}${degradedReasons.length > 0 ? `, degraded: ${degradedReasons.join("|")}` : ""}`,
  };
}
