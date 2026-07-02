import type { ReportCardGrade } from "../../types";
import type { ScoredEntry } from "./scoring";
import type {
  SelectorInput,
  SelectorProfile,
  SelectorRankRobustness,
} from "./types";
import { round1 } from "../math";
import {
  UNKNOWN_REPORT_CARD_GRADE_RANK,
  getReportCardGradeRank,
} from "../report-card-core";

export function dedupVariants(
  entries: ScoredEntry[],
  profile: SelectorProfile,
): ScoredEntry[] {
  const seen = new Map<string, ScoredEntry>();
  const out: ScoredEntry[] = [];
  for (const entry of entries) {
    if (entry.row.variantOf == null) {
      out.push(entry);
      continue;
    }
    const key =
      profile === "yield"
        ? `${entry.row.variantOf}::${entry.row.isYieldBearing ? "y" : "n"}`
        : entry.row.variantOf;
    const existing = seen.get(key);
    if (!existing || entry.score > existing.score) {
      seen.set(key, entry);
    }
  }
  const kept = new Set(Array.from(seen.values()));
  for (const entry of entries) {
    if (entry.row.variantOf == null) continue;
    if (kept.has(entry)) out.push(entry);
  }
  return out.sort((a, b) => b.score - a.score);
}

const MISSING_SELECTOR_GRADE_RANK = 99;
const SCORE_CLUSTER_WINDOW = 1.5;

function selectorGradeRank(grade: ReportCardGrade | null | undefined): number {
  if (grade == null) return MISSING_SELECTOR_GRADE_RANK;
  return -(getReportCardGradeRank(grade, UNKNOWN_REPORT_CARD_GRADE_RANK) ?? UNKNOWN_REPORT_CARD_GRADE_RANK);
}

function compareScoredTieBreakers(a: ScoredEntry, b: ScoredEntry): number {
  if (b.row.supplyUsd !== a.row.supplyUsd) {
    return b.row.supplyUsd - a.row.supplyUsd;
  }
  const aGrade = selectorGradeRank(a.row.safetyGrade);
  const bGrade = selectorGradeRank(b.row.safetyGrade);
  if (aGrade !== bGrade) return aGrade - bGrade;
  const aLiq = a.row.liquidityScore ?? -1;
  const bLiq = b.row.liquidityScore ?? -1;
  if (aLiq !== bLiq) return bLiq - aLiq;
  return a.row.id.localeCompare(b.row.id);
}

export function compareScored(a: ScoredEntry, b: ScoredEntry): number {
  const diff = b.score - a.score;
  if (diff !== 0) return diff;
  return compareScoredTieBreakers(a, b);
}

// Form descending score windows once; pairwise threshold tie-breaks in
// Array.sort comparators can create non-transitive cycles.
export function sortScoredEntries(entries: readonly ScoredEntry[]): ScoredEntry[] {
  const byScore = [...entries].sort(compareScored);
  const ordered: ScoredEntry[] = [];

  for (let index = 0; index < byScore.length;) {
    const clusterStart = index;
    const clusterTopScore = byScore[index]!.score;
    index += 1;

    while (
      index < byScore.length &&
      clusterTopScore - byScore[index]!.score <= SCORE_CLUSTER_WINDOW
    ) {
      index += 1;
    }

    const cluster = byScore.slice(clusterStart, index);
    cluster.sort(compareScoredTieBreakers);
    ordered.push(...cluster);
  }

  return ordered;
}

const CONCENTRATION_SUBSTITUTE_WINDOW = 3;

export function applyConcentrationSafeguard(entries: ScoredEntry[]): ScoredEntry[] {
  const remaining = [...entries];
  const selected: ScoredEntry[] = [];
  while (selected.length < 3 && remaining.length > 0) {
    const primary = remaining[0]!;
    const primaryProtocol = primary.row.protocolSlug;
    const conflicts =
      primaryProtocol != null &&
      selected.some((entry) => entry.row.protocolSlug === primaryProtocol);
    if (conflicts) {
      const substituteIndex = remaining.findIndex((candidate) => {
        if (candidate.row.protocolSlug == null) return false;
        if (candidate.row.protocolSlug === primaryProtocol) return false;
        return primary.score - candidate.score <= CONCENTRATION_SUBSTITUTE_WINDOW;
      });
      if (substituteIndex > 0) {
        const [substitute] = remaining.splice(substituteIndex, 1);
        substitute!.concentrationAdjusted = true;
        selected.push(substitute!);
        continue;
      }
    }
    selected.push(remaining.shift()!);
  }
  return [...selected, ...remaining];
}

export function rankScoredEntries(
  scored: readonly ScoredEntry[],
  input: SelectorInput,
): ScoredEntry[] {
  const deduped = dedupVariants([...scored], input.profile);
  const ranked = applyConcentrationSafeguard(sortScoredEntries(deduped));

  if (input.profile !== "trading" && ranked.length >= 2) {
    if (ranked[0]!.confidence < 40) {
      const tmp = ranked[0]!;
      ranked[0] = ranked[1]!;
      ranked[1] = tmp;
    }
  }
  return ranked;
}

export function rankRobustnessFor(
  entries: readonly ScoredEntry[],
  index: number,
): SelectorRankRobustness {
  const entry = entries[index];
  const next = entries[index + 1];
  if (entry?.concentrationAdjusted) {
    return { label: "concentration-adjusted", scoreMargin: next ? round1(Math.max(0, entry.score - next.score)) : null };
  }
  if (!entry || !next) return { label: "clear-margin", scoreMargin: null };
  const margin = round1(Math.max(0, entry.score - next.score));
  if (margin < SCORE_CLUSTER_WINDOW) return { label: "narrow-margin", scoreMargin: margin };
  if (margin < 3) return { label: "crowded-field", scoreMargin: margin };
  return { label: "clear-margin", scoreMargin: margin };
}
