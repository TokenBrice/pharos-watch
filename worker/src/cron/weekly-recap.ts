import type { DigestInputData } from "@shared/types/digest";
import { formatCurrency } from "@shared/lib/format";
import { round1 } from "@shared/lib/math";
import {
  getDepegEditorialImpactScore,
  getDepegMarketImpactScore,
  isCriticalDepegRisk,
} from "@shared/lib/digest-risk";
import type { CronProgressReporter, CronResult } from "../lib/cron-logger";
import { postDigestToTelegram, type TelegramCreds } from "../lib/telegram";
import { SECONDS } from "../lib/time-constants";
import { CIRCUIT_SOURCE } from "../lib/constants";
import { logMalformedJsonPath } from "../lib/json-decode-observability";
import {
  didDigestChannelDeliver,
  insertDigestRecord,
  requestDigestCopy,
  runDigestChannelDelivery,
} from "./digest/platform";
import { reportDigestProgress } from "./digest/progress";
import { formatQualityMetadata } from "./digest/quality-metadata";
import { NON_WEEKLY_DIGEST_SQL_FILTER } from "./daily-digest/shared";
import { buildRecentDigestMeta } from "./daily-digest/runtime-helpers";
import type { DigestValidationProfile } from "./daily-digest/response";
import { rollupDigestInputs, type RollupSummary } from "./daily-digest/collectors-shared";
import { DEWS_BAND_RANK } from "./daily-digest/digest-intelligence-utils";

const WEEKLY_SYSTEM_PROMPT = [
  "You write the weekly editorial recap for Pharos, a stablecoin analytics dashboard.",
  "Dry, sharp, memorable, like a sardonic columnist synthesizing rather than reporting.",
  "",
  "You receive a week of daily digest data, pre-aggregated weekly signal leaderboards, and week-over-week delta summaries.",
  "Use the Weekly Risk Leaderboard and Weekly Signals block as the source of truth for the week's protagonists. Use the week-over-week deltas to frame where this week sits versus the previous one.",
  "Daily headlines show how the week felt in sequence; the signal leaderboard and deltas decide what mattered.",
  "The top unsuppressed Weekly Risk Leaderboard item must drive P1. If it is a critical depeg, PSI becomes regime context, not the lead.",
  "",
  "ARC FRAMING.",
  "Find the week's narrative arc: what started, what ended, what is building.",
  "A weekly recap that reads like seven daily digests stapled together has failed.",
  "Do not turn seven observations of the same chronic active depeg into seven events. Separate active observations from unique signals.",
  "Do not dramatize suppressed, stale, zero-dollar, tiny, or artifact-prone signals. If the week was genuinely calm, say so clearly.",
  "",
  "FORWARD-LOOK MANDATE.",
  "The last paragraph must contain an anticipatory sentence about next week. Acceptable: 'next week will decide whether X', 'watch the Y threshold if Z continues', 'the next trigger is W crossing V'.",
  "Retrospective-only recaps are rejected.",
  "",
  "SPICE BUDGET.",
  "Earn one sharp sentence per recap: a named analogy, a historical parallel, or a concrete-stakes observation.",
  "One per recap. Do not force it.",
  "",
  "FORBIDDEN TICS.",
  "Do NOT reuse: 'plumbing' (as metaphor), 'beneath the calm', 'restless depths', 'calm surfaces,', 'surface calm', 'something moving underneath', 'serene', 'worth watching/monitoring' or 'bears watching' as a closer, 'time will tell', 'the question is whether', 'it is worth asking whether'.",
  "",
  "FORMATTING.",
  "No emojis, no clickbait, no hedging, no exclamation marks.",
  "NEVER use em dashes or en dashes. Use commas, semicolons, colons, or periods.",
  "",
  "STRUCTURE.",
  "The extended field is 4-6 paragraphs, 250-400 words total.",
  "P1: the week's headline from the top unsuppressed risk leader, with PSI arc and dominant regime as context.",
  "P2: the dominant story, the thread that ran through multiple days.",
  "P3: the counter-narrative, what moved the opposite direction or was quietly significant.",
  "P4: supply and capital flows, weekly mcap movement, biggest movers, gauge trend, referring to week-over-week deltas when they change the story.",
  "P5-P6 (optional): a structural observation or the forward-look.",
  "If using fewer than 6 paragraphs, fold the forward-look into the last paragraph.",
  "",
  "Every sentence must contain a specific number or coin name. Reference individual daily headlines when they illustrate a point.",
  "",
  "OUTPUT CONTRACT.",
  'Respond with valid JSON only: { "title": "3-8 word headline", "extended": "...", "text": "tweet-sized hook under 270 chars combined with title", ',
  '  "meta": { "leadSignalId": "...", "lead": "one of allowed leads", "tone": "one of allowed tones", "coins": ["..."], "usedCandidateIds": [...] } }',
  "Allowed leads and tones are identical to the daily contract.",
].join("\n");

type WeeklyRiskKind = "depeg" | "dews" | "mint-burn" | "blacklist" | "grade" | "yield" | "liquidity" | "supply";

interface WeeklyDepegSignal {
  id: string;
  symbol: string;
  label: string;
  impactScore: number;
  severityScore: number;
  mcapUsd: number;
  bps: number;
  date: string;
  kind: "active" | "resolved";
  critical: boolean;
  suppressReason?: string;
}

type SpikeDepeg = Pick<WeeklyDepegSignal, "id" | "date" | "symbol" | "bps" | "mcapUsd" | "impactScore" | "kind" | "critical">;

interface WeeklyRiskLeaderboardSignal {
  id: string;
  kind: WeeklyRiskKind;
  label: string;
  symbols: string[];
  impactScore: number;
  severityScore: number;
  date?: string;
  critical?: boolean;
  suppressReason?: string;
}

interface WeeklySpikeMetrics {
  minPsi: { date: string; score: number; band: string } | null;
  minGauge: { date: string; score: number } | null;
  maxDepeg: SpikeDepeg | null;
  maxDepegImpact: SpikeDepeg | null;
}

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
  spikeMetrics: WeeklySpikeMetrics;
  weeklySignals: {
    riskLeaderboard: WeeklyRiskLeaderboardSignal[];
    topDepegSignals: WeeklyDepegSignal[];
    topSupplySignals: { symbol: string; label: string; amountUsd: number }[];
    topDewsChanges: { symbol: string; from: string; to: string; score: number; mcapUsd: number; driver: string }[];
    maxAlertPlusMcapUsd: number;
    topPressureSignals: { symbol: string; intensity: number; net24hUsd: number; date: string }[];
    topBlacklistEvents: { symbol: string; chain: string; type: string; amountUsd: number; date: string }[];
    topGradeTransitions: { symbol: string; fromGrade: string; toGrade: string; mcapUsd: number; date: string }[];
    topYieldAnomalies: { symbol: string; apy: number; warnings: string[]; mcapUsd: number; date: string }[];
    topLiquidityShifts: { symbol: string; scoreDelta: number; mcapUsd: number; date: string }[];
  };
  weekOverWeekDeltas: {
    mcap: { current: number; prior: number; deltaPct: number | null };
    psi: { current: number; prior: number; delta: number };
    psiDominantBand: { current: string; prior: string };
    activeDepegObservations: { current: number; prior: number };
    uniqueDepegSignals: { current: number; prior: number };
    blacklistEvents: { current: number; prior: number };
    blacklistUsd: { current: number; prior: number };
    gradeTransitions: { current: number; prior: number };
    gauge: { current: number | null; prior: number | null };
    dataCoverage: { currentDays: number; priorDays: number };
  } | null;
}

interface WeeklyParsedRow {
  inputData: DigestInputData;
  date: string;
  title: string;
  text: string;
}

interface ExistingWeeklyDigestRow {
  generated_at: number;
  digest_title: string | null;
  digest_text: string;
  digest_extended: string | null;
  digest_meta: string | null;
}

type WeeklyDigestMeta = Record<string, unknown>;

/**
 * File-local helper: collapse the `flatMap → sort desc → slice` shape used
 * for every weekly signal leaderboard. The `project` callback receives the
 * full parsed row (not just `inputData`) so projections can include the
 * day's date alongside per-row signal fields.
 */
function topSignals<TOut>(
  parsed: ReadonlyArray<WeeklyParsedRow>,
  project: (row: WeeklyParsedRow) => TOut[],
  sortKey: (out: TOut) => number,
  limit = 7,
): TOut[] {
  return parsed
    .flatMap(project)
    .sort((a, b) => sortKey(b) - sortKey(a))
    .slice(0, limit);
}

function weeklySignalId(kind: WeeklyRiskKind, parts: readonly string[]): string {
  return ["weekly", kind, ...parts]
    .join(":")
    .toLowerCase()
    .replace(/[^a-z0-9:.-]+/g, "-")
    .replace(/-+/g, "-");
}

function toSpikeDepeg(signal: WeeklyDepegSignal | undefined): SpikeDepeg | null {
  if (!signal) return null;
  return {
    id: signal.id,
    date: signal.date,
    symbol: signal.symbol,
    bps: signal.bps,
    mcapUsd: signal.mcapUsd,
    impactScore: signal.impactScore,
    kind: signal.kind,
    critical: signal.critical,
  };
}

function parseWeeklyDigestMeta(
  rawMeta: string | null,
  updatedAt: number | null,
): WeeklyDigestMeta {
  if (!rawMeta) return {};
  try {
    const parsed = JSON.parse(rawMeta) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return { ...(parsed as WeeklyDigestMeta) };
    }
  } catch (error) {
    logMalformedJsonPath({
      scope: "cron",
      owner: "weekly-recap",
      context: "daily_digest.digest_meta",
      reason: "json-parse-failed",
      source: "daily_digest",
      ...(updatedAt != null ? { updatedAt } : {}),
    }, error);
  }
  return {};
}

function encodeWeeklyDigestMeta(
  rawMeta: string | null,
  params: {
    generatedAt: number;
    nowSec: number;
    telegramDelivered: boolean;
    telegramDeliveryStatus: string;
    weeklyDefaults?: WeeklyDigestMeta;
  },
): string {
  const meta = parseWeeklyDigestMeta(rawMeta, params.generatedAt);
  if (!params.telegramDelivered) {
    delete meta.telegramDeliveredAt;
  }
  return JSON.stringify({
    ...(params.weeklyDefaults ?? {}),
    ...meta,
    telegramDelivered: params.telegramDelivered,
    telegramDeliveryStatus: params.telegramDeliveryStatus,
    telegramDeliveryUpdatedAt: params.nowSec,
    ...(params.telegramDelivered ? { telegramDeliveredAt: params.nowSec } : {}),
  });
}

function shouldRetryExistingWeeklyTelegram(meta: WeeklyDigestMeta): boolean {
  if (meta.telegramDelivered !== false) return false;
  return meta.telegramDeliveryStatus !== "skipped: quality-gate";
}

function weeklyMetaString(meta: WeeklyDigestMeta, key: string): string | null {
  const value = meta[key];
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

async function updateWeeklyTelegramDeliveryMeta(
  db: D1Database,
  row: { generated_at: number; digest_meta: string | null },
  params: { nowSec: number; telegramStatus: string },
): Promise<void> {
  const digestMeta = encodeWeeklyDigestMeta(row.digest_meta, {
    generatedAt: row.generated_at,
    nowSec: params.nowSec,
    telegramDelivered: didDigestChannelDeliver(params.telegramStatus),
    telegramDeliveryStatus: params.telegramStatus,
  });
  await db
    .prepare(
      `UPDATE daily_digest
          SET digest_meta = ?
        WHERE generated_at = ?
          AND json_extract(digest_meta, '$.type') = 'weekly'`,
    )
    .bind(digestMeta, row.generated_at)
    .run();
}

async function deliverWeeklyDigestToTelegram(params: {
  db: D1Database;
  telegramCreds: TelegramCreds | null;
  digestTitle: string | null;
  digestExtended: string | null;
  digestText: string;
  generatedAt: number;
  weekStartLabel: string;
}): Promise<string> {
  return runDigestChannelDelivery({
    db: params.db,
    circuitSource: CIRCUIT_SOURCE.TELEGRAM_API,
    creds: params.telegramCreds,
    logPrefix: "weekly-recap",
    channelLabel: "Telegram",
    deliver: async (creds) => {
      const weekLabel = `Week of ${params.weekStartLabel}`;
      const tgTitle = `Weekly Recap: ${params.digestTitle || weekLabel}`;
      const date = new Date(params.generatedAt * 1000).toISOString().slice(0, 10);
      await postDigestToTelegram(
        tgTitle,
        params.digestExtended ?? params.digestText,
        `${date}-weekly`,
        creds,
      );
      return "ok";
    },
  });
}

function gradeRiskRank(grade: string): number {
  const normalized = grade.trim().toUpperCase();
  if (normalized.startsWith("A")) return 0;
  if (normalized.startsWith("B")) return 1;
  if (normalized.startsWith("C")) return 2;
  if (normalized.startsWith("D")) return 3;
  if (normalized.startsWith("F")) return 4;
  return 2;
}

function buildWeeklyRiskLeaderboard(params: {
  depegs: WeeklyDepegSignal[];
  dewsChanges: WeeklyInputData["weeklySignals"]["topDewsChanges"];
  pressureSignals: WeeklyInputData["weeklySignals"]["topPressureSignals"];
  blacklistEvents: WeeklyInputData["weeklySignals"]["topBlacklistEvents"];
  gradeTransitions: WeeklyInputData["weeklySignals"]["topGradeTransitions"];
  yieldAnomalies: WeeklyInputData["weeklySignals"]["topYieldAnomalies"];
  liquidityShifts: WeeklyInputData["weeklySignals"]["topLiquidityShifts"];
  supplySignals: WeeklyInputData["weeklySignals"]["topSupplySignals"];
}): WeeklyRiskLeaderboardSignal[] {
  const rows: WeeklyRiskLeaderboardSignal[] = [];

  for (const depeg of params.depegs) {
    rows.push({
      id: depeg.id,
      kind: "depeg",
      label: `${depeg.date} ${depeg.symbol}: ${depeg.label}, ${formatCurrency(depeg.mcapUsd)} mcap`,
      symbols: [depeg.symbol],
      date: depeg.date,
      impactScore: depeg.impactScore,
      severityScore: depeg.severityScore,
      critical: depeg.critical,
      ...(depeg.suppressReason ? { suppressReason: depeg.suppressReason } : {}),
    });
  }

  for (const change of params.dewsChanges) {
    const fromRank = DEWS_BAND_RANK[change.from] ?? 0;
    const toRank = DEWS_BAND_RANK[change.to] ?? 0;
    if (toRank <= fromRank) continue;
    const score = Math.max(1, change.mcapUsd / 1_000_000 + change.score);
    rows.push({
      id: weeklySignalId("dews", [change.symbol, change.from, change.to]),
      kind: "dews",
      label: `${change.symbol}: DEWS ${change.from} -> ${change.to}, score ${change.score}, driver ${change.driver}`,
      symbols: [change.symbol],
      impactScore: change.mcapUsd / 1_000_000,
      severityScore: score,
    });
  }

  for (const pressure of params.pressureSignals) {
    rows.push({
      id: weeklySignalId("mint-burn", [pressure.date, pressure.symbol, "pressure"]),
      kind: "mint-burn",
      label: `${pressure.date} ${pressure.symbol}: mint/burn intensity ${Math.round(pressure.intensity)}, net ${formatCurrency(pressure.net24hUsd)}`,
      symbols: [pressure.symbol],
      date: pressure.date,
      impactScore: Math.abs(pressure.net24hUsd) / 1_000_000,
      severityScore: Math.abs(pressure.net24hUsd) / 1_000_000 + Math.abs(pressure.intensity),
    });
  }

  for (const event of params.blacklistEvents) {
    rows.push({
      id: weeklySignalId("blacklist", [event.date, event.symbol, event.chain, event.type]),
      kind: "blacklist",
      label: `${event.date} ${event.symbol} on ${event.chain}: ${event.type}, ${formatCurrency(event.amountUsd)}`,
      symbols: [event.symbol],
      date: event.date,
      impactScore: event.amountUsd / 1_000_000,
      severityScore: event.amountUsd / 1_000_000,
    });
  }

  for (const transition of params.gradeTransitions) {
    const downgradeSteps = gradeRiskRank(transition.toGrade) - gradeRiskRank(transition.fromGrade);
    if (downgradeSteps <= 0) continue;
    rows.push({
      id: weeklySignalId("grade", [transition.date, transition.symbol, transition.fromGrade, transition.toGrade]),
      kind: "grade",
      label: `${transition.date} ${transition.symbol}: grade ${transition.fromGrade} -> ${transition.toGrade}, ${formatCurrency(transition.mcapUsd)} mcap`,
      symbols: [transition.symbol],
      date: transition.date,
      impactScore: transition.mcapUsd / 1_000_000,
      severityScore: downgradeSteps * transition.mcapUsd / 1_000_000,
    });
  }

  for (const anomaly of params.yieldAnomalies) {
    rows.push({
      id: weeklySignalId("yield", [anomaly.date, anomaly.symbol]),
      kind: "yield",
      label: `${anomaly.date} ${anomaly.symbol}: ${anomaly.apy}% APY, ${anomaly.warnings.join(", ")}`,
      symbols: [anomaly.symbol],
      date: anomaly.date,
      impactScore: anomaly.mcapUsd / 1_000_000,
      severityScore: anomaly.mcapUsd / 10_000_000 + anomaly.warnings.length * 25,
      suppressReason: "yield anomaly requires corroboration before leading",
    });
  }

  for (const shift of params.liquidityShifts) {
    if (shift.scoreDelta >= 0) continue;
    rows.push({
      id: weeklySignalId("liquidity", [shift.date, shift.symbol]),
      kind: "liquidity",
      label: `${shift.date} ${shift.symbol}: liquidity score ${shift.scoreDelta}, ${formatCurrency(shift.mcapUsd)} mcap`,
      symbols: [shift.symbol],
      date: shift.date,
      impactScore: Math.abs(shift.scoreDelta) * shift.mcapUsd / 1_000_000_000,
      severityScore: Math.abs(shift.scoreDelta) * shift.mcapUsd / 1_000_000_000,
    });
  }

  for (const supply of params.supplySignals) {
    if (supply.amountUsd >= 0) continue;
    rows.push({
      id: weeklySignalId("supply", [supply.symbol, supply.label]),
      kind: "supply",
      label: `${supply.symbol}: ${supply.label}, ${formatCurrency(supply.amountUsd)}`,
      symbols: [supply.symbol],
      impactScore: Math.abs(supply.amountUsd) / 1_000_000,
      severityScore: Math.abs(supply.amountUsd) / 1_000_000,
    });
  }

  return rows
    .sort((a, b) => {
      const suppressionDelta = Number(Boolean(a.suppressReason)) - Number(Boolean(b.suppressReason));
      const criticalDelta = Number(Boolean(b.critical)) - Number(Boolean(a.critical));
      return suppressionDelta || criticalDelta || b.severityScore - a.severityScore || b.impactScore - a.impactScore;
    })
    .slice(0, 7);
}

function parseDailyRows(
  dailyRows: { generated_at: number; digest_title: string | null; digest_text: string; input_data: string }[],
): WeeklyParsedRow[] {
  const parsed: WeeklyParsedRow[] = [];
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
  return parsed;
}

interface WeeklyTopSignals extends Omit<WeeklyInputData["weeklySignals"], "riskLeaderboard"> {
  allDepegSignals: WeeklyDepegSignal[];
}

function collectWeeklyTopSignals(parsed: WeeklyParsedRow[]): WeeklyTopSignals {
  const allDepegSignals = parsed.flatMap((d) => [
    ...(d.inputData.topDepegs ?? []).map((depeg) => {
      const impactScore = depeg.impactScore ?? getDepegMarketImpactScore(depeg.bps, depeg.mcapUsd);
      return {
        id: weeklySignalId("depeg", [depeg.stablecoinId ?? depeg.symbol, String(depeg.startedAt ?? d.date), "active"]),
        symbol: depeg.symbol,
        label: `${Math.abs(depeg.bps)} bps active ${depeg.direction ?? (depeg.bps >= 0 ? "above" : "below")} peg`,
        impactScore,
        severityScore: getDepegEditorialImpactScore(depeg.bps, depeg.mcapUsd),
        mcapUsd: depeg.mcapUsd,
        bps: Math.abs(depeg.bps),
        date: d.date,
        kind: "active" as const,
        critical: isCriticalDepegRisk(depeg),
        suppressReason: depeg.suppressReason,
      };
    }),
    ...(d.inputData.resolvedDepegs ?? []).map((depeg) => {
      const impactScore = depeg.impactScore ?? getDepegMarketImpactScore(depeg.peakBps, depeg.mcapUsd);
      return {
        id: weeklySignalId("depeg", [depeg.stablecoinId ?? depeg.symbol, String(depeg.startedAt ?? d.date), "resolved"]),
        symbol: depeg.symbol,
        label: `${depeg.peakBps} bps resolved after ${depeg.durationHours}h`,
        impactScore,
        severityScore: getDepegEditorialImpactScore(depeg.peakBps, depeg.mcapUsd),
        mcapUsd: depeg.mcapUsd,
        bps: depeg.peakBps,
        date: d.date,
        kind: "resolved" as const,
        critical: isCriticalDepegRisk({ bps: depeg.peakBps, mcapUsd: depeg.mcapUsd }),
      };
    }),
  ]);
  const topDepegSignals = [...allDepegSignals]
    .sort((a, b) => Number(b.critical) - Number(a.critical) || b.severityScore - a.severityScore || b.impactScore - a.impactScore)
    .slice(0, 7);
  const topSupplySignals = topSignals(parsed, (d) => {
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
  }, (row) => Math.abs(row.amountUsd));
  // DEWS uses an mcap-major / score-minor sort. Encode as a single numeric
  // key (mcap is non-negative USD, score is a bounded small integer) so we
  // can flow through the generic `sortKey: number` helper while preserving
  // the original `b.mcapUsd - a.mcapUsd || b.score - a.score` ordering.
  const topDewsChanges = topSignals(
    parsed,
    (d) => (d.inputData.dewsStress?.bandChanges ?? []).map((change) => ({
      symbol: change.symbol,
      from: change.from,
      to: change.to,
      score: change.score,
      mcapUsd: change.mcapUsd ?? 0,
      driver: change.topDriver,
    })),
    (row) => row.mcapUsd * 1000 + row.score,
  );
  const maxAlertPlusMcapUsd = Math.max(
    0,
    ...parsed.map((d) => (d.inputData.dewsStress?.elevatedCoins ?? []).reduce((sum, coin) => sum + coin.mcapUsd, 0)),
  );
  const topPressureSignals = topSignals(
    parsed,
    (d) => (d.inputData.mintBurnFlows?.topPressure ?? []).map((pressure) => ({
      symbol: pressure.symbol,
      intensity: pressure.intensity,
      net24hUsd: pressure.net24hUsd,
      date: d.date,
    })),
    (row) => Math.abs(row.intensity),
  );
  const topBlacklistEvents = topSignals(
    parsed,
    (d) => (d.inputData.blacklistActivity?.topEvents ?? []).map((event) => ({
      symbol: event.symbol,
      chain: event.chain,
      type: event.type,
      amountUsd: event.amountUsd,
      date: d.date,
    })),
    (row) => row.amountUsd,
  );
  const topGradeTransitions = topSignals(
    parsed,
    (d) => (d.inputData.gradeTransitions ?? [])
      .map((transition) => ({
        symbol: transition.symbol,
        fromGrade: transition.fromGrade,
        toGrade: transition.toGrade,
        mcapUsd: transition.mcapUsd,
        date: d.date,
      }))
      .filter((transition) => transition.mcapUsd != null),
    (row) => row.mcapUsd,
  );
  const topYieldAnomalies = topSignals(
    parsed,
    (d) => (d.inputData.yieldAnomalies ?? []).map((anomaly) => ({
      symbol: anomaly.symbol,
      apy: anomaly.currentApy,
      warnings: anomaly.warnings,
      mcapUsd: anomaly.mcapUsd,
      date: d.date,
    })),
    (row) => row.mcapUsd,
  );
  const topLiquidityShifts = topSignals(
    parsed,
    (d) => (d.inputData.liquidityShifts ?? []).map((shift) => ({
      symbol: shift.symbol,
      scoreDelta: shift.scoreDelta,
      mcapUsd: shift.mcapUsd,
      date: d.date,
    })),
    (row) => Math.abs(row.scoreDelta) * row.mcapUsd,
  );

  return {
    allDepegSignals,
    topDepegSignals,
    topSupplySignals,
    topDewsChanges,
    maxAlertPlusMcapUsd,
    topPressureSignals,
    topBlacklistEvents,
    topGradeTransitions,
    topYieldAnomalies,
    topLiquidityShifts,
  };
}

function buildWeeklySpikeMetrics(
  parsed: WeeklyParsedRow[],
  allDepegSignals: WeeklyDepegSignal[],
): WeeklySpikeMetrics {
  const psiObservations = parsed
    .map((d) => d.inputData.stabilityIndex ? { date: d.date, score: d.inputData.stabilityIndex.score, band: d.inputData.stabilityIndex.band } : null)
    .filter((entry): entry is { date: string; score: number; band: string } => entry !== null);
  const gaugeObservations = parsed
    .map((d) => d.inputData.mintBurnFlows?.gaugeScore != null ? { date: d.date, score: d.inputData.mintBurnFlows.gaugeScore } : null)
    .filter((entry): entry is { date: string; score: number } => entry !== null);
  const maxDepegByBps = [...allDepegSignals].sort((a, b) => b.bps - a.bps || b.impactScore - a.impactScore)[0];
  const maxDepegByImpact = [...allDepegSignals].sort((a, b) => b.impactScore - a.impactScore || b.bps - a.bps)[0];
  return {
    minPsi: psiObservations.length > 0 ? [...psiObservations].sort((a, b) => a.score - b.score)[0] : null,
    minGauge: gaugeObservations.length > 0 ? [...gaugeObservations].sort((a, b) => a.score - b.score)[0] : null,
    maxDepeg: toSpikeDepeg(maxDepegByBps),
    maxDepegImpact: toSpikeDepeg(maxDepegByImpact),
  };
}

function buildWeeklyWowDeltas(
  current: RollupSummary,
  priorParsed: WeeklyParsedRow[],
): WeeklyInputData["weekOverWeekDeltas"] {
  if (priorParsed.length < 5) return null;
  const prior = rollupDigestInputs(priorParsed.map((d) => d.inputData));
  return {
    mcap: {
      current: current.mcapEnd,
      prior: prior.mcapEnd,
      deltaPct: prior.mcapEnd > 0 ? ((current.mcapEnd - prior.mcapEnd) / prior.mcapEnd) * 100 : null,
    },
    psi: { current: current.psiMid, prior: prior.psiMid, delta: current.psiMid - prior.psiMid },
    psiDominantBand: { current: current.psiDominantBand, prior: prior.psiDominantBand },
    activeDepegObservations: { current: current.activeDepegObs, prior: prior.activeDepegObs },
    uniqueDepegSignals: { current: current.uniqueDepegSignals, prior: prior.uniqueDepegSignals },
    blacklistEvents: { current: current.blacklistEvents, prior: prior.blacklistEvents },
    blacklistUsd: { current: current.blacklistUsd, prior: prior.blacklistUsd },
    gradeTransitions: { current: current.gradeTransitions, prior: prior.gradeTransitions },
    gauge: { current: current.gaugeMid, prior: prior.gaugeMid },
    dataCoverage: { currentDays: current.days, priorDays: prior.days },
  };
}

function buildWeeklyInputData(
  currentDailyRows: { generated_at: number; digest_title: string | null; digest_text: string; input_data: string }[],
  priorDailyRows: { generated_at: number; digest_title: string | null; digest_text: string; input_data: string }[] = [],
): WeeklyInputData | null {
  const parsed = parseDailyRows(currentDailyRows);
  const priorParsed = parseDailyRows(priorDailyRows);
  if (parsed.length < 5) return null;

  const psiScores = parsed.map((d) => d.inputData.stabilityIndex?.score).filter((s): s is number => s != null);
  const mcaps = parsed.map((d) => d.inputData.totalMcapUsd);
  const gauges = parsed.map((d) => d.inputData.mintBurnFlows?.gaugeScore).filter((g): g is number => g != null);

  if (psiScores.length === 0 || mcaps.length === 0) return null;

  const current = rollupDigestInputs(parsed.map((d) => d.inputData));
  const dominantBand = current.psiDominantBand;

  const { allDepegSignals, ...topSignalsResult } = collectWeeklyTopSignals(parsed);
  const {
    topDepegSignals,
    topSupplySignals,
    topDewsChanges,
    maxAlertPlusMcapUsd,
    topPressureSignals,
    topBlacklistEvents,
    topGradeTransitions,
    topYieldAnomalies,
    topLiquidityShifts,
  } = topSignalsResult;

  const spikeMetrics = buildWeeklySpikeMetrics(parsed, allDepegSignals);

  const riskLeaderboard = buildWeeklyRiskLeaderboard({
    depegs: topDepegSignals,
    dewsChanges: topDewsChanges,
    pressureSignals: topPressureSignals,
    blacklistEvents: topBlacklistEvents,
    gradeTransitions: topGradeTransitions,
    yieldAnomalies: topYieldAnomalies,
    liquidityShifts: topLiquidityShifts,
    supplySignals: topSupplySignals,
  });

  const weekOverWeekDeltas = buildWeeklyWowDeltas(current, priorParsed);

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
    activeDepegObservationsThisWeek: current.activeDepegObs,
    uniqueDepegSignalsThisWeek: current.uniqueDepegSignals,
    totalBlacklistEventsThisWeek: current.blacklistEvents,
    totalBlacklistAmountUsd: current.blacklistUsd,
    gradeTransitionCount: current.gradeTransitions,
    gaugeRange: gauges.length >= 3 ? { min: Math.min(...gauges), max: Math.max(...gauges) } : null,
    spikeMetrics,
    weeklySignals: {
      riskLeaderboard,
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
    weekOverWeekDeltas,
  };
}

function buildWeeklyPrompt(
  data: WeeklyInputData,
  recentWeeklyMeta: { meta: Record<string, unknown> | null; title: string | null; rawText?: string | null }[] = [],
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
    lines.push(`Bank Run Gauge range: ${round1(data.gaugeRange.min)} to ${round1(data.gaugeRange.max)}`);
  }

  lines.push("", "Weekly spike metrics (do not let averages erase these):");
  if (data.spikeMetrics.minPsi) {
    lines.push(`  Worst PSI day: ${data.spikeMetrics.minPsi.date}, ${data.spikeMetrics.minPsi.score} [${data.spikeMetrics.minPsi.band}]`);
  }
  if (data.spikeMetrics.minGauge) {
    lines.push(`  Lowest Bank Run Gauge day: ${data.spikeMetrics.minGauge.date}, ${round1(data.spikeMetrics.minGauge.score)}`);
  }
  if (data.spikeMetrics.maxDepeg) {
    lines.push(`  Worst depeg by bps: ${data.spikeMetrics.maxDepeg.date} ${data.spikeMetrics.maxDepeg.symbol}, ${data.spikeMetrics.maxDepeg.bps} bps, ${formatCurrency(data.spikeMetrics.maxDepeg.mcapUsd)} mcap`);
  }
  if (data.spikeMetrics.maxDepegImpact) {
    lines.push(`  Largest depeg market impact: ${data.spikeMetrics.maxDepegImpact.date} ${data.spikeMetrics.maxDepegImpact.symbol}, impact ${data.spikeMetrics.maxDepegImpact.impactScore}, ${data.spikeMetrics.maxDepegImpact.bps} bps`);
  }

  if (data.weekOverWeekDeltas) {
    const d = data.weekOverWeekDeltas;
    lines.push("", "Week-over-week deltas (this week vs prior week):");
    lines.push(`  mcap: current ${formatCurrency(d.mcap.current)} / prior ${formatCurrency(d.mcap.prior)} / delta ${d.mcap.deltaPct == null ? "n/a" : `${d.mcap.deltaPct >= 0 ? "+" : ""}${d.mcap.deltaPct.toFixed(2)}%`}`);
    lines.push(`  PSI midpoint: current ${d.psi.current.toFixed(1)} / prior ${d.psi.prior.toFixed(1)} / delta ${d.psi.delta >= 0 ? "+" : ""}${d.psi.delta.toFixed(1)}`);
    lines.push(`  PSI dominant band: current ${d.psiDominantBand.current} / prior ${d.psiDominantBand.prior}`);
    lines.push(`  Active depeg observations: current ${d.activeDepegObservations.current} / prior ${d.activeDepegObservations.prior}`);
    lines.push(`  Unique depeg signals: current ${d.uniqueDepegSignals.current} / prior ${d.uniqueDepegSignals.prior}`);
    lines.push(`  Blacklist events: current ${d.blacklistEvents.current} / prior ${d.blacklistEvents.prior}`);
    lines.push(`  Blacklist USD: current ${formatCurrency(d.blacklistUsd.current)} / prior ${formatCurrency(d.blacklistUsd.prior)}`);
    lines.push(`  Grade transitions: current ${d.gradeTransitions.current} / prior ${d.gradeTransitions.prior}`);
    if (d.gauge.current != null && d.gauge.prior != null) {
      lines.push(`  Bank Run Gauge midpoint: current ${d.gauge.current.toFixed(1)} / prior ${d.gauge.prior.toFixed(1)}`);
    }
    lines.push(`  Data coverage: ${d.dataCoverage.currentDays}d current, ${d.dataCoverage.priorDays}d prior`);
  } else {
    lines.push("", "Week-over-week deltas: unavailable (insufficient prior-week history).");
  }

  lines.push("", "Weekly Risk Leaderboard (P1 lead must be the top unsuppressed item):");
  if (data.weeklySignals.riskLeaderboard.length > 0) {
    for (const signal of data.weeklySignals.riskLeaderboard) {
      const critical = signal.critical ? " | critical" : "";
      const suppression = signal.suppressReason ? ` | suppress: ${signal.suppressReason}` : "";
      lines.push(`  ${signal.id} | ${signal.kind} | severity=${round1(signal.severityScore)} | impact=${round1(signal.impactScore)}${critical}${suppression}`);
      lines.push(`    ${signal.label}`);
    }
  } else {
    lines.push("  No material risk signals reconstructed from daily inputs.");
  }

  lines.push("", "Weekly Signals (synthesize from this, do not merely recap daily copy):");
  if (data.weeklySignals.topDepegSignals.length > 0) {
    lines.push("  Top depeg signals by absolute market impact:");
    for (const signal of data.weeklySignals.topDepegSignals) {
      const suppression = signal.suppressReason ? ` | suppress: ${signal.suppressReason}` : "";
      const critical = signal.critical ? " | critical" : "";
      lines.push(`    ${signal.date} ${signal.symbol}: ${signal.label}, ${formatCurrency(signal.mcapUsd)} mcap, impact ${signal.impactScore}, severity ${signal.severityScore}${critical}${suppression}`);
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

function buildWeeklyLeadRequirements(data: WeeklyInputData): DigestValidationProfile["leadRequirements"] {
  const topCritical = data.weeklySignals.riskLeaderboard.find((signal) => !signal.suppressReason && signal.critical);
  if (!topCritical) return undefined;
  return [{
    candidateIds: [topCritical.id],
    severity: "hard",
    mentionTokens: topCritical.symbols,
    reason: `weekly risk leaderboard critical ${topCritical.kind} must drive the lead`,
  }];
}

export async function generateWeeklyRecap(
  db: D1Database,
  anthropicApiKey: string | null,
  telegramCreds: TelegramCreds | null = null,
  signal?: AbortSignal,
  reportProgress?: CronProgressReporter,
): Promise<CronResult> {
  await reportDigestProgress(reportProgress, {
    stage: "preflight",
    message: "Checking weekly recap prerequisites",
    providerFamily: "digest",
    itemsDone: 0,
    itemsTotal: 1,
    metadata: {
      countTotals: {
        configuredDeliveryChannels: Number(Boolean(telegramCreds)),
      },
    },
  });
  if (!anthropicApiKey) {
    await reportDigestProgress(reportProgress, {
      stage: "skipped",
      message: "Skipping weekly recap because Anthropic credentials are missing",
      providerFamily: "anthropic",
      itemsDone: 0,
      itemsTotal: 1,
      metadata: {
        skipped: "missing-api-key",
      },
    });
    return { metadata: "skipped: no API key" };
  }

  // Check if today is Monday (UTC)
  const now = new Date();
  if (now.getUTCDay() !== 1) {
    await reportDigestProgress(reportProgress, {
      stage: "skipped",
      message: "Skipping weekly recap outside Monday UTC",
      providerFamily: "digest",
      itemsDone: 0,
      itemsTotal: 1,
      metadata: {
        skipped: "not-monday",
        utcDay: now.getUTCDay(),
      },
    });
    return { metadata: "skipped: not Monday" };
  }

  // Check if weekly recap already exists for this week. Rows that were
  // generated but not delivered to Telegram stay eligible for a delivery retry.
  const weekStart = Math.floor(Date.now() / 1000) - 2 * SECONDS.ONE_DAY;
  const existing = await db
    .prepare(
      `SELECT generated_at, digest_title, digest_text, digest_extended, digest_meta
         FROM daily_digest
        WHERE generated_at >= ?
          AND json_extract(digest_meta, '$.type') = 'weekly'
        ORDER BY generated_at DESC
        LIMIT 1`,
    )
    .bind(weekStart)
    .first<ExistingWeeklyDigestRow>();
  if (existing) {
    const existingMeta = parseWeeklyDigestMeta(existing.digest_meta, existing.generated_at);
    if (!shouldRetryExistingWeeklyTelegram(existingMeta)) {
      await reportDigestProgress(reportProgress, {
        stage: "skipped",
        message: "Skipping weekly recap because this week already exists",
        providerFamily: "digest",
        itemsDone: 0,
        itemsTotal: 1,
        metadata: {
          skipped: "weekly-recap-exists",
          existingGeneratedAt: existing.generated_at,
        },
      });
      return { metadata: "skipped: weekly recap already exists" };
    }
    await reportDigestProgress(reportProgress, {
      stage: "telegram-delivery-retry",
      message: "Retrying weekly recap Telegram delivery",
      providerFamily: "telegram-api",
      itemsDone: 0,
      itemsTotal: 1,
      metadata: {
        existingGeneratedAt: existing.generated_at,
      },
    });
    const retryStatus = await deliverWeeklyDigestToTelegram({
      db,
      telegramCreds,
      digestTitle: existing.digest_title,
      digestExtended: existing.digest_extended,
      digestText: existing.digest_text,
      generatedAt: existing.generated_at,
      weekStartLabel: weeklyMetaString(existingMeta, "weekStart")
        ?? new Date(existing.generated_at * 1000).toISOString().slice(0, 10),
    });
    await updateWeeklyTelegramDeliveryMeta(db, existing, {
      nowSec: Math.floor(Date.now() / 1000),
      telegramStatus: retryStatus,
    });
    await reportDigestProgress(reportProgress, {
      stage: "complete",
      message: "Completed weekly recap Telegram retry",
      providerFamily: "telegram-api",
      itemsDone: 1,
      itemsTotal: 1,
      metadata: {
        telegramStatus: retryStatus,
      },
    });
    return {
      itemCount: 0,
      metadata: `weekly: existing recap delivery retry, telegram: ${retryStatus}`,
    };
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
    .map((entry) => ({
      meta: entry.meta as Record<string, unknown> | null,
      title: entry.title,
      rawText: entry.rawText,
    }));

  await reportDigestProgress(reportProgress, {
    stage: "input-collection",
    message: "Collecting weekly recap source digests",
    providerFamily: "pharos-d1",
    itemsDone: 0,
    itemsTotal: 15,
    metadata: {
      countTotals: {
        recentWeeklyMeta: recentWeeklyMeta.length,
      },
    },
  });
  // 15-day cutoff + LIMIT 15 captures current + prior weeks for WoW
  // deltas and bounds the result set deterministically even if the dedup
  // guard ever drifts.
  const cutoff = Math.floor(Date.now() / 1000) - 15 * SECONDS.ONE_DAY;
  const dailyRows = await db
    .prepare(
      `WITH latest_daily AS (
         SELECT generated_at, digest_title, digest_text, digest_extended, input_data,
                ROW_NUMBER() OVER (
                  PARTITION BY strftime('%Y-%m-%d', generated_at, 'unixepoch')
                  ORDER BY generated_at DESC
                ) AS row_rank
         FROM daily_digest
         WHERE generated_at >= ? AND (${NON_WEEKLY_DIGEST_SQL_FILTER})
       )
       SELECT generated_at, digest_title, digest_text, digest_extended, input_data
       FROM latest_daily
       WHERE row_rank = 1
       ORDER BY generated_at ASC
       LIMIT 15`,
    )
    .bind(cutoff)
    .all<{ generated_at: number; digest_title: string | null; digest_text: string; digest_extended: string | null; input_data: string }>();

  const allRows = dailyRows.results ?? [];
  // Snap the split to a UTC day boundary (= last Tuesday 00:00 UTC given
  // the Monday 08:05 cron slot). Day-level snap removes sub-second drift
  // ambiguity between weekly runs, unlike a rolling `now - 7d` window.
  const nowSec = Math.floor(Date.now() / 1000);
  const todayTs = nowSec - (nowSec % SECONDS.ONE_DAY);
  const weekBoundary = todayTs - 6 * SECONDS.ONE_DAY;
  const currentRows = allRows.filter((r) => r.generated_at >= weekBoundary);
  const priorRows = allRows.filter((r) => r.generated_at < weekBoundary);
  await reportDigestProgress(reportProgress, {
    stage: "input-collected",
    message: "Collected weekly recap source digests",
    providerFamily: "pharos-d1",
    itemsDone: allRows.length,
    itemsTotal: 15,
    metadata: {
      countTotals: {
        totalDailyRows: allRows.length,
        currentWeekRows: currentRows.length,
        priorWeekRows: priorRows.length,
        recentWeeklyMeta: recentWeeklyMeta.length,
      },
      cursor: {
        weekBoundary,
      },
    },
  });

  if (currentRows.length < 5) {
    await reportDigestProgress(reportProgress, {
      stage: "skipped",
      message: "Skipping weekly recap because current-week coverage is incomplete",
      providerFamily: "pharos-d1",
      itemsDone: currentRows.length,
      itemsTotal: 5,
      metadata: {
        skipped: "insufficient-current-week-digests",
        countTotals: {
          currentWeekRows: currentRows.length,
          requiredCurrentWeekRows: 5,
        },
      },
    });
    return { metadata: `skipped: only ${currentRows.length} daily digests available in current week (need 5+)` };
  }

  const weeklyData = buildWeeklyInputData(currentRows, priorRows);
  if (!weeklyData) {
    await reportDigestProgress(reportProgress, {
      stage: "input-unavailable",
      message: "Failed to build weekly recap input data",
      providerFamily: "pharos-d1",
      itemsDone: currentRows.length,
      itemsTotal: currentRows.length,
    });
    return { metadata: "skipped: failed to build weekly input data" };
  }

  const userPrompt = buildWeeklyPrompt(weeklyData, recentWeeklyMeta);
  await reportDigestProgress(reportProgress, {
    stage: "llm-generation",
    message: "Requesting weekly recap copy from Anthropic",
    providerFamily: "anthropic",
    itemsDone: 0,
    itemsTotal: 1,
    metadata: {
      countTotals: {
        promptChars: userPrompt.length,
        currentWeekRows: currentRows.length,
        priorWeekRows: priorRows.length,
        weeklyRiskSignals: weeklyData.weeklySignals.riskLeaderboard.length,
        maxTokens: 64000,
      },
    },
  });

  const digestCopy = await requestDigestCopy({
    db,
    anthropicApiKey,
    systemPrompt: WEEKLY_SYSTEM_PROMPT,
    userPrompt,
    // Matches daily-digest's 64k floor for Opus 4.7 adaptive thinking at
    // xhigh effort — same runaway-thinking failure mode would apply here.
    maxTokens: 64000,
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
      leadRequirements: buildWeeklyLeadRequirements(weeklyData),
    },
  });
  if (digestCopy.kind === "circuit-open") {
    await reportDigestProgress(reportProgress, {
      stage: "skipped",
      message: "Skipping weekly recap because Anthropic circuit is open",
      providerFamily: "anthropic",
      itemsDone: 0,
      itemsTotal: 1,
      metadata: {
        skipped: "anthropic-circuit-open",
      },
    });
    return { metadata: "skipped: anthropic circuit open" };
  }
  await reportDigestProgress(reportProgress, {
    stage: "llm-generation-complete",
    message: "Received weekly recap copy from Anthropic",
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

  const initialDigestMeta = encodeWeeklyDigestMeta(digestCopy.digestMeta, {
    generatedAt: nowSec,
    nowSec,
    telegramDelivered: false,
    telegramDeliveryStatus: "pending",
    weeklyDefaults: {
      type: "weekly",
      periodType: weeklyData.periodType,
      weekStart: weeklyData.weekStartDate,
      weekEnd: weeklyData.weekEndDate,
    },
  });

  // Store
  await reportDigestProgress(reportProgress, {
    stage: "persistence",
    message: "Persisting weekly recap row",
    providerFamily: "d1",
    itemsDone: 0,
    itemsTotal: 1,
    metadata: {
      cursor: {
        weekStart: weeklyData.weekStartDate,
        weekEnd: weeklyData.weekEndDate,
      },
    },
  });
  await insertDigestRecord({
    db,
    generatedAt: nowSec,
    digestText: digestCopy.digestText,
    digestTitle: digestCopy.digestTitle || null,
    inputData: weeklyData,
    digestExtended: digestCopy.digestExtended || null,
    digestMeta: initialDigestMeta,
  });

  // Post to Telegram
  const qualityGateStatus = digestCopy.hasBlockingQualityIssues ? "skipped: quality-gate" : null;
  await reportDigestProgress(reportProgress, {
    stage: "telegram-delivery",
    message: "Delivering weekly recap to Telegram",
    providerFamily: "telegram-api",
    itemsDone: 0,
    itemsTotal: 1,
    metadata: {
      qualityGateStatus,
    },
  });
  const telegramStatus = qualityGateStatus ?? await deliverWeeklyDigestToTelegram({
    db,
    telegramCreds,
    digestTitle: digestCopy.digestTitle || null,
    digestExtended: digestCopy.digestExtended || null,
    digestText: digestCopy.digestText,
    generatedAt: nowSec,
    weekStartLabel: weeklyData.weekStartDate,
  });
  await updateWeeklyTelegramDeliveryMeta(db, {
    generated_at: nowSec,
    digest_meta: initialDigestMeta,
  }, {
    nowSec,
    telegramStatus,
  });

  const qualityMetadata = formatQualityMetadata(digestCopy.qualityIssues);

  await reportDigestProgress(reportProgress, {
    stage: "complete",
    message: "Completed weekly recap generation",
    providerFamily: "digest",
    itemsDone: 1,
    itemsTotal: 1,
    metadata: {
      countTotals: {
        textChars: digestCopy.digestText.length,
        extendedChars: digestCopy.digestExtended.length,
        qualityIssues: digestCopy.qualityIssues.length,
      },
      telegramStatus,
      usedRawTextFallback: digestCopy.usedRawTextFallback,
    },
  });
  return {
    itemCount: 1,
    ...(digestCopy.usedRawTextFallback || digestCopy.qualityIssues.length > 0 ? { status: "degraded" as const } : {}),
    metadata: `weekly: ${digestCopy.digestText.length} chars, telegram: ${telegramStatus}${digestCopy.usedRawTextFallback ? ", degraded: raw-text-fallback" : ""}${qualityMetadata}`,
  };
}
