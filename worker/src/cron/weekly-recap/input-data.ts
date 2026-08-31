import { formatCurrency, formatIsoDate } from "@shared/lib/format";
import { getDepegEditorialImpactScore, getDepegMarketImpactScore, isCriticalDepegRisk } from "@shared/lib/digest-risk";
import { findDigestSignalQuarantineBySymbol } from "@shared/lib/digest-signal-quarantine";
import { safetyScorePublicationIdentitiesAreComparable } from "@shared/lib/safety-score-publication";
import {
  DigestSafetyContextSchema,
  type DigestEditorialCandidate,
  type DigestInputData,
  type DigestSafetyContext,
} from "@shared/types/digest";
import {
  SafetyScorePublicationIdentitySchema,
  type SafetyScorePublicationIdentity,
} from "@shared/types/safety-score-publication";
import { logMalformedJsonPath } from "../../lib/json-decode-observability";
import { rollupDigestInputs, type RollupSummary } from "../daily-digest/collectors-shared";
import {
  activeDepegEditorialCandidateId,
  buildEditorialCandidates,
  resolvedDepegEditorialCandidateId,
} from "../daily-digest/editorial-candidates";
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
  uniqueKey?: (out: TOut) => string,
): TOut[] {
  const sorted = parsed
    .flatMap(project)
    .sort((a, b) => sortKey(b) - sortKey(a));
  if (!uniqueKey) return sorted.slice(0, limit);
  const seen = new Set<string>();
  return sorted
    .filter((row) => {
      const key = uniqueKey(row);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
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

function canonicalDailyCandidates(parsed: WeeklyParsedRow[], index: number): DigestEditorialCandidate[] {
  const row = parsed[index];
  if (!row) return [];
  const inputData: DigestInputData = {
    ...row.inputData,
    mcap7dDelta: row.inputData.mcap7dDelta ?? 0,
    activeDepegCount: row.inputData.activeDepegCount ?? 0,
    topDepegs: row.inputData.topDepegs ?? [],
    biggestSupplyChange: row.inputData.biggestSupplyChange ?? null,
    mintBurnFlows:
      row.inputData.mintBurnFlows?.flightToQuality && Array.isArray(row.inputData.mintBurnFlows.topPressure)
        ? row.inputData.mintBurnFlows
        : undefined,
    blacklistActivity:
      typeof row.inputData.blacklistActivity?.totalAmountUsd === "number" &&
      Array.isArray(row.inputData.blacklistActivity.topEvents)
        ? row.inputData.blacklistActivity
        : undefined,
    stabilityIndex:
      row.inputData.stabilityIndex?.components ? row.inputData.stabilityIndex : null,
  };
  return row.inputData.editorialCandidates ?? buildEditorialCandidates(
    inputData,
    index > 0 ? parsed[index - 1]?.inputData ?? null : null,
  );
}

function findDailyDepegCandidate(
  candidates: readonly DigestEditorialCandidate[],
  kind: "depeg" | "resolved-depeg",
  expectedId: string,
  symbol: string,
): DigestEditorialCandidate | undefined {
  const exact = candidates.find((candidate) => candidate.kind === kind && candidate.id === expectedId);
  if (exact) return exact;

  // Compatibility for daily rows persisted before event-stable candidate ids.
  const sameSymbol = candidates.filter((candidate) =>
    candidate.kind === kind && candidate.symbols.includes(symbol.toUpperCase()),
  );
  return sameSymbol.length === 1 ? sameSymbol[0] : undefined;
}

function weeklyRiskKind(candidate: DigestEditorialCandidate): WeeklyRiskKind | null {
  if (candidate.kind === "resolved-depeg") return "depeg";
  if (
    candidate.kind === "depeg" ||
    candidate.kind === "dews" ||
    candidate.kind === "mint-burn" ||
    candidate.kind === "blacklist" ||
    candidate.kind === "grade" ||
    candidate.kind === "yield" ||
    candidate.kind === "liquidity" ||
    candidate.kind === "supply"
  ) {
    return candidate.kind;
  }
  return null;
}

function collectCanonicalWeeklyRiskCandidates(parsed: WeeklyParsedRow[]): WeeklyRiskLeaderboardSignal[] {
  const representativeByIdentity = new Map<string, WeeklyRiskLeaderboardSignal>();

  parsed.forEach((row, index) => {
    for (const candidate of canonicalDailyCandidates(parsed, index)) {
      const kind = weeklyRiskKind(candidate);
      if (kind == null || kind === "depeg") continue;
      if (kind === "grade" && (row.inputData.gradeTransitions?.length ?? 0) === 0) continue;
      // Blacklist candidates summarize a bounded daily window, while the other
      // daily candidate ids describe a stable signal identity across the week.
      const identity = candidate.kind === "blacklist" ? `${candidate.id}:${row.date}` : candidate.id;
      const weekly: WeeklyRiskLeaderboardSignal = {
        id: `weekly:${identity}`,
        kind,
        label: `${row.date} ${candidate.title}: ${candidate.headlineFacts.join("; ")}`,
        symbols: candidate.symbols,
        date: row.date,
        impactScore: candidate.impactScore,
        severityScore: candidate.impactScore,
        ...(candidate.suppressReason ? { suppressReason: candidate.suppressReason } : {}),
      };
      const existing = representativeByIdentity.get(identity);
      if (!existing || weekly.severityScore > existing.severityScore) {
        representativeByIdentity.set(identity, weekly);
      }
    }
  });

  return [...representativeByIdentity.values()];
}

function buildWeeklyRiskLeaderboard(params: {
  parsed: WeeklyParsedRow[];
  depegs: WeeklyDepegSignal[];
}): WeeklyRiskLeaderboardSignal[] {
  const rows = collectCanonicalWeeklyRiskCandidates(params.parsed);

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

function removeCandidateIds(ids: string[] | undefined, quarantinedIds: ReadonlySet<string>): string[] | undefined {
  return ids?.filter((id) => !quarantinedIds.has(id));
}

function quarantineRetractedLiquidity(
  inputData: DigestInputData,
  timestamp: number,
): { inputData: DigestInputData; quarantinedStablecoinIds: string[] } {
  const quarantinedBySymbol = new Map<string, string>();
  for (const shift of inputData.liquidityShifts ?? []) {
    const quarantine = findDigestSignalQuarantineBySymbol(shift.symbol, "liquidity", timestamp);
    if (quarantine) quarantinedBySymbol.set(shift.symbol.toUpperCase(), quarantine.stablecoinId);
  }
  if (quarantinedBySymbol.size === 0) return { inputData, quarantinedStablecoinIds: [] };

  const quarantinedSymbols = new Set(quarantinedBySymbol.keys());
  const candidateIsQuarantined = (candidate: DigestEditorialCandidate): boolean =>
    candidate.kind === "liquidity" &&
    candidate.symbols.some((symbol) => quarantinedSymbols.has(symbol.toUpperCase()));
  const quarantinedCandidateIds = new Set(
    (inputData.editorialCandidates ?? []).filter(candidateIsQuarantined).map((candidate) => candidate.id),
  );
  for (const symbol of quarantinedSymbols) quarantinedCandidateIds.add(`liquidity:${symbol.toLowerCase()}`);

  const changeSummary = inputData.changeSummary
    ? {
        ...inputData.changeSummary,
        newSignals: inputData.changeSummary.newSignals.filter((signal) =>
          signal.kind !== "liquidity" || !signal.symbols.some((symbol) => quarantinedSymbols.has(symbol.toUpperCase())),
        ),
        worsenedSignals: inputData.changeSummary.worsenedSignals.filter((signal) =>
          signal.kind !== "liquidity" || !signal.symbols.some((symbol) => quarantinedSymbols.has(symbol.toUpperCase())),
        ),
        improvedSignals: inputData.changeSummary.improvedSignals.filter((signal) =>
          signal.kind !== "liquidity" || !signal.symbols.some((symbol) => quarantinedSymbols.has(symbol.toUpperCase())),
        ),
        resolvedSignals: inputData.changeSummary.resolvedSignals.filter((signal) =>
          signal.kind !== "liquidity" || !signal.symbols.some((symbol) => quarantinedSymbols.has(symbol.toUpperCase())),
        ),
        repeatedSignals: inputData.changeSummary.repeatedSignals.filter((signal) =>
          signal.kind !== "liquidity" || !signal.symbols.some((symbol) => quarantinedSymbols.has(symbol.toUpperCase())),
        ),
      }
    : undefined;
  const editorialAudit = inputData.editorialAudit
    ? {
        ...inputData.editorialAudit,
        topCandidateIds: removeCandidateIds(inputData.editorialAudit.topCandidateIds, quarantinedCandidateIds) ?? [],
        usableCandidateIds: removeCandidateIds(inputData.editorialAudit.usableCandidateIds, quarantinedCandidateIds) ?? [],
        suppressedCandidateIds: removeCandidateIds(inputData.editorialAudit.suppressedCandidateIds, quarantinedCandidateIds) ?? [],
        momentumCandidateIds: removeCandidateIds(inputData.editorialAudit.momentumCandidateIds, quarantinedCandidateIds) ?? [],
        requiredLeadCandidateIds: removeCandidateIds(inputData.editorialAudit.requiredLeadCandidateIds, quarantinedCandidateIds),
        usedCandidateIds: removeCandidateIds(inputData.editorialAudit.usedCandidateIds, quarantinedCandidateIds),
        modelSuppressedCandidateIds: removeCandidateIds(inputData.editorialAudit.modelSuppressedCandidateIds, quarantinedCandidateIds),
        ...(inputData.editorialAudit.leadCandidateId && quarantinedCandidateIds.has(inputData.editorialAudit.leadCandidateId)
          ? { leadCandidateId: null, leadCandidateTitle: null }
          : {}),
      }
    : undefined;

  return {
    inputData: {
      ...inputData,
      liquidityShifts: (inputData.liquidityShifts ?? []).filter(
        (shift) => !quarantinedSymbols.has(shift.symbol.toUpperCase()),
      ),
      editorialCandidates: inputData.editorialCandidates?.filter((candidate) => !candidateIsQuarantined(candidate)),
      ...(changeSummary ? { changeSummary } : {}),
      nextTriggers: inputData.nextTriggers?.filter((trigger) =>
        trigger.metric !== "liquidity-score" ||
        trigger.symbol == null ||
        !quarantinedSymbols.has(trigger.symbol.toUpperCase()),
      ),
      ...(editorialAudit ? { editorialAudit } : {}),
    },
    quarantinedStablecoinIds: [...new Set(quarantinedBySymbol.values())],
  };
}

function parseDailyRows(
  dailyRows: DailyDigestSourceRow[],
): { parsed: WeeklyParsedRow[]; degradedSources: string[] } {
  const parsed: WeeklyParsedRow[] = [];
  const degradedSources = new Set<string>();
  for (const row of dailyRows) {
    try {
      const rawInputData = JSON.parse(row.input_data) as DigestInputData;
      const timestamp = rawInputData.dataQuality?.generatedAt ?? row.generated_at;
      const quarantined = quarantineRetractedLiquidity(rawInputData, timestamp);
      const date = formatIsoDate(row.generated_at);
      for (const stablecoinId of quarantined.quarantinedStablecoinIds) {
        degradedSources.add(`liquidity-shift-quarantined-signal:${stablecoinId}:${date}`);
      }
      parsed.push({
        date,
        title: quarantined.quarantinedStablecoinIds.length > 0 ? "" : row.digest_title ?? "Untitled",
        text: quarantined.quarantinedStablecoinIds.length > 0 ? "" : row.digest_text,
        inputData: quarantined.inputData,
      });
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
  return { parsed, degradedSources: [...degradedSources] };
}

function parsePersistedSafetyIdentity(value: unknown): SafetyScorePublicationIdentity | null {
  if (!value || typeof value !== "object") return null;
  const { publishedAt: _publishedAt, ...candidate } = value as Record<string, unknown>;
  return SafetyScorePublicationIdentitySchema.safeParse(candidate).data ?? null;
}

function parseAuthoredSafetyIdentity(inputData: DigestInputData): SafetyScorePublicationIdentity | null {
  const explicitContext = DigestSafetyContextSchema.safeParse(inputData.safetyContext).data;
  if (explicitContext) {
    return explicitContext.status === "available" ? explicitContext.identity : null;
  }
  return parsePersistedSafetyIdentity(inputData.safetyScores?.provenance);
}

function sanitizeSafetyForWeekly(
  parsed: WeeklyParsedRow[],
  safetyContext: DigestSafetyContext | undefined,
): WeeklyParsedRow[] {
  if (!safetyContext) return parsed;
  const activeIdentity = safetyContext.status === "available" ? safetyContext.identity : null;
  const seenTransitionIds = new Set<string>();
  return parsed.map((row) => {
    const inputData = { ...row.inputData };
    const authoredIdentity = parseAuthoredSafetyIdentity(inputData);
    const copyIsComparable =
      activeIdentity != null &&
      authoredIdentity != null &&
      safetyScorePublicationIdentitiesAreComparable(authoredIdentity, activeIdentity);
    const safetyIdentity = parsePersistedSafetyIdentity(inputData.safetyScores?.provenance);
    if (
      !activeIdentity ||
      !safetyIdentity ||
      !safetyScorePublicationIdentitiesAreComparable(safetyIdentity, activeIdentity)
    ) {
      delete inputData.safetyScores;
    }
    inputData.gradeTransitions = (inputData.gradeTransitions ?? []).filter((transition) => {
      const transitionIdentity = SafetyScorePublicationIdentitySchema.safeParse(
        transition.safetyScoreIdentity,
      ).data;
      if (
        !activeIdentity ||
        !transitionIdentity ||
        !safetyScorePublicationIdentitiesAreComparable(transitionIdentity, activeIdentity) ||
        seenTransitionIds.has(transition.historyId)
      ) {
        return false;
      }
      seenTransitionIds.add(transition.historyId);
      return true;
    });
    if (inputData.gradeTransitions.length === 0) delete inputData.gradeTransitions;
    return {
      ...row,
      title: copyIsComparable ? row.title : "",
      text: copyIsComparable ? row.text : "",
      inputData,
    };
  });
}

interface WeeklyTopSignals extends Omit<WeeklyInputData["weeklySignals"], "riskLeaderboard"> {
  allDepegSignals: WeeklyDepegSignal[];
}

function collectWeeklyTopSignals(parsed: WeeklyParsedRow[]): WeeklyTopSignals {
  const weekWindowStartSec = parsed[0]?.date
    ? Math.floor(Date.parse(`${parsed[0].date}T00:00:00Z`) / 1000)
    : 0;
  const allDepegObservations = parsed.flatMap((d, index) => {
    const dailyCandidates = canonicalDailyCandidates(parsed, index);
    return [
      ...(d.inputData.topDepegs ?? []).map((depeg) => {
        // Post-truth-layer dailies carry the live deviation; archived rows fall
        // back to the stored peak.
        const severityBps = depeg.currentBps ?? depeg.bps;
        const canonicalCandidate = findDailyDepegCandidate(
          dailyCandidates,
          "depeg",
          activeDepegEditorialCandidateId(depeg),
          depeg.symbol,
        );
        const impactScore = canonicalCandidate?.impactScore
          ?? getDepegEditorialImpactScore(severityBps, depeg.mcapUsd);
        // An event that predates the week window is a standing condition the
        // reader has already seen in prior recaps, not fresh weekly news.
        const carriedOver = depeg.startedAt != null && depeg.startedAt < weekWindowStartSec;
        const severityScore = impactScore * (carriedOver ? 0.5 : 1);
        const eventIdentity = `${depeg.stablecoinId ?? depeg.symbol.toUpperCase()}:${depeg.startedAt ?? "active"}`;
        return {
          id: weeklySignalId("depeg", [eventIdentity]),
          eventIdentity,
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
        const canonicalCandidate = findDailyDepegCandidate(
          dailyCandidates,
          "resolved-depeg",
          resolvedDepegEditorialCandidateId(depeg),
          depeg.symbol,
        );
        const impactScore = canonicalCandidate?.impactScore
          ?? depeg.impactScore
          ?? getDepegMarketImpactScore(depeg.peakBps, depeg.mcapUsd);
        const eventIdentity = `${depeg.stablecoinId ?? depeg.symbol.toUpperCase()}:${depeg.startedAt ?? `resolved:${depeg.endedAt ?? d.date}`}`;
        return {
          id: weeklySignalId("depeg", [eventIdentity]),
          eventIdentity,
          symbol: depeg.symbol,
          label: `${depeg.peakBps} bps resolved after ${depeg.durationHours}h`,
          impactScore,
          severityScore: impactScore,
          mcapUsd: depeg.mcapUsd,
          bps: depeg.peakBps,
          date: d.date,
          kind: "resolved" as const,
          critical: isCriticalDepegRisk({ bps: depeg.peakBps, mcapUsd: depeg.mcapUsd }),
        };
      }),
    ];
  });
  const allDepegSignals = [...allDepegObservations]
    .sort(
      (a, b) =>
        Number(b.critical) - Number(a.critical) || b.severityScore - a.severityScore || b.impactScore - a.impactScore,
    )
    .filter((signal, index, sorted) =>
      sorted.findIndex((candidate) => candidate.eventIdentity === signal.eventIdentity) === index,
    );
  const topDepegSignals = allDepegSignals.slice(0, 7);
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
          historyId: transition.historyId,
          recordedAt: transition.recordedAt,
          model: transition.model,
          safetyScoreIdentity: transition.safetyScoreIdentity,
          symbol: transition.symbol,
          fromGrade: transition.fromGrade,
          toGrade: transition.toGrade,
          mcapUsd: transition.mcapUsd,
          date: formatIsoDate(transition.recordedAt),
        }))
        .filter(
          (transition) =>
            typeof transition.historyId === "string" &&
            typeof transition.recordedAt === "number" &&
            (transition.model === "v8" || transition.model === "v9") &&
            SafetyScorePublicationIdentitySchema.safeParse(transition.safetyScoreIdentity).success &&
            typeof transition.symbol === "string" &&
            typeof transition.fromGrade === "string" &&
            typeof transition.toGrade === "string" &&
            typeof transition.mcapUsd === "number" &&
            Number.isFinite(transition.mcapUsd),
        ),
    (row) => row.mcapUsd,
    7,
    (row) => row.historyId,
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
  safetyContext?: DigestSafetyContext,
): WeeklyInputData | null {
  const currentParsed = parseDailyRows(currentDailyRows);
  const prior = parseDailyRows(priorDailyRows);
  const parsed = sanitizeSafetyForWeekly(currentParsed.parsed, safetyContext);
  const priorParsed = sanitizeSafetyForWeekly(prior.parsed, safetyContext);
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
    parsed,
    depegs: topDepegSignals,
  });

  const weekOverWeekDeltas = buildWeeklyWowDeltas(current, priorParsed);
  // Forward-look accountability: publishing the hit rate creates pressure
  // toward falsifiable near-term triggers (the corpus ran at ~4% hits).
  const outcomeCounts = { hit: 0, missed: 0, pending: 0, expired: 0 };
  for (const day of parsed) {
    for (const outcome of day.inputData.forwardLookOutcomes ?? []) {
      if (outcome.status in outcomeCounts) outcomeCounts[outcome.status as keyof typeof outcomeCounts] += 1;
    }
  }
  const forwardLookScoreboard =
    outcomeCounts.hit + outcomeCounts.missed + outcomeCounts.pending + outcomeCounts.expired > 0
      ? outcomeCounts
      : null;
  const degradedSources = [
    ...currentParsed.degradedSources,
    ...prior.degradedSources,
    ...(safetyContext?.status === "unavailable"
      ? [`safety-canonical-snapshot:${safetyContext.reason}`]
      : []),
  ];

  return {
    weekStartDate: parsed[0].date,
    weekEndDate: parsed[parsed.length - 1].date,
    periodType: "trailing-daily-editions",
    ...(safetyContext ? { safetyContext } : {}),
    ...(degradedSources.length > 0 ? { degradedSources: [...new Set(degradedSources)] } : {}),
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
    forwardLookScoreboard,
    weekOverWeekDeltas,
  };
}
