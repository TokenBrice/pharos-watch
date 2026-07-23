import { V9_CANDIDATE_POLICY_V1 } from "@shared/lib/safety-score-v9/policy";
import type { V9Grade, V9ValidatedPolicyEnvelope } from "@shared/types/safety-score-v9";

/**
 * Anchor-coherence sniff check (calibration judge, not an ops gate). The ruled
 * anchor contract is declared once in SAFETY_SCORE_V9_ANCHOR_CONTRACT_V1 as
 * grade-band references; the numeric thresholds are resolved from the candidate
 * methodology policy's gradeThresholds so the gate tracks policy retunes
 * instead of duplicating magic numbers. The production-acceptance validator
 * owns the complete release contract; this smaller gate keeps the principal
 * calibration anchors and adverse controls coherent during iteration.
 */

const SAFETY_SCORE_V9_ANCHOR_GATE_SCHEMA_VERSION = 1;

export type V9RatedGrade = Exclude<V9Grade, "NR">;

/** Minimal card projection the anchor gate evaluates. */
export interface V9AnchorGateCard {
  id: string;
  score: number | null;
  grade: V9Grade;
  archetype: string | null;
}

export interface V9AnchorPendingRuling {
  decisionId: string;
  alternativeMinGrade: V9RatedGrade;
  note: string;
}

export interface V9AnchorRule {
  id: string;
  minGrade: V9RatedGrade;
  label: string;
  pendingRuling?: V9AnchorPendingRuling;
}

export interface V9RelativePairRule {
  kind: "pair";
  id: string;
  overId: string;
  label: string;
}

export interface V9RelativeArchetypeRule {
  kind: "archetype-set";
  id: string;
  archetypes: readonly string[];
  label: string;
}

export type V9RelativeRule = V9RelativePairRule | V9RelativeArchetypeRule;

export interface V9AdverseScorePin {
  kind: "max-score";
  id: string;
  maxScore: number;
  label: string;
}

export interface V9AdverseGradePin {
  kind: "max-grade";
  id: string;
  maxGrade: V9RatedGrade;
  label: string;
}

export type V9AdverseRule = V9AdverseScorePin | V9AdverseGradePin;

export interface V9AnchorContract {
  schemaVersion: 1;
  anchors: readonly V9AnchorRule[];
  relative: readonly V9RelativeRule[];
  adverse: readonly V9AdverseRule[];
}

/**
 * The ruled anchor set. Grade references resolve against the candidate
 * policy's gradeThresholds: A=83, A-=80, B+=75, B=70, C+=60, C=55, D=40.
 */
export const SAFETY_SCORE_V9_ANCHOR_CONTRACT_V1 = {
  schemaVersion: 1,
  anchors: [
    { id: "usdc-circle", minGrade: "A", label: "A-anchor" },
    { id: "bold-liquity", minGrade: "A", label: "A-anchor" },
    { id: "usdt-tether", minGrade: "A-", label: "USDT resilience anchor" },
    { id: "dai-makerdao", minGrade: "B", label: "DAI current-facts anchor" },
    { id: "sdai-makerdao", minGrade: "B-", label: "sDAI current-facts anchor" },
    { id: "sbold-k3-capital", minGrade: "B-", label: "sBOLD measured-withdrawal anchor" },
    { id: "lusd-liquity", minGrade: "B+", label: "LUSD anchor" },
    { id: "pyusd-paypal", minGrade: "B", label: "B-anchor" },
    { id: "ausd-agora", minGrade: "C+", label: "AUSD anchor (amended B to C+ by owner ruling D-G, 2026-07-19)" },
    { id: "rlusd-ripple", minGrade: "B", label: "B-anchor" },
    { id: "zchf-frankencoin", minGrade: "C+", label: "ZCHF anchor (amended B to C+ by owner ruling D-H, 2026-07-19)" },
    { id: "fxusd-f-x-protocol", minGrade: "B", label: "B-anchor" },
  ],
  relative: [
    /**
     * SUPERSEDED (owner ruling, 2026-07-20) — the R8 pair rule
     * `{ kind: "pair", id: "pyusd-paypal", overId: "pusd-polymarket" }` was
     * removed, not amended. It asserted "PYUSD must score at least PUSD",
     * encoding an issuer-quality intuition: an OCC-supervised, Big-4-examined
     * issuer should outrank a six-month-old venue wrapper. The V9 exit pillar
     * measures a different thing — in-window executable exit — and on measured
     * facts the two disagree.
     *
     * Measured (pinned 2026-07-20 replay; PYUSD 76 / PUSD 77): PYUSD wins
     * backing by +11.4 (75.49 vs 64.09) and control by +10 (80 vs 70), so the
     * intuition is confirmed on both pillars that grade issuer quality. PYUSD
     * loses only on exit, by 21.96 (74.79 vs 96.75), because pUSD's
     * permissionless atomic unwrap clears the 300s stress horizon while PYUSD's
     * documented T+1 issuer redemption is excluded as
     * `unsupported-same-notional-route` — an exclusion that hits usdc-circle,
     * usdt-tether, usdp-paxos, rlusd-ripple and fdusd-first-digital identically,
     * so it is evenhanded rather than an asset-specific penalty.
     *
     * Both evidence levers were investigated and closed before the rule was
     * dropped; neither is a live option:
     *   - Realized-cost measurement on measured routes
     *     (`agents/safety-score-v9/results/phase3-2026-07-20/pyusd-pusd-verification.md`):
     *     unavailable to the consumer AND backwards. `executableUsd` is already
     *     the producer's bisection to the largest input clearing 200bps, so
     *     `executionCostBps = maxCostBps` is already correct; measured honestly
     *     PYUSD moves *down* to 74.
     *   - Admitting T+1 issuer redemption into the exit pillar
     *     (`.../r8-t1-redemption-counterfactual.md`): four variants modelled —
     *     two break adverse pins, one is a null set, and even where admitted
     *     PYUSD's issuer route scores 52.19 and is never its primary route, so
     *     the entire gain is the capped diversification bonus, not redemption
     *     credit.
     *
     * The inversion is therefore honest measurement, and the rule was asserting
     * an ordering the methodology does not produce. It was removed rather than
     * tuned around: scores and constraints are not adjusted to force an
     * ordering. The `kind: "pair"` machinery is deliberately retained for future
     * pair rules.
     */
    {
      kind: "archetype-set",
      id: "usdc-circle",
      archetypes: ["fiat-cash", "tbill"],
      label: "USDC must score at least every other centralized fiat asset",
    },
  ],
  adverse: [
    // USDD and USDAI adverse pins (both ≤39) SUPERSEDED by owner ruling 2026-07-21.
    // Both are well-backed but centralized-mint assets that V8 grades at C/C+;
    // the mint-soften + control-compensability changes let them land on their
    // honest pillar blend (USDD 55/C, USDAI 52/C-) instead of the hard 39 cap.
    // The owner released both pins ("USDD is 55/C in V8", "USDAI 62/C+ fitting");
    // they are no longer must-stay-low assets. U/EURS/MIM remain pinned.
    // TUSD adverse pin (≤C-) SUPERSEDED by owner ruling 2026-07-21 (reshape-v2
    // D8): TUSD lands on its honest blend (C- 54; redemption genuinely
    // DIFC-impaired, exit 46). It remains a named WATCH sentinel in every
    // counterfactual — a surprise rise gets flagged and re-presented, not
    // silently shipped — but is no longer a must-stay-low asset.
    { kind: "max-score", id: "u-united-stables", maxScore: 32, label: "U adverse pin" },
    { kind: "max-grade", id: "eurs-stasis", maxGrade: "F", label: "EURS adverse pin" },
    { kind: "max-grade", id: "mim-abracadabra", maxGrade: "F", label: "MIM adverse pin" },
  ],
} as const satisfies V9AnchorContract;

export type V9AnchorGateVerdictCode =
  | "pass"
  | "anchor-below-threshold"
  | "relative-inversion"
  | "adverse-above-bound"
  | "asset-missing"
  | "asset-not-rated";

export interface V9AnchorGateVerdict {
  rule: string;
  kind: "anchor" | "relative" | "adverse";
  status: "pass" | "fail";
  code: V9AnchorGateVerdictCode;
  observed: string;
  required: string;
  detail: string;
}

export interface V9AnchorGateReport {
  schemaVersion: 1;
  decision: "gate-passed" | "no-go";
  policyId: string;
  policyDigest: string;
  appliedRulings: string[];
  pendingRulings: Array<{
    decisionId: string;
    anchorId: string;
    currentMinGrade: V9RatedGrade;
    alternativeMinGrade: V9RatedGrade;
    applied: boolean;
  }>;
  gradeThresholds: Array<{ grade: V9RatedGrade; minScore: number }>;
  verdicts: V9AnchorGateVerdict[];
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function gradeThresholdMap(policy: V9ValidatedPolicyEnvelope): ReadonlyMap<V9RatedGrade, number> {
  return new Map(
    policy.policy.semantic.formula.gradeThresholds.map((threshold) => [threshold.grade, threshold.minScore]),
  );
}

/** Lowest score that would land above the given grade band, per policy thresholds. */
function upperBoundForMaxGrade(
  thresholds: ReadonlyMap<V9RatedGrade, number>,
  maxGrade: V9RatedGrade,
): number {
  const ascending = [...thresholds.entries()].sort((left, right) => left[1] - right[1]);
  const index = ascending.findIndex(([grade]) => grade === maxGrade);
  const above = index >= 0 ? ascending[index + 1] : undefined;
  if (!above) throw new Error(`Anchor contract max-grade pin ${maxGrade} has no higher grade band to bound it`);
  return above[1];
}

function failVerdict(
  rule: string,
  kind: V9AnchorGateVerdict["kind"],
  code: Exclude<V9AnchorGateVerdictCode, "pass">,
  required: string,
  detail: string,
  observed = "absent",
): V9AnchorGateVerdict {
  return { rule, kind, status: "fail", code, observed, required, detail };
}

function missingOrUnrated(
  rule: string,
  kind: V9AnchorGateVerdict["kind"],
  card: V9AnchorGateCard | undefined,
  required: string,
  assetId: string,
): V9AnchorGateVerdict | null {
  if (!card) {
    return failVerdict(rule, kind, "asset-missing", required, `${assetId} is absent from the evaluated card set`);
  }
  if (card.score === null) {
    return failVerdict(
      rule,
      kind,
      "asset-not-rated",
      required,
      `${card.id} is NR and cannot satisfy a score-based rule`,
      "NR",
    );
  }
  return null;
}

export function evaluateSafetyScoreV9AnchorGate(input: {
  cards: readonly V9AnchorGateCard[];
  policy?: V9ValidatedPolicyEnvelope;
  applyRulings?: readonly string[];
  contract?: V9AnchorContract;
}): V9AnchorGateReport {
  const policy = input.policy ?? V9_CANDIDATE_POLICY_V1;
  const contract: V9AnchorContract = input.contract ?? SAFETY_SCORE_V9_ANCHOR_CONTRACT_V1;
  const thresholds = gradeThresholdMap(policy);
  const declaredRulings = new Map(
    contract.anchors.flatMap((anchor) =>
      anchor.pendingRuling ? [[anchor.pendingRuling.decisionId, anchor] as const] : [],
    ),
  );
  const appliedRulings = [...new Set(input.applyRulings ?? [])].sort(compareText);
  for (const decisionId of appliedRulings) {
    if (!declaredRulings.has(decisionId)) {
      throw new Error(`Unknown anchor-gate pending ruling: ${decisionId}`);
    }
  }
  const appliedSet = new Set(appliedRulings);

  const byId = new Map<string, V9AnchorGateCard>();
  for (const card of input.cards) {
    if (byId.has(card.id)) throw new Error(`Anchor gate received duplicate card id: ${card.id}`);
    byId.set(card.id, card);
  }

  const verdicts: V9AnchorGateVerdict[] = [];

  for (const anchor of contract.anchors) {
    const rule = `anchor:${anchor.id}`;
    const rulingApplied = anchor.pendingRuling !== undefined && appliedSet.has(anchor.pendingRuling.decisionId);
    const minGrade =
      rulingApplied && anchor.pendingRuling ? anchor.pendingRuling.alternativeMinGrade : anchor.minGrade;
    const minScore = thresholds.get(minGrade);
    if (minScore === undefined) throw new Error(`Policy carries no grade threshold for ${minGrade}`);
    const required = `score ≥ ${minScore} (${minGrade})`;
    const card = byId.get(anchor.id);
    const unavailable = missingOrUnrated(rule, "anchor", card, required, anchor.id);
    if (unavailable) {
      verdicts.push(unavailable);
      continue;
    }
    const passes = card!.score! >= minScore;
    verdicts.push({
      rule,
      kind: "anchor",
      status: passes ? "pass" : "fail",
      code: passes ? "pass" : "anchor-below-threshold",
      observed: `${card!.score} (${card!.grade})`,
      required,
      detail: passes
        ? `${anchor.id} meets the ${anchor.label} threshold${rulingApplied ? ` (ruling ${anchor.pendingRuling!.decisionId} applied)` : ""}`
        : `${anchor.id} scores ${card!.score}, below the ${anchor.label} threshold of ${minScore}${rulingApplied ? ` (ruling ${anchor.pendingRuling!.decisionId} applied)` : ""}`,
    });
  }

  for (const relative of contract.relative) {
    if (relative.kind === "pair") {
      const rule = `relative:${relative.id}>=${relative.overId}`;
      const required = `${relative.id} score ≥ ${relative.overId} score`;
      const left = byId.get(relative.id);
      const right = byId.get(relative.overId);
      const unavailable =
        missingOrUnrated(rule, "relative", left, required, relative.id) ??
        missingOrUnrated(rule, "relative", right, required, relative.overId);
      if (unavailable) {
        verdicts.push(unavailable);
        continue;
      }
      const passes = left!.score! >= right!.score!;
      verdicts.push({
        rule,
        kind: "relative",
        status: passes ? "pass" : "fail",
        code: passes ? "pass" : "relative-inversion",
        observed: `${left!.score} vs ${right!.score}`,
        required,
        detail: passes
          ? `${relative.id} ${left!.score} ≥ ${relative.overId} ${right!.score}`
          : `${relative.id} ${left!.score} is below ${relative.overId} ${right!.score}`,
      });
      continue;
    }

    const rule = `relative:${relative.id}>=archetype(${[...relative.archetypes].sort(compareText).join("|")})`;
    const required = `${relative.id} score ≥ every other ${relative.archetypes.join("/")} asset score`;
    const leader = byId.get(relative.id);
    const unavailable = missingOrUnrated(rule, "relative", leader, required, relative.id);
    if (unavailable) {
      verdicts.push(unavailable);
      continue;
    }
    const archetypeSet = new Set(relative.archetypes);
    const violations = input.cards
      .filter(
        (card) =>
          card.id !== relative.id &&
          card.score !== null &&
          card.archetype !== null &&
          archetypeSet.has(card.archetype) &&
          card.score > leader!.score!,
      )
      .map((card) => `${card.id} ${card.score}`)
      .sort(compareText);
    const passes = violations.length === 0;
    verdicts.push({
      rule,
      kind: "relative",
      status: passes ? "pass" : "fail",
      code: passes ? "pass" : "relative-inversion",
      observed: `${relative.id} ${leader!.score}`,
      required,
      detail: passes
        ? `${relative.id} ${leader!.score} is not below any other ${relative.archetypes.join("/")} asset`
        : `${relative.id} ${leader!.score} is outscored by: ${violations.join(", ")}`,
    });
  }

  for (const pin of contract.adverse) {
    const rule = `adverse:${pin.id}`;
    const bound =
      pin.kind === "max-score" ? pin.maxScore + 1 : upperBoundForMaxGrade(thresholds, pin.maxGrade);
    const required =
      pin.kind === "max-score" ? `score ≤ ${pin.maxScore}` : `grade ≤ ${pin.maxGrade} (score < ${bound})`;
    const card = byId.get(pin.id);
    const unavailable = missingOrUnrated(rule, "adverse", card, required, pin.id);
    if (unavailable) {
      verdicts.push(unavailable);
      continue;
    }
    const passes = card!.score! < bound;
    verdicts.push({
      rule,
      kind: "adverse",
      status: passes ? "pass" : "fail",
      code: passes ? "pass" : "adverse-above-bound",
      observed: `${card!.score} (${card!.grade})`,
      required,
      detail: passes
        ? `${pin.id} stays pinned at ${card!.score}`
        : `${pin.id} scores ${card!.score}, above the adverse pin (${required})`,
    });
  }

  return {
    schemaVersion: SAFETY_SCORE_V9_ANCHOR_GATE_SCHEMA_VERSION,
    decision: verdicts.every((verdict) => verdict.status === "pass") ? "gate-passed" : "no-go",
    policyId: policy.policy.policyId,
    policyDigest: policy.semanticDigest,
    appliedRulings,
    pendingRulings: contract.anchors.flatMap((anchor) =>
      anchor.pendingRuling
        ? [
            {
              decisionId: anchor.pendingRuling.decisionId,
              anchorId: anchor.id,
              currentMinGrade: anchor.minGrade,
              alternativeMinGrade: anchor.pendingRuling.alternativeMinGrade,
              applied: appliedSet.has(anchor.pendingRuling.decisionId),
            },
          ]
        : [],
    ),
    gradeThresholds: [...thresholds.entries()]
      .map(([grade, minScore]) => ({ grade, minScore }))
      .sort((left, right) => right.minScore - left.minScore),
    verdicts,
  };
}
