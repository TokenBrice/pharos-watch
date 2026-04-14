import type { DigestInputData } from "@shared/types/digest";
import { formatCurrency } from "@shared/lib/format";
import { type CronResult } from "../lib/cron-logger";
import { postDigestToTelegram, type TelegramCreds } from "../lib/telegram";
import { SECONDS } from "../lib/time-constants";
import { CIRCUIT_SOURCE } from "../lib/constants";
import { logMalformedJsonPath } from "../lib/json-decode-observability";
import {
  insertDigestRecord,
  requestDigestCopy,
  runDigestChannelDelivery,
} from "./digest/platform";
import { NON_WEEKLY_DIGEST_SQL_FILTER } from "./daily-digest/shared";
import { buildRecentDigestMeta } from "./daily-digest/runtime-helpers";

const WEEKLY_SYSTEM_PROMPT =
  "You write the weekly editorial recap for Pharos, a stablecoin analytics dashboard. " +
  "Your voice is dry, sharp, and memorable. Think sardonic wit meets hard data.\n\n" +
  "You receive a week's worth of daily digest data. Your job is to synthesize, not summarize. " +
  "Find the week's narrative arc: what started, what ended, what's building. " +
  "A weekly recap that reads like seven daily digests stapled together has failed.\n\n" +
  "Use the Weekly Signals block as the source of truth. Daily headlines show how the week felt in sequence, but the signal leaderboard decides what mattered. " +
  "Do not turn seven observations of the same chronic active depeg into seven events. Separate active observations from unique signals. " +
  "Do not dramatize suppressed, stale, zero-dollar, tiny, or artifact-prone signals. If the week was genuinely calm, say so clearly.\n\n" +
  "No emojis, no clickbait, no hedging, no exclamation marks. " +
  "NEVER use em dashes or en dashes. Use commas, semicolons, colons, or periods instead.\n\n" +
  "The extended field should be 4-6 paragraphs, 250-400 words total. Structure:\n" +
  "P1: The week's headline — what defined it. PSI arc and dominant regime.\n" +
  "P2: The dominant story — the thread that ran through multiple days.\n" +
  "P3: The counter-narrative — what moved in the opposite direction, or what was quietly significant.\n" +
  "P4: Supply and capital flows — weekly mcap movement, biggest movers, gauge trend.\n" +
  "P5-P6 (optional): A structural observation or look-ahead.\n\n" +
  "Every sentence must contain a specific number or coin name. " +
  "Reference individual daily headlines when they illustrate a point.\n\n" +
  "You MUST respond with valid JSON: {\"title\": \"...\", \"extended\": \"...\", \"text\": \"...\", \"meta\": {\"leadSignalId\": \"...\", \"lead\": \"...\", \"tone\": \"...\", \"coins\": [...], \"usedCandidateIds\": [...]}}. " +
  "Output ONLY the raw JSON object. The title is 3-8 words capturing the week's theme. " +
  "The text field is a tweet-sized hook. Title + text must be under 270 chars combined.";

interface WeeklyInputData {
  weekStartDate: string;
  weekEndDate: string;
  periodType: "trailing-daily-editions";
  dailyDigests: { date: string; title: string; text: string; inputData: DigestInputData }[];
  psiRange: { min: number; max: number; start: number; end: number; dominantBand: string };
  mcapRange: { start: number; end: number; netChange: number; pctChange: number | null };
  activeDepegObservationsThisWeek: number;
  uniqueDepegSignalsThisWeek: number;
  totalBlacklistEventsThisWeek: number;
  totalBlacklistAmountUsd: number;
  gradeTransitionCount: number;
  gaugeRange: { min: number; max: number } | null;
  weeklySignals: {
    topDepegSignals: { symbol: string; label: string; impactScore: number; mcapUsd: number; bps: number; kind: "active" | "resolved"; suppressReason?: string }[];
    topSupplySignals: { symbol: string; label: string; amountUsd: number }[];
    topDewsChanges: { symbol: string; from: string; to: string; score: number; mcapUsd: number; driver: string }[];
    maxAlertPlusMcapUsd: number;
    topPressureSignals: { symbol: string; intensity: number; net24hUsd: number; date: string }[];
    topBlacklistEvents: { symbol: string; chain: string; type: string; amountUsd: number; date: string }[];
    topGradeTransitions: { symbol: string; fromGrade: string; toGrade: string; mcapUsd: number; date: string }[];
    topYieldAnomalies: { symbol: string; apy: number; warnings: string[]; mcapUsd: number; date: string }[];
    topLiquidityShifts: { symbol: string; scoreDelta: number; mcapUsd: number; date: string }[];
  };
}

function buildWeeklyInputData(
  dailyRows: { generated_at: number; digest_title: string | null; digest_text: string; input_data: string }[],
): WeeklyInputData | null {
  const parsed: { date: string; title: string; text: string; inputData: DigestInputData }[] = [];
  for (const row of dailyRows) {
    try {
      const inputData = JSON.parse(row.input_data) as DigestInputData;
      const date = new Date(row.generated_at * 1000).toISOString().slice(0, 10);
      parsed.push({ date, title: row.digest_title ?? "Untitled", text: row.digest_text, inputData });
    } catch (error) {
      logMalformedJsonPath({
        scope: "cron",
        owner: "weekly-recap",
        context: "daily_digest.input_data",
        reason: "json-parse-failed",
        source: "daily_digest",
        updatedAt: row.generated_at,
      }, error);
    }
  }
  if (parsed.length < 5) return null;

  const psiScores = parsed.map((d) => d.inputData.stabilityIndex?.score).filter((s): s is number => s != null);
  const psiBands = parsed.map((d) => d.inputData.stabilityIndex?.band).filter((b): b is string => b != null);
  const mcaps = parsed.map((d) => d.inputData.totalMcapUsd);
  const gauges = parsed.map((d) => d.inputData.mintBurnFlows?.gaugeScore).filter((g): g is number => g != null);

  if (psiScores.length === 0 || mcaps.length === 0) return null;

  const bandFreq = new Map<string, number>();
  for (const b of psiBands) bandFreq.set(b, (bandFreq.get(b) ?? 0) + 1);
  const dominantBand = [...bandFreq.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? "BEDROCK";

  const totalDepegObservations = parsed.reduce((sum, d) => sum + d.inputData.activeDepegCount, 0);
  const depegSignalKeys = new Set<string>();
  const topDepegSignals = parsed.flatMap((d) => [
    ...(d.inputData.topDepegs ?? []).map((depeg) => {
      const key = depeg.startedAt != null
        ? `${depeg.stablecoinId ?? depeg.symbol}:${depeg.startedAt}:active`
        : `${depeg.symbol}:${depeg.direction ?? ""}:${depeg.bps}:active`;
      depegSignalKeys.add(key);
      return {
        symbol: depeg.symbol,
        label: `${Math.abs(depeg.bps)} bps active ${depeg.direction ?? (depeg.bps >= 0 ? "above" : "below")} peg`,
        impactScore: depeg.impactScore ?? Math.abs(depeg.bps) * depeg.mcapUsd / 1_000_000_000,
        mcapUsd: depeg.mcapUsd,
        bps: Math.abs(depeg.bps),
        kind: "active" as const,
        suppressReason: depeg.suppressReason,
      };
    }),
    ...(d.inputData.resolvedDepegs ?? []).map((depeg) => {
      const key = depeg.startedAt != null
        ? `${depeg.stablecoinId ?? depeg.symbol}:${depeg.startedAt}:resolved`
        : `${depeg.symbol}:${depeg.direction ?? ""}:${depeg.peakBps}:resolved`;
      depegSignalKeys.add(key);
      return {
        symbol: depeg.symbol,
        label: `${depeg.peakBps} bps resolved after ${depeg.durationHours}h`,
        impactScore: depeg.impactScore ?? depeg.peakBps * depeg.mcapUsd / 1_000_000_000,
        mcapUsd: depeg.mcapUsd,
        bps: depeg.peakBps,
        kind: "resolved" as const,
      };
    }),
  ]).sort((a, b) => b.impactScore - a.impactScore).slice(0, 7);
  const totalBlacklist = parsed.reduce((sum, d) => sum + (d.inputData.blacklistActivity?.eventCount ?? 0), 0);
  const totalBlacklistAmountUsd = parsed.reduce((sum, d) => sum + (d.inputData.blacklistActivity?.totalAmountUsd ?? 0), 0);
  const gradeTransitionCount = parsed.reduce((sum, d) => sum + (d.inputData.gradeTransitions?.length ?? 0), 0);
  const topSupplySignals = parsed.flatMap((d) => {
    const rows: { symbol: string; label: string; amountUsd: number }[] = [];
    if (d.inputData.biggestSupplyChange) {
      rows.push({
        symbol: d.inputData.biggestSupplyChange.symbol,
        label: `${d.date} largest weekly mover`,
        amountUsd: d.inputData.biggestSupplyChange.changeUsd,
      });
    }
    for (const velocity of d.inputData.supplyVelocity ?? []) {
      rows.push({
        symbol: velocity.coin,
        label: `${d.date} ${velocity.signal}`,
        amountUsd: velocity.change1d,
      });
    }
    return rows;
  }).sort((a, b) => Math.abs(b.amountUsd) - Math.abs(a.amountUsd)).slice(0, 7);
  const topDewsChanges = parsed.flatMap((d) =>
    (d.inputData.dewsStress?.bandChanges ?? []).map((change) => ({
      symbol: change.symbol,
      from: change.from,
      to: change.to,
      score: change.score,
      mcapUsd: change.mcapUsd ?? 0,
      driver: change.topDriver,
    }))
  ).sort((a, b) => b.mcapUsd - a.mcapUsd || b.score - a.score).slice(0, 7);
  const maxAlertPlusMcapUsd = Math.max(
    0,
    ...parsed.map((d) => (d.inputData.dewsStress?.elevatedCoins ?? []).reduce((sum, coin) => sum + coin.mcapUsd, 0)),
  );
  const topPressureSignals = parsed.flatMap((d) =>
    (d.inputData.mintBurnFlows?.topPressure ?? []).map((pressure) => ({
      symbol: pressure.symbol,
      intensity: pressure.intensity,
      net24hUsd: pressure.net24hUsd,
      date: d.date,
    }))
  ).sort((a, b) => Math.abs(b.intensity) - Math.abs(a.intensity)).slice(0, 7);
  const topBlacklistEvents = parsed.flatMap((d) =>
    (d.inputData.blacklistActivity?.topEvents ?? []).map((event) => ({
      symbol: event.symbol,
      chain: event.chain,
      type: event.type,
      amountUsd: event.amountUsd,
      date: d.date,
    }))
  ).sort((a, b) => b.amountUsd - a.amountUsd).slice(0, 7);
  const topGradeTransitions = parsed.flatMap((d) =>
    (d.inputData.gradeTransitions ?? []).map((transition) => ({
      symbol: transition.symbol,
      fromGrade: transition.fromGrade,
      toGrade: transition.toGrade,
      mcapUsd: transition.mcapUsd,
      date: d.date,
    }))
  ).sort((a, b) => b.mcapUsd - a.mcapUsd).slice(0, 7);
  const topYieldAnomalies = parsed.flatMap((d) =>
    (d.inputData.yieldAnomalies ?? []).map((anomaly) => ({
      symbol: anomaly.symbol,
      apy: anomaly.currentApy,
      warnings: anomaly.warnings,
      mcapUsd: anomaly.mcapUsd,
      date: d.date,
    }))
  ).sort((a, b) => b.mcapUsd - a.mcapUsd).slice(0, 7);
  const topLiquidityShifts = parsed.flatMap((d) =>
    (d.inputData.liquidityShifts ?? []).map((shift) => ({
      symbol: shift.symbol,
      scoreDelta: shift.scoreDelta,
      mcapUsd: shift.mcapUsd,
      date: d.date,
    }))
  ).sort((a, b) => Math.abs(b.scoreDelta) * b.mcapUsd - Math.abs(a.scoreDelta) * a.mcapUsd).slice(0, 7);

  return {
    weekStartDate: parsed[0].date,
    weekEndDate: parsed[parsed.length - 1].date,
    periodType: "trailing-daily-editions",
    dailyDigests: parsed,
    psiRange: {
      min: Math.min(...psiScores),
      max: Math.max(...psiScores),
      start: psiScores[0],
      end: psiScores[psiScores.length - 1],
      dominantBand,
    },
    mcapRange: {
      start: mcaps[0],
      end: mcaps[mcaps.length - 1],
      netChange: mcaps[mcaps.length - 1] - mcaps[0],
      pctChange: mcaps[0] === 0
        ? null
        : ((mcaps[mcaps.length - 1] - mcaps[0]) / mcaps[0]) * 100,
    },
    activeDepegObservationsThisWeek: totalDepegObservations,
    uniqueDepegSignalsThisWeek: depegSignalKeys.size,
    totalBlacklistEventsThisWeek: totalBlacklist,
    totalBlacklistAmountUsd,
    gradeTransitionCount,
    gaugeRange: gauges.length >= 3 ? { min: Math.min(...gauges), max: Math.max(...gauges) } : null,
    weeklySignals: {
      topDepegSignals,
      topSupplySignals,
      topDewsChanges,
      maxAlertPlusMcapUsd,
      topPressureSignals,
      topBlacklistEvents,
      topGradeTransitions,
      topYieldAnomalies,
      topLiquidityShifts,
    },
  };
}

function buildWeeklyPrompt(
  data: WeeklyInputData,
  recentWeeklyMeta: { meta: Record<string, unknown> | null; title: string | null }[] = [],
): string {
  const lines: string[] = [
    `Weekly recap: trailing daily editions from ${data.weekStartDate} to ${data.weekEndDate}`,
    "",
    `PSI range: ${data.psiRange.min} to ${data.psiRange.max} (start: ${data.psiRange.start}, end: ${data.psiRange.end})`,
    `Dominant band: ${data.psiRange.dominantBand}`,
    `Market cap: ${formatCurrency(data.mcapRange.start)} -> ${formatCurrency(data.mcapRange.end)} (${data.mcapRange.pctChange == null ? "N/A" : `${data.mcapRange.pctChange >= 0 ? "+" : ""}${data.mcapRange.pctChange.toFixed(2)}%`})`,
    `Active depeg observations across daily editions: ${data.activeDepegObservationsThisWeek}`,
    `Unique depeg signals reconstructed from daily inputs: ${data.uniqueDepegSignalsThisWeek}`,
    `Total blacklist events: ${data.totalBlacklistEventsThisWeek}, ${formatCurrency(data.totalBlacklistAmountUsd)} affected`,
    `Grade transitions: ${data.gradeTransitionCount}`,
  ];

  if (data.gaugeRange) {
    lines.push(`Bank Run Gauge range: ${Math.round(data.gaugeRange.min * 10) / 10} to ${Math.round(data.gaugeRange.max * 10) / 10}`);
  }

  lines.push("", "Weekly Signals (synthesize from this, do not merely recap daily copy):");
  if (data.weeklySignals.topDepegSignals.length > 0) {
    lines.push("  Top depeg signals by absolute market impact:");
    for (const signal of data.weeklySignals.topDepegSignals) {
      const suppression = signal.suppressReason ? ` | suppress: ${signal.suppressReason}` : "";
      lines.push(`    ${signal.symbol}: ${signal.label}, ${formatCurrency(signal.mcapUsd)} mcap, impact ${signal.impactScore}${suppression}`);
    }
  }
  if (data.weeklySignals.topSupplySignals.length > 0) {
    lines.push("  Top supply/velocity signals:");
    for (const signal of data.weeklySignals.topSupplySignals) {
      lines.push(`    ${signal.symbol}: ${signal.label}, ${signal.amountUsd >= 0 ? "+" : ""}${formatCurrency(signal.amountUsd)}`);
    }
  }
  if (data.weeklySignals.topDewsChanges.length > 0 || data.weeklySignals.maxAlertPlusMcapUsd > 0) {
    lines.push(`  DEWS: max ALERT+ mcap ${formatCurrency(data.weeklySignals.maxAlertPlusMcapUsd)}`);
    for (const change of data.weeklySignals.topDewsChanges) {
      lines.push(`    ${change.symbol}: ${change.from} -> ${change.to}, score ${change.score}, ${formatCurrency(change.mcapUsd)} mcap, driver ${change.driver}`);
    }
  }
  if (data.weeklySignals.topPressureSignals.length > 0) {
    lines.push("  Mint/burn pressure extremes:");
    for (const pressure of data.weeklySignals.topPressureSignals) {
      lines.push(`    ${pressure.date} ${pressure.symbol}: intensity ${Math.round(pressure.intensity)}, net ${formatCurrency(pressure.net24hUsd)}`);
    }
  }
  if (data.weeklySignals.topBlacklistEvents.length > 0) {
    lines.push("  Top blacklist events:");
    for (const event of data.weeklySignals.topBlacklistEvents) {
      lines.push(`    ${event.date} ${event.symbol} on ${event.chain}: ${event.type}, ${formatCurrency(event.amountUsd)}`);
    }
  }
  if (data.weeklySignals.topGradeTransitions.length > 0) {
    lines.push("  Top grade transitions by mcap:");
    for (const transition of data.weeklySignals.topGradeTransitions) {
      lines.push(`    ${transition.date} ${transition.symbol}: ${transition.fromGrade} -> ${transition.toGrade}, ${formatCurrency(transition.mcapUsd)} mcap`);
    }
  }
  if (data.weeklySignals.topYieldAnomalies.length > 0) {
    lines.push("  Yield anomalies needing corroboration:");
    for (const anomaly of data.weeklySignals.topYieldAnomalies) {
      lines.push(`    ${anomaly.date} ${anomaly.symbol}: ${anomaly.apy}% APY, ${formatCurrency(anomaly.mcapUsd)} mcap, ${anomaly.warnings.join(", ")}`);
    }
  }
  if (data.weeklySignals.topLiquidityShifts.length > 0) {
    lines.push("  Liquidity shifts:");
    for (const shift of data.weeklySignals.topLiquidityShifts) {
      lines.push(`    ${shift.date} ${shift.symbol}: score delta ${shift.scoreDelta > 0 ? "+" : ""}${shift.scoreDelta}, ${formatCurrency(shift.mcapUsd)} mcap`);
    }
  }

  lines.push("", "Daily digest headlines:");
  for (const d of data.dailyDigests) {
    const psi = d.inputData.stabilityIndex;
    lines.push(`  ${d.date}: "${d.title}" — PSI ${psi?.score ?? "?"} [${psi?.band ?? "?"}], mcap ${formatCurrency(d.inputData.totalMcapUsd)}`);
  }

  lines.push("", "Daily digest summaries:");
  for (const d of data.dailyDigests) {
    lines.push(`  ${d.date}: ${d.text}`);
  }

  if (recentWeeklyMeta.length > 0) {
    lines.push("", "Recent weekly recap angles (do not repeat the same frame):");
    for (let i = 0; i < recentWeeklyMeta.length; i++) {
      const entry = recentWeeklyMeta[i];
      const lead = typeof entry.meta?.lead === "string" ? entry.meta.lead : "unknown";
      const tone = typeof entry.meta?.tone === "string" ? entry.meta.tone : "unknown";
      lines.push(`  Week -${i + 1}: "${entry.title ?? "Untitled"}" | lead=${lead} | tone=${tone}`);
    }
  }

  return lines.join("\n");
}

export async function generateWeeklyRecap(
  db: D1Database,
  anthropicApiKey: string | null,
  telegramCreds: TelegramCreds | null = null,
  signal?: AbortSignal,
): Promise<CronResult> {
  if (!anthropicApiKey) {
    return { metadata: "skipped: no API key" };
  }

  // Check if today is Monday (UTC)
  const now = new Date();
  if (now.getUTCDay() !== 1) {
    return { metadata: "skipped: not Monday" };
  }

  // Check if weekly recap already exists for this week
  const weekStart = Math.floor(Date.now() / 1000) - 2 * SECONDS.ONE_DAY;
  const existing = await db
    .prepare("SELECT id FROM daily_digest WHERE generated_at >= ? AND json_extract(digest_meta, '$.type') = 'weekly'")
    .bind(weekStart)
    .first();
  if (existing) {
    return { metadata: "skipped: weekly recap already exists" };
  }

  const recentWeeklyRows = await db
    .prepare(
      `SELECT digest_title, digest_text, digest_meta
       FROM daily_digest
       WHERE json_extract(digest_meta, '$.type') = 'weekly'
       ORDER BY generated_at DESC LIMIT 4`,
    )
    .all<{ digest_title: string | null; digest_text: string; digest_meta: string | null }>();
  const recentWeeklyMeta = buildRecentDigestMeta(recentWeeklyRows.results ?? [])
    .map((entry) => ({ meta: entry.meta as Record<string, unknown> | null, title: entry.title }));

  // Fetch last 7 daily digests (exclude weekly entries)
  const cutoff = Math.floor(Date.now() / 1000) - 8 * SECONDS.ONE_DAY;
  const dailyRows = await db
    .prepare(
      `SELECT generated_at, digest_title, digest_text, digest_extended, input_data
       FROM daily_digest
       WHERE generated_at >= ? AND (${NON_WEEKLY_DIGEST_SQL_FILTER})
       ORDER BY generated_at ASC`,
    )
    .bind(cutoff)
    .all<{ generated_at: number; digest_title: string | null; digest_text: string; digest_extended: string | null; input_data: string }>();

  const rows = (dailyRows.results ?? []).slice(-7);
  if (rows.length < 5) {
    return { metadata: `skipped: only ${rows.length} daily digests available (need 5+)` };
  }

  const weeklyData = buildWeeklyInputData(rows);
  if (!weeklyData) {
    return { metadata: "skipped: failed to build weekly input data" };
  }

  const userPrompt = buildWeeklyPrompt(weeklyData, recentWeeklyMeta);

  const digestCopy = await requestDigestCopy({
    db,
    anthropicApiKey,
    systemPrompt: WEEKLY_SYSTEM_PROMPT,
    userPrompt,
    maxTokens: 2000,
    signal,
    logPrefix: "weekly-recap",
    parseOptions: {
      metaFactory: ({ parsedMeta, usedRawTextFallback: degraded }) => ({
        ...(parsedMeta ?? {}),
        type: "weekly",
        periodType: weeklyData.periodType,
        weekStart: weeklyData.weekStartDate,
        weekEnd: weeklyData.weekEndDate,
        ...(degraded ? { degraded: "raw-text-fallback" } : {}),
      }),
    },
    validationProfile: {
      kind: "weekly",
      recentMeta: recentWeeklyMeta,
    },
  });
  if (digestCopy.kind === "circuit-open") {
    return { metadata: "skipped: anthropic circuit open" };
  }

  // Store
  const nowSec = Math.floor(Date.now() / 1000);
  await insertDigestRecord({
    db,
    generatedAt: nowSec,
    digestText: digestCopy.digestText,
    digestTitle: digestCopy.digestTitle || null,
    inputData: weeklyData,
    digestExtended: digestCopy.digestExtended || null,
    digestMeta: digestCopy.digestMeta,
  });

  // Post to Telegram
  const qualityGateStatus = digestCopy.hasBlockingQualityIssues ? "skipped: quality-gate" : null;
  const telegramStatus = qualityGateStatus ?? await runDigestChannelDelivery({
    db,
    circuitSource: CIRCUIT_SOURCE.TELEGRAM_API,
    creds: telegramCreds,
    logPrefix: "weekly-recap",
    channelLabel: "Telegram",
    deliver: async (creds) => {
      const weekLabel = `Week of ${weeklyData.weekStartDate}`;
      const tgTitle = `Weekly Recap: ${digestCopy.digestTitle || weekLabel}`;
      const date = new Date(nowSec * 1000).toISOString().slice(0, 10);
      await postDigestToTelegram(tgTitle, digestCopy.digestExtended, `${date}-weekly`, creds);
      return "ok";
    },
  });

  const qualityMetadata = digestCopy.qualityIssues.length > 0
    ? `, quality: ${digestCopy.qualityIssues.map((issue) => `${issue.code}:${issue.severity}`).join("|")}`
    : "";

  return {
    itemCount: 1,
    ...(digestCopy.usedRawTextFallback || digestCopy.qualityIssues.length > 0 ? { status: "degraded" as const } : {}),
    metadata: `weekly: ${digestCopy.digestText.length} chars, telegram: ${telegramStatus}${digestCopy.usedRawTextFallback ? ", degraded: raw-text-fallback" : ""}${qualityMetadata}`,
  };
}
