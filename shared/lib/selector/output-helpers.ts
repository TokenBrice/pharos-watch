import { round1 } from "../math";
import type {
  ExclusionRecord,
  ExclusionReason,
  MergedRow,
  SelectorClosestSurvivor,
  SelectorExclusionSummaryItem,
  SelectorInput,
  SelectorRelaxableConstraint,
} from "./types";

export function buildExclusionSummary(excluded: readonly ExclusionRecord[]): SelectorExclusionSummaryItem[] {
  const grouped = new Map<ExclusionReason, SelectorExclusionSummaryItem>();
  for (const record of excluded) {
    const existing = grouped.get(record.reason);
    if (existing) {
      existing.count += 1;
      if (existing.sampleIds.length < 3) existing.sampleIds.push(record.id);
      if (record.severity === "hard") existing.severity = "hard";
      else if (record.severity === "soft" && existing.severity === "info") existing.severity = "soft";
      continue;
    }
    grouped.set(record.reason, {
      reason: record.reason,
      count: 1,
      severity: record.severity,
      sampleIds: [record.id],
    });
  }
  return Array.from(grouped.values()).sort((a, b) =>
    b.count !== a.count ? b.count - a.count : a.reason.localeCompare(b.reason),
  );
}

function liveReadingFor(reason: ExclusionReason, row: MergedRow): string {
  switch (reason) {
    case "active-depeg":
      return row.currentDeviationBps != null
        ? `${Math.round(row.currentDeviationBps)} bps deviation`
        : "active depeg flag";
    case "peg-score-floor":
      return row.pegScore != null
        ? `PegScore ${Math.round(row.pegScore)}`
        : "missing PegScore";
    case "dews-ceiling":
      return row.dewsScore != null ? `DEWS ${Math.round(row.dewsScore)}` : "missing DEWS";
    case "safety-resilience-floor":
      return row.safetyResilienceScore != null
        ? `resilience ${Math.round(row.safetyResilienceScore)}`
        : "missing resilience";
    case "liquidity-floor":
      return row.liquidityScore != null
        ? `liquidity ${Math.round(row.liquidityScore)}`
        : "missing liquidity";
    case "effective-exit-floor":
      return row.effectiveExitScore != null
        ? `effective exit ${Math.round(row.effectiveExitScore)}`
        : "missing exit score";
    case "high-venue-on-c-tier":
      return row.venueRiskTier != null ? `venue risk ${row.venueRiskTier}` : "venue risk gap";
    case "yield-warning-unstable":
    case "yield-warning-thin-tvl":
      return row.warningSignals.length > 0 ? row.warningSignals.join(", ") : "yield warning";
    case "custody-regulated-only-violation":
    case "custody-onchain-only-violation":
      return row.custodyModel != null
        ? `custody model ${row.custodyModel}`
        : "custody model unavailable";
    case "coverage-too-thin":
      return "required signals missing";
    default:
      return "profile gate missed";
  }
}

/** Resolve the optional rowsById param, building the map lazily from rows when absent. */
export function resolveRowsById(
  map: Map<string, MergedRow> | undefined,
  rows: readonly MergedRow[],
): Map<string, MergedRow> {
  return map ?? new Map(rows.map((row) => [row.id, row]));
}

export function buildClosestSurvivors(
  excluded: readonly ExclusionRecord[],
  universe: readonly MergedRow[],
  input: SelectorInput,
  scoreIgnoringExclusion: (row: MergedRow, input: SelectorInput) => number | null,
  rowsById?: Map<string, MergedRow>,
): SelectorClosestSurvivor[] {
  const resolvedRowsById = resolveRowsById(rowsById, universe);
  const candidates: Array<SelectorClosestSurvivor & { sortScore: number }> = [];
  for (const record of excluded) {
    if (record.reason === "howey-uncertain" || record.reason === "lifecycle-non-active") continue;
    const row = resolvedRowsById.get(record.id);
    if (!row) continue;
    const hypotheticalScore = scoreIgnoringExclusion(row, input);
    candidates.push({
      id: row.id,
      symbol: row.symbol,
      failingDimension: record.reason,
      liveReading: liveReadingFor(record.reason, row),
      reason: record.reason,
      hypotheticalScore: hypotheticalScore == null ? null : round1(hypotheticalScore),
      sortScore: hypotheticalScore ?? -1,
    });
  }
  return candidates
    .sort((a, b) => b.sortScore - a.sortScore || a.id.localeCompare(b.id))
    .slice(0, 3)
    .map(({ sortScore: _sortScore, ...candidate }) => candidate);
}

function hasExcludedReason(
  excluded: readonly ExclusionRecord[],
  reasons: readonly ExclusionReason[],
): ExclusionReason | null {
  for (const reason of reasons) {
    if (excluded.some((record) => record.reason === reason)) return reason;
  }
  return null;
}

export function buildRelaxableConstraints(
  input: SelectorInput,
  excluded: readonly ExclusionRecord[],
): SelectorRelaxableConstraint[] {
  const out: SelectorRelaxableConstraint[] = [];
  const depegReason = hasExcludedReason(excluded, [
    "active-depeg",
    "peg-score-floor",
  ]);
  if (input.depegTolerance === "zero" || input.depegTolerance === "tight" || depegReason) {
    out.push({
      key: "depegTolerance",
      label: "Relax depeg tolerance",
      description: input.depegTolerance === "zero" ? "Zero to tight" : "Tight to moderate",
      reason: depegReason ?? "input-strictness",
    });
  }

  const venueReason = hasExcludedReason(excluded, [
    "high-venue-on-c-tier",
    "yield-warning-thin-tvl",
  ]);
  const venueScoped = input.composability !== "high" || !(input.venuePreferences?.includes("all" as never) ?? false);
  if (input.profile !== "treasury" && (venueScoped || venueReason)) {
    out.push({
      key: "venue",
      label: "Open venue scope",
      description: "Specific rail to all rails",
      reason: venueReason ?? "input-strictness",
    });
  }

  const exitReason = hasExcludedReason(excluded, [
    "effective-exit-floor",
    "supply-tvl-floor-1h",
    "liquidity-floor",
  ]);
  if (input.exitSpeed !== "any" || exitReason) {
    out.push({
      key: "exitSpeed",
      label: "Loosen exit speed",
      description: "Tighter exit to any",
      reason: exitReason ?? "input-strictness",
    });
  }
  return out;
}
