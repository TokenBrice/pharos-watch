import { formatCurrency, formatIsoDate } from "@shared/lib/format";
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
    return {
      ...row,
      title: copyIsComparable ? row.title : "",
      text: copyIsComparable ? row.text : "",
      inputData,
    };
  });
}

interface WeeklyTopSignals extends Omit<WeeklyInputData["weeklySignals"], "riskLeaderboard"> {
  allDepegObservations: WeeklyDepegSignal[];
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
          label: `${Math.abs(depeg.peakBps)} bps resolved after ${depeg.durationHours}h`,
          impactScore,
          severityScore: impactScore,
          mcapUsd: depeg.mcapUsd,
          bps: Math.abs(depeg.peakBps),
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
    (row) => row.amountUsd ?? 0,
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
    topDepegSignals,
    topSupplySignals,
    topDewsChanges,
    maxAlertPlusMcapUsd,
    totalDewsBandChanges,
    topPressureSignals,
    topBlacklistEvents,
    topGradeTransitions,
    topYieldAnomalies,
    topLiquidityShifts,
  };
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
  const { maxDepegByBps, maxDepegByImpact } = allDepegObservations.reduce<{
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
    blacklistEvents: { current: current.blacklistEvents, prior: prior.blacklistEvents },
    blacklistUsd: { current: current.blacklistUsd, prior: prior.blacklistUsd },
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
): WeeklyInputData | null {
  const currentParsed = parseDailyRows(currentDailyRows);
  const prior = parseDailyRows(priorDailyRows);
  const parsed = sanitizeSafetyForWeekly(currentParsed.parsed, safetyContext, gradeTransitionPeriods?.current);
  const priorParsed = sanitizeSafetyForWeekly(prior.parsed, safetyContext, gradeTransitionPeriods?.prior);
  if (parsed.length < 5) return null;

  const psiScores = parsed.map((d) => d.inputData.stabilityIndex?.score).filter((s): s is number => s != null);
  const coreMarketInputs = parsed.filter((day) => day.inputData.aggregateUniverse === "core-stablecoins-v1");
  const marketInputs = coreMarketInputs.length > 0 ? coreMarketInputs : parsed;
  const marketCoverageComplete = marketInputs.every((day) =>
    day.inputData.supplyCoverage?.complete === true && Number.isFinite(day.inputData.totalMcapUsd));
  const mcaps = marketCoverageComplete ? marketInputs.map((day) => day.inputData.totalMcapUsd) : [];
  const gauges = parsed.map((d) => d.inputData.mintBurnFlows?.gaugeScore).filter((g): g is number => g != null);

  if (psiScores.length === 0) return null;

  const current = rollupDigestInputs(parsed.map((d) => d.inputData), undefined, gradeTransitionPeriods?.current);
  const dominantBand = current.psiDominantBand!;

  const { allDepegObservations, ...topSignalsResult } = collectWeeklyTopSignals(parsed);
  const {
    topDepegSignals,
    topSupplySignals,
    topDewsChanges,
    maxAlertPlusMcapUsd,
    totalDewsBandChanges,
    topPressureSignals,
    topBlacklistEvents,
    topGradeTransitions,
    topYieldAnomalies,
    topLiquidityShifts,
  } = topSignalsResult;

  const spikeMetrics = buildWeeklySpikeMetrics(parsed, allDepegObservations);

  const riskLeaderboard = buildWeeklyRiskLeaderboard({
    parsed,
    depegs: topDepegSignals,
  });

  const weekOverWeekDeltas = buildWeeklyWowDeltas(current, priorParsed, gradeTransitionPeriods?.prior);
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
  const degradedSources = [
    ...currentParsed.degradedSources,
    ...prior.degradedSources,
    ...parsed.flatMap((day) => day.inputData.degradedSources ?? []),
    ...priorParsed.flatMap((day) => day.inputData.degradedSources ?? []),
  ];

  return {
    weekStartDate: parsed[0].date,
    weekEndDate: parsed[parsed.length - 1].date,
    periodType: "trailing-daily-editions",
    ...(gradeTransitionPeriods ? { gradeTransitionPeriods } : {}),
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
      start: mcaps[0] ?? null,
      end: mcaps[mcaps.length - 1] ?? null,
      netChange: mcaps.length > 0 ? mcaps[mcaps.length - 1] - mcaps[0] : null,
      pctChange: mcaps.length > 0 && mcaps[0] > 0 ? ((mcaps[mcaps.length - 1] - mcaps[0]) / mcaps[0]) * 100 : null,
      ...(!marketCoverageComplete ? { unavailableReason: "supply-coverage-incomplete" } : {}),
    },
    activeDepegObservationsThisWeek: current.activeDepegObs,
    uniqueDepegSignalsThisWeek: current.uniqueDepegSignals,
    totalBlacklistEventsThisWeek: current.blacklistEvents,
    totalBlacklistAmountUsd: current.blacklistUsd,
    blacklistUnpricedEventCount: current.blacklistUnpricedEvents,
    metricUnavailableReasons: current.unavailableReasons,
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
      topBlacklistEvents,
      topGradeTransitions,
      topYieldAnomalies,
      topLiquidityShifts,
    },
    forwardLookScoreboard,
    weekOverWeekDeltas,
  };
}
