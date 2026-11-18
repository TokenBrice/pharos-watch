import { DigestSupplyQuantityEvidenceSchema } from "@shared/types/digest";
import { getLatestSupplyPerimeterChange } from "@shared/lib/supply-perimeter-changes";
import { formatCurrency, formatIsoDate } from "@shared/lib/format";
import { DAY_SECONDS, HOUR_SECONDS } from "@shared/lib/time-constants";
import { getDepegEditorialImpactScore, getDepegMarketImpactScore, isCriticalDepegRisk } from "@shared/lib/digest-risk";
import { selectInvestmentWarningSignals } from "@shared/lib/yield-warning-signals";
import {
  findDigestSignalQuarantineBySymbol,
  findDigestSignalQuarantines,
  type DigestSignalClocks,
} from "@shared/lib/digest-signal-quarantine";
import { safetyScorePublicationIdentitiesAreComparable } from "@shared/lib/safety-score-publication";
import {
  DigestSafetyContextSchema,
  DigestGradeTransitionAccountingSchema,
  type DigestEventPeriod,
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
import { currentDepegBps } from "../daily-digest/digest-evidence";
import {
  activeDepegEditorialCandidateId,
  buildBlacklistActivityCandidate,
  buildEditorialCandidates,
  resolvedDepegEditorialCandidateId,
} from "../daily-digest/editorial-candidates";
import {
  summarizeWeeklyBlacklistActivity,
  WEEKLY_BLACKLIST_QUERY_UNAVAILABLE,
  WEEKLY_BLACKLIST_UNPRICED,
  type WeeklyBlacklistActivity,
} from "./blacklist";
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
  if (signal?.observedAt == null) return null;
  return {
    id: signal.id,
    date: formatIsoDate(signal.observedAt),
    observedAt: signal.observedAt,
    severityBasis: signal.severityBasis,
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
    mcap7dDelta: row.inputData.mcap7dDeltaCoverage?.coveredCoins === 0 ? null : row.inputData.mcap7dDelta ?? null,
    activeDepegCount: row.inputData.activeDepegCount ?? null,
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
      if (kind == null || kind === "depeg" || kind === "blacklist") continue;
      if (kind === "grade" && (row.inputData.gradeTransitions?.length ?? 0) === 0) continue;
      const identity = candidate.id;
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
  blacklist: WeeklyBlacklistActivity | null;
}): WeeklyRiskLeaderboardSignal[] {
  const rows = collectCanonicalWeeklyRiskCandidates(params.parsed);
  const blacklist = buildBlacklistActivityCandidate(params.blacklist ?? undefined);
  if (blacklist) {
    rows.push({
      id: "weekly:blacklist:event-period",
      kind: "blacklist",
      label: `Recorded blacklist activity${params.blacklist?.coverage.reason != null ? " (period coverage unconfirmed)" : ""}: ${blacklist.headlineFacts.join("; ")}`,
      symbols: [...new Set(blacklist.symbols)].slice(0, 4),
      impactScore: blacklist.impactScore,
      severityScore: blacklist.impactScore,
      ...(blacklist.suppressReason ? { suppressReason: blacklist.suppressReason } : {}),
    });
  }

  for (const depeg of params.depegs) {
    rows.push({
      id: depeg.id,
      kind: "depeg",
      label: `${depeg.symbol}: ${depeg.label}, ${formatCurrency(depeg.mcapUsd)} mcap`,
      symbols: [depeg.symbol],
      date: depeg.date,
      impactScore: depeg.impactScore,
      severityScore: depeg.severityScore,
      critical: depeg.critical,
      ...(depeg.eventAt != null ? { eventAt: depeg.eventAt } : {}),
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
        Boolean(row.critical) && !row.carriedOver && (row.kind !== "depeg" || row.eventAt != null);
      const criticalDelta = Number(freshCritical(b)) - Number(freshCritical(a));
      return suppressionDelta || criticalDelta || b.severityScore - a.severityScore || b.impactScore - a.impactScore;
    })
    .slice(0, 7);
}

function removeCandidateIds(ids: string[] | undefined, quarantinedIds: ReadonlySet<string>): string[] | undefined {
  return ids?.filter((id) => !quarantinedIds.has(id));
}

interface QuarantineSelection {
  stablecoinIds: Set<string>;
  symbols: Set<string>;
  /** Signal kinds the retracted claim can surface through. */
  candidateKind: DigestEditorialCandidate["kind"];
  signalKind: "liquidity" | "mint-burn";
}

function removeQuarantinedSignals(
  inputData: DigestInputData,
  selections: readonly QuarantineSelection[],
): DigestInputData {
  const hits = (kind: string, symbols: readonly string[]): boolean =>
    selections.some((selection) =>
      selection.signalKind === kind && symbols.some((symbol) => selection.symbols.has(symbol.toUpperCase())));
  const candidateIsQuarantined = (candidate: DigestEditorialCandidate): boolean =>
    selections.some((selection) =>
      candidate.kind === selection.candidateKind &&
      candidate.symbols.some((symbol) => selection.symbols.has(symbol.toUpperCase())));
  const quarantinedCandidateIds = new Set(
    (inputData.editorialCandidates ?? []).filter(candidateIsQuarantined).map((candidate) => candidate.id),
  );
  for (const selection of selections) {
    for (const symbol of selection.symbols) {
      quarantinedCandidateIds.add(selection.signalKind === "liquidity"
        ? `liquidity:${symbol.toLowerCase()}`
        : `mint-burn:${symbol.toLowerCase()}:pressure`);
    }
  }
  const keepSignal = (signal: { kind: string; symbols: string[] }): boolean => !hits(signal.kind, signal.symbols);
  const keepTrigger = (trigger: NonNullable<DigestInputData["nextTriggers"]>[number]): boolean => {
    if (trigger.candidateId && quarantinedCandidateIds.has(trigger.candidateId)) return false;
    return !(trigger.metric === "liquidity-score" && trigger.symbol != null && hits("liquidity", [trigger.symbol]));
  };

  const changeSummary = inputData.changeSummary
    ? {
        ...inputData.changeSummary,
        newSignals: inputData.changeSummary.newSignals.filter(keepSignal),
        worsenedSignals: inputData.changeSummary.worsenedSignals.filter(keepSignal),
        improvedSignals: inputData.changeSummary.improvedSignals.filter(keepSignal),
        resolvedSignals: inputData.changeSummary.resolvedSignals.filter(keepSignal),
        repeatedSignals: inputData.changeSummary.repeatedSignals.filter(keepSignal),
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
  const flowSymbols = selections.find((selection) => selection.signalKind === "mint-burn")?.symbols;

  return {
    ...inputData,
    ...(inputData.liquidityShifts
      ? { liquidityShifts: inputData.liquidityShifts.filter((shift) => !hits("liquidity", [shift.symbol])) }
      : {}),
    ...(flowSymbols && inputData.mintBurnFlows
      ? {
          mintBurnFlows: {
            ...inputData.mintBurnFlows,
            topPressure: inputData.mintBurnFlows.topPressure.filter(
              (pressure) => !flowSymbols.has(pressure.symbol.toUpperCase()),
            ),
          },
        }
      : {}),
    editorialCandidates: inputData.editorialCandidates?.filter((candidate) => !candidateIsQuarantined(candidate)),
    ...(changeSummary ? { changeSummary } : {}),
    nextTriggers: inputData.nextTriggers?.filter(keepTrigger),
    ...(editorialAudit ? { editorialAudit } : {}),
  };
}

function quarantineRetractedSignals(
  inputData: DigestInputData,
  clocks: DigestSignalClocks,
): { inputData: DigestInputData; quarantines: { family: "liquidity" | "flow"; stablecoinId: string }[] } {
  const liquidity: QuarantineSelection = {
    stablecoinIds: new Set(), symbols: new Set(), candidateKind: "liquidity", signalKind: "liquidity",
  };
  for (const shift of inputData.liquidityShifts ?? []) {
    const quarantine = findDigestSignalQuarantineBySymbol(shift.symbol, "liquidity", clocks.ingestion);
    if (quarantine) {
      liquidity.symbols.add(shift.symbol.toUpperCase());
      liquidity.stablecoinIds.add(quarantine.stablecoinId);
    }
  }
  // Matched on the edition clock before any pressure lookup, so candidate-only
  // and copy-only rows are quarantined even when no topPressure row survives.
  const flow: QuarantineSelection = {
    stablecoinIds: new Set(), symbols: new Set(), candidateKind: "mint-burn", signalKind: "mint-burn",
  };
  for (const quarantine of findDigestSignalQuarantines("flow", clocks)) {
    flow.stablecoinIds.add(quarantine.stablecoinId);
    for (const symbol of quarantine.symbols) flow.symbols.add(symbol.toUpperCase());
  }
  const selections = [liquidity, flow].filter((selection) => selection.symbols.size > 0);
  if (selections.length === 0) return { inputData, quarantines: [] };
  return {
    inputData: removeQuarantinedSignals(inputData, selections),
    quarantines: [
      ...[...liquidity.stablecoinIds].map((stablecoinId) => ({ family: "liquidity" as const, stablecoinId })),
      ...[...flow.stablecoinIds].map((stablecoinId) => ({ family: "flow" as const, stablecoinId })),
    ],
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
      const quarantined = quarantineRetractedSignals(rawInputData, {
        ingestion: rawInputData.dataQuality?.generatedAt ?? row.generated_at,
        edition: row.generated_at,
      });
      const date = formatIsoDate(row.generated_at);
      for (const { family, stablecoinId } of quarantined.quarantines) {
        degradedSources.add(family === "liquidity"
          ? `liquidity-shift-quarantined-signal:${stablecoinId}:${date}`
          : `mint-burn-pressure-quarantined-signal:${stablecoinId}:${date}`);
      }
      parsed.push({
        date,
        generatedAt: row.generated_at,
        title: quarantined.quarantines.length > 0 ? "" : row.digest_title ?? "Untitled",
        text: quarantined.quarantines.length > 0 ? "" : row.digest_text,
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
  period: DigestEventPeriod | undefined,
): WeeklyParsedRow[] {
  const activeIdentity = safetyContext?.status === "available" ? safetyContext.identity : null;
  return parsed.map((row) => {
    const inputData = { ...row.inputData };
    if (safetyContext?.status === "unavailable") {
      // Both weekly rollups must see failed canonical evidence before counting
      // the transitions removed below; unavailable is not an observed zero.
      inputData.degradedSources = [
        ...new Set([
          ...(inputData.degradedSources ?? []),
          `safety-canonical-snapshot:${safetyContext.reason}`,
        ]),
      ];
    }
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
    const accounting = DigestGradeTransitionAccountingSchema.safeParse(inputData.gradeTransitionAccounting).data;
    if (!accounting?.complete || !activeIdentity ||
        !safetyScorePublicationIdentitiesAreComparable(accounting.safetyScoreIdentity, activeIdentity)) {
      delete inputData.gradeTransitionAccounting;
    } else {
      inputData.gradeTransitionAccounting = accounting;
    }
    inputData.gradeTransitions = (inputData.gradeTransitions ?? []).filter((transition) => {
      const transitionIdentity = SafetyScorePublicationIdentitySchema.safeParse(
        transition.safetyScoreIdentity,
      ).data;
      if (
        !activeIdentity ||
        !transitionIdentity ||
        !safetyScorePublicationIdentitiesAreComparable(transitionIdentity, activeIdentity) ||
        !period || !Number.isFinite(transition.recordedAt) ||
        transition.recordedAt < period.start || transition.recordedAt >= period.end
      ) {
        return false;
      }
      return true;
    });
    if (inputData.gradeTransitions.length === 0) delete inputData.gradeTransitions;
    // The Safety Map census is Safety-derived stock evidence: it may only enter
    // the weekly prompt when its authored identity is comparable with the
    // active publication, never attributed to the active Safety source.
    if (!copyIsComparable) delete inputData.safetyMap;
    return {
      ...row,
      title: copyIsComparable ? row.title : "",
      text: copyIsComparable ? row.text : "",
      inputData,
    };
  });
}

interface WeeklyTopSignals extends Omit<WeeklyInputData["weeklySignals"], "riskLeaderboard" | "topBlacklistEvents"> {
  allDepegObservations: WeeklyDepegSignal[];
  rankedDepegSignals: WeeklyDepegSignal[];
}

/**
 * An active depeg is a standing condition only when its start predates the
 * declared event period. Legacy rows without `startedAt` fall back to the
 * age persisted with that edition; with neither, freshness is unknown and the
 * event is not demoted to carried-over.
 */
function depegStartedBeforeWindow(
  depeg: DigestInputData["topDepegs"][number],
  row: WeeklyParsedRow,
  weekWindowStartSec: number,
): boolean {
  let estimatedStartSec: number | null = null;
  const capturedAt = row.inputData.dataQuality?.generatedAt ?? row.generatedAt;
  if (depeg.startedAt != null) {
    estimatedStartSec = depeg.startedAt;
  } else if (depeg.ageHours != null) {
    estimatedStartSec = capturedAt - depeg.ageHours * HOUR_SECONDS;
  } else {
    const standing = row.inputData.standingConditions?.find((entry) =>
      depeg.stablecoinId != null ? entry.stablecoinId === depeg.stablecoinId : entry.symbol === depeg.symbol);
    if (standing != null) estimatedStartSec = capturedAt - standing.ageDays * DAY_SECONDS;
  }
  return estimatedStartSec != null && estimatedStartSec < weekWindowStartSec;
}

function collectWeeklyTopSignals(
  parsed: WeeklyParsedRow[],
  eventPeriod: DigestEventPeriod,
): WeeklyTopSignals {
  const allDepegObservations: WeeklyDepegSignal[] = parsed.flatMap((d, index) => {
    const dailyCandidates = canonicalDailyCandidates(parsed, index);
    const capturedAt = d.inputData.dataQuality?.generatedAt ?? d.generatedAt;
    return [
      ...(d.inputData.topDepegs ?? []).flatMap((depeg) => {
        const startedAt = depeg.startedAt;
        if (startedAt != null && (startedAt >= eventPeriod.end || startedAt > capturedAt)) return [];
        const eventAt = startedAt != null && Number.isSafeInteger(startedAt) && startedAt >= eventPeriod.start
          ? startedAt : undefined;
        const quoteAt = depeg.priceObservedAt;
        const observedAt = quoteAt != null && Number.isSafeInteger(quoteAt) &&
          quoteAt > 0 && quoteAt <= d.generatedAt && quoteAt >= eventPeriod.start && quoteAt < eventPeriod.end &&
          (startedAt == null || quoteAt >= startedAt) &&
          currentDepegBps(depeg, capturedAt) != null ? quoteAt : undefined;
        const severityBps = observedAt != null ? depeg.currentBps! : depeg.bps;
        if (!Number.isFinite(severityBps)) return [];
        const canonicalCandidate = findDailyDepegCandidate(
          dailyCandidates,
          "depeg",
          activeDepegEditorialCandidateId(depeg),
          depeg.symbol,
        );
        const impactScore = (observedAt != null || (depeg.currentBps == null && eventAt != null)
          ? canonicalCandidate?.impactScore : null)
          ?? getDepegEditorialImpactScore(severityBps, depeg.mcapUsd);
        const carriedOver = depegStartedBeforeWindow(depeg, d, eventPeriod.start);
        const severityScore = impactScore * (carriedOver ? 0.5 : 1);
        const eventIdentity = `${depeg.stablecoinId ?? depeg.symbol.toUpperCase()}:${depeg.startedAt ?? "active"}`;
        const magnitude = `${Math.abs(severityBps)} bps ${severityBps >= 0 ? "above" : "below"} peg`;
        const basis = observedAt != null
          ? `active, ${magnitude} observed at ${new Date(observedAt * 1000).toISOString()}`
          : `active${eventAt != null ? ` since ${formatIsoDate(eventAt)}` : ""}, stored lifetime peak ${magnitude} (peak time unknown)`;
        return [{
          id: weeklySignalId("depeg", [eventIdentity]),
          eventIdentity,
          symbol: depeg.symbol,
          label: `${basis}${carriedOver ? " (carried over from before this week)" : ""}`,
          impactScore,
          severityScore,
          mcapUsd: depeg.mcapUsd,
          bps: Math.abs(severityBps),
          ...(observedAt != null ? { date: formatIsoDate(observedAt), observedAt } : {}),
          ...(eventAt != null ? { eventAt } : {}),
          severityBasis: observedAt != null ? "current" as const : "peak-fallback" as const,
          kind: "active" as const,
          critical: (observedAt != null || (eventAt != null && capturedAt <= eventPeriod.end)) &&
            isCriticalDepegRisk({ bps: severityBps, mcapUsd: depeg.mcapUsd }),
          carriedOver,
          suppressReason: depeg.suppressReason,
        }];
      }),
      ...(d.inputData.resolvedDepegs ?? []).flatMap((depeg) => {
        const recoveredAt = depeg.endedAt;
        if (!Number.isFinite(depeg.peakBps) || (recoveredAt != null &&
          (!Number.isSafeInteger(recoveredAt) || recoveredAt < eventPeriod.start ||
            recoveredAt >= eventPeriod.end || recoveredAt > capturedAt))) return [];
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
        return [{
          id: weeklySignalId("depeg", [eventIdentity]),
          eventIdentity,
          symbol: depeg.symbol,
          label: `resolved after ${depeg.durationHours}h${recoveredAt == null ? "" : ` on ${formatIsoDate(recoveredAt)}`}; stored lifetime peak ${Math.abs(depeg.peakBps)} bps (peak time unknown)`,
          impactScore,
          severityScore: impactScore,
          mcapUsd: depeg.mcapUsd,
          bps: Math.abs(depeg.peakBps),
          ...(recoveredAt != null ? { eventAt: recoveredAt } : {}),
          severityBasis: "peak-fallback" as const,
          kind: "resolved" as const,
          critical: recoveredAt != null && depeg.startedAt != null && depeg.startedAt >= eventPeriod.start &&
            depeg.startedAt <= recoveredAt && isCriticalDepegRisk({ bps: depeg.peakBps, mcapUsd: depeg.mcapUsd }),
        }];
      }),
    ];
  });
  const topDepegs = (observations: WeeklyDepegSignal[]) => observations
    .sort((a, b) =>
      Number(b.critical) - Number(a.critical) || b.severityScore - a.severityScore || b.impactScore - a.impactScore)
    .filter((signal, index, sorted) =>
      sorted.findIndex((candidate) => candidate.eventIdentity === signal.eventIdentity) === index)
    .slice(0, 7);
  const rankedDepegSignals = topDepegs(allDepegObservations.filter((signal) =>
    signal.observedAt != null || signal.eventAt != null));
  const topDepegSignals = [
    ...topDepegs(allDepegObservations.filter((signal) => signal.severityBasis === "current")),
    ...topDepegs(allDepegObservations.filter((signal) => signal.severityBasis === "peak-fallback")),
  ];
  const topSupplySignals = topSignals(
    parsed,
    (d) => {
      const supplyLabel = (raw: unknown) => {
        if (raw === undefined) return "legacy USD-value change";
        const evidence = DigestSupplyQuantityEvidenceSchema.safeParse(raw).data;
        return evidence ? `token-count change at ${evidence.valuationPriceUsd} USD per token` : null;
      };
      const rows: { symbol: string; label: string; amountUsd: number }[] = [];
      const mover = d.inputData.biggestSupplyChange;
      const moverBasis = supplyLabel(mover?.quantityEvidence);
      if (mover && moverBasis != null) {
        rows.push({ symbol: mover.symbol, label: `${d.date} largest weekly mover (${moverBasis})`, amountUsd: mover.changeUsd });
      }
      for (const velocity of d.inputData.supplyVelocity ?? []) {
        const basis = supplyLabel(velocity.quantityEvidence);
        if (basis == null) continue;
        rows.push({ symbol: velocity.coin, label: `${d.date} ${velocity.signal} (${basis})`, amountUsd: velocity.change1d });
      }
      return rows;
    },
    (row) => Math.abs(row.amountUsd),
  );
  // DEWS orders observed market caps first (descending), then unavailable ones;
  // score breaks ties. An unavailable cap stays null rather than an invented $0.
  const topDewsChanges = parsed
    .flatMap((d) =>
      (d.inputData.dewsStress?.bandChanges ?? []).map((change) => ({
        symbol: change.symbol,
        from: change.from,
        to: change.to,
        score: change.score,
        mcapUsd: change.mcapUsd ?? null,
        driver: change.topDriver,
      })),
    )
    .sort((a, b) => {
      if (a.mcapUsd !== b.mcapUsd) {
        if (a.mcapUsd === null) return 1;
        if (b.mcapUsd === null) return -1;
        return b.mcapUsd - a.mcapUsd;
      }
      return b.score - a.score;
    })
    .slice(0, 7);
  const fullAlertPlusMcaps = parsed.map(({ inputData }) => {
    const dews = inputData.dewsStress;
    return dews?.alertPlusSupplyCoverage?.complete === true ? dews.alertPlusMcapUsd : null;
  });
  const maxAlertPlusMcapUsd = fullAlertPlusMcaps.every((value): value is number => value != null)
    ? Math.max(...fullAlertPlusMcaps)
    : null;
  const bandChangeCounts = parsed.map(({ inputData }) => inputData.dewsStress?.bandChangeCount);
  const totalDewsBandChanges = bandChangeCounts.every((value): value is number => value != null)
    ? bandChangeCounts.reduce((sum, count) => sum + count, 0)
    : null;
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
      (d.inputData.yieldAnomalies ?? []).flatMap((anomaly) => {
        // Archived rows may still carry operational advisories; filter before ranking.
        const warnings = selectInvestmentWarningSignals(anomaly.warnings);
        return warnings.length === 0 ? [] : [{
          symbol: anomaly.symbol,
          apy: anomaly.currentApy,
          warnings,
          mcapUsd: anomaly.mcapUsd,
          date: d.date,
        }];
      }),
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
    allDepegObservations,
    rankedDepegSignals,
    topDepegSignals,
    topSupplySignals,
    topDewsChanges,
    maxAlertPlusMcapUsd,
    totalDewsBandChanges,
    topPressureSignals,
    topGradeTransitions,
    topYieldAnomalies,
    topLiquidityShifts,
  };
}

/**
 * The daily collector persists only its display slices (top active magnitudes,
 * filtered top recovered rows) while the same rows carry the uncapped census.
 * A weekly depeg maximum is therefore a slice maximum unless each edition
 * persisted a magnitude for every event it observed; return the weakest such
 * edition per kind so the prompt can disclose the shown/total bound (ADR-34).
 */
function collectDepegObservationBounds(parsed: WeeklyParsedRow[]): WeeklySpikeMetrics["depegObservationBounds"] {
  const bounds: WeeklySpikeMetrics["depegObservationBounds"] = [];
  for (const kind of ["active", "resolved"] as const) {
    let weakest: WeeklySpikeMetrics["depegObservationBounds"][number] | null = null;
    for (const day of parsed) {
      const total = kind === "active" ? day.inputData.activeDepegCount : day.inputData.resolvedDepegCount;
      if (total == null) continue;
      const shown = kind === "active"
        ? day.inputData.topDepegs?.length ?? 0
        : day.inputData.resolvedDepegs?.length ?? 0;
      if (shown >= total) continue;
      if (weakest == null || total - shown > weakest.total - weakest.shown) {
        weakest = { kind, shown, total, date: day.date };
      }
    }
    if (weakest) bounds.push(weakest);
  }
  return bounds;
}

function buildWeeklySpikeMetrics(parsed: WeeklyParsedRow[], allDepegObservations: WeeklyDepegSignal[]): WeeklySpikeMetrics {
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
  const { maxDepegByBps, maxDepegByImpact } = allDepegObservations.filter((signal) => signal.observedAt != null).reduce<{
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
    depegObservationBounds: collectDepegObservationBounds(parsed),
  };
}

function buildWeeklyWowDeltas(
  current: RollupSummary,
  priorParsed: WeeklyParsedRow[],
  priorPeriod: DigestEventPeriod | undefined,
): WeeklyInputData["weekOverWeekDeltas"] {
  if (priorParsed.length < 5) return null;
  const prior = rollupDigestInputs(priorParsed.map((d) => d.inputData), undefined, priorPeriod);
  return {
    mcap: {
      current: current.mcapEnd,
      prior: prior.mcapEnd,
      deltaPct: current.mcapEnd != null && prior.mcapEnd != null && prior.mcapEnd > 0
        ? ((current.mcapEnd - prior.mcapEnd) / prior.mcapEnd) * 100 : null,
    },
    psi: {
      current: current.psiMid,
      prior: prior.psiMid,
      delta: current.psiMid != null && prior.psiMid != null ? current.psiMid - prior.psiMid : null,
      ...(current.psiMid == null || prior.psiMid == null ? { unavailableReason: "psi-observations-missing" } : {}),
    },
    psiDominantBand: { current: current.psiDominantBand, prior: prior.psiDominantBand },
    activeDepegObservations: { current: current.activeDepegObs, prior: prior.activeDepegObs },
    uniqueDepegSignals: { current: current.uniqueDepegSignals, prior: prior.uniqueDepegSignals },
    gradeTransitions: { current: current.gradeTransitions, prior: prior.gradeTransitions },
    gauge: { current: current.gaugeMid, prior: prior.gaugeMid },
    dataCoverage: { currentDays: current.days, priorDays: prior.days, currentPsiDays: current.psiObservationDays, priorPsiDays: prior.psiObservationDays },
  };
}

export function buildWeeklyInputData(
  currentDailyRows: DailyDigestSourceRow[],
  priorDailyRows: DailyDigestSourceRow[] = [],
  safetyContext?: DigestSafetyContext,
  gradeTransitionPeriods?: WeeklyInputData["gradeTransitionPeriods"],
  eventPeriods?: WeeklyInputData["eventPeriods"],
  blacklist?: { current: WeeklyBlacklistActivity | null; prior: WeeklyBlacklistActivity | null },
): WeeklyInputData | null {
  const currentParsed = parseDailyRows(currentDailyRows);
  const prior = parseDailyRows(priorDailyRows);
  const parsed = sanitizeSafetyForWeekly(currentParsed.parsed, safetyContext, gradeTransitionPeriods?.current);
  const priorParsed = sanitizeSafetyForWeekly(prior.parsed, safetyContext, gradeTransitionPeriods?.prior);
  if (parsed.length < 5) return null;

  const psiScores = parsed.map((d) => d.inputData.stabilityIndex?.score).filter((s): s is number => s != null);
  const coreMarketInputs = parsed.filter((day) => day.inputData.aggregateUniverse === "core-stablecoins-v1");
  const perimeterChangedAt = getLatestSupplyPerimeterChange(parsed[0].generatedAt, parsed[parsed.length - 1].generatedAt);
  const marketInputs = (coreMarketInputs.length > 0 ? coreMarketInputs : parsed)
    .filter((day) => perimeterChangedAt == null || day.generatedAt >= perimeterChangedAt);
  const marketCoverageComplete = marketInputs.every((day) =>
    day.inputData.supplyCoverage?.complete === true && Number.isFinite(day.inputData.totalMcapUsd));
  const mcaps = marketCoverageComplete ? marketInputs.map((day) => day.inputData.totalMcapUsd) : [];
  // A weekly change needs two comparable observations; one complete day has no
  // comparison pair and is not a flat week.
  const mcapRangeAvailable = marketCoverageComplete && mcaps.length >= 2;
  const gauges = parsed.map((d) => d.inputData.mintBurnFlows?.gaugeScore).filter((g): g is number => g != null);

  if (psiScores.length === 0) return null;

  const current = rollupDigestInputs(parsed.map((d) => d.inputData), undefined, gradeTransitionPeriods?.current);
  const dominantBand = current.psiObservationDays >= 3 ? current.psiDominantBand : null;

  const depegPeriod = eventPeriods?.current ?? {
    start: Math.floor(Date.parse(`${parsed[0].date}T00:00:00Z`) / 1_000),
    end: parsed[parsed.length - 1].generatedAt + 1,
  };
  const { allDepegObservations, rankedDepegSignals, ...topSignalsResult } = collectWeeklyTopSignals(parsed, depegPeriod);
  const {
    topDepegSignals,
    topSupplySignals,
    topDewsChanges,
    maxAlertPlusMcapUsd,
    totalDewsBandChanges,
    topPressureSignals,
    topGradeTransitions,
    topYieldAnomalies,
    topLiquidityShifts,
  } = topSignalsResult;

  const spikeMetrics = buildWeeklySpikeMetrics(parsed, allDepegObservations);

  const riskLeaderboard = buildWeeklyRiskLeaderboard({
    parsed,
    depegs: rankedDepegSignals,
    blacklist: blacklist?.current ?? null,
  });

  const weekOverWeekDeltas = buildWeeklyWowDeltas(current, priorParsed, gradeTransitionPeriods?.prior);
  if (weekOverWeekDeltas && getLatestSupplyPerimeterChange(priorParsed[priorParsed.length - 1].generatedAt, parsed[parsed.length - 1].generatedAt) != null) {
    weekOverWeekDeltas.mcap = { current: current.mcapEnd, prior: null, deltaPct: null };
  }
  // Forward-look accountability: publishing the hit rate creates pressure
  // toward falsifiable near-term triggers (the corpus ran at ~4% hits).
  const outcomeCounts = { hit: 0, missed: 0, pending: 0, expired: 0, unavailable: 0 };
  for (const day of parsed) {
    for (const outcome of day.inputData.forwardLookOutcomes ?? []) {
      if (outcome.status in outcomeCounts) outcomeCounts[outcome.status as keyof typeof outcomeCounts] += 1;
    }
  }
  const forwardLookScoreboard =
    outcomeCounts.hit + outcomeCounts.missed + outcomeCounts.pending + outcomeCounts.expired + outcomeCounts.unavailable > 0
      ? outcomeCounts
      : null;
  // Only current-window reads can support a "this week" claim; prior-window
  // degradation stays in the persisted union as provenance of the comparison.
  const degradedSourcesThisWeek = [
    ...currentParsed.degradedSources,
    ...parsed.flatMap((day) => day.inputData.degradedSources ?? []),
    ...(blacklist?.current === null ? [WEEKLY_BLACKLIST_QUERY_UNAVAILABLE] : []),
    ...(blacklist?.current?.coverage.reason === "weekly-blacklist-coverage-query" ? [blacklist.current.coverage.reason] : []),
  ];
  const degradedSources = [
    ...degradedSourcesThisWeek,
    ...prior.degradedSources,
    ...priorParsed.flatMap((day) => day.inputData.degradedSources ?? []),
    ...(blacklist?.prior === null ? [WEEKLY_BLACKLIST_QUERY_UNAVAILABLE] : []),
    ...(blacklist?.prior?.coverage.reason === "weekly-blacklist-coverage-query" ? [blacklist.prior.coverage.reason] : []),
  ];
  const currentBlacklist = summarizeWeeklyBlacklistActivity(blacklist?.current);
  const blacklistCountReason = currentBlacklist
    ? currentBlacklist.coverage.reason
    : blacklist ? WEEKLY_BLACKLIST_QUERY_UNAVAILABLE : "weekly-blacklist-event-period-unavailable";
  const blacklistUsdReason = blacklistCountReason ??
    ((currentBlacklist?.unpricedEventCount ?? 0) > 0 ? WEEKLY_BLACKLIST_UNPRICED : null);

  return {
    weekStartDate: parsed[0].date,
    weekEndDate: parsed[parsed.length - 1].date,
    periodType: "trailing-daily-editions",
    ...(eventPeriods ? { eventPeriods } : {}),
    ...(gradeTransitionPeriods ? { gradeTransitionPeriods } : {}),
    ...(safetyContext ? { safetyContext } : {}),
    ...(degradedSources.length > 0 ? { degradedSources: [...new Set(degradedSources)] } : {}),
    ...(degradedSourcesThisWeek.length > 0
      ? { degradedSourcesThisWeek: [...new Set(degradedSourcesThisWeek)] }
      : {}),
    dailyDigests: parsed,
    psiRange: {
      min: Math.min(...psiScores),
      max: Math.max(...psiScores),
      start: parsed[0]?.inputData.stabilityIndex?.score ?? null,
      end: parsed[parsed.length - 1]?.inputData.stabilityIndex?.score ?? null,
      observationDays: current.psiObservationDays,
      dominantBand,
    },
    mcapRange: {
      start: mcapRangeAvailable ? mcaps[0] : null,
      end: mcapRangeAvailable ? mcaps[mcaps.length - 1] : null,
      netChange: mcapRangeAvailable ? mcaps[mcaps.length - 1] - mcaps[0] : null,
      pctChange: mcapRangeAvailable && mcaps[0] > 0
        ? ((mcaps[mcaps.length - 1] - mcaps[0]) / mcaps[0]) * 100
        : null,
      ...(!marketCoverageComplete
        ? { unavailableReason: "supply-coverage-incomplete" }
        : !mcapRangeAvailable ? { unavailableReason: "insufficient-market-observations" } : {}),
    },
    activeDepegObservationsThisWeek: current.activeDepegObs,
    uniqueDepegSignalsThisWeek: current.uniqueDepegSignals,
    totalBlacklistEventsThisWeek: blacklistCountReason == null ? currentBlacklist?.eventCount ?? null : null,
    totalBlacklistAmountUsd: blacklistUsdReason == null ? currentBlacklist?.knownAmountUsd ?? null : null,
    blacklistUnpricedEventCount: blacklistCountReason == null ? currentBlacklist?.unpricedEventCount ?? null : null,
    ...(blacklist ? { blacklistLedgerObservations: {
      current: currentBlacklist,
      prior: summarizeWeeklyBlacklistActivity(blacklist.prior),
    } } : {}),
    metricUnavailableReasons: {
      ...current.unavailableReasons,
      ...(blacklistCountReason == null ? {} : { blacklistEvents: [blacklistCountReason] }),
      ...(blacklistUsdReason == null ? {} : { blacklistUsd: [blacklistUsdReason] }),
    },
    gradeTransitionCount: current.gradeTransitions,
    gaugeRange: gauges.length >= 3 ? { min: Math.min(...gauges), max: Math.max(...gauges) } : null,
    spikeMetrics,
    weeklySignals: {
      riskLeaderboard,
      topDepegSignals,
      topSupplySignals,
      topDewsChanges,
      maxAlertPlusMcapUsd,
      totalDewsBandChanges,
      topPressureSignals,
      topBlacklistEvents: blacklist?.current?.topEvents ?? [],
      topGradeTransitions,
      topYieldAnomalies,
      topLiquidityShifts,
    },
    forwardLookScoreboard,
    weekOverWeekDeltas,
  };
}
