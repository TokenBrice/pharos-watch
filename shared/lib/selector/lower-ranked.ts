/**
 * Lower-ranked-list selection.
 *
 * Two slots:
 *   - **Slot A** — highest-scoring excluded coin whose exclusion reason is in
 *     the profile-defining set.
 *   - **Slot B** — survivor at rank 4..N who is bottom-quartile on the user-
 *     emphasized dimension.
 *
 * Anti-rules: no coverage-too-thin coins, no duplicate reasons across slots,
 * no protocol-slug collisions with shortlisted coins.
 *
 * Binding: `agents/impl-plan-drafts/02-engine.md` §7.
 */
import { PROFILE_DEFINING_EXCLUSIONS } from "./exclusions";
import { round1 } from "../math";
import { percentileLinear } from "../stats";
import { resolveRowsById } from "./output-helpers";
import { getLowerRankedText } from "./what-to-watch-templates";
import type {
  ExclusionRecord,
  MergedRow,
  SelectorComponent,
  SelectorInput,
  SelectorLowerRanked,
  WeightKey,
} from "./types";

interface ScoredEntryLike {
  row: MergedRow;
  score: number;
  components: SelectorComponent[];
  confidence: number;
}

/**
 * `userEmphasizedDimension(input)` mapping table (design §3.5).
 * Returns the weight-vector key the lower-ranked Slot B grades against.
 */
export function userEmphasizedDimension(input: SelectorInput): WeightKey | null {
  if (input.depegTolerance === "zero") {
    return input.profile === "treasury" ? "pegStabilityHistory" : "pegStabilityLive";
  }
  if (input.composability === "high") return "liquidity";
  if (input.exitSpeed === "1h") return "liquidity";
  if (input.profile === "treasury" && input.horizon === "6mplus") {
    return "dependencyRisk";
  }
  if (input.profile === "yield" && input.minApy != null) return "pharosYieldScore";
  return "safetyOverall";
}

interface SlotACandidate {
  record: ExclusionRecord;
  row: MergedRow;
  hypotheticalScore: number;
  priority: number;
}

/**
 * Build the lower-ranked list.
 *
 * @param scored Ranked survivor list (after dedup + tie-break + demotion).
 * @param excluded Exclusion records from Layer 1.
 * @param input The original selector input.
 * @param allMerged Every merged row in the universe — used to look up rows
 *                  for excluded coins by id.
 * @param shortlistedIds Set of ids already in the top-3 (recommended) so the
 *                  anti-rule on protocol-slug collisions can fire.
 * @param scoreIgnoringExclusion Engine-provided scorer that returns the
 *                  weighted score for a row as if its exclusion had not
 *                  fired. Returns `null` when the row has no scorable
 *                  signals (so the candidate is dropped).
 */
export function selectLowerRanked(
  scored: ScoredEntryLike[],
  excluded: ExclusionRecord[],
  input: SelectorInput,
  allMerged: readonly MergedRow[],
  shortlistedIds: ReadonlySet<string>,
  scoreIgnoringExclusion: (row: MergedRow, input: SelectorInput) => number | null,
  rowsById?: Map<string, MergedRow>,
): SelectorLowerRanked[] {
  const out: SelectorLowerRanked[] = [];
  const profile = input.profile;

  // --- Slot A -------------------------------------------------------------
  const profileDefining = PROFILE_DEFINING_EXCLUSIONS[profile];
  const priorityOrder: readonly string[] =
    profile === "yield"
      ? [
          "high-venue-on-c-tier",
          "yield-warning-unstable",
          "yield-warning-thin-tvl",
          "peg-score-floor",
        ]
      : profileDefining;

  const resolvedRowsById = resolveRowsById(rowsById, allMerged);

  const slotACandidates: SlotACandidate[] = [];
  for (const record of excluded) {
    if (!profileDefining.includes(record.reason as never)) continue;
    if (record.reason === "coverage-too-thin") continue;
    const row = resolvedRowsById.get(record.id);
    if (row == null) continue;
    if (shortlistedIds.has(row.id)) continue;
    const hypothetical = scoreIgnoringExclusion(row, input);
    if (hypothetical == null) continue;
    const priorityIndex = priorityOrder.indexOf(record.reason);
    slotACandidates.push({
      record,
      row,
      hypotheticalScore: hypothetical,
      priority: priorityIndex === -1 ? priorityOrder.length : priorityIndex,
    });
  }
  slotACandidates.sort((a, b) =>
    a.priority !== b.priority
      ? a.priority - b.priority
      : b.hypotheticalScore - a.hypotheticalScore,
  );

  const slotA = slotACandidates[0];
  if (slotA != null) {
    const entry: SelectorLowerRanked = {
      id: slotA.row.id,
      symbol: slotA.row.symbol,
      name: slotA.row.name,
      slot: "A",
      reasonKey: slotA.record.reason,
      failedComponent: null,
      hypotheticalScore: round1(slotA.hypotheticalScore),
    };
    out.push({ ...entry, ...getLowerRankedText(entry) });
  }

  // --- Slot B -------------------------------------------------------------
  const dim = userEmphasizedDimension(input);
  if (dim == null || scored.length < 5) {
    return out;
  }
  const candidates = scored.slice(3);
  const dimValues = candidates
    .map((c) => c.components.find((x) => x.key === dim)?.normalizedValue ?? null)
    .filter((v): v is number => v != null);
  if (dimValues.length === 0) return out;
  const cutoff = percentileLinear(dimValues, 25);
  if (cutoff == null) return out;
  const bottomQuartile = candidates.filter((c) => {
    const v = c.components.find((x) => x.key === dim)?.normalizedValue ?? null;
    return v != null && v <= cutoff;
  });
  if (bottomQuartile.length === 0) return out;

  const shortlistedProtocolSlugs = new Set<string>();
  for (const row of allMerged) {
    if (shortlistedIds.has(row.id) && row.protocolSlug != null) {
      shortlistedProtocolSlugs.add(row.protocolSlug);
    }
  }

  // Pick highest-scoring eligible within the bottom quartile. If the first
  // candidate trips an anti-rule, continue to the next candidate instead of
  // dropping Slot B entirely.
  const reasonKey = `weak-${dim}`;
  const sortedBottomQuartile = [...bottomQuartile].sort((a, b) => b.score - a.score);
  for (const candidate of sortedBottomQuartile) {
    if (shortlistedIds.has(candidate.row.id)) continue;
    if (
      candidate.row.protocolSlug != null &&
      shortlistedProtocolSlugs.has(candidate.row.protocolSlug)
    ) {
      continue;
    }
    if (slotA != null && slotA.record.reason === reasonKey) {
      continue;
    }

    const entry: SelectorLowerRanked = {
      id: candidate.row.id,
      symbol: candidate.row.symbol,
      name: candidate.row.name,
      slot: "B",
      reasonKey,
      failedComponent: dim,
      hypotheticalScore: round1(candidate.score),
    };
    out.push({ ...entry, ...getLowerRankedText(entry) });
    break;
  }

  return out;
}
