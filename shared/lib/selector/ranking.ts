import type { ReportCardGrade } from "../../types";
import type { ScoredEntry } from "./scoring";
import type {
  SelectorInput,
  SelectorProfile,
  SelectorRankRobustness,
} from "./types";
import { round1 } from "../math";

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

const GRADE_RANK: Record<ReportCardGrade, number> = {
  "A+": 0,
  "A": 1,
  "A-": 2,
  "B+": 3,
  "B": 4,
  "B-": 5,
  "C+": 6,
  "C": 7,
  "C-": 8,
  "D": 9,
  "F": 10,
  "NR": 11,
};

export function compareScored(a: ScoredEntry, b: ScoredEntry): number {
  const diff = b.score - a.score;
  if (Math.abs(diff) > 1.5) return diff;
  if (b.row.supplyUsd !== a.row.supplyUsd) {
    return b.row.supplyUsd - a.row.supplyUsd;
  }
  const aGrade = a.row.safetyGrade != null ? GRADE_RANK[a.row.safetyGrade] : 99;
  const bGrade = b.row.safetyGrade != null ? GRADE_RANK[b.row.safetyGrade] : 99;
  if (aGrade !== bGrade) return aGrade - bGrade;
  const aLiq = a.row.liquidityScore ?? -1;
  const bLiq = b.row.liquidityScore ?? -1;
  if (aLiq !== bLiq) return bLiq - aLiq;
  return a.row.id.localeCompare(b.row.id);
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
  deduped.sort(compareScored);
  const ranked = applyConcentrationSafeguard(deduped);

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
  if (margin < 1.5) return { label: "narrow-margin", scoreMargin: margin };
  if (margin < 3) return { label: "crowded-field", scoreMargin: margin };
  return { label: "clear-margin", scoreMargin: margin };
}
