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

const WEEKLY_SYSTEM_PROMPT =
  "You write the weekly editorial recap for Pharos, a stablecoin analytics dashboard. " +
  "Your voice is dry, sharp, and memorable. Think sardonic wit meets hard data.\n\n" +
  "You receive a week's worth of daily digest data. Your job is to synthesize, not summarize. " +
  "Find the week's narrative arc: what started, what ended, what's building. " +
  "A weekly recap that reads like seven daily digests stapled together has failed.\n\n" +
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
  "You MUST respond with valid JSON: {\"title\": \"...\", \"extended\": \"...\", \"text\": \"...\", \"meta\": {\"lead\": \"...\", \"tone\": \"...\", \"coins\": [...]}}. " +
  "Output ONLY the raw JSON object. The title is 3-8 words capturing the week's theme. " +
  "The text field is a tweet-sized hook. Title + text must be under 270 chars combined.";

interface WeeklyInputData {
  weekStartDate: string;
  weekEndDate: string;
  dailyDigests: { date: string; title: string; text: string; inputData: DigestInputData }[];
  psiRange: { min: number; max: number; start: number; end: number; dominantBand: string };
  mcapRange: { start: number; end: number; netChange: number; pctChange: number };
  totalDepegsThisWeek: number;
  totalBlacklistEventsThisWeek: number;
  gradeTransitionCount: number;
  gaugeRange: { min: number; max: number } | null;
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

  const totalDepegs = parsed.reduce((sum, d) => sum + d.inputData.activeDepegCount, 0);
  const totalBlacklist = parsed.reduce((sum, d) => sum + (d.inputData.blacklistActivity?.eventCount ?? 0), 0);
  const gradeTransitionCount = parsed.reduce((sum, d) => sum + (d.inputData.gradeTransitions?.length ?? 0), 0);

  return {
    weekStartDate: parsed[0].date,
    weekEndDate: parsed[parsed.length - 1].date,
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
      pctChange: ((mcaps[mcaps.length - 1] - mcaps[0]) / mcaps[0]) * 100,
    },
    totalDepegsThisWeek: totalDepegs,
    totalBlacklistEventsThisWeek: totalBlacklist,
    gradeTransitionCount,
    gaugeRange: gauges.length >= 3 ? { min: Math.min(...gauges), max: Math.max(...gauges) } : null,
  };
}

function buildWeeklyPrompt(data: WeeklyInputData): string {
  const lines: string[] = [
    `Weekly recap: ${data.weekStartDate} to ${data.weekEndDate}`,
    "",
    `PSI range: ${data.psiRange.min} to ${data.psiRange.max} (start: ${data.psiRange.start}, end: ${data.psiRange.end})`,
    `Dominant band: ${data.psiRange.dominantBand}`,
    `Market cap: ${formatCurrency(data.mcapRange.start)} -> ${formatCurrency(data.mcapRange.end)} (${data.mcapRange.pctChange >= 0 ? "+" : ""}${data.mcapRange.pctChange.toFixed(2)}%)`,
    `Total depeg events across the week: ${data.totalDepegsThisWeek}`,
    `Total blacklist events: ${data.totalBlacklistEventsThisWeek}`,
    `Grade transitions: ${data.gradeTransitionCount}`,
  ];

  if (data.gaugeRange) {
    lines.push(`Bank Run Gauge range: ${Math.round(data.gaugeRange.min * 10) / 10} to ${Math.round(data.gaugeRange.max * 10) / 10}`);
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

  const rows = dailyRows.results ?? [];
  if (rows.length < 5) {
    return { metadata: `skipped: only ${rows.length} daily digests available (need 5+)` };
  }

  const weeklyData = buildWeeklyInputData(rows);
  if (!weeklyData) {
    return { metadata: "skipped: failed to build weekly input data" };
  }

  const userPrompt = buildWeeklyPrompt(weeklyData);

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
      weekStart: weeklyData.weekStartDate,
      weekEnd: weeklyData.weekEndDate,
      ...(degraded ? { degraded: "raw-text-fallback" } : {}),
    }),
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
  const telegramStatus = await runDigestChannelDelivery({
    db,
    circuitSource: CIRCUIT_SOURCE.TELEGRAM_API,
    creds: telegramCreds,
    logPrefix: "weekly-recap",
    channelLabel: "Telegram",
    deliver: async (creds) => {
      const weekLabel = `Week of ${weeklyData.weekStartDate}`;
      const tgTitle = `Weekly Recap: ${digestCopy.digestTitle || weekLabel}`;
      const date = new Date(nowSec * 1000).toISOString().slice(0, 10);
      await postDigestToTelegram(tgTitle, digestCopy.digestExtended, date, creds);
      return "ok";
    },
  });

  return {
    itemCount: 1,
    ...(digestCopy.usedRawTextFallback ? { status: "degraded" as const } : {}),
    metadata: `weekly: ${digestCopy.digestText.length} chars, telegram: ${telegramStatus}${digestCopy.usedRawTextFallback ? ", degraded: raw-text-fallback" : ""}`,
  };
}
