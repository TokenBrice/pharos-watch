import { V9_CANDIDATE_POLICY_V1 } from "@shared/lib/safety-score-v9/policy";
import { DEPEG_SEVERITY_BPS } from "@shared/lib/depeg-config";
import { MethodologyDetails, MethodologyFacts } from "../../methodology-shared";
import { SafetyScoresDimensionDetails } from "./safety-scores-dimension-details";
import { SafetyScoresScoringDetails } from "./safety-scores-scoring-details";

export function SafetyScoresTechnicalDetails() {
  const { releaseVersion, semantic } = V9_CANDIDATE_POLICY_V1.policy;
  const { formula } = semantic;
  const gradeThresholds = formula.gradeThresholds
    .map((threshold) => `${threshold.grade} ${threshold.minScore}+`)
    .join(", ");
  const activeDepegCaps = formula.activeDepegCaps
    .map((cap) => `≥${cap.minimumBps / 100}% → ${cap.limit}`)
    .join(" · ");
  const trackRecordCeilings = formula.trackRecordCeilings
    .filter((ceiling) => ceiling.limit !== null)
    .map((ceiling) => `<${ceiling.maxMonthsExclusive}m → ${ceiling.limit}`)
    .join(" · ");
  const rounding = "nearest own score; floor each ceiling once, then integer minimum";

  return (
    <>
      <MethodologyDetails summary="Current V10 technical contract" primary>
        <p>
          The checked policy normally uses Backing {formula.pillarWeights.backing * 100}%, Exit{" "}
          {formula.pillarWeights.exit * 100}%, and Economic Control {formula.pillarWeights.control * 100}%.
          Retain all three original weights. With at least two usable pillars, an unavailable third is priced at
          its cause-keyed unknown quality, not omitted or renormalized. The weakest of all three priced pillars
          sets bounded headroom above that minimum; missing-pillar pricing is uncertainty, not usable evidence.
          Fewer than two usable pillars means Pipeline gap without an aggregate or grade. Peg behavior applies with
          exponent {formula.pegExponent}. Five whole-score limit families remain: active depeg, known age
          under 24 and under 36 months, required parents/wrappers, realized holder loss and speculative-credit residual.
          The broad structural-cap matrix and duplicate evidence ceilings are retired.
        </p>
        <p>
          Policy owns score-bearing values and evidence-expiry budgets; the semantic digest rotates when they change.
          Cause-keyed unknown pricing applies only to genuinely missing subfactors, never as a floor on measured
          adverse values. LEVER-1, its hazard exception and grade-based D/F NR guards are retired. A low score,
          open question or active incident does not withhold an otherwise evidenced rating. Publication quarantine
          and accepted-state holds remain separate from rating availability.
        </p>
        <p className="pharos-numeric">
          candidate = weakestPriced + {formula.compensabilityHeadroom} × tanh((weightedQuality − weakestPriced) /{" "}
          {formula.compensabilityHeadroom})
        </p>
        <MethodologyFacts
          facts={[
            { label: "Pillar weights", value: "40/35/25 across all three priced pillars; no missing-pillar renormalization" },
            { label: "Peg adjustment", value: `(pegScore / 100)^${formula.pegExponent}` },
            { label: "Active-depeg caps", value: activeDepegCaps },
            { label: "Track-record ceilings", value: trackRecordCeilings },
            { label: "Rounding", value: rounding },
            { label: "Equal-cap priority", value: formula.capTiePriority.join(" → ") },
            { label: "Grade thresholds", value: gradeThresholds },
            { label: "Rating availability", value: "At least two usable pillars; no cause, low-score or D/F NR gate" },
            { label: "Publication", value: "Global failures hold; proven local technical gaps preserve pipeline-gap status" },
            { label: "Unknown Backing / Exit / Control (C)", value: `${semantic.unknownQuality.backing.C} / ${semantic.unknownQuality.exit.C} / ${semantic.unknownQuality.control.C}` },
            { label: "Unknown Backing / Exit / Control (U or unclassified)", value: `${semantic.unknownQuality.backing.U} / ${semantic.unknownQuality.exit.U} / ${semantic.unknownQuality.control.U}` },
            { label: "Exit unknown cause labels", value: "Presentation-only C/U labels; both price uncertainty at 50, never overwrite measured Exit" },
            { label: "Wrapper form deductions", value: "Pure 3 · native-staked 5 · strategy-vault 10; applied to the premium-free parent limit" },
            { label: "Realized holder loss", value: `≥${DEPEG_SEVERITY_BPS.severe / 100}% → ${formula.realizedHolderLoss.initialLimits.severe}; ≥${DEPEG_SEVERITY_BPS.offPeg / 100}% → ${formula.realizedHolderLoss.initialLimits.offPeg}; hold ${formula.realizedHolderLoss.holdDays} days, then linear recovery to 100 over ${formula.realizedHolderLoss.recoveryDays} days` },
            { label: "Speculative-credit residual", value: `High admitted reserve/global-claim measured-adverse credit signal → ${formula.speculativeCreditResidualLimit}; admitted legacy unscoped proof retained; no deployment/access-only cap` },
            {
              label: "Policy provenance",
              value: `Policy v${releaseVersion}; authority maximum ${semantic.control.authorityLadder.maxComponentQuality}; material-bridge share ${semantic.control.materialBridgeHighShareThreshold * 100}%`,
            },
          ]}
        />
      </MethodologyDetails>
      <MethodologyDetails summary="Historical V8.17 methodology: dimensions, formulas, thresholds, and caveats">
        <SafetyScoresScoringDetails />
        <SafetyScoresDimensionDetails />
      </MethodologyDetails>
    </>
  );
}
