import { V9_CANDIDATE_POLICY_V1 } from "@shared/lib/safety-score-v9/policy";
import { MethodologyDetails, MethodologyFacts } from "../../methodology-shared";
import { SafetyScoresDimensionDetails } from "./safety-scores-dimension-details";
import { SafetyScoresScoringDetails } from "./safety-scores-scoring-details";

export function SafetyScoresTechnicalDetails() {
  const formula = V9_CANDIDATE_POLICY_V1.policy.semantic.formula;
  const gates = V9_CANDIDATE_POLICY_V1.scoreBearingGates;
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
  const rounding = `${formula.rounding.uncapped} uncapped · ${formula.rounding.capped} capped · ${formula.scoreDecimals} decimals`;

  return (
    <>
      <MethodologyDetails summary="Current V9 technical contract" primary>
        <p>
          The checked policy uses Backing {formula.pillarWeights.backing * 100}%, Exit{" "}
          {formula.pillarWeights.exit * 100}%, and Economic Control {formula.pillarWeights.control * 100}%. It first
          computes their weighted quality, then limits compensation above the weakest material pillar with smooth
          bounded headroom. Peg behavior applies with exponent {formula.pegExponent}; dependencies, evidence rules,
          track-record ceilings, wrapper-local risks, and structural caps can constrain but never invent evidence.
        </p>
        <p>
          Since methodology v9.22 every score-bearing gate is part of the versioned policy asset
          rather than a code literal, so the semantic digest rotates whenever one changes. That
          covers the insufficient-evidence withhold band, the danger and F-grade peg predicates, the
          pre-exit danger predicate, the material-bridge high-share band, and the separately named
          evidence-expiry windows used by reviewed research, access reviews, overlays, and reserve
          evidence. Counterfactual replay can supply a validated gate projection and observe a
          distinct digest, so a gate change can no longer alter a published score invisibly. The
          active values did not change when this landed: the release rotated provenance, not scores.
        </p>
        <p className="pharos-numeric">
          candidate = weakest + {formula.compensabilityHeadroom} × tanh((weightedQuality − weakest) /{" "}
          {formula.compensabilityHeadroom})
        </p>
        <MethodologyFacts
          facts={[
            { label: "Pillar weights", value: "Backing 40% · Exit 35% · Economic Control 25%" },
            { label: "Peg adjustment", value: `(pegScore / 100)^${formula.pegExponent}` },
            { label: "Active-depeg caps", value: activeDepegCaps },
            { label: "Track-record ceilings", value: trackRecordCeilings },
            { label: "Rounding", value: rounding },
            { label: "Equal-cap priority", value: formula.capTiePriority.join(" → ") },
            { label: "Grade thresholds", value: gradeThresholds },
            { label: "Insufficient evidence", value: "NR unless an explicit bounded policy keeps it rateable" },
            { label: "Publication", value: "Global failure holds; attributable local failures quarantine to NR at ≥90% healthy" },
            {
              label: "Policy provenance",
              value: `Score-bearing gates digest-bound since v${gates.methodologyVersion}; withhold below ${gates.withhold.maxScoreExclusive}, F-gate peg floor ${gates.danger.fGatePegMultiplierFloor}, material-bridge share ${gates.control.materialBridgeHighShareThreshold * 100}%`,
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
