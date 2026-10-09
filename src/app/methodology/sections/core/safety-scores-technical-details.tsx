import { V9_CANDIDATE_POLICY_V1 } from "@shared/lib/safety-score-v9/policy";
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
  const rounding = `${formula.rounding.uncapped} uncapped · ${formula.rounding.capped} capped · ${formula.scoreDecimals} decimals`;

  return (
    <>
      <MethodologyDetails summary="Current V10 technical contract" primary>
        <p>
          The checked policy normally uses Backing {formula.pillarWeights.backing * 100}%, Exit{" "}
          {formula.pillarWeights.exit * 100}%, and Economic Control {formula.pillarWeights.control * 100}%.
          Use the weights of included pillars only, renormalized to sum to one. With at least two included pillars,
          weighted quality cannot exceed the strongest measured support, and the score receives at most bounded
          headroom above the weakest included pillar. Exactly one excluded pillar produces a labelled two-pillar
          partial rating; fewer than two means Pipeline gap with no aggregate or grade. Peg behavior applies with
          exponent {formula.pegExponent}; positively evidenced method, parent, history and structural constraints
          remain without missing-data ceilings.
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
        <p>
          Peg freshness uses the asset&apos;s original priceObservedAt and the unchanged 1,800-second production
          budget. Missing, null, nonpositive, fractional, unsafe-integer or future clocks produce a missing peg
          fact with unknown freshness; a cache or cohort timestamp cannot substitute. Only an absent legacy
          raw-list field may inherit that same asset&apos;s priceUpdatedAt. Preserving historical bytes and
          capture identity does not imply score equivalence under corrected clock admission.
        </p>
        <p>
          Reserve attempts retain typed per-datum loss and attempted fallback legs. Operational-only proof
          permits retained evidence only within all original clocks; unknown, evidential or semantic loss
          invalidates the datum, and later deferral cannot clear that invalidation. Returned fallback evidence
          is persisted honestly, not replaced with a better prior snapshot. Captured Backing lineage retains
          original reserve authority and loss history. Reserve-backed redemption keeps its original census,
          current configuration and original clocks; only actual present non-carryable composition/redemption
          loss or invalidation revokes its consumed parent. Healthy newer success alone does not reject it,
          and no newest-success tuple gate or post-recovery marker is added.
        </p>
        <p>
          In-flight pending reserve work is not a failure: prior finalized success or operational proof,
          original clocks and existing invalidation remain. Only finalized later attempts need their own
          matching identity and observed-clock proof; older packets cannot cover finalized mismatches.
          Tied-clock unstamped error/withheld failure is unknown; clean legacy ok/degraded stored success
          remains admitted when ordinary gates pass. Existing recovery abandonment records terminal unknown;
          no new pending timeout is added.
        </p>
        <p>
          Redemption losses retain asset, route and original input identity. Malformed rows preserve valid
          peers from the newest trusted run; a corrupt manifest or census remains a global failure.
          Whole-publication stale/unavailable and all-rows-quarantined holds remain, alongside the eight-hour
          output budget and original nested observation clocks. This adds no operational carry and does not
          change Exit continuity holds or output-price valuation.
        </p>
        <p className="pharos-numeric">
          candidate = weakestIncluded + {formula.compensabilityHeadroom} × tanh((renormalizedWeightedQuality − weakestIncluded) /{" "}
          {formula.compensabilityHeadroom})
        </p>
        <MethodologyFacts
          facts={[
            { label: "Pillar weights", value: "40/35/25 normally; renormalized over included pillars" },
            { label: "Peg adjustment", value: `(pegScore / 100)^${formula.pegExponent}` },
            { label: "Active-depeg caps", value: activeDepegCaps },
            { label: "Track-record ceilings", value: trackRecordCeilings },
            { label: "Rounding", value: rounding },
            { label: "Equal-cap priority", value: formula.capTiePriority.join(" → ") },
            { label: "Grade thresholds", value: gradeThresholds },
            { label: "Insufficient evidence", value: "C/U/D-only causal gates; A/B never NR" },
            { label: "Publication", value: "Global failures hold; proven local technical gaps preserve pipeline-gap status" },
            {
              label: "Policy provenance",
              value: `Score-bearing gates digest-bound since v${releaseVersion}; withhold below ${formula.withhold.maxScoreExclusive}, F-gate peg floor ${formula.danger.fGatePegMultiplierFloor}, material-bridge share ${semantic.control.materialBridgeHighShareThreshold * 100}%`,
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
