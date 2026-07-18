import { formatCurrency, formatIsoDate } from "@shared/lib/format";
import { getDepegEditorialImpactScore, getDepegMarketImpactScore, isCriticalDepegRisk } from "@shared/lib/digest-risk";
import type { DigestInputData } from "@shared/types/digest";
import { logMalformedJsonPath } from "../../lib/json-decode-observability";
import { rollupDigestInputs, type RollupSummary } from "../daily-digest/collectors-shared";
import { DEWS_BAND_RANK } from "../daily-digest/digest-intelligence-utils";
import type {
  DailyDigestSourceRow,
  SpikeDepeg,
  WeeklyDepegSignal,
  WeeklyInputData,
  WeeklyParsedRow,
  WeeklyRiskKind,
  WeeklyRiskLeaderboardSignal,
  WeeklySpikeMetrics,
} from "./types";

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
      ...(depeg.carriedOver ? { carriedOver: true } : {}),
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
      severityScore: (downgradeSteps * transition.mcapUsd) / 1_000_000,
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
      impactScore: (Math.abs(shift.scoreDelta) * shift.mcapUsd) / 1_000_000_000,
      severityScore: (Math.abs(shift.scoreDelta) * shift.mcapUsd) / 1_000_000_000,
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
      // Only criticals that are NEW this week outrank everything; a chronic
      // critical carried over from prior weeks competes on decayed severity
      // (the "Four Names Share The Critical Shelf" fix).
      const freshCritical = (row: WeeklyRiskLeaderboardSignal): boolean =>
        Boolean(row.critical) && !row.carriedOver;
      const criticalDelta = Number(freshCritical(b)) - Number(freshCritical(a));
      return suppressionDelta || criticalDelta || b.severityScore - a.severityScore || b.impactScore - a.impactScore;
    })
    .slice(0, 7);
}

function parseDailyRows(dailyRows: DailyDigestSourceRow[]): WeeklyParsedRow[] {
  const parsed: WeeklyParsedRow[] = [];
  for (const row of dailyRows) {
    try {
      const inputData = JSON.parse(row.input_data) as DigestInputData;
      const date = formatIsoDate(row.generated_at);
      parsed.push({ date, title: row.digest_title ?? "Untitled", text: row.digest_text, inputData });
    } catch (error) {
      logMalformedJsonPath(
        {
          scope: "cron",
          owner: "weekly-recap",
          context: "daily_digest.input_data",
          reason: "json-parse-failed",
          source: "daily_digest",
          updatedAt: row.generated_at,
        },
        error,
      );
    }
  }
  return parsed;
}

interface WeeklyTopSignals extends Omit<WeeklyInputData["weeklySignals"], "riskLeaderboard"> {
  allDepegSignals: WeeklyDepegSignal[];
}

function collectWeeklyTopSignals(parsed: WeeklyParsedRow[]): WeeklyTopSignals {
  const weekWindowStartSec = parsed[0]?.date
    ? Math.floor(Date.parse(`${parsed[0].date}T00:00:00Z`) / 1000)
    : 0;
  const allDepegSignals = parsed.flatMap((d) => [
    ...(d.inputData.topDepegs ?? []).map((depeg) => {
      // Post-truth-layer dailies carry the live deviation; archived rows fall
      // back to the stored peak.
      const severityBps = depeg.currentBps ?? depeg.bps;
      const impactScore = depeg.impactScore ?? getDepegMarketImpactScore(severityBps, depeg.mcapUsd);
      // An event that predates the week window is a standing condition the
      // reader has already seen in prior recaps, not fresh weekly news.
      const carriedOver = depeg.startedAt != null && depeg.startedAt < weekWindowStartSec;
      const severityScore = getDepegEditorialImpactScore(severityBps, depeg.mcapUsd) * (carriedOver ? 0.5 : 1);
      return {
        id: weeklySignalId("depeg", [depeg.stablecoinId ?? depeg.symbol, String(depeg.startedAt ?? d.date), "active"]),
        symbol: depeg.symbol,
        label: `${Math.abs(severityBps)} bps active ${severityBps >= 0 ? "above" : "below"} peg${carriedOver ? " (carried over from before this week)" : ""}`,
        impactScore,
        severityScore,
        mcapUsd: depeg.mcapUsd,
        bps: Math.abs(severityBps),
        date: d.date,
        kind: "active" as const,
        critical: isCriticalDepegRisk({ bps: severityBps, mcapUsd: depeg.mcapUsd }),
        carriedOver,
        suppressReason: depeg.suppressReason,
      };
    }),
    ...(d.inputData.resolvedDepegs ?? []).map((depeg) => {
      const impactScore = depeg.impactScore ?? getDepegMarketImpactScore(depeg.peakBps, depeg.mcapUsd);
      return {
        id: weeklySignalId("depeg", [
          depeg.stablecoinId ?? depeg.symbol,
          String(depeg.startedAt ?? d.date),
          "resolved",
        ]),
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
    .sort(
      (a, b) =>
        Number(b.critical) - Number(a.critical) || b.severityScore - a.severityScore || b.impactScore - a.impactScore,
    )
    .slice(0, 7);
  const topSupplySignals = topSignals(
    parsed,
    (d) => {
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
    },
    (row) => Math.abs(row.amountUsd),
  );
  // DEWS uses an mcap-major / score-minor sort. Encode as a single numeric
  // key (mcap is non-negative USD, score is a bounded small integer) so we
  // can flow through the generic `sortKey: number` helper while preserving
  // the original `b.mcapUsd - a.mcapUsd || b.score - a.score` ordering.
  const topDewsChanges = topSignals(
    parsed,
    (d) =>
      (d.inputData.dewsStress?.bandChanges ?? []).map((change) => ({
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
    (d) =>
      (d.inputData.mintBurnFlows?.topPressure ?? []).map((pressure) => ({
        symbol: pressure.symbol,
        intensity: pressure.intensity,
        net24hUsd: pressure.net24hUsd,
        date: d.date,
      })),
    (row) => Math.abs(row.intensity),
  );
  const topBlacklistEvents = topSignals(
    parsed,
    (d) =>
      (d.inputData.blacklistActivity?.topEvents ?? []).map((event) => ({
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
    (d) =>
      (d.inputData.gradeTransitions ?? [])
        .map((transition) => ({
          symbol: transition.symbol,
          fromGrade: transition.fromGrade,
          toGrade: transition.toGrade,
          mcapUsd: transition.mcapUsd,
          date: d.date,
        }))
        .filter(
          (transition) =>
            typeof transition.symbol === "string" &&
            typeof transition.fromGrade === "string" &&
            typeof transition.toGrade === "string" &&
            typeof transition.mcapUsd === "number" &&
            Number.isFinite(transition.mcapUsd),
        ),
    (row) => row.mcapUsd,
  );
  const topYieldAnomalies = topSignals(
    parsed,
    (d) =>
      (d.inputData.yieldAnomalies ?? []).map((anomaly) => ({
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
    (d) =>
      (d.inputData.liquidityShifts ?? []).map((shift) => ({
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

function buildWeeklySpikeMetrics(parsed: WeeklyParsedRow[], allDepegSignals: WeeklyDepegSignal[]): WeeklySpikeMetrics {
  const psiObservations = parsed
    .map((d) =>
      d.inputData.stabilityIndex
        ? { date: d.date, score: d.inputData.stabilityIndex.score, band: d.inputData.stabilityIndex.band }
        : null,
    )
    .filter((entry): entry is { date: string; score: number; band: string } => entry !== null);
  const gaugeObservations = parsed
    .map((d) =>
      d.inputData.mintBurnFlows?.gaugeScore != null
        ? { date: d.date, score: d.inputData.mintBurnFlows.gaugeScore }
        : null,
    )
    .filter((entry): entry is { date: string; score: number } => entry !== null);
  const { maxDepegByBps, maxDepegByImpact } = allDepegSignals.reduce<{
    maxDepegByBps: WeeklyDepegSignal | undefined;
    maxDepegByImpact: WeeklyDepegSignal | undefined;
  }>(
    (acc, s) => ({
      maxDepegByBps:
        acc.maxDepegByBps == null ||
        s.bps > acc.maxDepegByBps.bps ||
        (s.bps === acc.maxDepegByBps.bps && s.impactScore > acc.maxDepegByBps.impactScore)
          ? s
          : acc.maxDepegByBps,
      maxDepegByImpact:
        acc.maxDepegByImpact == null ||
        s.impactScore > acc.maxDepegByImpact.impactScore ||
        (s.impactScore === acc.maxDepegByImpact.impactScore && s.bps > acc.maxDepegByImpact.bps)
          ? s
          : acc.maxDepegByImpact,
    }),
    { maxDepegByBps: undefined, maxDepegByImpact: undefined },
  );
  const minByScore = <T extends { score: number }>(observations: T[]): T | null =>
    observations.reduce<T | null>(
      (best, observation) => (best == null || observation.score < best.score ? observation : best),
      null,
    );
  return {
    minPsi: minByScore(psiObservations),
    minGauge: minByScore(gaugeObservations),
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

export function buildWeeklyInputData(
  currentDailyRows: DailyDigestSourceRow[],
  priorDailyRows: DailyDigestSourceRow[] = [],
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
      pctChange: mcaps[0] === 0 ? null : ((mcaps[mcaps.length - 1] - mcaps[0]) / mcaps[0]) * 100,
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
